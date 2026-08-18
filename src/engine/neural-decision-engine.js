// ═══════════════════════════════════════════════════════════════
// NEURAL DECISION ENGINE
// El cerebro de LinkCore. No路由 — DECIDE.
// 
// Inspirado en:
// - SciOrch: MCTS-based orchestration
// - Scale AI Dialect: Enterprise Decision Record
// - Orchestra: Close the Loop (Plan→Sandbox→Execute→Learn)
// - Qualixar: Three-layer meta-learning routing
// ═══════════════════════════════════════════════════════════════

import { OLLAMA_MODELS } from './ollama-catalog.js';
import { metricsRecord, metricsGetModelStats, circuitIsOpen, circuitRecordSuccess, circuitRecordFailure } from './chip-core.js';
import { routeQuery } from './smart-router.js';
import { computeContentConfidence } from './translation.js';
import { localStorage } from '../memory-bus.js';

// Bug real: mctsTree, edrLog, strategyMemory y learningStore (declarados
// mas abajo) vivian SOLO en memoria del proceso -- se borraban en cada
// reinicio, contradiciendo la propia promesa de ARCHITECTURE.md ("EDR:
// 1.000 decisiones CON TRAZABILIDAD COMPLETA"). chip-core.js (cache,
// circuit breaker, metricas) y learning-loop.js (sesgo aprendido por
// modelo) ya persisten a disco via localStorage -- este motor era el
// unico de los tres sistemas de aprendizaje del chip que no lo hacia.
// Se restaura al cargar el modulo y se guarda tras cada mutacion real.
var NEURAL_STORAGE_KEY = 'lc_neural_state';

function _saveNeuralState() {
  try {
    localStorage.setItem(NEURAL_STORAGE_KEY, JSON.stringify({
      mctsTree: mctsTree,
      edrLog: edrLog,
      strategyMemory: strategyMemory,
      learningStore: learningStore,
    }));
  } catch (e) {}
}

