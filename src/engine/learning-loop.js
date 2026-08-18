// ── LEARNING LOOP V2: Aprendizaje profundo por modelo y categoría ──
// Registra qué modelo funciona mejor para qué tipo de tarea.
// Con el tiempo, el sistema aprende a elegir el mejor modelo
// automáticamente para cada tipo de query.

import { localStorage } from '../memory-bus.js';
import { getBanditScore, recordBanditOutcome } from './bandit-router.js';

var STORAGE_KEY = 'lc_learning_v2';
var MIN_SAMPLES = 3;
var LEARNED_BIAS_CAP = 0.15;
var MAX_ENTRIES = 2000;

var _data = { models: {}, categories: {}, pairings: {}, collaborations: {} };

function _load() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _data = Object.assign({ models: {}, categories: {}, pairings: {}, collaborations: {} }, parsed);
        if (!_data.collaborations) _data.collaborations = {};
      }
    }
  } catch (e) {}
}

function _save() {
  try {
    if (Object.keys(_data.pairings).length > MAX_ENTRIES) {
      var keys = Object.keys(_data.pairings);
      var sorted = keys.sort(function(a, b) {
        return (_data.pairings[a].count || 0) - (_data.pairings[b].count || 0);
      });
      var toRemove = sorted.slice(0, Math.floor(MAX_ENTRIES * 0.2));
      toRemove.forEach(function(k) { delete _data.pairings[k]; });
    }
    if (Object.keys(_data.collaborations || {}).length > MAX_ENTRIES) {
      var cKeys = Object.keys(_data.collaborations);
      var cSorted = cKeys.sort(function(a, b) {
        return (_data.collaborations[a].count || 0) - (_data.collaborations[b].count || 0);
      });
      var cToRemove = cSorted.slice(0, Math.floor(MAX_ENTRIES * 0.2));
      cToRemove.forEach(function(k) { delete _data.collaborations[k]; });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_data));
  } catch (e) {}
}

_load();

// ── RECORD: Registra resultado de una query ──

export function recordQuery(query, modelId, category, result) {
  var mid = modelId || 'unknown';
  var cat = category || 'general';

  if (!_data.models[mid]) {
    _data.models[mid] = { total: 0, success: 0, fail: 0, totalLatency: 0, totalTokens: 0, avgQuality: 0, qualitySum: 0 };
  }
  var m = _data.models[mid];
  m.total++;
  if (result.ok) m.success++; else m.fail++;
  m.totalLatency += result.latencyMs || 0;
  m.totalTokens += result.tokens || 0;
  if (typeof result.quality === 'number') {
    m.qualitySum += result.quality;
    m.avgQuality = m.qualitySum / m.total;
  }

  if (!_data.categories[cat]) {
    _data.categories[cat] = { total: 0, models: {} };
  }
  _data.categories[cat].total++;
  if (!_data.categories[cat].models[mid]) {
    _data.categories[cat].models[mid] = { count: 0, success: 0, avgLatency: 0, totalLatency: 0 };
  }
  var cm = _data.categories[cat].models[mid];
  cm.count++;
  if (result.ok) cm.success++;
  cm.totalLatency += result.latencyMs || 0;
  cm.avgLatency = cm.totalLatency / cm.count;

  var pairKey = mid + '::' + cat;
  if (!_data.pairings[pairKey]) {
    _data.pairings[pairKey] = { count: 0, success: 0, totalLatency: 0, avgQuality: 0, qualitySum: 0, lastUsed: 0 };
  }
  var p = _data.pairings[pairKey];
  p.count++;
  if (result.ok) p.success++;
  p.totalLatency += result.latencyMs || 0;
  if (typeof result.quality === 'number') {
    p.qualitySum += result.quality;
    p.avgQuality = p.qualitySum / p.count;
  }
  p.lastUsed = Date.now();

  _save();

  // Alimenta el bandit contextual (2026-08-17, hallazgo #10) con la MISMA
  // señal de recompensa que ya se usa aqui arriba -- no una escala nueva
  // que haya que recalibrar. Se alimenta SIEMPRE (no solo en frio): un
  // brazo sigue aprendiendo aunque ya tenga MIN_SAMPLES, por si getLearnedBias
  // alguna vez necesita volver a consultarlo (p.ej. tras vaciar pairings
  // por MAX_ENTRIES). No puede tumbar el registro principal si falla.
  try {
    var reward = result.ok ? (typeof result.quality === 'number' ? result.quality : 0.7) : 0.1;
    recordBanditOutcome(mid, cat, query, reward);
  } catch (e) {}
}

