// ── CHIP CORE: Infraestructura base del chip virtual LinkCore ──
// Cache, circuit breaker, rate limiter, health check, metrics.
// Todo request pasa por aqui antes de llegar a cualquier modelo.

import { localStorage } from '../memory-bus.js';

// ── CACHE ──
// Misma query + mismo modelo = respuesta cacheada.
// Reduce latencia de 10s+ a <50ms en queries repetidas.
var CACHE_PREFIX = 'lc_cache_';
var CACHE_MAX_ENTRIES = 500;
var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

export function cacheGet(query, modelId) {
  var key = CACHE_PREFIX + hashQuery(query, modelId);
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    entry.hits = (entry.hits || 0) + 1;
    entry.lastHit = Date.now();
    localStorage.setItem(key, JSON.stringify(entry));
    return entry;
  } catch (e) {
    return null;
  }
}

export function cacheSet(query, modelId, result) {
  var key = CACHE_PREFIX + hashQuery(query, modelId);
  try {
    var entry = {
      query: query,
      modelId: modelId,
      text: result.text,
      provider: result.provider,
      latencyMs: result.latencyMs,
      ts: Date.now(),
      hits: 0,
      lastHit: null,
    };
    localStorage.setItem(key, JSON.stringify(entry));
    evictCacheIfNeeded(CACHE_PREFIX, CACHE_MAX_ENTRIES);
  } catch (e) {}
}

// ── CACHE DE RESPUESTA FINAL (no por modelo) ──
// Bug real de rendimiento, medido en vivo (2026-08-08): repetir la MISMA
// pregunta tardaba 64.9s la segunda vez (vs 115.9s la primera) -- solo
// 1.8x mas rapido, cuando deberia ser practicamente instantaneo. Causa:
// cacheGet/cacheSet de arriba cachean por (query + modelId), es decir la
// respuesta de CADA MODELO por separado. Eso ahorra las llamadas a los
// modelos, pero el pipeline vuelve a rehacer desde cero todo lo que va
// DESPUES: ronda 2 de comunicacion entre modelos, sintesis por confianza,
// consenso/arbitraje y revision G-STACK -- que en esta maquina son la
// mayor parte del tiempo. Esta cache guarda el RESULTADO FINAL ya
// sintetizado, indexado solo por la query (mas el sector/agente, que
// cambia el system prompt y por tanto la respuesta valida).
var FINAL_PREFIX = 'lc_final_';
var FINAL_TTL_MS = 30 * 60 * 1000; // mismo TTL que la cache por modelo
// Bug real, encontrado en la auditoria de "listo para mercado" (2026-08-09):
// finalCacheSet nunca purgaba nada -- evictCacheIfNeeded() solo escaneaba
// CACHE_PREFIX (la cache por-modelo), no FINAL_PREFIX. Una entrada de
// resultado final solo se borraba si alguien volvia a preguntar EXACTAMENTE
// lo mismo dentro de los 30 minutos de TTL (finalCacheGet la limpia al
// leerla caducada) -- una pregunta unica, hecha una sola vez, se quedaba en
// storage.json para siempre. Con uso real sostenido (no solo pruebas de
// una sesion) esto crece sin limite. Mismo mecanismo LRU que ya tiene la
// cache por-modelo, limite mas bajo porque cada entrada aqui es la
// respuesta YA sintetizada completa (mas pesada que una respuesta de un
// solo modelo).
var FINAL_MAX_ENTRIES = 200;

export function finalCacheGet(query, agentId) {
  var key = FINAL_PREFIX + hashQuery(query, agentId || 'default');
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var entry = JSON.parse(raw);
    if (Date.now() - entry.ts > FINAL_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    entry.hits = (entry.hits || 0) + 1;
    entry.lastHit = Date.now();
    localStorage.setItem(key, JSON.stringify(entry));
    return entry.payload;
  } catch (e) {
    return null;
  }
}

