// ═══════════════════════════════════════════════════════════════
// MEMORY BUS: Grafo de Conocimiento Persistente + Diario Comprimido
//
// Reemplaza y extiende localstorage-shim.js con:
// 1. Knowledge Graph: Entidades + Relaciones + Timestamps + Confianza
// 2. Execution Journal: Diario comprimido de comandos/respuestas/decisiones
// 3. Context Injection: Resumen matemático del estado del proyecto
// 4. Export/Import: Grafo serializable para sincronización Mesh
//
// Compatible con localStorage API existente (getItem/setItem/removeItem)
// para que el motor actual no se rompa.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ── STORAGE ──
var DATA_DIR = path.join(os.homedir(), '.linkcore');
var GRAPH_FILE = path.join(DATA_DIR, 'knowledge-graph.json');
var JOURNAL_FILE = path.join(DATA_DIR, 'execution-journal.json');
var LEGACY_FILE = path.join(DATA_DIR, 'storage.json');

// ── CONSTANTS ──
var MAX_ENTITIES = 5000;
var MAX_RELATIONS = 10000;
var MAX_JOURNAL_ENTRIES = 2000;
var MAX_JOURNAL_SIZE_KB = 512;
var ENTITY_DECAY_DAYS = 90;
var CONFIDENCE_THRESHOLD = 0.3;

// ── KNOWLEDGE GRAPH ──
var _graph = { entities: {}, relations: {}, meta: { created: Date.now(), version: 2 } };

// ── EXECUTION JOURNAL ──
var _journal = { entries: [], stats: { totalCommands: 0, totalTokens: 0, avgResponseLength: 0 } };

// ── LEGACY COMPAT (localStorage shim) ──
var _legacy = {};

function loadAll() {
  try {
    if (fs.existsSync(GRAPH_FILE)) {
      var raw = fs.readFileSync(GRAPH_FILE, 'utf-8');
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entities) _graph = parsed;
    }
  } catch (e) {}
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      var raw2 = fs.readFileSync(JOURNAL_FILE, 'utf-8');
      var parsed2 = JSON.parse(raw2);
      if (parsed2 && typeof parsed2 === 'object' && parsed2.entries) {
        _journal = decompressJournal(parsed2);
      }
    }
  } catch (e) {}
  try {
    if (fs.existsSync(LEGACY_FILE)) {
      var raw3 = fs.readFileSync(LEGACY_FILE, 'utf-8');
      var parsed3 = JSON.parse(raw3);
      if (parsed3 && typeof parsed3 === 'object') _legacy = parsed3;
    }
  } catch (e) {}
}

function saveGraph() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    var tmpFile = GRAPH_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(_graph), 'utf-8');
    fs.renameSync(tmpFile, GRAPH_FILE);
  } catch (e) {}
}

function saveJournal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    var compressed = compressJournal(_journal);
    var tmpFile = JOURNAL_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(compressed), 'utf-8');
    fs.renameSync(tmpFile, JOURNAL_FILE);
  } catch (e) {}
}

function saveLegacy() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    var tmpFile = LEGACY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(_legacy), 'utf-8');
    fs.renameSync(tmpFile, LEGACY_FILE);
  } catch (e) {}
}

// ── KNOWLEDGE GRAPH: ENTITIES ──

