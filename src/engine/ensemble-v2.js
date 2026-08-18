// ── ENSEMBLE V2: Motor de ensemble learning real ──
// Ejecuta la misma query en N modelos en paralelo.
// Los modelos se comunican entre si (round-2).
// Sintesis final con scored responses.
// Aprende de cada ejecución.

import os from 'node:os';
import { routeQuery, recordOutcome } from './smart-router.js';
import { cacheGet, cacheSet, circuitRecordSuccess, circuitRecordFailure, circuitIsOpen, chipPreFlight, chipEventRecord } from './chip-core.js';
import { runGStackWorkflow, detectWorkflow, runGStackRole, detectRole, GSTACK_ROLES } from '../gstack.js';
import { recordGStackReview, getCollaborationBias } from './learning-loop.js';
import { arbitrateResponses, shannonEntropy, calculateConsensus, cosineSimilarity, jaccardSimilarity } from './neural-arbitrage.js';
import { computeContentConfidence, looksLikeContextLeak } from './translation.js';
import { detectSemanticOverlap } from './semantic-translator.js';
import { compareNumericClaims } from './math-verify.js';
import * as neuralMod from './neural-decision-engine.js';
// looksLikeContextLeak: ver translation.js -- movido ahi (2026-08-03) para
// que callAI() en backend.js tambien pueda usarlo, no solo el ensemble.

// Cuantos modelos de `candidateModels` (necesitan `.sizeMB`) caben a la vez
// en la RAM libre AHORA MISMO, con el mismo margen de seguridad de 300MB
// que usa evictForModel() (ollama-catalog.js). A nivel de modulo porque
// tanto la ronda 1 (ensembleRun) como la ronda 2 (round2Communicate) lo
// necesitan -- ver el comentario grande sobre paralelismo real en
// ensembleRun mas abajo.
function computeParallelBatchSize(candidateModels) {
  var freeMB = Math.round(os.freemem() / 1024 / 1024);
  var fits = 1;
  var cumulative = 0;
  for (var ci = 0; ci < candidateModels.length; ci++) {
    cumulative += (candidateModels[ci].sizeMB || 800);
    if (cumulative + 300 <= freeMB) fits = ci + 1;
    else break;
  }
  return Math.max(1, Math.min(fits, candidateModels.length));
}

// ── BATCHING CONTINUO (2026-08-17, hallazgo #4) ──
// Antes: computeParallelBatchSize() se llamaba UNA VEZ por ronda de tamaño
// fijo (Promise.all de N, esperar a que TODOS terminen, recien entonces
// re-evaluar RAM libre y admitir el siguiente lote). Si N-1 modelos
// terminan rapido y 1 se queda colgado cerca del timeout, ese hueco de RAM
// liberado por los N-1 se queda sin usar hasta que el ultimo termine --
// exactamente el "todos acaban a la vez salvo uno" que ya motivo el diseño
// original RAM-adaptativo, pero limitado a fronteras de lote. Aqui se
// reevalua la RAM libre real cada vez que CUALQUIER item individual
// termina (no solo al final del lote) y se admite mas trabajo al instante
// si ya cabe -- mismo criterio de RAM (computeParallelBatchSize), grano
// mas fino. os.freemem() ya reflaja lo que consumen los items EN VUELO
// (no hace falta restar `running` a mano), asi que la capacidad devuelta
// es directamente "cuantos MAS caben ahora mismo".
function runContinuousBatch(items, runOne) {
  return new Promise(function (resolveAll) {
    if (!items.length) { resolveAll([]); return; }
    var results = new Array(items.length);
    var idx = 0;
    var running = 0;
    var finished = 0;

    function launchOne(i) {
      running++;
      runOne(items[i]).then(function (res) {
        results[i] = res;
      }).catch(function (e) {
        results[i] = { model: items[i] && (items[i].model || items[i].id), ok: false, error: e && e.message };
      }).finally(function () {
        running--;
        finished++;
        if (finished === items.length) resolveAll(results);
        else admitMore();
      });
    }

    function admitMore() {
      if (idx >= items.length) return;
      var capacity = computeParallelBatchSize(items.slice(idx));
      while (running < capacity && idx < items.length) {
        launchOne(idx);
        idx++;
      }
    }
    admitMore();
  });
}

// ── ESCALADO ADAPTATIVO: tercer modelo de desempate ──
// Construido 2026-08-10: si dos respuestas de la ronda 1 (ciegas, antes de
// verse entre si) discrepan de verdad, sintetizar entre las dos como si
// fuera una sola opinion oculta el desacuerdo en vez de resolverlo --
// unifyResponses()/synthesizeResponses() elige la de mayor "confianza",
// no la correcta. Deliberadamente conservador en las señales que usa:
//
// 1. Desacuerdo NUMERICO (compareNumericClaims, math-verify.js): cifra
//    final distinta entre las dos respuestas -- señal determinista, la
//    principal razon para escalar.
// 2. Solapamiento semantico casi nulo (detectSemanticOverlap): las
//    respuestas no comparten apenas vocabulario -- probable que hablen de
//    cosas distintas. Umbral MUY bajo (0.03) a proposito: la calibracion
//    en vivo de esta misma noche demostro que el solapamiento de palabras
//    es ruidoso en el rango medio (una respuesta parcialmente de acuerdo
//    solapaba MENOS que dos que discrepaban en la cifra exacta) -- no es
//    fiable como señal principal, solo como red de seguridad en el caso
//    extremo (case real: "fotosintesis" vs "machine learning" dio 0.000).
function detectRealDisagreement(validRound1) {
  for (var i = 0; i < validRound1.length; i++) {
    for (var j = i + 1; j < validRound1.length; j++) {
      var numeric = compareNumericClaims(validRound1[i].text, validRound1[j].text);
      if (numeric && numeric.disagree) {
        return { disagree: true, reason: 'numeric_disagreement', detail: numeric, pair: [validRound1[i].model, validRound1[j].model] };
      }
      var overlap = detectSemanticOverlap(validRound1[i].text, validRound1[j].text);
      if (overlap < 0.03) {
        return { disagree: true, reason: 'near_zero_overlap', detail: { overlap: overlap }, pair: [validRound1[i].model, validRound1[j].model] };
      }
    }
  }
  return { disagree: false };
}

