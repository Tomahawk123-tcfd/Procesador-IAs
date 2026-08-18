// ═══════════════════════════════════════════════════════════════
// LINKCORE CONSENSUS & MEDIATION LAYER
// Detects contradictions between AI agents, resolves conflicts
// with principled protocols. The judge for agent disputes.
// ═══════════════════════════════════════════════════════════════

import { read as memRead, write as memWrite, query as memQuery, detectConflicts as memDetectConflicts } from './memory.js';
import { extractIntent, extractEntities, detectActions } from './translation.js';
import { detectSemanticOverlap } from './semantic-translator.js';

// ═══════════════════════════════════════════
// CONTRADICTION TAXONOMY
// ═══════════════════════════════════════════

var CONTRADICTION_TYPES = {
  FACTUAL: 'factual',
  STATE: 'state',
  POLICY: 'policy',
  TEMPORAL: 'temporal',
  CAUSAL: 'causal',
  SEMANTIC_INTENT: 'semantic_intent',
  RESOURCE_CONTENTION: 'resource_contention',
};

// ═══════════════════════════════════════════
// CLASIFICACION DE NATURALEZA DEL CONFLICTO (2026-08-17, hallazgo #9)
// CONTRADICTION_TYPES de arriba clasifica por MECANISMO DE DETECCION (que
// detector lo encontro): factual, state, temporal... Este es un eje
// DISTINTO y complementario -- clasifica por que hacer con el conflicto
// una vez detectado, sin el cual el sintetizador/mediador trata todo
// desacuerdo igual (elegir un ganador). Tres clases:
//   contradictory              -- solo una postura puede ser cierta sobre
//                                  el MISMO hecho (senal de exclusion
//                                  mutua real: positivo vs negativo,
//                                  cifras que no pueden ser ambas ciertas)
//   causally_invalid_combination -- cada afirmacion es individualmente
//                                  razonable, el problema es la
//                                  COMBINACION (dos agentes modifican el
//                                  mismo recurso, o el estado compartido
//                                  cambio entre una lectura y otra) -- no
//                                  se trata de que uno mienta
//   contentious                -- ambas posturas pueden ser defendibles
//                                  (recomendaciones/interpretaciones
//                                  distintas, no hechos opuestos) -- forzar
//                                  un ganador aqui pierde informacion real
// ═══════════════════════════════════════════

var CONFLICT_CLASSES = {
  CONTRADICTORY: 'contradictory',
  CAUSALLY_INVALID_COMBINATION: 'causally_invalid_combination',
  CONTENTIOUS: 'contentious',
};

function classifyConflictNature(contradiction) {
  // FACTUAL con señal de exclusion mutua real (positivo/negativo sobre el
  // mismo predicado, o dos cifras incompatibles sobre el mismo hecho) --
  // no pueden ser ambas ciertas.
  if (contradiction.type === CONTRADICTION_TYPES.FACTUAL) {
    return CONFLICT_CLASSES.CONTRADICTORY;
  }
  // SEMANTIC_INTENT confirmacion-vs-rechazo tambien es exclusion mutua real
  // (no se puede confirmar Y rechazar la misma accion a la vez).
  if (contradiction.type === CONTRADICTION_TYPES.SEMANTIC_INTENT) {
    return CONFLICT_CLASSES.CONTRADICTORY;
  }
  // STATE/RESOURCE_CONTENTION: cada agente puede tener razon por separado
  // (vio un estado valido en su propio momento, o actuo sobre un recurso
  // sin saber que otro tambien lo hacia) -- el problema es que las dos
  // acciones/lecturas coexisten mal, no que una sea falsa.
  if (contradiction.type === CONTRADICTION_TYPES.STATE || contradiction.type === CONTRADICTION_TYPES.RESOURCE_CONTENTION) {
    return CONFLICT_CLASSES.CAUSALLY_INVALID_COMBINATION;
  }
  // TEMPORAL/POLICY/CAUSAL y cualquier otro: sin señal de exclusion mutua
  // explicita, tratar como desacuerdo legitimo entre posturas defendibles
  // en vez de asumir que una es un error.
  return CONFLICT_CLASSES.CONTENTIOUS;
}

// ═══════════════════════════════════════════
// DETECTION: Factual Contradictions
// ═══════════════════════════════════════════