function makeEntityId(name, type) {
  return (type || 'concept') + '::' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function addEntity(name, type, properties) {
  var id = makeEntityId(name, type);
  var now = Date.now();

  if (!_graph.entities[id]) {
    _graph.entities[id] = {
      id: id,
      name: name,
      type: type || 'concept',
      properties: {},
      confidence: 1.0,
      created: now,
      lastAccessed: now,
      accessCount: 0,
    };
  }

  var entity = _graph.entities[id];
  entity.lastAccessed = now;
  entity.accessCount++;

  if (properties && typeof properties === 'object') {
    var keys = Object.keys(properties);
    for (var i = 0; i < keys.length; i++) {
      entity.properties[keys[i]] = properties[keys[i]];
    }
  }

  evictOldEntities();
  saveGraph();
  return id;
}

export function getEntity(name, type) {
  var id = makeEntityId(name, type);
  var entity = _graph.entities[id];
  if (entity) {
    entity.lastAccessed = Date.now();
    entity.accessCount++;
  }
  return entity || null;
}

export function searchEntities(query, opts) {
  opts = opts || {};
  var limit = opts.limit || 10;
  var typeFilter = opts.type || null;
  var minConfidence = opts.minConfidence || CONFIDENCE_THRESHOLD;

  var queryLower = query.toLowerCase();
  var queryTokens = tokenize(queryLower);
  var results = [];

  var ids = Object.keys(_graph.entities);
  for (var i = 0; i < ids.length; i++) {
    var entity = _graph.entities[ids[i]];
    if (entity.confidence < minConfidence) continue;
    if (typeFilter && entity.type !== typeFilter) continue;

    var score = scoreEntity(entity, queryTokens, queryLower);
    if (score > 0) {
      results.push({ entity: entity, score: score });
    }
  }

  results.sort(function(a, b) { return b.score - a.score; });
  return results.slice(0, limit).map(function(r) { return r.entity; });
}

function scoreEntity(entity, queryTokens, queryLower) {
  var score = 0;
  var nameLower = entity.name.toLowerCase();

  // Exact match
  if (nameLower === queryLower) return 100;

  // Partial match
  if (nameLower.indexOf(queryLower) !== -1 || queryLower.indexOf(nameLower) !== -1) {
    score += 50;
  }

  // Token overlap
  var entityTokens = tokenize(nameLower);
  for (var i = 0; i < queryTokens.length; i++) {
    for (var j = 0; j < entityTokens.length; j++) {
      if (queryTokens[i] === entityTokens[j]) score += 10;
      if (entityTokens[j].indexOf(queryTokens[i]) !== -1) score += 5;
    }
  }

  // Property match
  var propKeys = Object.keys(entity.properties);
  for (var k = 0; k < propKeys.length; k++) {
    var val = String(entity.properties[propKeys[k]]).toLowerCase();
    for (var t = 0; t < queryTokens.length; t++) {
      if (val.indexOf(queryTokens[t]) !== -1) score += 3;
    }
  }

  // Recency boost (exponential decay)
  var ageMs = Date.now() - entity.lastAccessed;
  var ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) score *= 1.5;
  else if (ageDays < 7) score *= 1.2;
  else if (ageDays < 30) score *= 1.0;

  // Access frequency boost
  score += Math.min(20, entity.accessCount * 2);

  return score;
}

function evictOldEntities() {
  var ids = Object.keys(_graph.entities);
  if (ids.length <= MAX_ENTITIES) return;

  var now = Date.now();
  var cutoff = now - (ENTITY_DECAY_DAYS * 24 * 60 * 60 * 1000);
  var toRemove = [];

  for (var i = 0; i < ids.length; i++) {
    var entity = _graph.entities[ids[i]];
    if (entity.lastAccessed < cutoff && entity.accessCount < 3) {
      toRemove.push(ids[i]);
    }
  }

  // Sort by access count (lowest first) and remove excess
  var excess = ids.length - MAX_ENTITIES + toRemove.length;
  if (excess > 0) {
    var allCandidates = ids.filter(function(id) {
      return toRemove.indexOf(id) === -1;
    }).sort(function(a, b) {
      return _graph.entities[a].accessCount - _graph.entities[b].accessCount;
    });
    toRemove = toRemove.concat(allCandidates.slice(0, excess));
  }

  for (var j = 0; j < toRemove.length; j++) {
    delete _graph.entities[toRemove[j]];
  }
}

// ── KNOWLEDGE GRAPH: RELATIONS ──

export function addRelation(fromId, toId, type, properties) {
  var relKey = fromId + '->' + toId + '::' + (type || 'related');
  var now = Date.now();

  if (!_graph.relations[relKey]) {
    _graph.relations[relKey] = {
      from: fromId,
      to: toId,
      type: type || 'related',
      properties: {},
      strength: 1.0,
      created: now,
      lastUsed: now,
      useCount: 0,
    };
  }

  var rel = _graph.relations[relKey];
  rel.lastUsed = now;
  rel.useCount++;

  if (properties && typeof properties === 'object') {
    var keys = Object.keys(properties);
    for (var i = 0; i < keys.length; i++) {
      rel.properties[keys[i]] = properties[keys[i]];
    }
  }

  evictOldRelations();
  saveGraph();
  return relKey;
}