// ── LEARNED BIAS: Sesgo aprendido para un modelo en una categoría ──
// Retorna un valor entre -LEARNED_BIAS_CAP y +LEARNED_BIAS_CAP.
// Positivo = el modelo es bueno para esta categoría.
// Negativo = el modelo es malo para esta categoría.
// 0 = no hay suficiente historial.

export function getLearnedBias(modelId, category, query) {
  var pairKey = modelId + '::' + (category || 'general');
  var p = _data.pairings[pairKey];
  // Arranque en frio (2026-08-17, hallazgo #10): antes esto devolvia 0
  // ("sin opinion") para CUALQUIER modelo con menos de MIN_SAMPLES
  // muestras -- un modelo recien anadido al catalogo competia a ciegas
  // contra piezas con historial real. getBanditScore() (LinUCB,
  // bandit-router.js) da una estimacion PRINCIPIADA incluso con cero
  // datos (arranca con exploracion alta, se acota sola con el uso). Se
  // escala al mismo rango que el sesgo aprendido normal para que ningun
  // llamador tenga que cambiar como interpreta el valor devuelto -- solo
  // se nota que el "sin opinion" plano de antes ahora es una opinion real.
  if (!p || p.count < MIN_SAMPLES) {
    try {
      var banditRaw = getBanditScore(modelId, category, query);
      // Bug real (2026-08-17, cazador de bugs): a diferencia del camino
      // "caliente" de mas abajo (que blinda `raw` con isFinite antes de
      // devolverlo -- ver el comentario del bug NaN de 2026-08-12), este
      // camino en frio no comprobaba nada: si getBanditScore() alguna vez
      // devuelve NaN/Infinity (estado corrompido, bug en buildContext,
      // etc.), NaN * LEARNED_BIAS_CAP = NaN y Math.max/min con NaN siguen
      // devolviendo NaN -- se colaba silenciosamente el mismo tipo de bug
      // que ya se habia corregido una vez en el camino caliente. Misma
      // blindaje aqui: si no es finito, "sin opinion" (0), nunca NaN.
      if (!isFinite(banditRaw)) return 0;
      // El termino de exploracion de LinUCB no esta acotado por diseño --
      // se recorta a LEARNED_BIAS_CAP para que nunca domine por si solo
      // sobre una pieza con historial real ya establecido en otro sitio
      // del scoring (tamaño, residencia en RAM, etc.).
      return Math.max(-LEARNED_BIAS_CAP, Math.min(LEARNED_BIAS_CAP, banditRaw * LEARNED_BIAS_CAP));
    } catch (e) {
      return 0;
    }
  }

  // Bug real, preexistente y silencioso, encontrado en vivo (2026-08-12) al
  // conectar esta funcion a la seleccion de modelos Ollama: recordQuery()
  // guarda `totalLatency` en cada pairing pero NUNCA calcula `avgLatency`
  // (solo lo hace para _data.categories, no para _data.pairings). Asi que
  // `p.avgLatency` era undefined -> `1 - undefined/30000` = NaN ->
  // latencyScore NaN -> raw NaN -> Math.max/min con NaN devuelve NaN. Esta
  // funcion llevaba devolviendo NaN para TODO pairing con suficientes
  // muestras desde que existe, contaminando en silencio el unico sitio que
  // la usaba (hf-intermediation.js, que sumaba NaN a su score). Se calcula
  // la latencia media aqui a partir de los datos que si existen
  // (totalLatency/count) y se blinda el resultado contra NaN: si algo sigue
  // saliendo no-finito, se devuelve 0 (= "sin opinion"), nunca NaN, para
  // que ningun comparador de sort quede en orden indefinido.
  var successRate = p.success / p.count;
  var avgLatency = p.count > 0 ? (p.totalLatency || 0) / p.count : 0;
  var latencyScore = Math.max(0, 1 - avgLatency / 30000);
  var qualityScore = p.avgQuality || 0.5;

  var raw = (successRate - 0.7) * 0.4 + (latencyScore - 0.5) * 0.2 + (qualityScore - 0.5) * 0.4;
  if (!isFinite(raw)) return 0;
  return Math.max(-LEARNED_BIAS_CAP, Math.min(LEARNED_BIAS_CAP, raw));
}