export function finalCacheSet(query, agentId, payload) {
  var key = FINAL_PREFIX + hashQuery(query, agentId || 'default');
  try {
    localStorage.setItem(key, JSON.stringify({
      query: query,
      agentId: agentId || 'default',
      payload: payload,
      ts: Date.now(),
      hits: 0,
      lastHit: null,
    }));
    evictCacheIfNeeded(FINAL_PREFIX, FINAL_MAX_ENTRIES);
  } catch (e) {}
}

export function cacheStats() {
  var stats = { entries: 0, totalHits: 0, totalSize: 0 };
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0) {
        var entry = JSON.parse(localStorage.getItem(k) || '{}');
        stats.entries++;
        stats.totalHits += entry.hits || 0;
        stats.totalSize += (entry.text || '').length;
      }
    }
  } catch (e) {}
  return stats;
}

export function cacheClear() {
  var keys = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
    }
    keys.forEach(function(k) { localStorage.removeItem(k); });
  } catch (e) {}
  return keys.length;
}

function hashQuery(query, modelId) {
  var str = (query || '').toLowerCase().trim() + '|' + (modelId || '');
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// Generalizada (2026-08-09) para poder purgar tambien la cache de
// resultado final, no solo la cache por-modelo -- ver el bug real que
// motivo esto justo debajo, en finalCacheSet.
function evictCacheIfNeeded(prefix, maxEntries) {
  var keys = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) keys.push(k);
    }
  } catch (e) { return; }
  if (keys.length <= maxEntries) return;
  var entries = [];
  keys.forEach(function(k) {
    try {
      var e = JSON.parse(localStorage.getItem(k) || '{}');
      entries.push({ key: k, ts: e.ts || 0, hits: e.hits || 0 });
    } catch (err) {}
  });
  entries.sort(function(a, b) { return (a.hits - b.hits) || (a.ts - b.ts); });
  var toRemove = entries.slice(0, keys.length - maxEntries);
  toRemove.forEach(function(e) { localStorage.removeItem(e.key); });
}

// ── CIRCUIT BREAKER ──
// Si un modelo falla 3 veces seguidas, lo saltamos por 5 minutos.
// Evita gastar tiempo en un modelo que esta caido.

var CB_PREFIX = 'lc_cb_';
var CB_FAIL_THRESHOLD = 3;
var CB_RECOVERY_MS = 5 * 60 * 1000;

export function circuitIsOpen(modelId) {
  var key = CB_PREFIX + modelId;
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return false;
    var state = JSON.parse(raw);
    if (state.failures < CB_FAIL_THRESHOLD) return false;
    if (Date.now() - state.lastFail > CB_RECOVERY_MS) {
      localStorage.removeItem(key);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

export function circuitRecordSuccess(modelId) {
  var key = CB_PREFIX + modelId;
  try { localStorage.removeItem(key); } catch (e) {}
}

export function circuitRecordFailure(modelId) {
  var key = CB_PREFIX + modelId;
  try {
    var raw = localStorage.getItem(key);
    var state = raw ? JSON.parse(raw) : { failures: 0, lastFail: 0 };
    state.failures = (state.failures || 0) + 1;
    state.lastFail = Date.now();
    localStorage.setItem(key, JSON.stringify(state));
  } catch (e) {}
}

export function circuitStats() {
  var stats = { open: [], halfOpen: [] };
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(CB_PREFIX) === 0) {
        var modelId = k.slice(CB_PREFIX.length);
        var state = JSON.parse(localStorage.getItem(k) || '{}');
        if (state.failures >= CB_FAIL_THRESHOLD) {
          if (Date.now() - state.lastFail > CB_RECOVERY_MS) {
            stats.halfOpen.push(modelId);
          } else {
            stats.open.push(modelId);
          }
        }
      }
    }
  } catch (e) {}
  return stats;
}

// ── RATE LIMITER ──
// No mas de N requests por minuto por modelo.
// Evita saturar Ollama con requests paralelos.