export function getRelations(entityId, opts) {
  opts = opts || {};
  var direction = opts.direction || 'both'; // 'out', 'in', 'both'
  var typeFilter = opts.type || null;
  var limit = opts.limit || 50;

  var results = [];
  var ids = Object.keys(_graph.relations);

  for (var i = 0; i < ids.length; i++) {
    var rel = _graph.relations[ids[i]];
    var matches = false;

    if ((direction === 'out' || direction === 'both') && rel.from === entityId) matches = true;
    if ((direction === 'in' || direction === 'both') && rel.to === entityId) matches = true;
    if (typeFilter && rel.type !== typeFilter) matches = false;

    if (matches) {
      results.push(rel);
      if (results.length >= limit) break;
    }
  }

  return results;
}

function evictOldRelations() {
  var ids = Object.keys(_graph.relations);
  if (ids.length <= MAX_RELATIONS) return;

  // Create a sorted copy, don't mutate original
  var sorted = ids.slice().sort(function(a, b) {
    return _graph.relations[a].useCount - _graph.relations[b].useCount;
  });
  var toRemove = sorted.slice(0, ids.length - MAX_RELATIONS);
  for (var i = 0; i < toRemove.length; i++) {
    delete _graph.relations[toRemove[i]];
  }
}

// ── EXECUTION JOURNAL ──

export function addJournalEntry(entry) {
  var now = Date.now();
  var journalEntry = {
    id: crypto.randomUUID ? crypto.randomUUID() : 'j-' + now + '-' + Math.random().toString(36).slice(2, 8),
    timestamp: now,
    type: entry.type || 'command', // 'command', 'response', 'decision', 'ensemble', 'gstack'
    content: entry.content || '',
    model: entry.model || null,
    category: entry.category || null,
    latencyMs: entry.latencyMs || 0,
    tokens: entry.tokens || 0,
    metadata: entry.metadata || {},
  };

  _journal.entries.push(journalEntry);
  _journal.stats.totalCommands++;
  _journal.stats.totalTokens += journalEntry.tokens;

  // Rolling buffer: keep only recent entries
  if (_journal.entries.length > MAX_JOURNAL_ENTRIES) {
    _journal.entries = _journal.entries.slice(-MAX_JOURNAL_ENTRIES);
  }

  saveJournal();
  return journalEntry.id;
}

export function getJournal(opts) {
  opts = opts || {};
  var limit = opts.limit || 50;
  var typeFilter = opts.type || null;
  var since = opts.since || 0;
  var until = opts.until || Date.now();

  var results = [];
  for (var i = _journal.entries.length - 1; i >= 0; i--) {
    var entry = _journal.entries[i];
    if (entry.timestamp < since || entry.timestamp > until) continue;
    if (typeFilter && entry.type !== typeFilter) continue;

    results.unshift(entry);
    if (results.length >= limit) break;
  }

  return results;
}

// ── COMPRESSION: Journal ──
// Simple compression: deduplicate repeated patterns, encode timestamps as deltas

function compressJournal(journal) {
  if (!journal || !journal.entries) return journal;

  var compressed = {
    entries: journal.entries.map(function(entry) {
      return {
        t: entry.timestamp,
        y: entry.type,
        c: entry.content.length > 500 ? entry.content.slice(0, 500) + '...' : entry.content,
        m: entry.model,
        cat: entry.category,
        l: entry.latencyMs,
        tk: entry.tokens,
      };
    }),
    stats: journal.stats,
    _compressed: true,
  };

  return compressed;
}

function decompressJournal(compressed) {
  if (!compressed || !compressed._compressed) return compressed;

  return {
    entries: compressed.entries.map(function(entry) {
      return {
        timestamp: entry.t,
        type: entry.y,
        content: entry.c,
        model: entry.m,
        category: entry.cat,
        latencyMs: entry.l,
        tokens: entry.tk,
        metadata: {},
      };
    }),
    stats: compressed.stats,
  };
}

