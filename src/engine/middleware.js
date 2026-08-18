// ═══════════════════════════════════════════════════════════════
// LINKCORE MIDDLEWARE — Coordination Engine
// Ties Translation + Memory + Consensus into one unified pipeline
// This is the Event Spine for AI agents
// ═══════════════════════════════════════════════════════════════

import {
  write as memWrite,
  read as memRead,
  readAll as memReadAll,
  acquireLock as memLock,
  releaseLock as memUnlock,
  detectConflicts as memDetectConflicts,
  detectSemanticConflicts as memDetectSemanticConflicts,
  formatForPrompt as memFormat,
  getStats as memStats,
  query as memQuery,
  clear as memClear,
} from './memory.js';

import {
  detectFormat,
  normalizeToStandard,
  extractIntent,
  extractEntities,
  detectActions,
  registerAgent,
  getAgent,
  listAgents,
  updateAgentStatus,
  translateForAgent,
  formatForPrompt as translationFormat,
  calibrateConfidence,
  getCalibratedConfidence,
} from './translation.js';

import {
  detectAllContradictions,
  resolveContradiction,
  buildMediatorPrompt,
  parseMediatorResponse,
  recordDriftSnapshot,
  detectDrift,
  logConsensusEvent,
  getAuditTrail,
} from './consensus.js';

// ═══════════════════════════════════════════
// EVENT BUS
// ═══════════════════════════════════════════

var _listeners = {};
var _eventLog = [];
var _sequenceNumber = 0;

function on(eventType, callback) {
  if (!_listeners[eventType]) _listeners[eventType] = [];
  _listeners[eventType].push(callback);
}

function off(eventType, callback) {
  if (!_listeners[eventType]) return;
  _listeners[eventType] = _listeners[eventType].filter(function(cb) { return cb !== callback; });
}

function emit(eventType, data) {
  _sequenceNumber++;
  var event = {
    id: _sequenceNumber,
    type: eventType,
    data: data,
    timestamp: Date.now(),
  };
  _eventLog.push(event);
  if (_eventLog.length > 1000) _eventLog = _eventLog.slice(-700);

  var handlers = _listeners[eventType] || [];
  handlers.forEach(function(cb) {
    try { cb(event); } catch(e) {}
  });

  var wildcardHandlers = _listeners['*'] || [];
  wildcardHandlers.forEach(function(cb) {
    try { cb(event); } catch(e) {}
  });
}

function getEventLog(opts) {
  opts = opts || {};
  var log = _eventLog;
  if (opts.type) log = log.filter(function(e) { return e.type === opts.type; });
  if (opts.since) log = log.filter(function(e) { return e.timestamp > opts.since; });
  if (opts.limit) log = log.slice(-opts.limit);
  return log;
}

// ═══════════════════════════════════════════
// AGENT REGISTRATION
// ═══════════════════════════════════════════

function registerIA(id, config) {
  var result = registerAgent(id, config);
  if (result.ok) {
    memWrite('agent_' + id, {
      id: id,
      type: config.type,
      name: config.name,
      capabilities: config.capabilities,
      registeredAt: Date.now(),
    }, 'system');
    emit('agent:registered', { agentId: id, config: config });
  }
  return result;
}

function getIA(id) {
  return getAgent(id);
}

function listIAs() {
  return listAgents();
}

function updateIAStatus(id, status) {
  var result = updateAgentStatus(id, status);
  if (result.ok) {
    memWrite('agent_status_' + id, { status: status, updatedAt: Date.now() }, 'system');
    emit('agent:status', { agentId: id, status: status });
  }
  return result;
}

// ═══════════════════════════════════════════
// PROCESS INPUT (from any IA)
// ═══════════════════════════════════════════