function _loadNeuralState() {
  try {
    var raw = localStorage.getItem(NEURAL_STORAGE_KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.mctsTree) mctsTree = parsed.mctsTree;
    if (parsed.edrLog) edrLog = parsed.edrLog;
    if (parsed.strategyMemory) strategyMemory = parsed.strategyMemory;
    if (parsed.learningStore) learningStore = parsed.learningStore;
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// ENTERPRISE DECISION RECORD (EDR)
// Cada decisión queda registrada con trazabilidad completa
// ═══════════════════════════════════════════════════════════════

var edrLog = [];
var MAX_EDR = 1000;

function recordDecision(decision) {
  var entry = {
    id: 'edr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    query: decision.query,
    modelsSelected: decision.modelsSelected || [],
    reasoning: decision.reasoning || '',
    outcome: decision.outcome || 'pending',
    qualityScore: decision.qualityScore || 0,
    latencyMs: decision.latencyMs || 0,
    cost: decision.cost || 0,
    consensusScore: decision.consensusScore || 0,
    contradictions: decision.contradictions || [],
    learningSignal: decision.learningSignal || null,
  };
  edrLog.push(entry);
  if (edrLog.length > MAX_EDR) edrLog.shift();
  _saveNeuralState();
  return entry;
}

function getEDR(limit) {
  return edrLog.slice(-(limit || 50));
}

// ═══════════════════════════════════════════════════════════════
// MCTS-BASED MODEL SELECTION
// Monte Carlo Tree Search para seleccionar modelos
// ═══════════════════════════════════════════════════════════════

var mctsTree = {};

// Lectura pura, sin crear nodo (a diferencia de getMCTSNode): para usar
// como desempate en la seleccion de candidatos de ensemble-v2.js sin
// contaminar el arbol con entradas de visitas=0 por cada modelo que se
// consulta pero nunca se usa de verdad.
//
// Ponderacion de latencia real (2026-08-09): antes esto era solo
// node.avgReward (confianza de contenido de la respuesta). Un modelo que
// responde bien pero tarda el doble no perdia nada en el ranking, pese a
// que en esta maquina (sin GPU, round1 de ensemble-v2.js en serie) el
// tiempo es el recurso mas escaso de los dos. metricsGetModelStats() ya
// se importaba en este archivo y no se usaba en ningun sitio -- son los
// mismos datos reales que muestra `linkcore chip` (avgLatencyMs medido,
// no estimado). 60000ms como techo de normalizacion porque es el mismo
// techo de timeout que usa ensemble-v2.js para un modelo solo en serie
// -- un modelo que tarda eso es, en la practica, el peor caso aceptable.
// Si no hay metricas de latencia todavia (modelo nunca ejecutado fuera
// del ensemble), se cae al avgReward puro -- mismo comportamiento que
// antes, no un cambio de semantica para el caso sin datos.
export function getMCTSScore(modelId, category) {
  var key = modelId + '::' + category;
  var node = mctsTree[key];
  if (!node || node.visits === 0) return null;
  var stats = metricsGetModelStats();
  var modelStats = stats[modelId];
  if (!modelStats || !modelStats.avgLatencyMs) return node.avgReward;
  var latencyScore = Math.max(0, Math.min(1, 1 - modelStats.avgLatencyMs / 60000));
  return node.avgReward * 0.7 + latencyScore * 0.3;
}

function getMCTSNode(modelId, category) {
  var key = modelId + '::' + category;
  if (!mctsTree[key]) {
    mctsTree[key] = {
      model: modelId,
      category: category,
      visits: 0,
      wins: 0,
      totalReward: 0,
      avgReward: 0,
      explorationBonus: 0,
    };
  }
  return mctsTree[key];
}

function mctsSelect(category, candidates) {
  var C = 1.414; // Exploration constant (sqrt(2))
  var totalVisits = 0;
  
  for (var i = 0; i < candidates.length; i++) {
    var node = getMCTSNode(candidates[i].id, category);
    totalVisits += node.visits;
  }
  
  var best = null;
  var bestScore = -Infinity;
  
  for (var j = 0; j < candidates.length; j++) {
    var node = getMCTSNode(candidates[j].id, category);
    var exploit = node.visits > 0 ? node.avgReward : 0.5;
    var explore = node.visits > 0 ? C * Math.sqrt(Math.log(totalVisits + 1) / (node.visits + 1)) : C;
    var score = exploit + explore;
    
    if (score > bestScore) {
      bestScore = score;
      best = candidates[j];
    }
  }
  
  return best;
}

function mctsUpdate(modelId, category, reward) {
  var node = getMCTSNode(modelId, category);
  node.visits++;
  node.wins += reward;
  node.totalReward += reward;
  node.avgReward = node.totalReward / node.visits;
  _saveNeuralState();
}

// ═══════════════════════════════════════════════════════════════
// THREE-LAYER META-LEARNING ROUTING
// Layer 1: Strategy Selection (epsilon-greedy)
// Layer 2: Model Selection (MCTS + scoring)
// Layer 3: Bayesian POMDP (belief-state updates)
// ═══════════════════════════════════════════════════════════════

var strategyMemory = {};

function selectStrategy(category, query) {
  var strategies = ['fastest', 'cheapest', 'best_quality', 'ensemble', 'cascade'];
  
  if (!strategyMemory[category]) {
    strategyMemory[category] = {};
    for (var i = 0; i < strategies.length; i++) {
      strategyMemory[category][strategies[i]] = { attempts: 0, successes: 0, avgLatency: 0 };
    }
  }
  
  var catMemory = strategyMemory[category];
  var epsilon = 0.2;
  
  if (Math.random() < epsilon) {
    return strategies[Math.floor(Math.random() * strategies.length)];
  }
  
  var bestStrategy = 'fastest';
  var bestScore = -1;
  
  var stratKeys = Object.keys(catMemory);
  for (var j = 0; j < stratKeys.length; j++) {
    var s = catMemory[stratKeys[j]];
    if (s.attempts < 3) return stratKeys[j];
    var successRate = s.successes / s.attempts;
    var latencyScore = Math.max(0, 1 - s.avgLatency / 60000);
    var score = successRate * 0.7 + latencyScore * 0.3;
    if (score > bestScore) {
      bestScore = score;
      bestStrategy = stratKeys[j];
    }
  }
  
  return bestStrategy;
}

function updateStrategy(category, strategy, success, latencyMs) {
  if (!strategyMemory[category]) return;
  var s = strategyMemory[category][strategy];
  if (!s) return;
  s.attempts++;
  if (success) s.successes++;
  s.avgLatency = (s.avgLatency * (s.attempts - 1) + latencyMs) / s.attempts;
}

// ═══════════════════════════════════════════════════════════════
// NEURAL CONSENSUS
// Finds mathematical agreement between models
// ═══════════════════════════════════════════════════════════════

function computeNeuralConsensus(responses) {
  if (responses.length < 2) {
    return { consensusScore: 100, contradictions: [], confidence: 'single_model' };
  }
  
  var scores = [];
  var contradictions = [];
  
  for (var i = 0; i < responses.length; i++) {
    for (var j = i + 1; j < responses.length; j++) {
      var similarity = computeTextSimilarity(responses[i].text, responses[j].text);
      scores.push({
        pair: responses[i].model + ' ↔ ' + responses[j].model,
        similarity: similarity,
      });
      if (similarity < 0.3) {
        contradictions.push({
          models: [responses[i].model, responses[j].model],
          similarity: similarity,
        });
      }
    }
  }
  
  var avgSimilarity = scores.length > 0 
    ? scores.reduce(function(a, b) { return a + b.similarity; }, 0) / scores.length 
    : 0;
  
  return {
    consensusScore: Math.round(avgSimilarity * 100),
    contradictions: contradictions,
    confidence: avgSimilarity > 0.7 ? 'high' : avgSimilarity > 0.4 ? 'medium' : 'low',
    pairwiseScores: scores,
  };
}

function computeTextSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  var words1 = text1.toLowerCase().split(/\s+/);
  var words2 = text2.toLowerCase().split(/\s+/);
  var set1 = {};
  var set2 = {};
  for (var i = 0; i < words1.length; i++) set1[words1[i]] = true;
  for (var j = 0; j < words2.length; j++) set2[words2[j]] = true;
  var intersection = 0;
  var union = 0;
  var allWords = {};
  var k;
  for (k in set1) allWords[k] = true;
  for (k in set2) allWords[k] = true;
  for (k in allWords) {
    union++;
    if (set1[k] && set2[k]) intersection++;
  }
  return union > 0 ? intersection / union : 0;
}

// ═══════════════════════════════════════════════════════════════
// CLOSE THE LOOP: Plan → Sandbox → Execute → Learn
// ═══════════════════════════════════════════════════════════════

var learningStore = {};

// Las cuatro variables de estado (edrLog, mctsTree, strategyMemory,
// learningStore) ya estan declaradas -- se restaura aqui, no antes.
_loadNeuralState();

function planExecution(query, category, opts) {
  var strategy = (opts && opts.strategy && opts.strategy !== 'auto') ? opts.strategy : selectStrategy(category, query);
  var modelCount = (opts && opts.modelCount) || (strategy === 'ensemble' ? 3 : strategy === 'cascade' ? 5 : 1);
  var isMultiModel = strategy === 'ensemble' || strategy === 'cascade';
  // El paso de abajo filtra a "instalado y <1GB" -- con el catalogo actual eso
  // deja solo un puñado de candidatos elegibles de los ~50 del catalogo, y el
  // scoring de routeQuery favorece tiers medium/large (instalados o no) por
  // encima de small/tiny instalados. Con un buffer pequeño (modelCount+5) el
  // filtro se quedaba sin suficientes candidatos y modelCount=5 devolvia solo
  // 3 modelos sin avisar. Pedimos un pool generoso para que el filtro tenga
  // margen real de donde elegir.
  var route = routeQuery(query, category, { maxModels: isMultiModel ? Math.max(modelCount * 4, 20) : modelCount + 5 });

  var models = route.ok ? route.selected : [];

  if (isMultiModel) {
    models = models.filter(function(m) { return m.installed && (m.sizeMB || 0) < 1000; });
    models = models.slice(0, modelCount);
  }
  
  var plan = {
    query: query,
    category: category,
    strategy: strategy,
    models: models,
    estimatedLatency: strategy === 'turbo' ? 5000 : strategy === 'ensemble' ? 30000 : 15000,
    estimatedCost: 0,
    maxRetries: strategy === 'cascade' ? 5 : 1,
  };
  
  return plan;
}

function sandboxExecution(plan) {
  return {
    valid: plan.models.length > 0,
    riskLevel: plan.strategy === 'cascade' ? 'low' : plan.strategy === 'ensemble' ? 'medium' : 'low',
    warnings: [],
  };
}

function learnFromOutcome(plan, outcome) {
  var key = plan.category + '::' + plan.strategy;
  if (!learningStore[key]) {
    learningStore[key] = { outcomes: [], avgQuality: 0, avgLatency: 0 };
  }
  
  var store = learningStore[key];
  store.outcomes.push({
    timestamp: Date.now(),
    quality: outcome.qualityScore || 0,
    latency: outcome.latencyMs || 0,
    success: outcome.ok || false,
    consensusScore: outcome.consensusScore || 0,
  });
  
  if (store.outcomes.length > 100) store.outcomes.shift();
  
  var totalQuality = 0;
  var totalLatency = 0;
  for (var i = 0; i < store.outcomes.length; i++) {
    totalQuality += store.outcomes[i].quality;
    totalLatency += store.outcomes[i].latency;
  }
  store.avgQuality = totalQuality / store.outcomes.length;
  store.avgLatency = totalLatency / store.outcomes.length;

  updateStrategy(plan.category, plan.strategy, outcome.ok, outcome.latencyMs);
  _saveNeuralState();
}

// ═══════════════════════════════════════════════════════════════
// MAIN: NEURAL DECIDE
// The brain that orchestrates everything
// ═══════════════════════════════════════════════════════════════

export async function neuralDecide(query, opts) {
  var startedAt = Date.now();
  var category = categorizeQuery(query);
  
  // STEP 1: PLAN
  var plan = planExecution(query, category, opts);
  
  // STEP 2: SANDBOX
  var sandbox = sandboxExecution(plan);
  if (!sandbox.valid) {
    return { ok: false, error: 'no_valid_plan', plan: plan };
  }
  
  // STEP 3: EXECUTE
  var backendMod = await import('../backend.js');
  var results = [];
  var modelsUsed = [];
  
  if (plan.strategy === 'ensemble') {
    // Execute multiple models in parallel
    var promises = plan.models.map(function(m) {
      var caller = m.installed ? backendMod.callOllamaModel : backendMod.callHFModel;
      var modelId = m.installed ? m.id : (m.hfId || m.id);
      return caller(modelId, query, {
        maxTokens: (opts && opts.maxTokens) || 400,
        temperature: 0.3,
        timeoutMs: 10000,
      }).then(function(result) {
        if (result && result.ok) {
          modelsUsed.push(modelId);
          circuitRecordSuccess(modelId);
          return { model: modelId, text: result.text, ok: true, latencyMs: result.latencyMs };
        }
        circuitRecordFailure(modelId);
        return { model: modelId, text: null, ok: false };
      }).catch(function(e) {
        circuitRecordFailure(modelId);
        return { model: modelId, text: null, ok: false, error: e.message };
      });
    });
    
    results = await Promise.all(promises);
  } else if (plan.strategy === 'cascade') {
    // Execute models in sequence until one works
    for (var i = 0; i < plan.models.length; i++) {
      var m = plan.models[i];
      var caller = m.installed ? backendMod.callOllamaModel : backendMod.callHFModel;
      var modelId = m.installed ? m.id : (m.hfId || m.id);
      
      try {
        var result = await caller(modelId, query, {
          maxTokens: (opts && opts.maxTokens) || 400,
          temperature: 0.3,
          timeoutMs: 10000,
        });
        
        if (result && result.ok) {
          modelsUsed.push(modelId);
          circuitRecordSuccess(modelId);
          results.push({ model: modelId, text: result.text, ok: true, latencyMs: result.latencyMs });
          break;
        }
      } catch (e) {
        circuitRecordFailure(modelId);
      }
    }
  } else {
    // Single model (fastest/cheapest/best_quality)
    var m = plan.models[0];
    if (m) {
      var caller = m.installed ? backendMod.callOllamaModel : backendMod.callHFModel;
      var modelId = m.installed ? m.id : (m.hfId || m.id);
      
      try {
        var result = await caller(modelId, query, {
          maxTokens: (opts && opts.maxTokens) || 400,
          temperature: 0.3,
          timeoutMs: 10000,
        });
        
        if (result && result.ok) {
          modelsUsed.push(modelId);
          circuitRecordSuccess(modelId);
          results.push({ model: modelId, text: result.text, ok: true, latencyMs: result.latencyMs });
        }
      } catch (e) {
        circuitRecordFailure(modelId);
      }
    }
  }
  
  var validResults = results.filter(function(r) { return r.ok && r.text; });
  if (validResults.length === 0) {
    return { ok: false, error: 'all_models_failed', plan: plan, results: results };
  }
  
  // STEP 4: LEARN
  var latencyMs = Date.now() - startedAt;
  
  var bestResult = validResults[0];
  var consensus = null;
  
  if (validResults.length > 1) {
    consensus = computeNeuralConsensus(validResults);
    // Pick the result from the model with highest MCTS score
    for (var j = 0; j < validResults.length; j++) {
      var node = getMCTSNode(validResults[j].model, category);
      if (node.avgReward > 0.5) {
        bestResult = validResults[j];
        break;
      }
    }
  }

  // Bug real, critico: mctsUpdate() (la funcion que hace que el arbol
  // aprenda) nunca se llamaba desde ningun sitio -- ni aqui, ni en ningun
  // otro archivo. Cada nodo MCTS se quedaba en visits:0/avgReward:0 para
  // siempre, asi que el chequeo de arriba ("node.avgReward > 0.5") nunca
  // era cierto y el pipeline de "elegir el mejor resultado por MCTS" caia
  // siempre al primer resultado por defecto -- el pilar de aprendizaje que
  // ARCHITECTURE.md anuncia ("MCTS Selector: aprende que modelos
  // funcionan") era enteramente decorativo. Se conecta aqui, con una senal
  // de recompensa por modelo (no solo para el "mejor"): computeContentConfidence()
  // en vez de bestResult.text.length/5 -- ese proxy premiaba respuestas
  // LARGAS sin relacion con si eran correctas, un incentivo perverso justo
  // para lo que se quiere evitar (alucinaciones verbosas). computeContentConfidence
  // ya penaliza rechazos/dudas y premia estructura real (translation.js).
  for (var vi = 0; vi < validResults.length; vi++) {
    var vr = validResults[vi];
    var vrReward = vr.text ? computeContentConfidence(vr.text) : 0.1;
    mctsUpdate(vr.model, category, vrReward);
  }

  var qualityScore = bestResult.text ? Math.round(computeContentConfidence(bestResult.text) * 100) : 0;

  learnFromOutcome(plan, {
    ok: true,
    qualityScore: qualityScore,
    latencyMs: latencyMs,
    consensusScore: consensus ? consensus.consensusScore : 100,
  });
  
  // Record decision in EDR
  var decision = recordDecision({
    query: query,
    modelsSelected: modelsUsed,
    reasoning: plan.strategy + ' with ' + modelsUsed.length + ' models',
    outcome: 'success',
    qualityScore: qualityScore,
    latencyMs: latencyMs,
    consensusScore: consensus ? consensus.consensusScore : 100,
    contradictions: consensus ? consensus.contradictions : [],
    learningSignal: { category: category, strategy: plan.strategy },
  });
  
  return {
    ok: true,
    text: bestResult.text,
    model: bestResult.model,
    provider: 'neural-decision-engine',
    latencyMs: latencyMs,
    neural: {
      strategy: plan.strategy,
      category: category,
      modelsExecuted: modelsUsed,
      modelsSucceeded: validResults.length,
      consensus: consensus,
      qualityScore: qualityScore,
      decisionId: decision.id,
      mctsScores: modelsUsed.map(function(m) {
        var node = getMCTSNode(m, category);
        return { model: m, visits: node.visits, avgReward: node.avgReward };
      }),
    },
    ensemble: validResults.length > 1 ? {
      size: validResults.length,
      models: modelsUsed,
      scores: validResults.map(function(r) { return { model: r.model, score: Math.round(qualityScore) }; }),
    } : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// QUERY CATEGORIZATION
// ═══════════════════════════════════════════════════════════════

function categorizeQuery(query) {
  var q = query.toLowerCase();
  if (q.match(/código|code|program|función|class|bug|error|debug/)) return 'code';
  if (q.match(/escribe|redacta|resume|traduce|email|documento/)) return 'writing';
  if (q.match(/analiza|compara|evalúa|reason|piensa|explica/)) return 'reasoning';
  if (q.match(/busca|search|investiga|encuentra|noticias/)) return 'research';
  if (q.match(/crea|genera|diseña|build|make|imagen/)) return 'creative';
  if (q.match(/datos|data|gráfico|chart|números|calcula/)) return 'data';
  return 'general';
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export function getNeuralStats() {
  return {
    mctsTreeSize: Object.keys(mctsTree).length,
    edrLogSize: edrLog.length,
    strategyMemorySize: Object.keys(strategyMemory).length,
    learningStoreSize: Object.keys(learningStore).length,
    topModels: Object.keys(mctsTree)
      .map(function(k) { return mctsTree[k]; })
      .sort(function(a, b) { return b.avgReward - a.avgReward; })
      .slice(0, 5)
      .map(function(n) { return { model: n.model, category: n.category, avgReward: n.avgReward, visits: n.visits }; }),
  };
}

export function getEDRLog(limit) {
  return getEDR(limit);
}

// Bug real, encontrado en vivo (2026-08-07): recordDecision()/mctsUpdate()
// solo se llamaban desde dentro de neuralDecide(), y neuralDecide() solo se
// invoca como respaldo de ultimo recurso si smartQuery() lanza una
// excepcion (ver index.js) -- algo que casi nunca pasa, porque smartQuery()
// tiene su propia cascada de fallback interna. Resultado: el EDR (la
// "Learning Layer" real del diagrama de arquitectura) tenia una sola
// entrada de dias atras pese a decenas de consultas reales exitosas -- la
// capa de aprendizaje existia pero nunca se ejercitaba en el camino real.
// Se exportan aqui para que backend.js pueda registrar cada consulta real
// que SI tiene exito, no solo el caso de fallo total.
export { recordDecision, mctsUpdate };

export function getStrategyPerformance() {
  return strategyMemory;
}

export function getLearningInsights() {
  var insights = [];
  var keys = Object.keys(learningStore);
  for (var i = 0; i < keys.length; i++) {
    var store = learningStore[keys[i]];
    insights.push({
      strategy: keys[i],
      avgQuality: Math.round(store.avgQuality),
      avgLatency: Math.round(store.avgLatency),
      totalOutcomes: store.outcomes.length,
    });
  }
  return insights;
}