var FACTUAL_SIGNALS = [
  { positive: /es\s+(correcto|verdadero|cierto|exacto|preciso)/i, negative: /no\s+es\s+(correcto|verdadero|cierto|exacto|preciso)/i },
  { positive: /siempre\s+(ocurre|funciona|aplica|hace)/i, negative: /nunca\s+(ocurre|funciona|aplica|hace)/i },
  { positive: /aumenta|crece|sube|mejora|incrementa/i, negative: /disminuye|baja|cae|empeora|reduce/i },
  { positive: /rentable|profitable|beneficioso|positivo/i, negative: /no\s+rentable|no\s+profitable|perjudicial|negativo/i },
  { positive: /seguro|safe|risk-free/i, negative: /peligroso|risky|no\s+seguro|arriesgado/i },
  { positive: /eficiente|optimal|mejor/i, negative: /ineficiente|suboptimal|peor/i },
  { positive: /disponible|available|en\s+stock|listo/i, negative: /no\s+disponible|agotado|out\s+of\s+stock|no\s+listo/i },
  { positive: /aprobado|approved|autorizado|validado/i, negative: /rechazado|denied|no\s+autorizado|rechazado/i },
];

function detectFactualContradictions(agentOutputs) {
  var contradictions = [];
  for (var i = 0; i < agentOutputs.length; i++) {
    for (var j = i + 1; j < agentOutputs.length; j++) {
      var a = agentOutputs[i];
      var b = agentOutputs[j];
      if (!a.content || !b.content) continue;

      var textA = a.content.toLowerCase();
      var textB = b.content.toLowerCase();

      for (var k = 0; k < FACTUAL_SIGNALS.length; k++) {
        var sig = FACTUAL_SIGNALS[k];
        var aHasPositive = sig.positive.test(textA);
        var aHasNegative = sig.negative.test(textA);
        var bHasPositive = sig.positive.test(textB);
        var bHasNegative = sig.negative.test(textB);

        if ((aHasPositive && bHasNegative) || (aHasNegative && bHasPositive)) {
          contradictions.push({
            type: CONTRADICTION_TYPES.FACTUAL,
            agent1: a.agent,
            agent2: b.agent,
            claim1: extractRelevantSentence(a.content, sig),
            claim2: extractRelevantSentence(b.content, sig),
            signal: aHasPositive ? 'positive_vs_negative' : 'negative_vs_positive',
            confidence: 0.75,
            severity: 'high',
          });
          break;
        }
      }

      var numA = uniqueNumbers(extractNumbers(textA));
      var numB = uniqueNumbers(extractNumbers(textB));
      // Bug real (consensus.js, ya mencionado dos veces en crew.js y
      // middleware.js como "falso positivo del detector de numeros
      // sueltos" pero nunca arreglado en origen). Habia dos capas de
      // sobre-generacion aqui:
      // 1) El gate previo exigia una "entidad compartida" (findSharedEntities,
      //    ahora eliminado) pero extractEntities() en translation.js SOLO
      //    detecta email/url/telefono/fecha/dinero/%/numero -- nunca temas
      //    reales como "cliente" o "CAC" -- y encima exigia coincidir en
      //    VALOR EXACTO. Efecto perverso doble: dejaba pasar pares de
      //    numeros sin relacion alguna (dos textos sobre "mercado" casi
      //    siempre comparten algun numero suelto en algun sitio) Y bloqueaba
      //    contradicciones reales sobre el mismo hecho (250 vs 900 nunca
      //    "comparten entidad" por valor exacto, aunque ambos sean el CAC).
      // 2) Sin ese gate, se comparaba CUALQUIER numero de A contra
      //    CUALQUIER numero de B.
      // Arreglo: comparar el CONTEXTO LOCAL alrededor de cada numero (no el
      // texto entero, no un gate de entidad por valor exacto) -- solo si el
      // contexto se parece de verdad es razonable pensar que los dos
      // numeros hablan de la misma cifra.
      if (numA.length && numB.length) {
        var seenPairs = {};
        for (var n1 = 0; n1 < numA.length; n1++) {
          for (var n2 = 0; n2 < numB.length; n2++) {
            if (numA[n1].value === numB[n2].value) continue;
            if (Math.abs(numA[n1].value - numB[n2].value) <= numA[n1].value * 0.1) continue;
            var contextOverlap = detectSemanticOverlap(numA[n1].context, numB[n2].context);
            if (contextOverlap < 0.25) continue;
            var pairKey = numA[n1].formatted + '|' + numB[n2].formatted;
            if (seenPairs[pairKey]) continue;
            seenPairs[pairKey] = true;
            contradictions.push({
              type: CONTRADICTION_TYPES.FACTUAL,
              agent1: a.agent,
              agent2: b.agent,
              claim1: numA[n1].context.trim(),
              claim2: numB[n2].context.trim(),
              signal: 'numeric_discrepancy',
              confidence: Math.min(0.65, 0.4 + contextOverlap * 0.5),
              severity: 'medium',
            });
          }
        }
      }
    }
  }
  return contradictions;
}

