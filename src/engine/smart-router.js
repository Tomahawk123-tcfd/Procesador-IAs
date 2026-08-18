// ── SMART ROUTER: Selección inteligente de modelos ──
// Usa datos históricos (metrics) + contexto de tarea + preferencias
// para elegir el MEJOR modelo para cada query.
// No es random. No es "el primero que esté instalado".
// Es una decisión basada en datos.

import { OLLAMA_MODELS, MAX_SAFE_MODEL_SIZE_MB } from './ollama-catalog.js';
import { metricsRecord, metricsGetModelStats, circuitIsOpen } from './chip-core.js';
import { getLearnedBias, getPreferredCollaborators } from './learning-loop.js';

// ── SCORING ──
// Cada modelo recibe un score basado en:
// 1. Compatibilidad con la tarea (category match)
// 2. Historial de calidad (success rate)
// 3. Latencia (más rápido = mejor)
// 4. Costo (más barato = mejor, pero con peso bajo)
// 5. Tamaño (más grande = mejor calidad, pero más lento)

function analyzeQuerySignals(query) {
  var t = String(query || '').toLowerCase();
  return {
    code: /\b(codigo|code|funcion|función|script|api|debug|regex|sql|typescript|javascript|python|node|react|test|html|css)\b/.test(t),
    math: /\b(calcula|resuelve|ecuaci[oó]n|porcentaje|inter[eé]s|promedio|ratio|margen|area|área|volumen)\b|\d\s*[%€$]|\d\s*[+\-*/=x]/.test(t),
    compare: /\b(compara|comparaci[oó]n|diferencia|vs\b|versus|pros y contras|trade-?off|mejor|peor)\b/.test(t),
    planning: /\b(estrategia|roadmap|arquitectura|plan|migraci[oó]n|riesgo|audita|benchmark|eval[uú]a)\b/.test(t),
    longForm: t.length > 220,
  };
}

function specializationBonus(model, category, signals) {
  var bonus = 0;
  var cats = model.categories || [];
  var family = model.family || '';
  var hasCode = cats.indexOf('code') !== -1;
  var hasReasoning = cats.indexOf('reasoning') !== -1;
  var hasText = cats.indexOf('text') !== -1;

  if (signals.code) {
    if (family === 'qwen-coder' || family === 'starcoder' || family === 'codestral' || family === 'deepseek-coder') bonus += 26;
    else if (hasCode && hasReasoning) bonus += 16;
    else if (hasCode) bonus += 8;
    else bonus -= 12;
  }

  if (signals.math || signals.compare || signals.planning) {
    if (hasReasoning) bonus += 16;
    if (family === 'qwen' || family === 'llama' || family === 'qwen-coder') bonus += 8;
    if (!hasReasoning) bonus -= 10;
  }

  if (!signals.code && !signals.math && !signals.compare && hasText) {
    bonus += 4;
  }

  if ((signals.math || signals.compare || signals.planning || signals.longForm) && model.tier === 'tiny') bonus -= 25;
  if ((signals.math || signals.compare || signals.planning) && model.tier === 'small' && (model.sizeMB || 0) < 900) bonus -= 10;
  if (signals.longForm && hasText) bonus += 6;
  if (category === 'code' && !hasCode) bonus -= 10;
  if (category === 'reasoning' && hasReasoning) bonus += 8;

  return bonus;
}