function processInput(rawInput, agentId, context) {
  context = context || {};

  var normalized = normalizeToStandard(rawInput, agentId);
  var format = detectFormat(rawInput);
  var intent = extractIntent(normalized.content);
  var entities = extractEntities(normalized.content);
  var actions = detectActions(normalized.content);

  normalized.intent = intent;
  normalized.entities = entities;
  normalized.actions = actions;

  // Bug real (2026-07-31): esta entrada de telemetria se escribia SIN
  // ninguna rama -- memory.js.write() usa `branch` solo como etiqueta,
  // no como espacio de almacenamiento (ver la nota en crew.js sobre el
  // mismo fallo), asi que la clave sin '::' quedaba marcada como "hecho
  // durable" para memoryFormat() de crew.js y se inyectaba ENTERA en
  // el contexto de CUALQUIER ejecucion futura, para siempre -- decenas
  // de acumulaciones de sesiones de prueba anteriores acababan
  // dominando el prompt de una consulta nueva sin relacion alguna.
  // Con `context.branch` (la rama de ESTA ejecucion, pasada desde
  // crew.js/orchestrator.js) la clave lleva '::' y memoryFormat() la
  // trata como ruido de trabajo de la rama, no como hecho durable.
  memWrite((context.branch ? context.branch + '::' : '') + 'input_' + agentId + '_' + Date.now(), {
    agentId: agentId,
    content: normalized.content.slice(0, 500),
    intent: intent,
    entities: entities,
    actions: actions,
    format: format,
  }, agentId);

  emit('input:processed', {
    agentId: agentId,
    intent: intent,
    entityCount: entities.length,
    actionCount: actions.length,
    format: format,
    confidence: normalized.confidence,
  });

  return normalized;
}

// Bug real, latente pero real, encontrado en vivo (2026-08-10) auditando
// coordinate() tras el fix de parsePlanSteps en crew.js: cada memWrite()
// de esta funcion (mas abajo, 'output_'/'mediation_'/'unified_') aisla la
// ejecucion metiendo el branch como PREFIJO de la clave ('<branch>::...'
// -- mismo patron que crew.js, con el mismo razonamiento: el `opts.branch`
// nativo de memory.js es solo una etiqueta sobre un slot global, no un
// espacio de almacenamiento separado, ver la nota larga en crew.js). Pero
// la LECTURA para el snapshot que alimenta deteccion de contradicciones y
// el prompt del mediador llamaba a memFormat() (formatForPrompt() de
// memory.js) SIN argumentos -- que filtra por `entry.branch`, un campo que
// ninguna escritura de este archivo rellena nunca (write() por defecto lo
// deja en 'main'). Resultado: el filtro nunca podia coincidir con nada,
// asi que memFormat() devolvia SIEMPRE el volcado global sin acotar,
// exactamente el mismo bug de "memoria no aislada por ejecucion" ya
// corregido hoy en crew.js (memoryReadAll sin branch, memoryFormat como
// contexto por defecto). Impacto real actual: bajo -- RESOLUTION_POLICIES
// en consensus.js esta vacio ({}) y ningun llamador real de coordinate()
// (crew.js, orchestrator.js) pasa mediatorAI, asi que buildMediatorPrompt()
// -el unico consumidor que usa el CONTENIDO del snapshot, no solo su
// longitud- es hoy codigo muerto. Se arregla igual, para no dejar la
// trampa lista para el dia que alguien active el mediador.
function scopedMemorySnapshot(branch) {
  var entries = memReadAll();
  var prefix = branch ? branch + '::' : null;
  var lines = ['Memoria compartida entre agentes IA:'];
  var count = 0;
  Object.keys(entries).forEach(function(k) {
    var isThisRun = prefix && k.indexOf(prefix) === 0;
    var isDurable = k.indexOf('::') === -1;
    if (!isThisRun && !isDurable) return;
    var e = entries[k];
    var shortKey = isThisRun ? k.slice(prefix.length) : k;
    var val = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
    lines.push('- [' + e.agentId + '] ' + shortKey + ' (v' + e.version + '): ' + val.slice(0, 200));
    count++;
  });
  return count ? lines.join('\n') : '';
}

// ═══════════════════════════════════════════
// COORDINATE (the main pipeline)
// ═══════════════════════════════════════════