var RL_PREFIX = 'lc_rl_';
var RL_WINDOW_MS = 60 * 1000;
var RL_DEFAULT_LIMIT = 10;

export function rateLimitCheck(modelId, limit) {
  limit = limit || RL_DEFAULT_LIMIT;
  var key = RL_PREFIX + modelId;
  try {
    var raw = localStorage.getItem(key);
    var state = raw ? JSON.parse(raw) : { timestamps: [] };
    var now = Date.now();
    state.timestamps = (state.timestamps || []).filter(function(t) { return now - t < RL_WINDOW_MS; });
    if (state.timestamps.length >= limit) return false;
    state.timestamps.push(now);
    localStorage.setItem(key, JSON.stringify(state));
    return true;
  } catch (e) {
    return true;
  }
}

export function rateLimitStats() {
  var stats = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(RL_PREFIX) === 0) {
        var modelId = k.slice(RL_PREFIX.length);
        var state = JSON.parse(localStorage.getItem(k) || '{}');
        var now = Date.now();
        var recent = (state.timestamps || []).filter(function(t) { return now - t < RL_WINDOW_MS; });
        stats[modelId] = recent.length;
      }
    }
  } catch (e) {}
  return stats;
}

// ── METRICS ──
// Trackea latencia, tokens, exitos/fallos por modelo.
// Base de datos para el learning loop.

var METRICS_KEY = 'lc_metrics';

export function metricsRecord(entry) {
  try {
    var raw = localStorage.getItem(METRICS_KEY);
    var metrics = raw ? JSON.parse(raw) : { queries: [], byModel: {} };
    entry.ts = Date.now();
    metrics.queries.push(entry);
    if (metrics.queries.length > 10000) {
      metrics.queries = metrics.queries.slice(-5000);
    }
    var mid = entry.model || 'unknown';
    if (!metrics.byModel[mid]) {
      metrics.byModel[mid] = { total: 0, success: 0, fail: 0, totalLatency: 0, totalTokens: 0 };
    }
    var m = metrics.byModel[mid];
    m.total++;
    if (entry.ok) m.success++; else m.fail++;
    m.totalLatency += entry.latencyMs || 0;
    m.totalTokens += entry.tokens || 0;
    localStorage.setItem(METRICS_KEY, JSON.stringify(metrics));
  } catch (e) {}
}

export function metricsGetModelStats() {
  try {
    var raw = localStorage.getItem(METRICS_KEY);
    var metrics = raw ? JSON.parse(raw) : { byModel: {} };
    var result = {};
    for (var mid in metrics.byModel) {
      var m = metrics.byModel[mid];
      result[mid] = {
        total: m.total,
        successRate: m.total ? (m.success / m.total * 100).toFixed(1) + '%' : '0%',
        avgLatencyMs: m.total ? Math.round(m.totalLatency / m.total) : 0,
        avgTokens: m.total ? Math.round(m.totalTokens / m.total) : 0,
      };
    }
    return result;
  } catch (e) {
    return {};
  }
}

export function metricsGetRecent(n) {
  n = n || 20;
  try {
    var raw = localStorage.getItem(METRICS_KEY);
    var metrics = raw ? JSON.parse(raw) : { queries: [] };
    return metrics.queries.slice(-n);
  } catch (e) {
    return [];
  }
}

export function metricsClear() {
  try { localStorage.removeItem(METRICS_KEY); } catch (e) {}
}

// ── CONTADORES DEL CHIP (2026-08-11) ──
// Contadores reales, acumulados, persistentes -- para que `linkcore chip`
// muestre datos medidos de verdad (aciertos de cache semantico, camino
// rapido vs escalado, hallazgos de verificacion) en vez de una cifra fija
// puesta en el codigo. Un evento se registra desde el punto exacto donde
// ocurre en backend.js -- si nunca se llama, el contador se queda en
// cero, honestamente, no en un numero de ejemplo.
var CHIP_EVENTS_KEY = 'lc_chip_events';
var CHIP_EVENT_TYPES = ['semanticCacheHit', 'semanticCacheMiss', 'fastPath', 'escalatedPath', 'verificationCheck', 'verificationFinding', 'mediatedSynthesis', 'collaborationWin'];