export function scoreModels(query, category, candidates) {
  var stats = metricsGetModelStats();
  var scored = [];
  var signals = analyzeQuerySignals(query);

  for (var i = 0; i < candidates.length; i++) {
    var m = candidates[i];
    var score = 0;

    if (category && m.categories && m.categories.indexOf(category) !== -1) {
      score += 50;
    }

    var s = stats[m.id];
    if (s && s.total >= 3) {
      var successRate = parseFloat(s.successRate) || 0;
      score += successRate * 0.4;
      var latencyScore = Math.max(0, 100 - s.avgLatencyMs / 100);
      score += latencyScore * 0.2;
    }

    if (m.tier === 'large') score += 15;
    else if (m.tier === 'medium') score += 30;
    else if (m.tier === 'small') score += 25;
    else score += 10;

    if (m.installed) score += 10;

    var sizeMB = m.sizeMB || 0;
    if (sizeMB > 10000) score -= 20;
    if (sizeMB > 20000) score -= 30;

    score += specializationBonus(m, category, signals);
    // query se pasa aqui (2026-08-17, hallazgo #10) para que el bandit de
    // arranque en frio dentro de getLearnedBias tenga contexto real, no
    // solo la categoria -- este es el unico llamador de getLearnedBias que
    // ya tenia `query` en scope sin necesitar cambiar su propia firma.
    score += getLearnedBias(m.id, category || 'general', query) * 60;

    scored.push({ model: m, score: score });
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  return scored;
}

// ── ROUTE ──
// Determina el mejor modelo para una query específica.

export function routeQuery(query, category, opts) {
  opts = opts || {};
  var excludeFamilies = opts.excludeFamilies || [];
  var maxModels = opts.maxModels || 3;

  var excluded = {};
  excludeFamilies.forEach(function(f) { excluded[f] = true; });

  // Bug real, severo, encontrado en vivo (2026-08-10) auditando esta
  // funcion tras cerrar el mismo fallo en selectDiverseOllama()
  // (ollama-catalog.js): routeQuery() alimenta tanto ensemble-v2.js (el
  // camino por defecto de casi toda consulta) como neural-decision-
  // engine.js (respaldo de ultimo recurso si smartQuery() lanza, ver
  // index.js#handleAsk). El scoring de mas abajo SOLO penaliza el tamano
  // (-20/-30 en el score), no lo excluye -- bajo agotamiento real de
  // circuit breaker (ya observado hoy mismo con uso intensivo sostenido:
  // varios modelos pequenos con el circuito abierto a la vez), un modelo
  // 'large' con score negativo puede seguir siendo el UNICO candidato
  // superviviente y ganar por defecto, no por merito. Backend.js ya vivio
  // este exacto fallo en otro camino (cuelgue medido de 3m21s cargando un
  // modelo 'large' en frio, sin GPU, en una maquina con 5.83GB de RAM
  // total -- 19-24GB no cabe ni de lejos, no es lento, es imposible sin
  // swapping masivo) y lo cerro alli; aqui, en la funcion compartida por
  // el camino MAS usado de todo el sistema, seguia sin cerrarse. Se
  // excluye por completo, no solo se penaliza.
  // Segundo bug real, gemelo del de arriba, encontrado en el mismo repaso:
  // este filtro no excluia candidatos no instalados -- OLLAMA_MODELS
  // incluye decenas de entradas con installed:false y un hfId de
  // respaldo (phi3, mistral, codestral, deepseek-r1/coder, gemma2,
  // qwen2.5:14b...). routeQuery() mas abajo les asigna
  // providerHint:'huggingface' a proposito, y tanto ensemble-v2.js como
  // neural-decision-engine.js despachan literalmente
  // `m.installed ? callOllamaModel : callHFModel` -- callHFModel() hace
  // un fetch real a un proxy remoto (backend.js#callHFModel). Es la MISMA
  // fuga a proveedor remoto que ya se cerro hoy en otros tres archivos
  // (orchestrator.js, vnpu-core.js, ollama-catalog.js) tras la decision
  // explicita "100% local de verdad" -- aqui, en la funcion que alimenta
  // el camino mas usado de todo el sistema, seguia abierta sin que nadie
  // la hubiera tocado. Mismo escape valvula que ollama-catalog.js
  // (opts.allowRemote), por si algun consumidor futuro lo necesita
  // explicitamente -- ningun llamador real lo pasa hoy.
  var allowRemote = opts.allowRemote === true;
  // Bug real, grave, confirmado en vivo (2026-08-14): `m.tier === 'large'`
  // excluye por ETIQUETA escrita a mano, no por el tamano real -- el mismo
  // riesgo que ollama-catalog.js ya documento y cerro con
  // MAX_SAFE_MODEL_SIZE_MB (numero real derivado de la RAM de esta
  // maquina, no una etiqueta que se puede catalogar mal). Reproducido: la
  // jefa (Kimi K3, via ensembleRun() -> routeQuery()) recibio
  // gemma4:latest (9608MB, etiquetado a mano como 'medium' cuando por
  // tamaño es 'large') como candidato valido, y tambien llama3.1:8b
  // (4920MB) y qwen2.5-coder:7b (4683MB) -- ambos genuinamente 'medium'
  // pero mas grandes de lo que esta maquina de 5.83GB puede cargar sin
  // colgarse. El intento de cargarlos se rechaza ahora al instante en
  // evictForModel() (ollama-catalog.js), pero para entonces routeQuery()
  // ya los habia ofrecido como candidatos, agotando reintentos en vez de ir
  // directo a un modelo que si cabe. Se excluye aqui con el mismo numero
  // real que ya usa selectDiverseOllama(), no con la etiqueta.
  var candidates = OLLAMA_MODELS.filter(function(m) {
    if (!allowRemote && !m.installed) return false;
    if (excluded[m.family]) return false;
    if (m.categories && m.categories.indexOf('embedding') !== -1) return false;
    if (circuitIsOpen(m.id)) return false;
    if (m.tier === 'large') return false;
    if ((m.sizeMB || 0) > MAX_SAFE_MODEL_SIZE_MB) return false;
    return true;
  });

  var scored = scoreModels(query, category, candidates);
  var preferredModelIds = [];
  if (maxModels > 1 && scored.length > 0) {
    preferredModelIds = getPreferredCollaborators([scored[0].model.id], category || 'general', Math.max(0, maxModels - 1), opts.learningContext || null);
  }

  var selected = scored.slice(0, maxModels).map(function(s) {
    var model = Object.assign({}, s.model);
    if (!model.installed && model.hfId) {
      model.remoteId = model.hfId;
      model.providerHint = 'huggingface';
    } else {
      model.providerHint = 'ollama';
    }
    return model;
  });

  return {
    ok: selected.length > 0,
    selected: selected,
    scores: scored.slice(0, maxModels).map(function(s) { return { model: s.model.id, score: s.score.toFixed(1) }; }),
    preferredModelIds: preferredModelIds,
    category: category,
    totalCandidates: candidates.length,
  };
}

// ── RECORD OUTCOME ──
// Registra el resultado de una query para mejorar el routing futuro.

export function recordOutcome(query, modelId, category, result) {
  metricsRecord({
    query: query,
    model: modelId,
    category: category,
    ok: result.ok,
    latencyMs: result.latencyMs || 0,
    tokens: (result.text || '').length,
    provider: result.provider || 'unknown',
  });
}

// ── BEST MODEL FOR CATEGORY ──
// Retorna el mejor modelo historically para una categoría dada.

export function bestModelForCategory(category) {
  var stats = metricsGetModelStats();
  var candidates = OLLAMA_MODELS.filter(function(m) {
    return m.categories && m.categories.indexOf(category) !== -1 && m.installed;
  });

  var best = null;
  var bestScore = -1;

  for (var i = 0; i < candidates.length; i++) {
    var m = candidates[i];
    var score = 0;
    var s = stats[m.id];
    if (s && s.total >= 3) {
      score = (parseFloat(s.successRate) || 0) * 0.6 + Math.max(0, 100 - s.avgLatencyMs / 100) * 0.4;
    }
    if (m.tier === 'large') score += 20;
    else if (m.tier === 'medium') score += 15;
    else if (m.tier === 'small') score += 10;

    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }

  return best || (candidates.length ? candidates[0] : null);
}