async function coordinate(agentOutputs, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  var onProgress = opts.onProgress || null;
  var mediatorAI = opts.mediatorAI || null;
  var branch = opts.branch || null;

  function emitProgress(evt) {
    emit('coordinate:' + evt.type, evt);
    if (onProgress) try { onProgress(evt); } catch(e) {}
  }

  emitProgress({ type: 'start', message: 'Iniciando coordinacion entre agentes...', agentCount: agentOutputs.length });

  var normalizedOutputs = agentOutputs.map(function(o) {
    return processInput(o.content || o.text || o, o.agent || o.agentId || 'unknown', { branch: branch });
  });

  emitProgress({ type: 'translation_done', message: 'Traduccion completada. ' + normalizedOutputs.length + ' agentes procesados.', outputs: normalizedOutputs.length });

  normalizedOutputs.forEach(function(o) {
    memWrite((branch ? branch + '::' : '') + 'output_' + o.agent + '_' + Date.now(), {
      agent: o.agent,
      content: o.content.slice(0, 500),
      intent: o.intent,
      confidence: o.confidence,
    }, o.agent);
  });

  var memorySnapshot = scopedMemorySnapshot(branch);
  emitProgress({ type: 'memory_sync', message: 'Memoria compartida sincronizada.', memorySize: memorySnapshot.length });

  emitProgress({ type: 'consensus_start', message: 'Detectando contradicciones entre agentes...' });

  var contradictions = detectAllContradictions(normalizedOutputs, memorySnapshot);

  memDetectConflicts(300000).forEach(function(c) {
    contradictions.push({
      type: 'resource_contention',
      agents: c.agents,
      signal: 'concurrent_write',
      confidence: 0.6,
      severity: 'medium',
    });
  });

  var semanticConflicts = memDetectSemanticConflicts(
    memQuery({ keyPattern: /^output_/, limit: 50 })
  );
  contradictions = contradictions.concat(semanticConflicts);

  recordDriftSnapshot(normalizedOutputs);
  var drift = detectDrift(300000);

  emitProgress({
    type: 'consensus_done',
    message: contradictions.length ? contradictions.length + ' contradicciones detectadas.' : 'Sin contradicciones detectadas.',
    contradictionCount: contradictions.length,
    drift: drift,
  });

  var resolutions = [];
  var mediation = null;

  if (contradictions.length > 0) {
    emitProgress({ type: 'mediation_start', message: 'Resolviendo contradicciones...' });

    for (var i = 0; i < contradictions.length; i++) {
      var c = contradictions[i];
      var resolution = resolveContradiction(c, {
        agentAuthorities: opts.agentAuthorities || {},
        policies: opts.policies || [],
        sharedMemory: memorySnapshot,
      });
      resolutions.push({ contradiction: c, resolution: resolution });

      logConsensusEvent({
        type: 'resolution',
        agents: [c.agent1 || c.agent, c.agent2].filter(Boolean),
        contradictionCount: 1,
        resolution: resolution.resolution,
        details: resolution.reason,
      });
    }

    var unresolved = resolutions.filter(function(r) { return r.resolution.resolution === 'escalation'; });

    if (unresolved.length > 0 && mediatorAI) {
      emitProgress({ type: 'mediator_invoke', message: 'Invocando agente mediador para ' + unresolved.length + ' contradicciones...' });

      var mediatorPrompt = buildMediatorPrompt(
        unresolved.map(function(r) { return r.contradiction; }),
        { sharedMemory: memorySnapshot }
      );

      try {
        var mediatorResponse = await mediatorAI(mediatorPrompt);
        mediation = parseMediatorResponse(mediatorResponse);

        memWrite((branch ? branch + '::' : '') + 'mediation_' + Date.now(), {
          prompt: mediatorPrompt.slice(0, 500),
          response: mediation.content ? mediation.content.slice(0, 500) : null,
          resolved: mediation.resolved,
          confidence: mediation.confidence,
        }, 'mediator');

        logConsensusEvent({
          type: 'mediation',
          agents: unresolved.map(function(r) { return r.contradiction.agent1; }).filter(Boolean),
          contradictionCount: unresolved.length,
          resolution: mediation.resolved ? 'mediated' : 'unresolved',
          details: mediation.content ? mediation.content.slice(0, 200) : null,
        });
      } catch(e) {
        emitProgress({ type: 'mediator_error', message: 'Error en mediador: ' + e.message });
      }
    }
  }

  var unified = synthesize(normalizedOutputs, resolutions, mediation);

  memWrite((branch ? branch + '::' : '') + 'unified_' + Date.now(), {
    agentCount: normalizedOutputs.length,
    contradictionCount: contradictions.length,
    resolutionCount: resolutions.length,
    unifiedLength: unified.content.length,
    confidence: unified.confidence,
  }, 'synthesizer');

  var totalMs = Date.now() - startedAt;

  emitProgress({
    type: 'done',
    message: 'Coordinacion completada. ' + contradictions.length + ' contradicciones, ' + resolutions.length + ' resueltas. ' + totalMs + 'ms.',
    contradictions: contradictions.length,
    resolutions: resolutions.length,
    unifiedConfidence: unified.confidence,
    totalMs: totalMs,
    drift: drift,
  });

  logConsensusEvent({
    type: 'coordinate',
    agents: normalizedOutputs.map(function(o) { return o.agent; }),
    contradictionCount: contradictions.length,
    resolution: contradictions.length ? (mediation && mediation.resolved ? 'mediated' : 'partial') : 'clean',
  });

  return {
    unified: unified,
    contradictions: contradictions,
    resolutions: resolutions,
    mediation: mediation,
    drift: drift,
    memorySnapshot: memorySnapshot,
    totalMs: totalMs,
  };
}