// ═══════════════════════════════════════════
// DETECTION: State Contradictions
// ═══════════════════════════════════════════

function detectStateContradictions(agentOutputs, sharedMemory) {
  var contradictions = [];
  if (!sharedMemory) return contradictions;

  agentOutputs.forEach(function(output) {
    var actions = detectActions(output.content);
    actions.forEach(function(action) {
      if (action.action === 'delete' || action.action === 'update_record') {
        var entities = extractEntities(output.content);
        entities.forEach(function(entity) {
          var memState = memRead('state_' + entity.value);
          if (memState && memState.value) {
            var intent = extractIntent(output.content);
            if (intent.intent === 'confirmation' || intent.intent === 'action') {
              contradictions.push({
                type: CONTRADICTION_TYPES.STATE,
                agent: output.agent,
                action: action.action,
                entity: entity.value,
                currentState: memState.value,
                proposedAction: output.content.slice(0, 200),
                confidence: 0.6,
                severity: 'high',
              });
            }
          }
        });
      }
    });
  });
  return contradictions;
}

// ═══════════════════════════════════════════
// DETECTION: Temporal Contradictions
// ═══════════════════════════════════════════

function detectTemporalContradictions(agentOutputs) {
  var contradictions = [];
  var timeActions = [];

  agentOutputs.forEach(function(output) {
    var text = (output.content || '').toLowerCase();
    var timeRefs = text.match(/(antes|despues|durante|mientras|hasta|desde|el\s+\d|mañana|hoy|ayer|próximo|next|before|after|during)/gi);
    if (timeRefs && timeRefs.length > 1) {
      timeActions.push({ agent: output.agent, content: output.content, timeRefs: timeRefs });
    }
  });

  for (var i = 0; i < timeActions.length; i++) {
    for (var j = i + 1; j < timeActions.length; j++) {
      var a = timeActions[i];
      var b = timeActions[j];
      var aHasBefore = /(antes|before|primero|first)/i.test(a.content);
      var bHasAfter = /(despues|after|luego|then|ultimo|last)/i.test(b.content);
      if (aHasBefore && bHasAfter) {
        contradictions.push({
          type: CONTRADICTION_TYPES.TEMPORAL,
          agent1: a.agent,
          agent2: b.agent,
          claim1: a.content.slice(0, 150),
          claim2: b.content.slice(0, 150),
          signal: 'temporal_order_conflict',
          confidence: 0.5,
          severity: 'medium',
        });
      }
    }
  }
  return contradictions;
}

// ═══════════════════════════════════════════
// DETECTION: Resource Contention
// ═══════════════════════════════════════════

function detectResourceContention(agentOutputs) {
  var contradictions = [];
  var resourceActions = {};

  agentOutputs.forEach(function(output) {
    var actions = detectActions(output.content);
    var entities = extractEntities(output.content);
    actions.forEach(function(action) {
      entities.forEach(function(entity) {
        var key = action.action + ':' + entity.value;
        if (!resourceActions[key]) resourceActions[key] = [];
        resourceActions[key].push({ agent: output.agent, action: action, entity: entity, content: output.content });
      });
    });
  });

  Object.keys(resourceActions).forEach(function(key) {
    var actions = resourceActions[key];
    if (actions.length < 2) return;
    var agents = {};
    actions.forEach(function(a) { agents[a.agent] = true; });
    if (Object.keys(agents).length > 1) {
      contradictions.push({
        type: CONTRADICTION_TYPES.RESOURCE_CONTENTION,
        resource: key,
        agents: Object.keys(agents),
        actions: actions.map(function(a) { return { agent: a.agent, action: a.action.action, entity: a.entity.value }; }),
        confidence: 0.7,
        severity: 'high',
      });
    }
  });
  return contradictions;
}

// ═══════════════════════════════════════════
// DETECTION: Semantic Intent Divergence
// ═══════════════════════════════════════════