// Pide un modelo mas, de una familia no usada aun, para desempatar. Nunca
// lanza -- una escalacion fallida degrada a sintetizar con lo que ya
// habia (el comportamiento de antes de este cambio), nunca tumba el
// ensemble entero por un intento de mejora que no salio bien.
async function tryEscalate(query, category, validRound1, systemPrompt, opts, backendMod) {
  var disagreement = detectRealDisagreement(validRound1);
  // `disagree` se expone explicitamente (no solo `triggered`) porque
  // ensembleRun() lo reutiliza para una segunda decision, independiente
  // de si el desempate tuvo exito: si de verdad no hay desacuerdo, no
  // hace falta ni ronda 2 ni revision G-STACK -- ver el comentario grande
  // en ensembleRun() sobre el coste real medido de esas dos rondas.
  if (!disagreement.disagree) return { triggered: false, disagree: false };

  try {
    var usedFamilies = validRound1.map(function (r) { return r.family; }).filter(Boolean);
    // Bug real, confirmado en vivo (2026-08-17): smollm2:135m salio elegido
    // como modelo de desempate. El camino normal de ronda 1 (mas abajo en
    // ensembleRun -> selectDiverseEnsembleModels) excluye 'tiny' con un
    // filtro DURO (m.tier !== 'tiny') desde 2026-08-03, por las mismas
    // alucinaciones de tema documentadas en backend.js#callOllamaModel.
    // Este desempate, en cambio, tomaba `tiebreakRoute.selected[0]`
    // directo de routeQuery() sin pasar por ese filtro -- y routeQuery()
    // (smart-router.js) solo PENALIZA 'tiny' en el score (-25) para
    // categorias math/compare/planning/longForm (scoreModels), no lo
    // excluye para el resto (general/text/code sin esas señales). Un
    // desempate es, si acaso, MAS importante de acertar que un voto normal
    // del ensemble -- exactamente al reves de dejarlo con MENOS filtro que
    // la ronda 1. Se pide un pool mas amplio (5 en vez de 1) y se descarta
    // 'tiny' explicitamente, igual que selectDiverseEnsembleModels().
    var tiebreakRoute = routeQuery(query, category, { maxModels: 5, excludeFamilies: usedFamilies });
    var tiebreakModel = tiebreakRoute.ok ? (tiebreakRoute.selected.find(function (m) { return m.tier !== 'tiny'; }) || null) : null;
    if (!tiebreakModel || circuitIsOpen(tiebreakModel.id)) {
      return { triggered: false, disagree: true, attempted: true, reason: disagreement.reason, detail: disagreement.detail, error: 'no_tiebreak_candidate' };
    }

    var tbCaller = tiebreakModel.installed ? backendMod.callOllamaModel : backendMod.callHFModel;
    var tbId = tiebreakModel.installed ? tiebreakModel.id : (tiebreakModel.hfId || tiebreakModel.id);
    var tbResult = await tbCaller(tbId, query, {
      systemPrompt: systemPrompt,
      maxTokens: opts.maxTokens || 400,
      temperature: opts.temperature || 0.3,
      timeoutMs: 60000,
    });

    if (tbResult && tbResult.ok && !looksLikeContextLeak(tbResult.text)) {
      circuitRecordSuccess(tbId);
      recordOutcome(query, tbId, category, { ok: true, latencyMs: tbResult.latencyMs });
      validRound1.push({ model: tbId, family: tiebreakModel.family, text: tbResult.text, ok: true, latencyMs: tbResult.latencyMs });
      return { triggered: true, disagree: true, reason: disagreement.reason, detail: disagreement.detail, tiebreakModel: tbId };
    }
    circuitRecordFailure(tbId);
    return { triggered: false, disagree: true, attempted: true, reason: disagreement.reason, detail: disagreement.detail, error: 'tiebreak_no_response' };
  } catch (e) {
    return { triggered: false, disagree: true, attempted: true, reason: disagreement.reason, detail: disagreement.detail, error: e.message };
  }
}

function buildMediatorPrompt(query, round2, synthesis, arbitrageReport) {
  var sections = [];
  sections.push('Consulta original:\n' + truncate(query, 1200));
  sections.push('Mejor borrador heurístico actual:\n' + truncate(synthesis.text, 1200));
  sections.push('Respuestas colaborativas por modelo:\n' + round2.map(function (r) {
    return '[' + r.model + ']\n' + truncate(r.text, 900);
  }).join('\n\n'));

  if (arbitrageReport) {
    sections.push(
      'Señales de arbitraje:\n' +
      '- Consenso: ' + Math.round((arbitrageReport.consensus && arbitrageReport.consensus.score || 0) * 100) + '%\n' +
      '- Contradicciones detectadas: ' + ((arbitrageReport.consensus && arbitrageReport.consensus.contradictionCount) || 0) + '\n' +
      '- Mejor respuesta base: ' + ((arbitrageReport.bestResponse && arbitrageReport.bestResponse.model) || 'desconocida')
    );
  }

  return sections.join('\n\n---\n\n') +
    '\n\nTarea: redacta una RESPUESTA FINAL única y mejorada. Reglas estrictas:\n' +
    '1. Conserva lo que varias voces apoyan o lo que no esta contradicho.\n' +
    '2. Si hay contradiccion no resuelta, dilo con cautela en vez de inventar.\n' +
    '3. Prioriza exactitud, respuesta directa y estructura clara sobre estilo.\n' +
    '4. No menciones modelos, consenso, arbitraje ni el proceso interno.\n' +
    '5. Devuelve SOLO la respuesta final para el usuario.';
}

function responseLines(text) {
  return String(text || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
}

function lineSupportMetrics(targetLine, responses) {
  var bestSim = 0;
  var supportCount = 0;
  var contradictionCount = 0;
  var normalized = targetLine.trim();
  if (!normalized || normalized.length < 12) {
    return { supportCount: 0, contradictionCount: 0, bestSim: 0 };
  }

  var targetTokens = normalized.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 2; });
  for (var i = 0; i < responses.length; i++) {
    var lines = responseLines(responses[i].text);
    var localBest = 0;
    var localContradiction = false;
    for (var j = 0; j < lines.length; j++) {
      var candidate = lines[j];
      if (!candidate) continue;

      var sim = 1;
      if (candidate === normalized) {
        localBest = Math.max(localBest, 1);
        continue;
      }

      var cosine = cosineSimilarity(normalized, candidate);
      var jaccard = jaccardSimilarity(normalized, candidate);
      sim = cosine * 0.65 + jaccard * 0.35;
      if (sim > localBest) localBest = sim;

      if (sim >= 0.45) {
        var numeric = compareNumericClaims(normalized, candidate);
        if (numeric && numeric.disagree) {
          localContradiction = true;
          continue;
        }
      }

      if (sim < 0.22) {
        var lowered = candidate.toLowerCase();
        var common = 0;
        for (var k = 0; k < targetTokens.length; k++) {
          if (lowered.indexOf(targetTokens[k]) !== -1) common++;
        }
        if (common >= 2) localContradiction = true;
      }
    }
    var supported = localBest >= 0.72 && !localContradiction;
    if (supported) supportCount++;
    if (localContradiction && !supported) contradictionCount++;
    if (localBest > bestSim) bestSim = localBest;
  }

  return { supportCount: supportCount, contradictionCount: contradictionCount, bestSim: bestSim };
}