// Expuesto para que un llamador decida si merece la pena pasar `query`
// (mas caro de obtener en algunos sitios) -- si ya hay historial real, el
// bandit ni se consulta dentro de getLearnedBias, asi que da igual.
export function hasSufficientSamples(modelId, category) {
  var pairKey = modelId + '::' + (category || 'general');
  var p = _data.pairings[pairKey];
  return !!(p && p.count >= MIN_SAMPLES);
}

function collaborationKey(models, category) {
  var ids = (models || []).filter(Boolean).slice().sort();
  return ids.join('||') + '::' + (category || 'general');
}

function normalizeCollaborationContext(context) {
  context = context || {};
  return {
    riskLevel: context.riskLevel || 'unknown',
    workloadType: context.workloadType || 'general',
  };
}

function collaborationContextKey(context) {
  var normalized = normalizeCollaborationContext(context);
  return normalized.riskLevel + '|' + normalized.workloadType;
}

function createCollaborationStats() {
  return {
    count: 0,
    success: 0,
    totalLatency: 0,
    qualitySum: 0,
    avgQuality: 0,
    contradictionSum: 0,
    consensusSum: 0,
    mediatedCount: 0,
    verificationCleanCount: 0,
    verificationResolvedCount: 0,
    contradictionResolvedCount: 0,
    confidenceGainSum: 0,
    consensusGainSum: 0,
    escalationCount: 0,
    lastUsed: 0,
  };
}

function updateCollaborationStats(stats, result) {
  stats.count++;
  if (result.ok !== false) stats.success++;
  stats.totalLatency += result.latencyMs || 0;
  if (typeof result.quality === 'number') {
    stats.qualitySum += result.quality;
    stats.avgQuality = stats.qualitySum / stats.count;
  }
  if (typeof result.contradictions === 'number') stats.contradictionSum += result.contradictions;
  if (typeof result.consensusScore === 'number') stats.consensusSum += result.consensusScore;
  if (result.mediated) stats.mediatedCount++;
  if (result.verificationFindings !== true) stats.verificationCleanCount++;
  if (result.verificationResolved) stats.verificationResolvedCount++;
  if (typeof result.contradictionsResolved === 'number' && result.contradictionsResolved > 0) {
    stats.contradictionResolvedCount += result.contradictionsResolved;
  }
  if (typeof result.confidenceGain === 'number') stats.confidenceGainSum += result.confidenceGain;
  if (typeof result.consensusGain === 'number') stats.consensusGainSum += result.consensusGain;
  if (result.escalated) stats.escalationCount++;
  stats.lastUsed = Date.now();
}

function statsSummary(stats) {
  if (!stats || !stats.count) {
    return {
      successRate: '0%',
      avgLatencyMs: 0,
      avgQuality: 'N/A',
      avgConsensus: '0.000',
      avgContradictions: '0.00',
      mediatedRate: '0%',
      verificationCleanRate: '0%',
      verificationResolvedRate: '0%',
      avgConfidenceGain: '0.000',
      avgConsensusGain: '0.000',
      contradictionResolutionRate: '0.00',
      escalationRate: '0%',
    };
  }
  return {
    successRate: (stats.success / stats.count * 100).toFixed(1) + '%',
    avgLatencyMs: Math.round(stats.totalLatency / stats.count),
    avgQuality: stats.avgQuality ? stats.avgQuality.toFixed(3) : 'N/A',
    avgConsensus: (stats.consensusSum / stats.count).toFixed(3),
    avgContradictions: (stats.contradictionSum / stats.count).toFixed(2),
    mediatedRate: (stats.mediatedCount / stats.count * 100).toFixed(1) + '%',
    verificationCleanRate: (stats.verificationCleanCount / stats.count * 100).toFixed(1) + '%',
    verificationResolvedRate: (stats.verificationResolvedCount / stats.count * 100).toFixed(1) + '%',
    avgConfidenceGain: (stats.confidenceGainSum / stats.count).toFixed(3),
    avgConsensusGain: (stats.consensusGainSum / stats.count).toFixed(3),
    contradictionResolutionRate: (stats.contradictionResolvedCount / stats.count).toFixed(2),
    escalationRate: (stats.escalationCount / stats.count * 100).toFixed(1) + '%',
  };
}