function detectIntentDivergence(agentOutputs) {
  var contradictions = [];
  var intents = agentOutputs.map(function(o) {
    return { agent: o.agent, intent: extractIntent(o.content), content: o.content };
  });

  for (var i = 0; i < intents.length; i++) {
    for (var j = i + 1; j < intents.length; j++) {
      var a = intents[i];
      var b = intents[j];
      if (a.intent.intent === 'confirmation' && b.intent.intent === 'rejection') {
        contradictions.push({
          type: CONTRADICTION_TYPES.SEMANTIC_INTENT,
          agent1: a.agent,
          agent2: b.agent,
          intent1: a.intent,
          intent2: b.intent,
          claim1: a.content.slice(0, 150),
          claim2: b.content.slice(0, 150),
          confidence: 0.85,
          severity: 'critical',
        });
      }
      if (a.intent.intent === 'action' && b.intent.intent === 'rejection') {
        contradictions.push({
          type: CONTRADICTION_TYPES.SEMANTIC_INTENT,
          agent1: a.agent,
          agent2: b.agent,
          intent1: a.intent,
          intent2: b.intent,
          claim1: a.content.slice(0, 150),
          claim2: b.content.slice(0, 150),
          confidence: 0.7,
          severity: 'high',
        });
      }
    }
  }
  return contradictions;
}

// ═══════════════════════════════════════════
// DETECTION: Output Overlap (Semantic Dedup)
// ═══════════════════════════════════════════

function detectOutputOverlap(agentOutputs) {
  var contradictions = [];
  var valid = agentOutputs.filter(function(o) { return o && o.content && o.content.length > 50; });

  for (var i = 0; i < valid.length; i++) {
    for (var j = i + 1; j < valid.length; j++) {
      var overlap = detectSemanticOverlap(valid[i].content, valid[j].content);
      if (overlap > 0.6) {
        contradictions.push({
          type: 'output_overlap',
          agent1: valid[i].agent,
          agent2: valid[j].agent,
          overlap: overlap,
          claim1: valid[i].content.slice(0, 200),
          claim2: valid[j].content.slice(0, 200),
          signal: 'semantic_duplication',
          confidence: overlap,
          severity: overlap > 0.8 ? 'high' : 'medium',
        });
      }
    }
  }
  return contradictions;
}

// ═══════════════════════════════════════════
// MASTER DETECTION
// ═══════════════════════════════════════════

function detectAllContradictions(agentOutputs, sharedMemory) {
  var all = [];
  all = all.concat(detectFactualContradictions(agentOutputs));
  all = all.concat(detectStateContradictions(agentOutputs, sharedMemory));
  all = all.concat(detectTemporalContradictions(agentOutputs));
  all = all.concat(detectResourceContention(agentOutputs));
  all = all.concat(detectIntentDivergence(agentOutputs));
  all = all.concat(detectOutputOverlap(agentOutputs));

  all.forEach(function(c) { c.conflictClass = classifyConflictNature(c); });

  all.sort(function(a, b) {
    var severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
  });

  return all;
}

// ═══════════════════════════════════════════
// RESOLUTION: Three-Tier Hierarchy
// ═══════════════════════════════════════════

var RESOLUTION_POLICIES = {};

function registerPolicy(contradictionType, handler) {
  RESOLUTION_POLICIES[contradictionType] = handler;
}

function resolveContradiction(contradiction, context) {
  context = context || {};

  if (RESOLUTION_POLICIES[contradiction.type]) {
    var policyResult = RESOLUTION_POLICIES[contradiction.type](contradiction, context);
    if (policyResult) return policyResult;
  }

  if (context.policies && context.policies.length) {
    for (var i = 0; i < context.policies.length; i++) {
      var policy = context.policies[i];
      if (policy.matches && policy.matches(contradiction)) {
        return {
          resolution: 'policy',
          decision: policy.decision,
          reason: policy.reason || 'Policy-based resolution',
          confidence: 0.9,
          policyName: policy.name,
        };
      }
    }
  }

  // No forzar un ganador por autoridad cuando el conflicto es CONTENTIOUS
  // (2026-08-17, hallazgo #9): ambas posturas pueden ser defendibles -- la
  // autoridad de quien la dijo no la hace mas VERDADERA, solo mas
  // prioritaria por politica. Descartar un agente por autoridad aqui borra
  // una perspectiva legitima en vez de presentarla. Para CONTRADICTORY/
  // CAUSALLY_INVALID_COMBINATION si tiene sentido: ahi la autoridad es un
  // desempate razonable sobre cual version del HECHO/estado es la real.
  if (context.agentAuthorities && contradiction.conflictClass !== CONFLICT_CLASSES.CONTENTIOUS) {
    var auth1 = context.agentAuthorities[contradiction.agent1] || 0;
    var auth2 = context.agentAuthorities[contradiction.agent2] || 0;
    if (auth1 !== auth2) {
      var winner = auth1 > auth2 ? contradiction.agent1 : contradiction.agent2;
      return {
        resolution: 'authority',
        decision: winner,
        reason: 'Agent ' + winner + ' has higher authority (' + Math.max(auth1, auth2) + ' vs ' + Math.min(auth1, auth2) + ')',
        confidence: 0.8,
        winner: winner,
      };
    }
  }

  if (contradiction.conflictClass === CONFLICT_CLASSES.CONTENTIOUS) {
    return {
      resolution: 'present_both',
      decision: null,
      reason: 'Desacuerdo legitimo entre posturas defendibles -- no se elige un ganador, se presentan ambas.',
      confidence: 0,
      contradiction: contradiction,
    };
  }

  return {
    resolution: 'escalation',
    decision: 'human_review',
    reason: 'Cannot auto-resolve. Requires human judgment.',
    confidence: 0,
    contradiction: contradiction,
  };
}