export function chipEventRecord(type) {
  try {
    var raw = localStorage.getItem(CHIP_EVENTS_KEY);
    var counts = raw ? JSON.parse(raw) : {};
    counts[type] = (counts[type] || 0) + 1;
    localStorage.setItem(CHIP_EVENTS_KEY, JSON.stringify(counts));
  } catch (e) {}
}

export function chipEventGetCounts() {
  try {
    var raw = localStorage.getItem(CHIP_EVENTS_KEY);
    var counts = raw ? JSON.parse(raw) : {};
    var out = {};
    CHIP_EVENT_TYPES.forEach(function (t) { out[t] = counts[t] || 0; });
    return out;
  } catch (e) {
    var zeroed = {};
    CHIP_EVENT_TYPES.forEach(function (t) { zeroed[t] = 0; });
    return zeroed;
  }
}

// ── HEALTH CHECK ──
// Verifica el estado de todos los componentes del chip.

export async function healthCheck() {
  var status = {
    cache: cacheStats(),
    circuitBreaker: circuitStats(),
    rateLimiter: rateLimitStats(),
    ollama: { reachable: false, models: [] },
    timestamp: new Date().toISOString(),
  };

  try {
    var res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      var data = await res.json();
      status.ollama.reachable = true;
      status.ollama.models = (data.models || []).map(function(m) { return { name: m.name, size: m.size }; });
    }
  } catch (e) {
    status.ollama.error = e.message;
  }

  status.healthy = status.ollama.reachable;
  return status;
}

// ── ADAPTIVE TIMEOUT ──
// Modelos pequenos: 15s. Modelos medianos: 30s. Modelos grandes: 60s.

export function adaptiveTimeout(modelId) {
  if (!modelId) return 60000;
  var id = modelId.toLowerCase();
  if (id.indexOf('135m') !== -1 || id.indexOf('360m') !== -1) return 20000;
  if (id.indexOf(':0.5b') !== -1 || id.indexOf(':1b') !== -1) return 30000;
  if (id.indexOf(':1.5b') !== -1 || id.indexOf(':2b') !== -1 || id.indexOf(':3b') !== -1) return 45000;
  if (id.indexOf(':7b') !== -1 || id.indexOf(':8b') !== -1 || id.indexOf(':9b') !== -1) return 90000;
  if (id.indexOf(':13b') !== -1 || id.indexOf(':14b') !== -1) return 120000;
  if (id.indexOf(':32b') !== -1 || id.indexOf(':34b') !== -1 || id.indexOf(':35b') !== -1) return 180000;
  if (id.indexOf(':70b') !== -1 || id.indexOf(':72b') !== -1 || id.indexOf(':90b') !== -1) return 300000;
  if (id.indexOf(':236b') !== -1 || id.indexOf(':340b') !== -1 || id.indexOf(':405b') !== -1) return 600000;
  return 60000;
}

// ── FULL CHIP PIPELINE ──
// Funcion principal: toda query pasa por aqui antes de ir a un modelo.
// Retorna { cacheHit, circuitOpen, rateLimited, timeout, metrics }

export function chipPreFlight(query, modelId) {
  var result = { cacheHit: false, circuitOpen: false, rateLimited: false, timeout: 30000 };

  var cached = cacheGet(query, modelId);
  if (cached) {
    result.cacheHit = true;
    result.cachedEntry = cached;
    return result;
  }

  if (circuitIsOpen(modelId)) {
    result.circuitOpen = true;
    return result;
  }

  if (!rateLimitCheck(modelId)) {
    result.rateLimited = true;
    return result;
  }

  result.timeout = adaptiveTimeout(modelId);
  return result;
}