function contextStatsFor(collaboration, context) {
  if (!collaboration || !context) return null;
  var key = collaborationContextKey(context);
  return collaboration.contexts && collaboration.contexts[key] ? collaboration.contexts[key] : null;
}

export function recordCollaboration(models, category, result, context) {
  var ids = (models || []).filter(Boolean);
  if (ids.length < 2) return;
  result = result || {};
  var key = collaborationKey(ids, category);
  if (!_data.collaborations[key]) {
    _data.collaborations[key] = Object.assign(createCollaborationStats(), {
      models: ids.slice().sort(),
      category: category || 'general',
      contexts: {},
    });
  }
  var c = _data.collaborations[key];
  updateCollaborationStats(c, result);

  var normalizedContext = normalizeCollaborationContext(context);
  var ctxKey = collaborationContextKey(normalizedContext);
  if (!c.contexts[ctxKey]) {
    c.contexts[ctxKey] = Object.assign(createCollaborationStats(), {
      riskLevel: normalizedContext.riskLevel,
      workloadType: normalizedContext.workloadType,
    });
  }
  updateCollaborationStats(c.contexts[ctxKey], result);
  _save();
}

function collaborationRawScore(c) {
  if (!c || !c.count) return null;
  var successRate = c.success / c.count;
  var qualityScore = c.avgQuality || 0.5;
  var avgConsensus = c.count > 0 ? (c.consensusSum / c.count) : 0.5;
  var contradictionPenalty = c.count > 0 ? ((c.contradictionSum / c.count) * 0.08) : 0;
  var verificationBonus = c.count > 0 ? ((c.verificationCleanCount / c.count) - 0.7) * 0.12 : 0;
  var verificationResolvedBonus = c.count > 0 ? (c.verificationResolvedCount / c.count) * 0.05 : 0;
  var contradictionResolutionBonus = c.count > 0 ? Math.min(0.06, (c.contradictionResolvedCount / c.count) * 0.03) : 0;
  var confidenceGainBonus = c.count > 0 ? Math.min(0.08, (c.confidenceGainSum / c.count) * 0.2) : 0;
  var consensusGainBonus = c.count > 0 ? Math.min(0.06, (c.consensusGainSum / c.count) * 0.16) : 0;
  var raw = (successRate - 0.7) * 0.28 + (qualityScore - 0.5) * 0.28 + (avgConsensus - 0.5) * 0.24 - contradictionPenalty + verificationBonus + verificationResolvedBonus + contradictionResolutionBonus + confidenceGainBonus + consensusGainBonus;
  return isFinite(raw) ? raw : null;
}

function collaborationScoreForContext(collaboration, context) {
  var globalRaw = collaborationRawScore(collaboration);
  if (!context) return globalRaw;
  var scoped = contextStatsFor(collaboration, context);
  if (scoped && scoped.count >= MIN_SAMPLES) {
    var scopedRaw = collaborationRawScore(scoped);
    if (scopedRaw === null) return globalRaw;
    if (globalRaw === null) return scopedRaw;
    return scopedRaw * 0.85 + globalRaw * 0.15;
  }

  var knownContexts = Object.keys(collaboration.contexts || {}).filter(function (key) {
    var stats = collaboration.contexts[key];
    return stats && stats.count >= MIN_SAMPLES;
  });
  if (knownContexts.length > 0 && globalRaw !== null) {
    return globalRaw * 0.35;
  }
  return globalRaw;
}