// ═══════════════════════════════════════════
// MEDIATOR AGENT
// ═══════════════════════════════════════════

function buildMediatorPrompt(contradictions, context) {
  var prompt = 'Eres el Mediador de LinkCore. Detectaste las siguientes contradicciones entre agentes IA especializados:\n\n';

  var CLASS_LABEL = {
    contradictory: 'CONTRADICTORIO -- solo una postura puede ser cierta sobre este hecho',
    causally_invalid_combination: 'COMBINACION INVALIDA -- cada afirmacion es razonable por separado, el problema es que coexisten mal',
    contentious: 'CONTENCIOSO -- ambas posturas pueden ser defendibles, no es un error de una de las dos',
  };

  contradictions.forEach(function(c, i) {
    prompt += 'Contradiccion ' + (i + 1) + ' (' + c.type + ', severidad: ' + c.severity + ', naturaleza: ' + (CLASS_LABEL[c.conflictClass] || c.conflictClass) + '):\n';
    prompt += '- Agente ' + (c.agent1 || c.agent) + ': ' + (c.claim1 || c.proposedAction || 'N/A') + '\n';
    if (c.agent2) {
      prompt += '- Agente ' + c.agent2 + ': ' + (c.claim2 || 'N/A') + '\n';
    }
    prompt += '- Confianza: ' + Math.round(c.confidence * 100) + '%\n\n';
  });

  if (context.sharedMemory) {
    prompt += 'Contexto de memoria compartida:\n' + context.sharedMemory.slice(0, 1000) + '\n\n';
  }

  // Instrucciones distintas segun la naturaleza (2026-08-17, hallazgo #9):
  // antes se le pedia SIEMPRE "indica cual postura es mas solida", incluso
  // para desacuerdos donde ninguna postura es objetivamente mas correcta --
  // eso empuja al mediador a fabricar un ganador donde no lo hay.
  prompt += 'Tu tarea:\n';
  prompt += '1. Analiza cada contradiccion con evidencia y razonamiento\n';
  prompt += '2. Para las marcadas CONTRADICTORIO o COMBINACION INVALIDA: si puedes resolverla, indica cual postura es mas solida y por que\n';
  prompt += '3. Para las marcadas CONTENCIOSO: NO elijas un ganador -- presenta ambas posturas con sus argumentos, son perspectivas validas, no un error a corregir\n';
  prompt += '4. Proporciona una recomendacion final con nivel de confianza (para CONTENCIOSO, la recomendacion es como presentar ambas, no cual descartar)\n';
  prompt += '5. Responde en espanol, profesional, sin emojis\n';

  return prompt;
}

function parseMediatorResponse(response) {
  if (!response) return { resolved: false, reason: 'No response from mediator' };
  var text = typeof response === 'string' ? response : response.content || response.text || '';
  var resolved = /resuelto|resolved|la postura[^.:;!?\n]{0,40}es[^.:;!?\n]{0,40}correcta|la mejor opcion/i.test(text);
  var confidence = 0.5;
  var confMatch = text.match(/confianza[:\s]*(\d+)%/i);
  if (confMatch) confidence = parseInt(confMatch[1]) / 100;

  return {
    resolved: resolved,
    content: text,
    confidence: confidence,
    hasBothPostures: /ambas posturas|por un lado[^.:;!?\n]{0,40}por otro|argumentos a favor[^.:;!?\n]{0,40}argumentos en contra/i.test(text),
  };
}

