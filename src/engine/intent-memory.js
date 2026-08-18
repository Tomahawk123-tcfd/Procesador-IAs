// ═══════════════════════════════════════════════════════════════
// LINKCORE INTENT MEMORY — STITCH-inspired
// Indexes each memory step with contextual intent:
//   1. Thematic Scope — current high-level goal
//   2. Event Type — action performed
//   3. Key Entity Types — relevant entities
// Based on ACL 2026 paper: "Grounding Agent Memory in Contextual Intent"
// ═══════════════════════════════════════════════════════════════

// Mismo hallazgo que en memory.js (ver su cabecera): _intentStore vivia
// solo en RAM de proceso, se borraba en cada reload. Persistencia real
// anadida con el mismo patron (localStorage, try/catch silencioso).
var STORAGE_KEY = 'x1_intent_memory';
var _intentStore = [];
var _activeScope = null;
var MAX_INTENT_MEMORY = 100;

function _hasStorage() {
  try { return typeof localStorage !== 'undefined' && localStorage !== null; } catch (e) { return false; }
}

function _load() {
  if (!_hasStorage()) return;
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    var data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      _intentStore = Array.isArray(data.entries) ? data.entries : [];
      _activeScope = data.activeScope || null;
    }
  } catch (e) { /* storage corrupto o inaccesible: arranca en blanco */ }
}

function _save() {
  if (!_hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries: _intentStore,
      activeScope: _activeScope,
      savedAt: Date.now(),
    }));
  } catch (e) { /* cuota excedida: no interrumpe la escritura en RAM */ }
}

_load();

// ═══ Intent Categories ═══

var EVENT_TYPES = {
  SEARCH: 'search',
  CODE: 'code',
  ANALYSIS: 'analysis',
  WRITING: 'writing',
  ORCHESTRATION: 'orchestration',
  TRANSLATION: 'translation',
  PLANNING: 'planning',
  CONVERSATION: 'conversation',
};

var ENTITY_TYPES = {
  MODEL: 'model',
  TASK: 'task',
  FILE: 'file',
  API: 'api',
  DATA: 'data',
  USER: 'user',
  RESULT: 'result',
};

// ═══ Intent Extraction ═══

var SCOPE_PATTERNS = [
  { pattern: /investiga|research|busca info|analiza/i, scope: 'research' },
  { pattern: /programa|code|escribe codigo|debug|implementa/i, scope: 'development' },
  { pattern: /escrib|redacta|documento|articulo|blog/i, scope: 'writing' },
  { pattern: /email|correo|gmail|mensaje/i, scope: 'communication' },
  { pattern: /reunion|meeting|calendario|agenda/i, scope: 'meetings' },
  { pattern: /marketing|ventas|campana|seo/i, scope: 'marketing' },
  { pattern: /finanzas|inversion|budget|stock/i, scope: 'finance' },
  { pattern: /legal|contrato|ley/i, scope: 'legal' },
  { pattern: /deploy|vercel|github|ci\/cd/i, scope: 'deployment' },
  { pattern: /analiza|compara|evalua|compara/i, scope: 'analysis' },
];

var EVENT_PATTERNS = [
  { pattern: /busca|search|find|encuentra|google/i, type: EVENT_TYPES.SEARCH },
  { pattern: /code|programa|funcion|componente|script|api/i, type: EVENT_TYPES.CODE },
  { pattern: /analiza|compara|evalua|razona|explica/i, type: EVENT_TYPES.ANALYSIS },
  { pattern: /escrib|redacta|genera|crea texto/i, type: EVENT_TYPES.WRITING },
  { pattern: /orchestra|descompone|pipeline|ensemble/i, type: EVENT_TYPES.ORCHESTRATION },
  { pattern: /traduce|translate|contexto|packet/i, type: EVENT_TYPES.TRANSLATION },
  { pattern: /plan|estrategia|paso|siguiente/i, type: EVENT_TYPES.PLANNING },
];