export function pruneUnsupportedLines(text, responses) {
  var originalLines = responseLines(text);
  if (originalLines.length < 2 || !responses || responses.length < 2) return text;

  var kept = [];
  for (var i = 0; i < originalLines.length; i++) {
    var line = originalLines[i];
    if (line.length < 12 || /^[-*#\d.\s]+$/.test(line)) {
      kept.push(line);
      continue;
    }
    var metrics = lineSupportMetrics(line, responses);
    var shouldDrop = metrics.contradictionCount > 0 && metrics.supportCount <= 1;
    if (!shouldDrop) kept.push(line);
  }

  var pruned = kept.join('\n');
  if (!pruned.trim()) return text;
  if (pruned.length < text.length * 0.45) return text;
  return pruned;
}

function lineSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  var cosine = cosineSimilarity(a, b);
  var jaccard = jaccardSimilarity(a, b);
  return cosine * 0.65 + jaccard * 0.35;
}

function collectConsensusAnchors(responses) {
  if (!responses || responses.length < 2) return [];
  var items = [];
  for (var i = 0; i < responses.length; i++) {
    var lines = responseLines(responses[i].text);
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (!line || line.length < 18) continue;
      items.push({ model: responses[i].model, text: line });
    }
  }

  var clusters = [];
  for (var ii = 0; ii < items.length; ii++) {
    var item = items[ii];
    var bestCluster = null;
    var bestSim = 0;
    for (var ci = 0; ci < clusters.length; ci++) {
      var sim = lineSimilarity(item.text, clusters[ci].representative);
      var numeric = compareNumericClaims(item.text, clusters[ci].representative);
      if (numeric && numeric.disagree) continue;
      if (sim >= 0.65 && sim > bestSim) {
        bestSim = sim;
        bestCluster = clusters[ci];
      }
    }
    if (!bestCluster) {
      clusters.push({
        representative: item.text,
        lines: [item],
        models: [item.model],
      });
      continue;
    }
    bestCluster.lines.push(item);
    if (bestCluster.models.indexOf(item.model) === -1) bestCluster.models.push(item.model);
    if (item.text.length > bestCluster.representative.length) bestCluster.representative = item.text;
  }

  return clusters.filter(function (cluster) {
    return cluster.models.length >= 2;
  }).map(function (cluster) {
    return {
      text: cluster.representative,
      supportCount: cluster.models.length,
      models: cluster.models.slice(),
    };
  }).sort(function (a, b) {
    if (b.supportCount !== a.supportCount) return b.supportCount - a.supportCount;
    return b.text.length - a.text.length;
  });
}

export function reinforceConsensusLines(text, responses) {
  var baseLines = responseLines(text);
  if (!responses || responses.length < 2 || !baseLines.length) return text;

  var anchors = collectConsensusAnchors(responses);
  if (!anchors.length) return text;

  var additions = [];
  for (var i = 0; i < anchors.length && additions.length < 3; i++) {
    var anchor = anchors[i].text;
    var alreadyCovered = baseLines.some(function (line) {
      var numeric = compareNumericClaims(line, anchor);
      if (numeric && numeric.disagree) return false;
      return lineSimilarity(line, anchor) >= 0.8;
    });
    if (!alreadyCovered) additions.push(anchor);
  }

  if (!additions.length) return text;
  return text.replace(/\s+$/, '') + '\n' + additions.join('\n');
}

async function mediateCollaborativeAnswer(query, category, round2, synthesis, arbitrageReport, systemPrompt, opts, backendMod) {
  if (!round2 || round2.length < 2) return null;
  try {
    var mediatorRoute = routeQuery(query, category, { maxModels: 1 });
    var mediatorModel = mediatorRoute && mediatorRoute.ok && mediatorRoute.selected && mediatorRoute.selected[0]
      ? mediatorRoute.selected[0]
      : null;
    var mediatorId = mediatorModel && mediatorModel.id ? mediatorModel.id : (synthesis.model || round2[0].model);
    if (!mediatorId || circuitIsOpen(mediatorId)) return null;

    var mediationPrompt = buildMediatorPrompt(query, round2, synthesis, arbitrageReport);
    var mediationResult = await backendMod.callOllamaModel(mediatorId, mediationPrompt, {
      systemPrompt: systemPrompt,
      maxTokens: Math.min(opts.maxTokens || 900, 900),
      temperature: 0.1,
      timeoutMs: opts.mediatorTimeoutMs || 45000,
    });

    if (!mediationResult || !mediationResult.ok || !mediationResult.text || looksLikeContextLeak(mediationResult.text)) {
      return null;
    }

    try { chipEventRecord('mediatedSynthesis'); } catch (e) {}

    return {
      text: mediationResult.text.trim(),
      model: mediationResult.model || mediatorId,
      provider: mediationResult.provider || 'ollama-local',
      latencyMs: mediationResult.latencyMs || 0,
    };
  } catch (e) {
    return null;
  }
}