export function getCollaborationBias(selectedModels, candidateModelId, category, context) {
  var chosen = (selectedModels || []).filter(Boolean);
  if (!candidateModelId || chosen.length === 0) return 0;

  var total = 0;
  var matched = 0;

  // 1) Sesgo exacto de topología: si ya vimos que ESTE grupo concreto
  // funciona bien (o mal), pesa más que las parejas aisladas.
  var exactKey = collaborationKey(chosen.concat([candidateModelId]), category);
  var exact = _data.collaborations[exactKey];
  if (exact && exact.count >= MIN_SAMPLES) {
    var exactRaw = collaborationScoreForContext(exact, context);
    if (exactRaw !== null) {
      total += exactRaw * 1.5;
      matched += 1.5;
    }
  }

  // 2) Respaldo por parejas: si no hay topología completa suficiente, usa
  // el historial de cómo se lleva el candidato con cada voz ya elegida.
  for (var i = 0; i < chosen.length; i++) {
    var key = collaborationKey([chosen[i], candidateModelId], category);
    var c = _data.collaborations[key];
    if (!c || c.count < MIN_SAMPLES) continue;
    var raw = collaborationScoreForContext(c, context);
    if (raw === null) continue;
    total += raw;
    matched++;
  }

  if (!matched) return 0;
  var avg = total / matched;
  return Math.max(-LEARNED_BIAS_CAP, Math.min(LEARNED_BIAS_CAP, avg));
}

export function getPreferredCollaborators(selectedModels, category, limit, context) {
  var chosen = (selectedModels || []).filter(Boolean);
  if (!chosen.length) return [];
  limit = typeof limit === 'number' ? limit : 3;
  if (limit <= 0) return [];

  var ranked = Object.keys(_data.collaborations || {}).map(function (key) {
    return _data.collaborations[key];
  }).filter(function (c) {
    if (!c || c.count < MIN_SAMPLES) return false;
    if ((c.category || 'general') !== (category || 'general')) return false;
    for (var i = 0; i < chosen.length; i++) {
      if (c.models.indexOf(chosen[i]) === -1) return false;
    }
    return c.models.length > chosen.length;
  }).map(function (c) {
    var raw = collaborationScoreForContext(c, context);
    if (raw === null || raw <= 0) return null;
    return {
      score: raw,
      count: c.count,
      models: c.models,
      recommended: c.models.filter(function (id) { return chosen.indexOf(id) === -1; }),
    };
  }).filter(Boolean).sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.count - a.count;
  });

  var preferred = [];
  for (var i = 0; i < ranked.length && preferred.length < limit; i++) {
    for (var j = 0; j < ranked[i].recommended.length && preferred.length < limit; j++) {
      var id = ranked[i].recommended[j];
      if (preferred.indexOf(id) === -1) preferred.push(id);
    }
  }
  return preferred;
}

export function collaborationReport() {
  return Object.keys(_data.collaborations || {}).map(function (key) {
    var c = _data.collaborations[key];
    var summary = statsSummary(c);
    return Object.assign({
      models: c.models,
      category: c.category,
      count: c.count,
      processorScore: collaborationRawScore(c) !== null ? collaborationRawScore(c).toFixed(4) : 'N/A',
      contexts: Object.keys(c.contexts || {}).map(function (ctxKey) {
        var ctx = c.contexts[ctxKey];
        var ctxSummary = statsSummary(ctx);
        return Object.assign({
          riskLevel: ctx.riskLevel,
          workloadType: ctx.workloadType,
          count: ctx.count,
          processorScore: collaborationRawScore(ctx) !== null ? collaborationRawScore(ctx).toFixed(4) : 'N/A',
        }, ctxSummary);
      }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5),
    }, summary);
  }).sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return parseFloat(b.processorScore) - parseFloat(a.processorScore);
  });
}

export function topologyReport(limit, opts) {
  opts = opts || {};
  limit = typeof limit === 'number' ? limit : 10;
  var category = opts.category || null;
  var context = opts.context || null;
  return Object.keys(_data.collaborations || {}).map(function (key) {
    return _data.collaborations[key];
  }).filter(function (c) {
    if (!c || c.count < MIN_SAMPLES) return false;
    if (category && c.category !== category) return false;
    return true;
  }).map(function (c) {
    var summary = statsSummary(c);
    return Object.assign({
      models: c.models,
      category: c.category,
      count: c.count,
      processorScore: collaborationScoreForContext(c, context),
    }, summary);
  }).filter(function (item) {
    return typeof item.processorScore === 'number' && isFinite(item.processorScore);
  }).sort(function (a, b) {
    if (b.processorScore !== a.processorScore) return b.processorScore - a.processorScore;
    return b.count - a.count;
  }).slice(0, limit).map(function (item) {
    item.processorScore = item.processorScore.toFixed(4);
    return item;
  });
}