var ENTITY_PATTERNS = [
  { pattern: /deepseek|claude|gpt|gemini|llama|qwen|mistral|model/i, type: ENTITY_TYPES.MODEL },
  { pattern: /tarea|task|subtarea|step|paso/i, type: ENTITY_TYPES.TASK },
  { pattern: /archivo|file|doc|documento|code/i, type: ENTITY_TYPES.FILE },
  { pattern: /api|endpoint|fetch|request/i, type: ENTITY_TYPES.API },
  { pattern: /dato|data|metrica|numero|resultado/i, type: ENTITY_TYPES.DATA },
  { pattern: /usuario|user|you|tu/i, type: ENTITY_TYPES.USER },
  { pattern: /output|respuesta|result/i, type: ENTITY_TYPES.RESULT },
];

// ═══ Intent Indexing ═══

function extractIntent(text, opts) {
  opts = opts || {};
  if (!text) return null;

  var scope = null;
  var eventType = EVENT_TYPES.CONVERSATION;
  var entities = [];

  // Extract thematic scope
  for (var i = 0; i < SCOPE_PATTERNS.length; i++) {
    if (SCOPE_PATTERNS[i].pattern.test(text)) {
      scope = SCOPE_PATTERNS[i].scope;
      break;
    }
  }
  if (!scope && _activeScope) scope = _activeScope;
  if (!scope) scope = 'general';

  // Extract event type.
  //
  // Bug real, confirmado en vivo (2026-08-13): `opts` se aceptaba pero
  // nunca se leia -- orchestrator.js llama
  // `storeWithIntent(query, 'orchestrator', { eventType: 'orchestration' })`
  // explicitamente para forzar la clasificacion de sus propias tareas, pero
  // ese valor se tiraba y `eventType` se recalculaba siempre por regex
  // sobre `text`. La mayoria de queries de orquestacion no contienen
  // literalmente "orquesta/descompone/pipeline/ensemble", asi que quedaban
  // mal etiquetadas como CONVERSATION -- y `recallByIntent()` pesa
  // eventType con +2 puntos, asi que la memoria recuperada despues para
  // una tarea de orquestacion no encontraba sus propias entradas pasadas.
  // Si el caller pide un eventType valido de forma explicita, gana sobre
  // la heuristica por regex (intencion explicita > inferencia).
  var EVENT_TYPE_VALUES = Object.values(EVENT_TYPES);
  if (opts.eventType && EVENT_TYPE_VALUES.indexOf(opts.eventType) !== -1) {
    eventType = opts.eventType;
  } else {
    for (var j = 0; j < EVENT_PATTERNS.length; j++) {
      if (EVENT_PATTERNS[j].pattern.test(text)) {
        eventType = EVENT_PATTERNS[j].type;
        break;
      }
    }
  }

  // Extract entity types
  for (var k = 0; k < ENTITY_PATTERNS.length; k++) {
    if (ENTITY_PATTERNS[k].pattern.test(text)) {
      entities.push(ENTITY_PATTERNS[k].type);
    }
  }

  return {
    scope: scope,
    eventType: eventType,
    entities: entities,
    timestamp: Date.now(),
  };
}

// ═══ Memory Operations ═══

function storeWithIntent(content, agentId, opts) {
  opts = opts || {};
  var intent = extractIntent(content, opts);

  var entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    content: content,
    agentId: agentId || 'system',
    intent: intent,
    createdAt: Date.now(),
    accessCount: 0,
    lastAccessed: null,
    strength: 1.0,
  };

  _intentStore.push(entry);
  if (_intentStore.length > MAX_INTENT_MEMORY) {
    _intentStore = _intentStore.slice(-MAX_INTENT_MEMORY);
  }

  _save();
  return entry;
}