// ═══════════════════════════════════════════
// SYNTHESIZE
// ═══════════════════════════════════════════

function synthesize(normalizedOutputs, resolutions, mediation) {
  var validOutputs = normalizedOutputs.filter(function(o) { return o.content && o.content.length > 0; });
  if (!validOutputs.length) return { content: 'No se obtuvieron respuestas de los agentes.', confidence: 0 };

  var avgConfidence = validOutputs.reduce(function(s, o) { return s + getCalibratedConfidence(o.agent, o.confidence); }, 0) / validOutputs.length;

  var lines = [];
  var hasMediation = mediation && mediation.resolved;
  var unresolvedCount = resolutions.filter(function(r) { return r.resolution.resolution === 'escalation'; }).length;

  // Bug real (2026-07-30), mismo defecto que unifyResponses() en crew.js:
  // cuando habia mediacion, esta funcion DESCARTABA el contenido real de
  // TODOS los agentes y mostraba solo el texto del mediador -- si el
  // detector de contradicciones marcaba un falso positivo (regex sobre
  // numeros sueltos, ver consensus.js), la respuesta util que ya existia
  // se perdia por completo. El mejor output real va SIEMPRE primero; la
  // mediacion se añade como nota aparte, nunca sustituye el trabajo hecho.
  var sorted = validOutputs.slice().sort(function(a, b) {
    return getCalibratedConfidence(b.agent, b.confidence) - getCalibratedConfidence(a.agent, a.confidence);
  });
  lines.push(sorted[0].content);

  if (sorted.length > 1) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Agentes consultados:**');
    sorted.forEach(function(o) {
      var calConf = getCalibratedConfidence(o.agent, o.confidence);
      lines.push('- `' + o.agent + '` — confianza: ' + Math.round(calConf * 100) + '%');
    });
  }

  if (hasMediation) {
    lines.push('');
    lines.push('**Nota de conciliacion** (se detecto una posible discrepancia entre agentes):');
    lines.push(mediation.content);
  }

  if (resolutions.length > 0) {
    var resolvedCount = resolutions.filter(function(r) { return r.resolution.resolution !== 'escalation'; }).length;
    lines.push('');
    lines.push('**Deteccion de conflictos:** ' + resolvedCount + '/' + resolutions.length + ' resueltos automáticamente');
    if (unresolvedCount > 0) {
      lines.push('**Atencion:** ' + unresolvedCount + ' requieren revisión humana');
    }
  }

  lines.push('');
  lines.push('**Confianza promedio:** ' + Math.round(avgConfidence * 100) + '%');

  return {
    content: lines.join('\n'),
    confidence: avgConfidence,
    agentCount: validOutputs.length,
    primaryAgent: validOutputs[0].agent,
  };
}

// ═══════════════════════════════════════════
// CONVENIENCE: Quick coordinate for orchestrator
// ═══════════════════════════════════════════

function quickCoordinate(results, opts) {
  var agentOutputs = Object.keys(results).map(function(key) {
    var r = results[key];
    return {
      agent: r.agent || key,
      content: r.text || r.content || r,
    };
  });
  return coordinate(agentOutputs, opts);
}

// ═══════════════════════════════════════════
// SYSTEM STATUS
// ═══════════════════════════════════════════

function getStatus() {
  var memStatsResult = memStats();
  var recentEvents = getEventLog({ limit: 10 });
  var recentAudit = getAuditTrail({ limit: 10 });
  return {
    agents: listIAs(),
    memory: memStatsResult,
    recentEvents: recentEvents,
    recentAudit: recentAudit,
    eventLogSize: _eventLog.length,
    sequenceNumber: _sequenceNumber,
  };
}

function reset() {
  memClear();
  _listeners = {};
  _eventLog = [];
  _sequenceNumber = 0;
  return { ok: true };
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  registerIA,
  getIA,
  listIAs,
  updateIAStatus,
  processInput,
  coordinate,
  quickCoordinate,
  synthesize,
  on,
  off,
  emit,
  getEventLog,
  getStatus,
  reset,
  memWrite,
  memRead,
  memReadAll,
  memFormat,
  memStats,
  memQuery,
  memLock,
  memUnlock,
  detectFormat,
  normalizeToStandard,
  extractIntent,
  extractEntities,
  detectActions,
  detectAllContradictions,
  resolveContradiction,
  buildMediatorPrompt,
  parseMediatorResponse,
  recordDriftSnapshot,
  detectDrift,
  logConsensusEvent,
  getAuditTrail,
};