// ── BEST MODEL FOR CATEGORY ──
// El "producto final" del learning loop: dado un tipo de tarea,
// ¿qué modelo debo usar?

export function bestModelForCategory(category) {
  var cat = _data.categories[category];
  if (!cat || cat.total < MIN_SAMPLES) return null;

  var models = Object.keys(cat.models);
  var best = null;
  var bestScore = -Infinity;

  for (var i = 0; i < models.length; i++) {
    var mid = models[i];
    var cm = cat.models[mid];
    if (cm.count < MIN_SAMPLES) continue;

    var successRate = cm.success / cm.count;
    var latencyScore = Math.max(0, 1 - cm.avgLatency / 30000);
    var score = successRate * 0.5 + latencyScore * 0.3 + (cm.count / cat.total) * 0.2;

    if (score > bestScore) {
      bestScore = score;
      best = mid;
    }
  }

  return best;
}

// ── MODEL REPORT ──
// Reporte completo de rendimiento de un modelo.

export function modelReport(modelId) {
  var m = _data.models[modelId];
  if (!m) return null;
  return {
    total: m.total,
    successRate: m.total ? (m.success / m.total * 100).toFixed(1) + '%' : '0%',
    avgLatencyMs: m.total ? Math.round(m.totalLatency / m.total) : 0,
    avgTokens: m.total ? Math.round(m.totalTokens / m.total) : 0,
    avgQuality: m.avgQuality ? m.avgQuality.toFixed(3) : 'N/A',
    categories: Object.keys(_data.categories).filter(function(cat) {
      return _data.categories[cat].models[modelId];
    }).map(function(cat) {
      var cm = _data.categories[cat].models[modelId];
      return {
        category: cat,
        count: cm.count,
        successRate: cm.count ? (cm.success / cm.count * 100).toFixed(1) + '%' : '0%',
        avgLatencyMs: Math.round(cm.avgLatency),
        bias: getLearnedBias(modelId, cat).toFixed(4),
      };
    }),
  };
}

// ── FULL REPORT ──
// Reporte completo de todo el sistema de aprendizaje.

export function fullReport() {
  var models = Object.keys(_data.models).map(function(mid) {
    return { model: mid, ...modelReport(mid) };
  }).filter(function(r) { return r.total > 0; });

  var categoryBest = {};
  Object.keys(_data.categories).forEach(function(cat) {
    categoryBest[cat] = bestModelForCategory(cat);
  });

  return {
    totalQueries: Object.keys(_data.pairings).reduce(function(sum, k) { return sum + _data.pairings[k].count; }, 0),
    uniqueModels: models.length,
    uniqueCategories: Object.keys(_data.categories).length,
    models: models,
    bestByCategory: categoryBest,
    collaborations: collaborationReport().slice(0, 25),
    topologies: topologyReport(15),
  };
}

export function clear() {
  _data = { models: {}, categories: {}, pairings: {}, collaborations: {} };
  _save();
}

export function getStats() {
  return {
    models: Object.keys(_data.models).length,
    categories: Object.keys(_data.categories).length,
    pairings: Object.keys(_data.pairings).length,
    collaborations: Object.keys(_data.collaborations || {}).length,
    totalQueries: Object.keys(_data.pairings).reduce(function(sum, k) { return sum + _data.pairings[k].count; }, 0),
  };
}