// Selecciona voces independientes. El orden de entrada ya viene del broker
// (capacidad, especializacion y aprendizaje); esta funcion solo preserva ese
// orden y fuerza diversidad de familia antes de permitir una repeticion.
export function selectDiverseEnsembleModels(rankedCandidates, size, opts) {
  opts = opts || {};
  var excludeFamilies = opts.excludeFamilies || [];
  var excludeModelIds = opts.excludeModelIds || [];
  var preferredIds = opts.preferredModelIds || [];
  var eligible = (rankedCandidates || []).filter(function (m) {
    return m && m.installed && m.tier !== 'tiny' &&
      excludeFamilies.indexOf(m.family) === -1 &&
      excludeModelIds.indexOf(m.id) === -1 &&
      !circuitIsOpen(m.id);
  });

  // Las preferencias aprendidas/externas reordenan, pero nunca saltan las
  // guardas de salud ni convierten dos variantes de la misma familia en una
  // falsa diversidad.
  eligible = eligible.slice().sort(function (a, b) {
    return (preferredIds.indexOf(b.id) !== -1 ? 1 : 0) - (preferredIds.indexOf(a.id) !== -1 ? 1 : 0);
  });

  var selected = [];
  var usedFamilies = {};
  while (selected.length < size && eligible.length) {
    var bestIdx = -1;
    var bestScore = -Infinity;
    for (var i = 0; i < eligible.length; i++) {
      var candidate = eligible[i];
      var score = 0;
      if (preferredIds.indexOf(candidate.id) !== -1) score += 1;
      if (!usedFamilies[candidate.family]) score += 0.6;
      score += getCollaborationBias(selected.map(function (m) { return m.id; }), candidate.id, opts.category || 'general', opts.learningContext || null) * 5;
      score -= selected.some(function (m) { return m.family === candidate.family; }) ? 0.5 : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    var picked = eligible.splice(bestIdx, 1)[0];
    selected.push(picked);
    usedFamilies[picked.family] = true;
  }
  return selected;
}

// ── ENSEMBLE RUN ──
// Ejecuta query en N modelos, cada uno ve los resultados de los demás,
// luego un mediador sintetiza la mejor respuesta.

export async function ensembleRun(query, opts, aiCaller) {
  opts = opts || {};
  var size = opts.size || 2;
  var category = opts.category || null;
  var systemPrompt = opts.systemPrompt || 'Responde en español de forma clara y útil.';
  var startedAt = Date.now();

  // Pedimos un pool mas amplio que el tamaño final: el broker lo ordena por
  // capacidad de la tarea y el selector de abajo puede elegir familias
  // independientes en vez de tomar accidentalmente dos variantes de Llama.
  var route = routeQuery(query, category, { maxModels: Math.max(size * 4, 12), excludeFamilies: opts.excludeFamilies || [] });
  if (!route.ok) return { ok: false, error: 'no_models_available', route: route };

  var ollamaMod = await import('./ollama-catalog.js');
  var backendMod = await import('../backend.js');

  // 'tiny' (smollm2:135m/360m) excluido a proposito: confirmado en vivo
  // (2026-08-03, ver backend.js#callOllamaModel) que estos modelos pueden
  // alucinar un tema totalmente distinto y hasta mutar letra a letra
  // cualquier texto que se les cuele -- ninguna deteccion de salida
  // (echo/repeticion) los pilla siempre. Como voto de ensemble, ese ruido
  // puede colarse en la sintesis; mejor no arriesgarlo cuando hay
  // suficientes modelos 'small' instalados.
  //
  // Bug real, confirmado en vivo (2026-08-13): `opts.excludeFamilies` solo
  // se aplicaba a `route` (arriba), usado como candidato SOLO cuando
  // `orderedSmall.length < size` -- con 5 modelos 'small' instalados y
  // size normalmente 1 o 3, esa rama practicamente nunca se alcanza, asi
  // que excludeFamilies era codigo muerto en la practica (confirmado:
  // ningun caller real en todo el repo pasa excludeFamilies a
  // ensembleRun()). Se aplica tambien aqui, junto con excludeModelIds
  // (nuevo, mas fino que excludeFamilies -- excluye un MODELO concreto sin
  // descartar el resto de su familia). Motivo real de excludeModelIds: el
  // camino escalado de backend.js#smartQuery llama a ensembleRun() otra
  // vez con el mismo `orderedSmall` determinista (mismas puntuaciones MCTS,
  // mismo estado de circuit breaker) que el camino rapido -- sin excluir
  // el modelo que YA respondio (y cuya respuesta motivo la escalada por
  // tener un hallazgo real), ese modelo vuelve a ser el candidato #1 de la
  // escalada. Bajo presion de RAM (ver el caso real: "Compara REST y
  // GraphQL", 2 desalojos, la escalada degrado a 1 solo modelo), ese unico
  // modelo que SI llega a responder es, con alta probabilidad, el mismo de
  // antes -- la "escalada" no consigue ninguna segunda opinion real, solo
  // repite la pregunta al modelo que ya fallo.
  var mctsCategory = category || 'general';
  var fallbackCandidates = Object.values(ollamaMod.OLLAMA_MODELS).filter(function(m) {
    if (!m.installed || m.tier === 'tiny' || m.tier === 'large') return false;
    if ((m.sizeMB || 0) > ollamaMod.MAX_SAFE_MODEL_SIZE_MB) return false;
    if (opts.excludeFamilies && opts.excludeFamilies.indexOf(m.family) !== -1) return false;
    if (opts.excludeModelIds && opts.excludeModelIds.indexOf(m.id) !== -1) return false;
    if (circuitIsOpen(m.id)) return false;
    return true;
  }).sort(function (a, b) {
    var scoreA = neuralMod.getMCTSScore(a.id, mctsCategory);
    var scoreB = neuralMod.getMCTSScore(b.id, mctsCategory);
    return (scoreB === null ? 0.5 : scoreB) - (scoreA === null ? 0.5 : scoreA);
  });

  // El ranking del router es el camino principal; el fallback MCTS solo
  // rellena candidatos ausentes. Antes ocurria al reves y el ensemble podia
  // ignorar completamente el modelo especializado para la tarea.
  var rankedCandidates = route.selected.concat(fallbackCandidates.filter(function (candidate) {
    return !route.selected.some(function (routed) { return routed.id === candidate.id; });
  }));
  var mergedPreferredIds = (opts.preferredModelIds || []).slice();
  (route.preferredModelIds || []).forEach(function (id) {
    if (mergedPreferredIds.indexOf(id) === -1) mergedPreferredIds.push(id);
  });
  var models = selectDiverseEnsembleModels(rankedCandidates, size, Object.assign({}, opts, {
    category: opts.category || category || route.category || 'general',
    preferredModelIds: mergedPreferredIds,
    learningContext: opts.learningContext || null,
  }));

  // Historia real de esta ronda, en tres capas (2026-08-03 a 2026-08-16):
  //
  // Capa 1 (ya arreglada): este tope forzaba TODO modelo del ensemble a
  // un limite duro de 10s sin importar adaptiveTimeout().
  //
  // Capa 2 (ya arreglada): se compenso la contencion de CPU del
  // paralelismo con un suelo de 30s / techo de 60s por modelo.
  //
  // Capa 3 (2026-08-03, YA NO es la solucion final): medido en vivo con 3
  // modelos 'small' (1B-3B) reales corriendo a la vez con Promise.all en
  // ESTA maquina concreta (5.83GB, sin GPU): los TRES agotaron el techo de
  // 60s sin responder ninguno. La correccion de entonces fue forzar SIEMPRE
  // serie -- funciono, pero convertia el ensemble en "N veces el tiempo de
  // un modelo" en cualquier maquina, incluida una con RAM/CPU de sobra para
  // correr varios a la vez de verdad.
  //
  // Capa 4 (esta, 2026-08-16): la contencion de CPU/RAM es una propiedad de
  // ESTA maquina en ESTE momento, no una constante del algoritmo -- el
  // mismo motivo por el que MAX_SAFE_MODEL_SIZE_MB (ollama-catalog.js) se
  // calcula de la RAM real en vez de estar fijo. Se calcula cuantos modelos
  // de esta tanda caben a la vez en la RAM libre AHORA MISMO (mismo margen
  // de seguridad de 300MB que evictForModel), y se corren en paralelo real
  // por lotes de ese tamaño con Promise.all. Si la RAM solo da para 1 (como
  // en esta maquina bajo presion), el comportamiento es identico a la Capa
  // 3 -- nunca peor que antes. Si la maquina tiene RAM/CPU de sobra (el
  // hardware real al que apunta el producto, no este portatil de pruebas),
  // varios modelos corren a la vez de verdad y el tiempo total se acerca al
  // del modelo mas lento del lote, no a la suma de todos -- como un examen
  // donde casi todos los alumnos terminan a la vez, no uno detras de otro.
  var round1 = [];

  // Revertido a proposito (2026-08-06): el ensemble hibrido con Groq via el
  // Worker remoto se probo, se verifico en vivo (846ms-1.4s por voz, 3-4
  // voces reales en 8-32s) y luego se decidio explicitamente quitarlo --
  // LinkCore vuelve a ser 100% local. Si se retoma en el futuro, el bloque
  // que llamaba a `backendMod.callAIEnsemble` con `LINKCORE_PROXY_SECRET`
  // esta en el historial de git de este archivo.

  async function runOneModel(m) {
    // Presupuesto global (2026-08-14): si el reloj compartido de toda la
    // orquestacion ya se agoto (ver ORCHESTRATION_GLOBAL_BUDGET_MS en
    // orchestrator.js), no tiene sentido empezar OTRO intento de 15-60s --
    // se rinde con el mismo detalle honesto que ya usa circuit_open, no en
    // silencio.
    if (opts.deadlineTs && Date.now() > opts.deadlineTs) {
      return { model: m.id, family: m.family, text: null, ok: false, error: 'global_budget_exhausted' };
    }

    if (circuitIsOpen(m.id)) {
      return { model: m.id, family: m.family, text: null, ok: false, error: 'circuit_open' };
    }

    var preflight = chipPreFlight(query, m.id);
    // Una respuesta contaminada (fuga de contexto) guardada en cache ANTES
    // de este fix seguiria sirviendose para siempre si no se revalida aqui
    // tambien -- el cache no caduca por corregir el codigo, solo por TTL.
    if (preflight.cacheHit && !looksLikeContextLeak(preflight.cachedEntry.text)) {
      return { model: m.id, family: m.family, text: preflight.cachedEntry.text, ok: true, fromCache: true, latencyMs: 0 };
    }

    var caller = m.installed ? backendMod.callOllamaModel : backendMod.callHFModel;
    var modelId = m.installed ? m.id : (m.hfId || m.id);
    // Techo subido de 45s a 60s (2026-08-05, encontrado en vivo): llama3.2:3b
    // aislado responde en 36.6s, pero como SEGUNDO candidato de una ronda en
    // serie fallaba por timeout -- el primer candidato deja el modelo
    // anterior recien liberado y este necesita su propia carga en frio, con
    // menos margen del que sugiere adaptiveTimeout() en aislamiento. 60s le
    // da margen real sin importar si esta ronda corre en serie o en
    // paralelo real (el lote ya esta dimensionado para que quepa en RAM).
    var timeout = Math.min(Math.max(preflight.timeout || 10000, 15000), 60000);

    try {
      var result = await caller(modelId, query, {
        systemPrompt: systemPrompt,
        maxTokens: opts.maxTokens || 400,
        temperature: opts.temperature || 0.3,
        timeoutMs: timeout,
      });
      if (result && result.ok && !looksLikeContextLeak(result.text)) {
        circuitRecordSuccess(modelId);
        recordOutcome(query, modelId, category, { ok: true, latencyMs: result.latencyMs });
        cacheSet(query, modelId, result);
        return { model: modelId, family: m.family, text: result.text, ok: true, latencyMs: result.latencyMs, modelConfidence: result.modelConfidence };
      }
      circuitRecordFailure(modelId);
      recordOutcome(query, modelId, category, { ok: false });
      return { model: modelId, family: m.family, text: null, ok: false, error: (result && looksLikeContextLeak(result.text)) ? 'context_leak' : (result && result.error) || 'no_response' };
    } catch (e) {
      circuitRecordFailure(modelId);
      recordOutcome(query, modelId, category, { ok: false });
      return { model: modelId, family: m.family, text: null, ok: false, error: e.message };
    }
  }

  round1 = await runContinuousBatch(models, runOneModel);

  var validRound1 = round1.filter(function(r) { return r.ok && r.text; });
  if (validRound1.length === 0) {
    return { ok: false, error: 'all_models_failed', round1: round1, route: route, latencyMs: Date.now() - startedAt };
  }

  if (validRound1.length === 1) {
    return {
      ok: true,
      text: validRound1[0].text,
      model: validRound1[0].model,
      provider: 'ensemble-single',
      latencyMs: Date.now() - startedAt,
      ensemble: { size: 1, models: validRound1.map(function(r) { return r.model; }), scores: [] },
      route: route,
    };
  }

  // Escalado adaptativo: solo tiene sentido de "desempate" con exactamente
  // dos posturas en conflicto -- con 3+ ya hay mas de una opinion sobre la
  // mesa y el resto del pipeline (round2 + arbitraje) ya tiene con que
  // trabajar. opts.adaptiveEscalation === false lo desactiva explicitamente
  // (por si algun llamador necesita latencia acotada por encima de todo).
  var escalation = { triggered: false };
  if (opts.adaptiveEscalation !== false && validRound1.length === 2) {
    escalation = await tryEscalate(query, category, validRound1, systemPrompt, opts, backendMod);
  }

  // Bug real de rendimiento, medido en vivo (2026-08-11): un ensemble de 2
  // modelos hacia SIEMPRE 5 llamadas reales a modelos en serie -- ronda 1
  // (2), ronda 2 (2 mas, para que cada uno "reconsidere" viendo al otro) y
  // G-STACK (1 revisor mas) -- incluso cuando los dos modelos YA estaban
  // de acuerdo desde la ronda 1. Pedirle a un modelo que reconsidere una
  // respuesta con la que el otro ya coincide no cambia nada, solo cuesta
  // (medido: response identica en round2Communicate para el caso sano).
  // `escalation.disagree` viene del MISMO chequeo (detectRealDisagreement)
  // que ya decide si hace falta un tercer modelo de desempate -- se
  // reutiliza aqui para una segunda decision: si es `false` (se comprobo
  // Y no habia desacuerdo), la ronda 2 y G-STACK se saltan y se usa la
  // ronda 1 directamente. Si `escalation.disagree` es `undefined` (no se
  // llego a comprobar -- mas de 2 modelos, o adaptiveEscalation:false), se
  // mantiene el comportamiento de siempre por seguridad: no se salta nada
  // sin haber verificado que era seguro hacerlo.
  var skipReconciliation = escalation.disagree === false;

  var round2 = skipReconciliation
    ? validRound1.map(function (r) { return { model: r.model, family: r.family, text: r.text, revised: false }; })
    : await round2Communicate(query, validRound1, systemPrompt, aiCaller);

  // Estabilidad del consenso tras la ronda 2 (2026-08-17, hallazgo #8):
  // hoy nada mide si pedirle a los modelos que "reconsideren viendo a los
  // demas" ACERCO sus respuestas o las ALEJO -- la mediacion y G-STACK ya
  // corren siempre que hay ronda 2 (ver mas abajo), asi que no hace falta
  // una ronda 3 de generacion redundante; lo que faltaba de verdad era la
  // SEÑAL: si los modelos discreparon MAS tras verse entre si que en frio,
  // es una razon real para desconfiar mas de la sintesis, y hoy esa señal
  // se calculaba (escalation.disagree, de la ronda 1) pero nunca se
  // comparaba contra el estado tras la ronda 2. Solo se calcula cuando
  // round2 de verdad corrio (skipReconciliation ya cubre "no hacia falta").
  var round2Disagreement = null;
  var disagreementIncreased = false;
  if (!skipReconciliation && round2.length >= 2) {
    round2Disagreement = detectRealDisagreement(round2);
    // "Aumento" real: en frio no habia desacuerdo detectable (o no se
    // comprobo con exactamente 2 modelos) y tras verse SI lo hay -- revisar
    // considerandose una IA que cambio de postura y ahora choca con otra.
    disagreementIncreased = round2Disagreement.disagree && escalation.disagree !== true;
  }

  var synthesis = synthesizeResponses(query, round2);

  // NEURAL ARBITRAGE: Mathematical consensus analysis
  var arbitrageReport = null;
  try {
    var responsesForArbitrage = round2.map(function(r) {
      return { model: r.model, family: r.family, text: r.text, latencyMs: 0 };
    });
    arbitrageReport = arbitrateResponses(query, responsesForArbitrage, opts);
  } catch (e) {
    // Arbitrage is optional, don't fail ensemble
  }

  var mediated = null;
  if (opts.mediatedSynthesis !== false && round2.length >= 2) {
    mediated = await mediateCollaborativeAnswer(query, category, round2, synthesis, arbitrageReport, systemPrompt, opts, backendMod);
  }

  var baseText = mediated && mediated.text ? mediated.text : synthesis.text;
  baseText = pruneUnsupportedLines(baseText, round2);
  baseText = reinforceConsensusLines(baseText, round2);
  var baseModel = mediated && mediated.model ? mediated.model : (synthesis.model || round2[0].model);

  // G-STACK REVIEW: Post-synthesis quality check. Se salta en el mismo
  // caso que la ronda 2 (ver skipReconciliation arriba) -- si los modelos
  // ya coincidian de verdad, una revision extra de calidad es otra
  // llamada real a un modelo por un beneficio marginal en el caso sano.
  var gstackReviewResult = null;
  if (opts.gstackReview !== false && !skipReconciliation) {
    try {
      gstackReviewResult = await gstackReview(query, baseText, opts);
    } catch (e) {
      // G-STACK review is optional, don't fail ensemble -- pero antes esto
      // se tragaba la excepcion en total silencio (investigado 2026-08-17,
      // hallazgo real: gstackReview.qualityScore aparecia null en un
      // ensemble real sin NADA en service.log). extractQualityScore() en si
      // no puede devolver null -- siempre devuelve un numero, ver el
      // comentario en esa funcion mas abajo -- asi que el null observado
      // solo podia venir de aqui: gstackReview() lanzando (fallo real de
      // callAI dentro de runGStackRole/runGStackWorkflow, p.ej. timeout del
      // modelo revisor) y este catch tragandoselo sin dejar rastro. El
      // resto de catches "opcionales" de este mismo archivo y de
      // backend.js (orchestrator, crew, intermediation-core) SI logean con
      // console.error('[LinkCore] ...') -- este era la excepcion
      // inconsistente. Corregido para que loguee igual.
      console.error('[LinkCore] gstackReview:', e.message);
    }
  }

  var result = {
    ok: true,
    text: baseText,
    model: baseModel,
    provider: 'ensemble-v2',
    latencyMs: Date.now() - startedAt,
    ensemble: {
      size: validRound1.length,
      models: validRound1.map(function(r) { return r.model; }),
      escalation: escalation,
      disagreementIncreased: disagreementIncreased,
      round2Disagreement: round2Disagreement,
      // round1Text: lo que cada modelo respondio a ciegas, antes de ver a
      // los demas -- necesario para poder mostrarle al usuario "esto dijo
      // cada IA de forma independiente" (round2.text puede ser identico si
      // no reviso, o distinto si cambio de postura al ver a sus companeros).
      round2: round2.map(function(r, i) {
        return { model: r.model, revised: r.revised || false, text: r.text, round1Text: validRound1[i] ? validRound1[i].text : null };
      }),
      scores: synthesis.scores,
      mediation: mediated ? {
        used: true,
        model: mediated.model,
        latencyMs: mediated.latencyMs,
        provider: mediated.provider,
      } : { used: false },
    },
    route: route,
  };

  // Attach Neural Arbitrage report
  if (arbitrageReport) {
    result.neuralArbitrage = {
      consensusScore: arbitrageReport.consensus.score,
      confidence: arbitrageReport.consensus.confidence,
      contradictionCount: arbitrageReport.consensus.contradictionCount,
      bestModel: arbitrageReport.bestResponse ? arbitrageReport.bestResponse.model : null,
      rankings: arbitrageReport.rankings,
      signature: arbitrageReport.signature,
    };
    // Solo usar el texto recomendado por arbitraje si NO hubo una
    // mediacion final real ni una revision posterior que deba prevalecer.
    if (!gstackReviewResult && !(mediated && mediated.text) && arbitrageReport.recommendedText && arbitrageReport.consensus.score > 0.7) {
      result.text = arbitrageReport.recommendedText;
      result.model = arbitrageReport.bestResponse ? arbitrageReport.bestResponse.model : result.model;
    }
    if (arbitrageReport.consensus.score >= 0.7) {
      try { chipEventRecord('collaborationWin'); } catch (e) {}
    }
  }

  // Attach G-STACK review if available
  if (gstackReviewResult) {
    result.gstackReview = {
      role: gstackReviewResult.role,
      roleName: gstackReviewResult.roleName,
      qualityScore: gstackReviewResult.qualityScore,
      suggestions: gstackReviewResult.suggestions,
      model: gstackReviewResult.model,
      latencyMs: gstackReviewResult.latencyMs
    };
    // Si la revision sale alta, conservamos el mejor texto base disponible
    // (mediado si existe; si no, heuristico/arbitral). Si no, anadimos las
    // mejoras sugeridas sobre ese mismo texto base en vez de volver a un
    // borrador anterior menos rico.
    if (gstackReviewResult.qualityScore < 80 && gstackReviewResult.suggestions.length > 0) {
      result.text = result.text + '\n\n--- Mejoras sugeridas ---\n' +
        gstackReviewResult.suggestions.map(function(s, i) {
          return (i + 1) + '. ' + s;
        }).join('\n');
    }

    // Feed G-STACK review into learning loop
    try {
      recordGStackReview(gstackReviewResult, validRound1.map(function(r) { return r.model; }));
    } catch (e) {
      // Learning loop recording is optional
    }
  }

  return result;
}

// ── ROUND 2: Comunicación entre modelos ──
// Cada modelo ve las respuestas de los demás y revisa su propia respuesta.

async function round2Communicate(query, round1Results, basePrompt, aiCaller) {
  // Mismo fix que round 1 (2026-08-03): Promise.all aqui lanzaba hasta
  // `size` llamadas de revision en paralelo, la misma contencion de CPU
  // que dejaba el ensemble entero en all_models_failed. Igual que en
  // ensembleRun (ver el comentario grande de "Capa 4", 2026-08-16): la
  // contencion de CPU/RAM es una propiedad de la maquina en ese momento, no
  // una constante del algoritmo. Se calcula cuantas revisiones caben a la
  // vez en la RAM libre real (computeParallelBatchSize, a nivel de modulo)
  // y se corren en paralelo real por lotes con Promise.all. En una maquina
  // ajustada de RAM esto da 1 (serie, igual que antes); en una con margen
  // real, varias revisiones corren a la vez de verdad.
  var backendMod = await import('../backend.js');
  var ollamaMod = await import('./ollama-catalog.js');
  var sizeById = {};
  ollamaMod.OLLAMA_MODELS.forEach(function (m) { sizeById[m.id] = m.sizeMB; });

  async function reviseOne(original) {
    var otherResponses = round1Results.filter(function(r) { return r.model !== original.model; });
    if (otherResponses.length === 0) {
      return { model: original.model, family: original.family, text: original.text, revised: false };
    }

    var revisePrompt = 'Revisa tu respuesta considerando las perspectivas de otros modelos.\n\n' +
      'Tu respuesta original:\n' + truncate(original.text, 400) + '\n\n' +
      'Perspectivas de otros modelos:\n' +
      otherResponses.map(function(r) { return '- ' + r.model + ': ' + truncate(r.text, 200); }).join('\n') + '\n\n' +
      'Si alguna perspectiva es más precisa o completa, incorpórala. Si no, mantén tu respuesta.\n' +
      'Responde SOLO con tu respuesta revisada (sin explicar cambios).';

    try {
      // Bug real, encontrado en vivo (2026-08-05): esta llamada usaba
      // callAI() -- el cascada COMPLETO de smartQuery (re-escanea el
      // catalogo de intermediacion desde cero, ~4s, y si el resultado se
      // rechaza puede caer en cascada por HF/Worker/fallback de varios
      // modelos) en vez de simplemente pedirle al MISMO modelo que
      // reviese su propia respuesta. Ademas de ser mucho mas lento de lo
      // necesario (confirmado: un ensembleRun con esto colgado por mas de
      // 290s, mientras que los mismos 2 modelos en llamada directa
      // responden casi al instante), tambien es semanticamente incorrecto
      // -- callAI() puede elegir un modelo DISTINTO al que dio la
      // respuesta original, asi que "revisa tu respuesta" la contestaba
      // a veces una IA que nunca vio la respuesta original. El id con
      // "/" es la convencion ya usada en round1 para distinguir HF de
      // Ollama (modelId = m.installed ? m.id : (m.hfId || m.id)).
      var isHF = original.model.indexOf('/') !== -1;
      var caller = isHF ? backendMod.callHFModel : backendMod.callOllamaModel;
      // timeoutMs subido de 20000 a 35000 (2026-08-09): mismo patron que
      // otros timeouts de hoy -- 400 tokens a la velocidad real medida en
      // esta CPU (~10 tokens/seg) piden ~40s. Con 20s, la revision podia
      // fallar por timeout mas a menudo de lo necesario y degradar en
      // silencio a la respuesta de ronda 1 sin revisar -- degradacion
      // segura (no rompe nada), pero perdia la parte real de "ensemble
      // learning" (ver companeros y reconsiderar) mas de lo debido.
      var result = await caller(original.model, revisePrompt, { systemPrompt: basePrompt, maxTokens: 400, temperature: 0.2, timeoutMs: 35000 });
      var revisedText = result && result.text ? result.text.trim() : '';
      // Bug real, critico, confirmado en vivo (2026-08-03): algunos modelos
      // -- sobre todo los mas pequeños -- no revisan nada, devuelven el
      // PROMPT de revision en si mismo como si fuera la respuesta (ecoan la
      // instruccion en vez de seguirla). "Revisa tu respuesta
      // considerando las perspectivas de otros modelos..." volvia
      // literalmente como texto final al usuario, sustituyendo una
      // respuesta original BUENA por la instruccion repetida. El chequeo
      // anterior (`length > 20`) no lo detectaba: el prompt de revision
      // tiene mucho mas de 20 caracteres, asi que pasaba como "revision
      // valida". Se detecta comparando el inicio de la respuesta contra
      // el inicio del propio prompt enviado -- una revision real no puede
      // empezar identica a la instruccion que la pidio.
      var echoPrefix = revisePrompt.slice(0, 40).trim();
      var isEcho = revisedText && echoPrefix && revisedText.indexOf(echoPrefix) === 0;
      if (revisedText && revisedText.length > 20 && !isEcho) {
        return { model: original.model, family: original.family, text: revisedText, revised: true, modelConfidence: result && result.modelConfidence };
      }
      return { model: original.model, family: original.family, text: original.text, revised: false, revisionError: isEcho ? 'echo_detected' : null, modelConfidence: original.modelConfidence };
    } catch (e) {
      return { model: original.model, family: original.family, text: original.text, revised: false, modelConfidence: original.modelConfidence };
    }
  }

  // sizeMB no viene en el objeto de round1Results (solo model/family/text) --
  // se copia aqui para que runContinuousBatch pueda seguir dimensionando por
  // RAM real; reviseOne() ignora el campo extra, solo lee lo que ya leia.
  var round1WithSize = round1Results.map(function (r) {
    return Object.assign({}, r, { sizeMB: sizeById[r.model] });
  });
  var revised = await runContinuousBatch(round1WithSize, reviseOne);

  return revised;
}

// ── SINTESIS ──
// Elige la mejor respuesta de entre las revisadas.
// Si hay un mediador disponible, lo usa. Si no, usa heurísticas.

function synthesizeResponses(query, responses) {
  // Bug real, confirmado en vivo (2026-08-03): esta puntuacion premiaba
  // FORMATO (longitud, saltos de linea, bloques de codigo) por encima de
  // si la respuesta de verdad contestaba la pregunta. Reproducido: ante
  // "que es mas importante, retencion o adquisicion de clientes", gano
  // una respuesta generica de consejos de startup (con lista numerada,
  // +5 por saltos de linea) sobre una respuesta que SI contestaba
  // directamente la pregunta pero en un solo parrafo. Se sustituye por
  // dos señales reales: computeContentConfidence (calidad intrinseca del
  // texto -- longitud calibrada, estructura, penaliza rechazos/dudas, ya
  // probado en neural-decision-engine.js) y detectSemanticOverlap contra
  // la QUERY ORIGINAL (relevancia real -- si la respuesta ni siquiera
  // comparte vocabulario con la pregunta, probablemente no la contesta).
  // El bonus de "revisado" se reduce (15 -> 8): antes por si solo bastaba
  // para ganar cualquier comparacion, ahora desempata sin dominar.
  var scored = responses.map(function(r) {
    var quality = computeContentConfidence(r.text) * 54; // 0-54 puntos (heuristica de TEXTO)
    var relevance = detectSemanticOverlap(r.text, query) * 27; // 0-27 puntos
    // Confianza REAL del modelo (2026-08-17, hallazgo de investigacion #7):
    // media geometrica de sus logprobs por token, calculada en
    // callOllamaModel() -- a diferencia de quality/relevance de arriba, esto
    // no lee el texto resultante, lee cuanta certeza tuvo el modelo mientras
    // generaba. Se omite (no se rellena con un valor neutro) si no esta
    // disponible -- p.ej. una respuesta servida desde cache no la trae.
    var modelConf = typeof r.modelConfidence === 'number' ? r.modelConfidence * 19 : 0; // 0-19 puntos
    var score = quality + relevance + modelConf;
    if (r.revised) score += 8;
    if (r.family === 'qwen-coder' || r.family === 'starcoder') score += 5;
    return { model: r.model, text: r.text, score: score, family: r.family, modelConfidence: r.modelConfidence };
  });

  scored.sort(function(a, b) { return b.score - a.score; });

  return {
    text: scored[0].text,
    model: scored[0].model,
    // Antes solo se devolvia {model, score} -- se perdia lo que cada
    // modelo dijo de verdad. Sin el texto individual no hay forma de
    // explicarle al usuario "esto dijo cada IA", solo el nombre y una
    // puntuacion sin contexto.
    scores: scored.map(function(s) { return { model: s.model, score: s.score, text: s.text }; }),
  };
}

function truncate(text, maxLen) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

// ── G-STACK REVIEW: Revisión post-síntesis ──
// After ensemble generates a response, G-STACK roles review it for quality.
// The review feeds back into learning-loop for model routing improvement.

async function gstackReview(query, synthesisText, opts) {
  opts = opts || {};
  var workflowId = detectWorkflow(query);
  var roleId = detectRole(query);

  // If no specific workflow/role detected, use reviewer as default
  if (!workflowId && !roleId) {
    roleId = 'reviewer';
  }

  var reviewResult = null;

  if (workflowId) {
    // Full workflow detected (e.g., featurePlan, preRelease)
    reviewResult = await runGStackWorkflow(workflowId, query, {
      maxTokens: opts.maxTokens || 1500,
      temperature: 0.1,
      timeoutMs: opts.timeoutMs || 30000
    });
  } else if (roleId) {
    // Single role detected
    reviewResult = await runGStackRole(roleId, query, synthesisText, {
      maxTokens: opts.maxTokens || 1500,
      temperature: 0.1,
      timeoutMs: opts.timeoutMs || 30000
    });
  }

  if (!reviewResult) return null;

  // Extract quality signals from G-STACK review
  var qualityScore = extractQualityScore(reviewResult);
  var suggestions = extractSuggestions(reviewResult);

  return {
    role: roleId || workflowId,
    roleName: reviewResult.roleName || reviewResult.workflow || 'unknown',
    qualityScore: qualityScore,
    suggestions: suggestions,
    rawOutput: reviewResult.output || reviewResult.finalOutput || '',
    model: reviewResult.model,
    latencyMs: reviewResult.latencyMs
  };
}

// Extract a 0-100 quality score from G-STACK review output.
//
// Nota (investigado 2026-08-17): pese al nombre, esta funcion NUNCA parsea
// un numero real del texto del modelo -- no hay ningun regex buscando
// digitos, "80%", "8/10" ni "puntuacion: X". Es puramente un heuristico de
// palabras clave: busca el VEREDICTO textual que los prompts de
// GSTACK_ROLES piden explicitamente ("Veredicto: aprobar/reducir/
// expandir/descartar", ver gstack.js) y, si no encuentra ninguno,
// cuenta palabras positivas vs negativas con un default neutral de 70.
// Esto NO es un bug de formato de regex (tipo "espera 80% pero el modelo
// escribio 80 de 100") porque nunca se intento parsear un numero en
// absoluto -- es una decision de diseno deliberada, coherente con como
// se le pide el veredicto al modelo (cualitativo, no numerico). Por eso
// esta funcion, tal cual esta escrita, SIEMPRE devuelve un numero (85,
// 70, 60, 40, 20, o el heuristico 0-100) y nunca null/NaN -- el null
// real observado en vivo (gstackReview.qualityScore) no podia venir de
// aqui; vino del catch silencioso en ensembleRun() que llama a
// gstackReview(), corregido en el mismo commit (ver comentario ahi).
function extractQualityScore(reviewResult) {
  var text = (reviewResult.output || reviewResult.finalOutput || '').toLowerCase();

  // Look for explicit verdict/score patterns
  if (/aprob|done|approved|veredicto.*aprobar/.test(text)) return 85;
  if (/done.with.concerns|concerns|preocupaciones/.test(text)) return 70;
  if (/reducir|reduce|recortar/.test(text)) return 60;
  if (/blocked|bloqueado|critico/.test(text)) return 40;
  if (/descartar|descartado|rejected/.test(text)) return 20;

  // Heuristic: count positive vs negative signals
  var positives = (text.match(/bien|correcto|solido|buena|mejor|optimo|eficiente/g) || []).length;
  var negatives = (text.match(/fallo|error|bug|problema|riesgo|deuda|falta|missing|critico/g) || []).length;
  var total = positives + negatives;

  if (total === 0) return 70; // Neutral default
  return Math.round((positives / total) * 100);
}

// Extract actionable suggestions from G-STACK review
function extractSuggestions(reviewResult) {
  var text = reviewResult.output || reviewResult.finalOutput || '';
  var suggestions = [];

  // Look for numbered lists or bullet points that contain recommendations
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (/^\d+[\.\)]\s/.test(line) || /^[-•*]\s/.test(line)) {
      var cleaned = line.replace(/^[\d\.\)\-•*]\s*/, '').trim();
      if (cleaned.length > 10 && cleaned.length < 300) {
        suggestions.push(cleaned);
      }
    }
  }

  return suggestions.slice(0, 5); // Max 5 suggestions
}