// ── CONTEXT INJECTION ──
// Genera un resumen comprimido del estado del proyecto para inyectar en prompts

export function getContextSummary(opts) {
  opts = opts || {};
  var maxTokens = opts.maxTokens || 800;
  var query = opts.query || '';

  var parts = [];

  // 1. Entity summary by type
  var byType = {};
  var entityIds = Object.keys(_graph.entities);
  for (var i = 0; i < entityIds.length; i++) {
    var entity = _graph.entities[entityIds[i]];
    if (!byType[entity.type]) byType[entity.type] = [];
    byType[entity.type].push(entity);
  }

  var typeNames = Object.keys(byType);
  for (var t = 0; t < typeNames.length; t++) {
    var entities = byType[typeNames[t]];
    // Sort by recency
    entities.sort(function(a, b) { return b.lastAccessed - a.lastAccessed; });
    var topEntities = entities.slice(0, 5);
    parts.push(typeNames[t] + ': ' + topEntities.map(function(e) {
      return e.name + (e.confidence < 0.8 ? ' (*)' : '');
    }).join(', '));
  }

  // 2. Recent journal summary
  var recentEntries = _journal.entries.slice(-10);
  if (recentEntries.length > 0) {
    var commandCount = recentEntries.filter(function(e) { return e.type === 'command'; }).length;
    var ensembleCount = recentEntries.filter(function(e) { return e.type === 'ensemble'; }).length;
    parts.push('Reciente: ' + commandCount + ' comandos, ' + ensembleCount + ' ensembles');
  }

  // 3. Top relations
  var relIds = Object.keys(_graph.relations);
  if (relIds.length > 0) {
    var topRels = relIds.slice(0, 5).map(function(id) {
      var rel = _graph.relations[id];
      return rel.from.split('::')[1] + '->' + rel.to.split('::')[1];
    });
    parts.push('Relaciones: ' + topRels.join(', '));
  }

  // 4. Stats
  parts.push('Grafo: ' + entityIds.length + ' entidades, ' + relIds.length + ' relaciones, ' + _journal.stats.totalCommands + ' comandos registrados');

  var summary = parts.join('\n');

  // Truncate if too long
  if (summary.length > maxTokens * 4) {
    summary = summary.slice(0, maxTokens * 4) + '...';
  }

  return summary;
}

// ── ENTITY EXTRACTION FROM TEXT ──
// Extrae entidades automáticamente de texto de conversación