// ── BACKWARD COMPAT: orchestrator.js llama recordOutcome(family, category, signals) ──
// El API viejo usaba (family, category, {confidence, contradictionInvolved, revised, crossStyleReceived}).
// Lo mapeamos al nuevo recordQuery internamente.
export function recordOutcome(family, category, signals) {
  if (!family) return;
  signals = signals || {};
  var cat = category || 'general';
  var mid = '__family__' + family;

  var succeeded = signals.ok !== false;

  if (!_data.models[mid]) {
    _data.models[mid] = { total: 0, success: 0, fail: 0, totalLatency: 0, totalTokens: 0, avgQuality: 0, qualitySum: 0 };
  }
  var m = _data.models[mid];
  m.total++;
  if (succeeded) m.success++; else m.fail++;
  m.totalLatency += signals.latencyMs || 1000;

  if (!_data.categories[cat]) _data.categories[cat] = { total: 0, models: {} };
  _data.categories[cat].total++;
  if (!_data.categories[cat].models[mid]) {
    _data.categories[cat].models[mid] = { count: 0, success: 0, avgLatency: 0, totalLatency: 0 };
  }
  var cm = _data.categories[cat].models[mid];
  cm.count++;
  if (succeeded) cm.success++;
  cm.totalLatency += signals.latencyMs || 1000;
  cm.avgLatency = cm.totalLatency / cm.count;

  var pairKey = mid + '::' + cat;
  if (!_data.pairings[pairKey]) {
    _data.pairings[pairKey] = { count: 0, success: 0, totalLatency: 0, avgQuality: 0, qualitySum: 0, lastUsed: 0 };
  }
  var p = _data.pairings[pairKey];
  p.count++;
  if (succeeded) p.success++;
  p.totalLatency += signals.latencyMs || 1000;
  if (typeof signals.confidence === 'number') {
    p.qualitySum += signals.confidence;
    p.avgQuality = p.qualitySum / p.count;
  }
  p.lastUsed = Date.now();

  _save();
}

// ── G-STACK FEEDBACK: Quality signals from G-STACK reviews ──
// When G-STACK reviews an ensemble response, it generates quality signals
// that should influence future model selection. This function records those
// signals into the learning loop.

export function recordGStackReview(reviewResult, ensembleModels) {
  if (!reviewResult || !reviewResult.qualityScore) return;

  var qualityScore = reviewResult.qualityScore / 100;
  var role = reviewResult.role || 'reviewer';

  // Record G-STACK role performance
  var gstackKey = '__gstack__' + role;
  if (!_data.models[gstackKey]) {
    _data.models[gstackKey] = { total: 0, success: 0, fail: 0, totalLatency: 0, totalTokens: 0, avgQuality: 0, qualitySum: 0 };
  }
  var gm = _data.models[gstackKey];
  gm.total++;
  gm.totalLatency += reviewResult.latencyMs || 0;
  gm.qualitySum += qualityScore;
  gm.avgQuality = gm.qualitySum / gm.total;
  if (qualityScore >= 0.6) gm.success++; else gm.fail++;

  // Boost/reduce ensemble model scores based on G-STACK review
  if (ensembleModels && ensembleModels.length > 0) {
    for (var i = 0; i < ensembleModels.length; i++) {
      var modelId = ensembleModels[i];
      if (!_data.models[modelId]) continue;

      var adjustment = (qualityScore - 0.5) * 0.1;
      var m = _data.models[modelId];
      m.qualitySum += adjustment;
      m.avgQuality = m.qualitySum / m.total;

      var pairKey = modelId + '::gstack-reviewed';
      if (!_data.pairings[pairKey]) {
        _data.pairings[pairKey] = { count: 0, success: 0, totalLatency: 0, avgQuality: 0, qualitySum: 0, lastUsed: 0 };
      }
      var p = _data.pairings[pairKey];
      p.count++;
      p.totalLatency += reviewResult.latencyMs || 0;
      p.qualitySum += qualityScore;
      p.avgQuality = p.qualitySum / p.count;
      if (qualityScore >= 0.6) p.success++;
      p.lastUsed = Date.now();
    }
  }

  var cat = 'gstack-reviewed';
  if (!_data.categories[cat]) _data.categories[cat] = { total: 0, models: {} };
  _data.categories[cat].total++;

  _save();
}

// ── G-STACK REPORT ──
export function gstackReport() {
  var roles = Object.keys(_data.models).filter(function(k) {
    return k.indexOf('__gstack__') === 0;
  });

  return roles.map(function(key) {
    var role = key.replace('__gstack__', '');
    var m = _data.models[key];
    return {
      role: role,
      totalReviews: m.total,
      avgQuality: m.avgQuality ? m.avgQuality.toFixed(3) : 'N/A',
      successRate: m.total ? (m.success / m.total * 100).toFixed(1) + '%' : '0%',
      avgLatencyMs: m.total ? Math.round(m.totalLatency / m.total) : 0,
    };
  });
}