// ═══════════════════════════════════════════
// DRIFT MONITOR
// ═══════════════════════════════════════════

var _driftHistory = [];

function recordDriftSnapshot(agentOutputs) {
  var snapshot = {
    timestamp: Date.now(),
    agents: agentOutputs.map(function(o) {
      return {
        agent: o.agent,
        intent: extractIntent(o.content),
        entities: extractEntities(o.content),
      };
    }),
  };
  _driftHistory.push(snapshot);
  if (_driftHistory.length > 100) _driftHistory = _driftHistory.slice(-100);
  return snapshot;
}

function detectDrift(windowMs) {
  windowMs = windowMs || 300000;
  var cutoff = Date.now() - windowMs;
  var recent = _driftHistory.filter(function(s) { return s.timestamp > cutoff; });
  if (recent.length < 2) return { drifted: false, reason: 'insufficient_data' };

  var first = recent[0];
  var last = recent[recent.length - 1];
  var intentChanges = 0;
  var agentIntents = {};

  first.agents.forEach(function(a) {
    agentIntents[a.agent] = a.intent.intent;
  });

  last.agents.forEach(function(a) {
    if (agentIntents[a.agent] && agentIntents[a.agent] !== a.intent.intent) {
      intentChanges++;
    }
  });

  var driftRate = intentChanges / Math.max(Object.keys(agentIntents).length, 1);

  return {
    drifted: driftRate > 0.3,
    driftRate: driftRate,
    intentChanges: intentChanges,
    totalAgents: Object.keys(agentIntents).length,
    timeWindowMs: windowMs,
    severity: driftRate > 0.5 ? 'high' : driftRate > 0.3 ? 'medium' : 'low',
  };
}

// ═══════════════════════════════════════════
// AUDIT TRAIL
// ═══════════════════════════════════════════

var _consensusAudit = [];

function logConsensusEvent(event) {
  _consensusAudit.push({
    type: event.type,
    timestamp: Date.now(),
    agents: event.agents || [],
    contradictionCount: event.contradictionCount || 0,
    resolution: event.resolution || null,
    details: event.details || null,
  });
  if (_consensusAudit.length > 2000) _consensusAudit = _consensusAudit.slice(-1500);
}

function getAuditTrail(opts) {
  opts = opts || {};
  var trail = _consensusAudit;
  if (opts.type) trail = trail.filter(function(e) { return e.type === opts.type; });
  if (opts.since) trail = trail.filter(function(e) { return e.timestamp > opts.since; });
  if (opts.limit) trail = trail.slice(-opts.limit);
  return trail;
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function extractRelevantSentence(text, signal) {
  var sentences = text.split(/[.!?\n]+/);
  for (var i = 0; i < sentences.length; i++) {
    if (signal.positive.test(sentences[i]) || signal.negative.test(sentences[i])) {
      return sentences[i].trim().slice(0, 200);
    }
  }
  return text.slice(0, 200);
}

function extractNumbers(text) {
  var numbers = [];
  var regex = /[\d,]+\.?\d*/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    var val = parseFloat(match[0].replace(/,/g, ''));
    if (!isNaN(val) && val > 0) {
      var start = Math.max(0, match.index - 40);
      var end = Math.min(text.length, match.index + match[0].length + 40);
      numbers.push({ value: val, formatted: match[0], context: text.slice(start, end) });
    }
  }
  return numbers;
}

function uniqueNumbers(numbers) {
  var seen = {};
  var out = [];
  numbers.forEach(function (n) {
    if (seen[n.formatted]) return;
    seen[n.formatted] = true;
    out.push(n);
  });
  return out;
}

function clearAuditTrail() { _consensusAudit = []; }
function clearDriftHistory() { _driftHistory = []; }

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  CONTRADICTION_TYPES,
  CONFLICT_CLASSES,
  classifyConflictNature,
  detectFactualContradictions,
  detectStateContradictions,
  detectTemporalContradictions,
  detectResourceContention,
  detectIntentDivergence,
  detectOutputOverlap,
  detectAllContradictions,
  resolveContradiction,
  registerPolicy,
  buildMediatorPrompt,
  parseMediatorResponse,
  recordDriftSnapshot,
  detectDrift,
  logConsensusEvent,
  getAuditTrail,
  clearAuditTrail,
  clearDriftHistory,
};