function recallByIntent(query, opts) {
  opts = opts || {};
  var limit = opts.limit || 5;
  var queryIntent = extractIntent(query, opts);

  if (!queryIntent) return _intentStore.slice(-limit);

  var scored = _intentStore.map(function(entry) {
    var score = 0;

    // Scope match (highest weight)
    if (entry.intent && entry.intent.scope === queryIntent.scope) {
      score += 3;
    }

    // Event type match
    if (entry.intent && entry.intent.eventType === queryIntent.eventType) {
      score += 2;
    }

    // Entity type overlap
    if (entry.intent && queryIntent.entities.length > 0) {
      var overlap = entry.intent.entities.filter(function(e) {
        return queryIntent.entities.indexOf(e) !== -1;
      }).length;
      score += overlap;
    }

    // Recency boost (decay over time)
    var age = Date.now() - entry.createdAt;
    var recency = Math.max(0, 1 - age / (24 * 60 * 60 * 1000)); // 24h decay
    score += recency;

    // Strength (accessed entries are stronger)
    score += entry.strength * 0.5;

    // Text similarity (simple keyword overlap)
    var queryWords = query.toLowerCase().split(/\s+/);
    var contentWords = entry.content.toLowerCase().split(/\s+/);
    var wordOverlap = queryWords.filter(function(w) {
      return w.length > 3 && contentWords.indexOf(w) !== -1;
    }).length;
    score += wordOverlap * 0.3;

    return { entry: entry, score: score };
  });

  scored.sort(function(a, b) { return b.score - a.score; });

  var results = scored.slice(0, limit).map(function(s) {
    s.entry.accessCount++;
    s.entry.lastAccessed = Date.now();
    s.entry.strength = Math.min(1.0, s.entry.strength + 0.1);
    return s.entry;
  });

  if (results.length) _save();
  return results;
}

function setScope(scope) {
  _activeScope = scope;
  _save();
}

function getActiveScope() {
  return _activeScope;
}

function getStats() {
  var scopes = {};
  var eventTypes = {};
  _intentStore.forEach(function(e) {
    if (e.intent) {
      scopes[e.intent.scope] = (scopes[e.intent.scope] || 0) + 1;
      eventTypes[e.intent.eventType] = (eventTypes[e.intent.eventType] || 0) + 1;
    }
  });
  return {
    totalEntries: _intentStore.length,
    activeScope: _activeScope,
    topScope: Object.keys(scopes).sort(function(a, b) { return scopes[b] - scopes[a]; })[0] || null,
    topEventType: Object.keys(eventTypes).sort(function(a, b) { return eventTypes[b] - eventTypes[a]; })[0] || null,
  };
}

function formatForPrompt(opts) {
  opts = opts || {};
  var entries = recallByIntent(opts.query || '', { limit: opts.limit || 6 });
  if (!entries.length) return '';
  var lines = ['Memoria con intención (STITCH):'];
  entries.forEach(function(e) {
    var scope = e.intent ? e.intent.scope : 'general';
    var type = e.intent ? e.intent.eventType : 'unknown';
    lines.push('- [' + scope + '/' + type + '] ' + e.content.slice(0, 200));
  });
  return lines.join('\n');
}

function clear() {
  _intentStore = [];
  _activeScope = null;
  _save();
}

function decay(opts) {
  opts = opts || {};
  var decayRate = opts.decayRate || 0.05;
  var minStrength = opts.minStrength || 0.1;
  var removed = 0;

  _intentStore = _intentStore.filter(function(entry) {
    entry.strength = Math.max(minStrength, entry.strength - decayRate);
    if (entry.strength <= minStrength && entry.accessCount === 0) {
      removed++;
      return false;
    }
    return true;
  });

  _save();
  return { removed: removed, remaining: _intentStore.length };
}

// ═══ Exports ═══

export {
  extractIntent,
  storeWithIntent,
  recallByIntent,
  setScope,
  getActiveScope,
  getStats,
  formatForPrompt,
  clear,
  decay,
  EVENT_TYPES,
  ENTITY_TYPES,
};