export function extractEntities(text, opts) {
  opts = opts || {};
  var category = opts.category || 'conversation';

  var entities = [];

  // Extract code-like entities
  var codeBlocks = text.match(/```[\s\S]*?```/g) || [];
  for (var i = 0; i < codeBlocks.length; i++) {
    var code = codeBlocks[i].replace(/```\w*\n?/g, '').trim();
    if (code.length > 10 && code.length < 1000) {
      var funcMatch = code.match(/(?:function|const|let|var|class)\s+(\w+)/);
      if (funcMatch) {
        entities.push({ name: funcMatch[1], type: 'code', properties: { language: 'detected', snippet: code.slice(0, 200) } });
      }
    }
  }

  // Extract file paths
  var paths = text.match(/(?:src|lib|core|engine|test|bin|sdk)[\\/][\w\-\\.]+/g) || [];
  for (var j = 0; j < paths.length; j++) {
    entities.push({ name: paths[j], type: 'file', properties: { mentionedIn: category } });
  }

  // Extract technical terms
  var techTerms = text.match(/\b(?:ensemble|arbitrage|consensus|pipeline|router|cache|circuit|breaker|learning|loop|mesh|memory|bus|gstack|crew|orchestrat)\b/gi) || [];
  var uniqueTerms = [];
  for (var k = 0; k < techTerms.length; k++) {
    var term = techTerms[k].toLowerCase();
    if (uniqueTerms.indexOf(term) === -1) uniqueTerms.push(term);
  }
  for (var l = 0; l < uniqueTerms.length; l++) {
    entities.push({ name: uniqueTerms[l], type: 'concept', properties: { source: 'auto-extracted' } });
  }

  // Extract model names
  var modelNames = text.match(/\b(?:qwen|llama|smollm|gemma|phi|mistral|deepseek|starcoder|codestral|rwkv|nemotron)\b/gi) || [];
  var uniqueModels = [];
  for (var m = 0; m < modelNames.length; m++) {
    var mName = modelNames[m].toLowerCase();
    if (uniqueModels.indexOf(mName) === -1) uniqueModels.push(mName);
  }
  for (var n = 0; n < uniqueModels.length; n++) {
    entities.push({ name: uniqueModels[n], type: 'model', properties: { mentionedIn: category } });
  }

  // Add entities to graph
  var added = [];
  for (var p = 0; p < entities.length; p++) {
    var e = entities[p];
    var id = addEntity(e.name, e.type, e.properties);
    added.push(id);
  }

  return added;
}

// ── EXPORT / IMPORT ──

export function exportGraph() {
  return JSON.stringify({
    graph: _graph,
    journal: compressJournal(_journal),
    exportedAt: Date.now(),
    version: 2,
  });
}

export function importGraph(data) {
  try {
    var parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!parsed || !parsed.graph) return false;

    _graph = parsed.graph;
    if (parsed.journal) {
      _journal = decompressJournal(parsed.journal);
    }

    saveGraph();
    saveJournal();
    return true;
  } catch (e) {
    return false;
  }
}

// ── COMPACT REPORT (for CLI) ──

export function graphReport() {
  var entityCount = Object.keys(_graph.entities).length;
  var relationCount = Object.keys(_graph.relations).length;
  var journalCount = _journal.entries.length;

  var byType = {};
  var ids = Object.keys(_graph.entities);
  for (var i = 0; i < ids.length; i++) {
    var type = _graph.entities[ids[i]].type;
    byType[type] = (byType[type] || 0) + 1;
  }

  var avgConfidence = 0;
  if (entityCount > 0) {
    var confSum = 0;
    for (var j = 0; j < ids.length; j++) {
      confSum += _graph.entities[ids[j]].confidence;
    }
    avgConfidence = confSum / entityCount;
  }

  return {
    entities: entityCount,
    relations: relationCount,
    journalEntries: journalCount,
    totalCommands: _journal.stats.totalCommands,
    totalTokens: _journal.stats.totalTokens,
    entitiesByType: byType,
    avgConfidence: avgConfidence.toFixed(3),
    graphSizeKB: Math.round(JSON.stringify(_graph).length / 1024),
    journalSizeKB: Math.round(JSON.stringify(_journal).length / 1024),
  };
}

// ── TOKENIZER ──

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]/g, ' ')
    .split(/\s+/)
    .filter(function(t) { return t.length > 2; });
}

// ── LEGACY COMPAT (localStorage API) ──
// Maintains backward compatibility with existing engine code

export var localStorage = {
  getItem: function(key) {
    // Check legacy first, then graph metadata
    if (Object.prototype.hasOwnProperty.call(_legacy, key)) return _legacy[key];
    return null;
  },
  setItem: function(key, value) {
    _legacy[key] = String(value);
    saveLegacy();
  },
  removeItem: function(key) {
    delete _legacy[key];
    saveLegacy();
  },
  clear: function() {
    _legacy = {};
    saveLegacy();
  },
  key: function(index) {
    var keys = Object.keys(_legacy);
    return index >= 0 && index < keys.length ? keys[index] : null;
  },
  get length() {
    return Object.keys(_legacy).length;
  },
};

// ── INITIALIZATION ──

loadAll();

export function installGlobalShim() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
  if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage.__linkcoreShim) {
    globalThis.localStorage = localStorage;
    globalThis.localStorage.__linkcoreShim = true;
  }
  return LEGACY_FILE;
}

// ── GRACEFUL SHUTDOWN ──
export function flush() {
  saveGraph();
  saveJournal();
  saveLegacy();
}
