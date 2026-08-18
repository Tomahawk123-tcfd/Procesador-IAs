// ═══════════════════════════════════════════════════════════════
// LINKCORE SHARED MEMORY — Transactional Memory for AI Agents
// Atomic writes, snapshot isolation, versioning, provenance
// This is the Company Brain for agent coordination
// ═══════════════════════════════════════════════════════════════
//
// HISTORIA REAL: hasta 2026-07-28 este modulo vivia solo en `var _store =
// {}` -- memoria de proceso pura. Cada write() sobrevivia mientras la
// pestana seguia abierta y desaparecia entera al cerrar o recargar. Un
// modulo llamado "Company Brain" que se olvida de todo al refrescar no es
// un cerebro, es una libreta que se quema cada noche. Es la causa raiz
// concreta y verificable de "tengo que dar contexto todo el rato": nada
// de lo que los agentes escribian aqui sobrevivia a la siguiente sesion.
//
// Persistencia real anadida sin tocar la API publica -- cada write/CAS/
// prune/clear que ya funcionaba sigue funcionando igual, solo que ahora
// sobrevive. Mismo patron que loadManualMemory/saveManualMemory en
// backend.js: localStorage (no chrome.storage -- no existe en Electron),
// JSON, try/catch silencioso si el storage no esta disponible.

var STORAGE_KEY = 'x1_company_brain';
// _locks NUNCA se persiste: un lock es un compromiso de la sesion viva
// que lo pidio. Persistirlo dejaria locks huerfanos bloqueando para
// siempre a un agente que ya no existe tras un reload.
var _store = {};
var _versions = {};
var _branches = {};
var _auditLog = [];
var _locks = {};
var _snapshotCounter = 0;
var _conflictHandlers = {};

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
      _store = data.store || {};
      _versions = data.versions || {};
      _branches = data.branches || {};
      // El audit log se persiste acotado -- es historial de depuracion,
      // no estado que otro agente necesite leer para razonar.
      _auditLog = Array.isArray(data.auditLog) ? data.auditLog.slice(-500) : [];
    }
  } catch (e) { /* storage corrupto o inaccesible: arranca en blanco, no falla */ }
}

function _save() {
  if (!_hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      store: _store,
      versions: _versions,
      branches: _branches,
      auditLog: _auditLog.slice(-500),
      savedAt: Date.now(),
    }));
  } catch (e) { /* cuota excedida u otro fallo de storage: no interrumpe la escritura en RAM */ }
}

_load();

// ═══════════════════════════════════════════
// CORE: Atomic Write
// ═══════════════════════════════════════════

function write(key, value, agentId, opts) {
  opts = opts || {};
  var branch = opts.branch || 'main';
  var now = Date.now();
  var version = (_versions[key] || 0) + 1;

  if (_locks[key] && _locks[key] !== agentId) {
    return { ok: false, error: 'locked', lockedBy: _locks[key], key: key };
  }

  var entry = _store[key];
  if (entry && opts.expectedVersion && entry.version !== opts.expectedVersion) {
    return { ok: false, error: 'version_conflict', expected: opts.expectedVersion, actual: entry.version, key: key };
  }

  var prevValue = entry ? entry.value : undefined;
  var prevVersion = entry ? entry.version : 0;

  _store[key] = {
    value: value,
    agentId: agentId,
    version: version,
    branch: branch,
    createdAt: entry ? entry.createdAt : now,
    updatedAt: now,
    prevValue: prevValue,
    prevVersion: prevVersion,
  };

  _versions[key] = version;

  if (!_branches[branch]) _branches[branch] = {};
  _branches[branch][key] = version;

  _auditLog.push({
    type: 'write',
    key: key,
    agentId: agentId,
    version: version,
    branch: branch,
    timestamp: now,
    valuePreview: preview(value),
  });
  if (_auditLog.length > 5000) _auditLog = _auditLog.slice(-3000);

  // Bug real, mismo patron que finalCacheSet en chip-core.js (2026-08-09):
  // _store nunca se purgaba -- cada runCrew()/paso de orquestador escribe
  // claves con Date.now() en el nombre (unicas por diseno, para aislar
  // ejecuciones distintas), asi que con uso real sostenido crece sin
  // limite. _auditLog ya tenia tope; _store/_versions/_branches no.
  _evictStoreIfNeeded();

  _save();
  return { ok: true, version: version, key: key };
}

var STORE_MAX_ENTRIES = 3000;
function _evictStoreIfNeeded() {
  var keys = Object.keys(_store);
  if (keys.length <= STORE_MAX_ENTRIES) return;
  keys.sort(function (a, b) { return (_store[a].updatedAt || 0) - (_store[b].updatedAt || 0); });
  var toRemove = keys.slice(0, keys.length - STORE_MAX_ENTRIES);
  toRemove.forEach(function (k) {
    var branch = _store[k] && _store[k].branch;
    delete _store[k];
    delete _versions[k];
    if (branch && _branches[branch]) {
      delete _branches[branch][k];
      if (Object.keys(_branches[branch]).length === 0) delete _branches[branch];
    }
  });
}

// ═══════════════════════════════════════════
// CORE: Atomic Read (Snapshot Isolation)
// ═══════════════════════════════════════════

function read(key, opts) {
  opts = opts || {};
  var entry = _store[key];
  if (!entry) return null;
  if (opts.branch && entry.branch !== opts.branch) return null;
  return {
    value: entry.value,
    version: entry.version,
    agentId: entry.agentId,
    branch: entry.branch,
    updatedAt: entry.updatedAt,
  };
}

function readBatch(keys, opts) {
  var results = {};
  keys.forEach(function(k) {
    results[k] = read(k, opts);
  });
  return results;
}

function readAll(opts) {
  opts = opts || {};
  var results = {};
  Object.keys(_store).forEach(function(k) {
    var entry = _store[k];
    if (opts.branch && entry.branch !== opts.branch) return;
    results[k] = {
      value: entry.value,
      version: entry.version,
      agentId: entry.agentId,
      updatedAt: entry.updatedAt,
    };
  });
  return results;
}

// ═══════════════════════════════════════════
// CORE: Compare-and-Swap (Conditional Write)
// ═══════════════════════════════════════════

function compareAndSwap(key, expectedValue, newValue, agentId) {
  var entry = _store[key];
  if (!entry) {
    if (expectedValue === undefined || expectedValue === null) {
      return write(key, newValue, agentId);
    }
    return { ok: false, error: 'key_not_found', key: key };
  }
  if (JSON.stringify(entry.value) !== JSON.stringify(expectedValue)) {
    return { ok: false, error: 'value_mismatch', key: key };
  }
  return write(key, newValue, agentId, { expectedVersion: entry.version });
}

// ═══════════════════════════════════════════
// CORE: Locking
// ═══════════════════════════════════════════

function acquireLock(key, agentId, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  if (_locks[key] && _locks[key] !== agentId) {
    return { ok: false, lockedBy: _locks[key] };
  }
  _locks[key] = agentId;
  _auditLog.push({ type: 'lock', key: key, agentId: agentId, timestamp: Date.now() });
  setTimeout(function() {
    if (_locks[key] === agentId) {
      releaseLock(key, agentId);
    }
  }, timeoutMs);
  return { ok: true };
}

function releaseLock(key, agentId) {
  if (_locks[key] === agentId) {
    delete _locks[key];
    _auditLog.push({ type: 'unlock', key: key, agentId: agentId, timestamp: Date.now() });
    return { ok: true };
  }
  return { ok: false, error: 'not_lock_owner' };
}

// ═══════════════════════════════════════════
// CORE: Branch & Merge
// ═══════════════════════════════════════════

function createBranch(name) {
  if (_branches[name]) return { ok: false, error: 'branch_exists' };
  _branches[name] = {};
  _auditLog.push({ type: 'branch_create', branch: name, timestamp: Date.now() });
  return { ok: true };
}

// Limitacion arquitectonica real, documentada en vez de fingida-arreglada
// (auditoria 2026-08-17): _store es un mapa PLANO, keyed solo por `key` --
// una clave dada vive en UNA sola rama a la vez, nunca en dos ramas
// distintas simultaneamente. Eso significa que `sourceEntry` y
// `targetEntry` de abajo son literalmente el MISMO objeto (misma lectura
// `_store[key]` dos veces), asi que `targetEntry.branch === targetBranch`
// solo puede ser cierto si `sourceBranch === targetBranch` -- lo que hace
// que la deteccion de conflictos de las lineas de abajo sea codigo
// inalcanzable para cualquier merge real entre dos ramas distintas: cae
// siempre a la sobreescritura silenciosa de la ultima linea del bucle. Un
// arreglo real exigiria re-indexar _store por `branch+key` compuesto (toca
// write/read/readAll/query/_evictStoreIfNeeded, no es un cambio de una
// linea) -- no se hace aqui porque mergeBranch() no tiene NINGUN caller
// real en todo el repo hoy (confirmado por grep); rehacer el modelo de
// datos para una funcion que nadie invoca no es el uso correcto del
// esfuerzo. Si algun dia se conecta un caller real, este comentario es la
// primera parada antes de confiar en la deteccion de conflictos.
function mergeBranch(sourceBranch, targetBranch, agentId, conflictResolver) {
  var sourceKeys = _branches[sourceBranch] || {};
  var conflicts = [];
  var merged = [];

  Object.keys(sourceKeys).forEach(function(key) {
    var sourceEntry = _store[key];
    if (!sourceEntry || sourceEntry.branch !== sourceBranch) return;

    var targetEntry = _store[key];
    if (targetEntry && targetEntry.branch === targetBranch && targetEntry.version > 0) {
      if (JSON.stringify(targetEntry.value) !== JSON.stringify(sourceEntry.prevValue)) {
        conflicts.push({ key: key, source: sourceEntry.value, target: targetEntry.value });
        if (conflictResolver) {
          var resolved = conflictResolver(key, sourceEntry.value, targetEntry.value);
          var w = write(key, resolved, agentId, { branch: targetBranch });
          if (w.ok) merged.push(key);
        }
        return;
      }
    }
    var w = write(key, sourceEntry.value, agentId, { branch: targetBranch });
    if (w.ok) merged.push(key);
  });

  delete _branches[sourceBranch];
  _auditLog.push({
    type: 'branch_merge',
    source: sourceBranch,
    target: targetBranch,
    agentId: agentId,
    merged: merged.length,
    conflicts: conflicts.length,
    timestamp: Date.now(),
  });

  // El bucle de arriba ya persistio cada write() individual, pero el
  // delete _branches[sourceBranch] de la linea de arriba ocurre despues
  // del ultimo _save() -- sin este guardado explicito, la rama fuente
  // "borrada" reaparecia intacta tras un reload.
  _save();
  return { ok: true, merged: merged.length, conflicts: conflicts };
}

// ═══════════════════════════════════════════
// CORE: Version History & Provenance
// ═══════════════════════════════════════════

function getHistory(key, limit) {
  limit = limit || 20;
  var history = [];
  var entry = _store[key];
  if (!entry) return history;

  history.push({
    version: entry.version,
    value: entry.value,
    agentId: entry.agentId,
    updatedAt: entry.updatedAt,
    branch: entry.branch,
  });

  var prev = entry.prevValue;
  var prevVersion = entry.prevVersion;
  for (var i = 1; i < limit && prev !== undefined; i++) {
    history.push({
      version: prevVersion,
      value: prev,
      agentId: 'historical',
      branch: entry.branch,
    });
    prev = undefined;
    prevVersion = 0;
  }

  return history;
}

function getProvenance(key) {
  var entry = _store[key];
  if (!entry) return null;
  return {
    key: key,
    currentVersion: entry.version,
    createdBy: entry.agentId,
    createdAt: entry.createdAt,
    lastModifiedBy: entry.agentId,
    lastModifiedAt: entry.updatedAt,
    branch: entry.branch,
  };
}

// ═══════════════════════════════════════════
// CORE: Query Engine
// ═══════════════════════════════════════════

function query(opts) {
  opts = opts || {};
  var results = [];
  Object.keys(_store).forEach(function(key) {
    var entry = _store[key];
    if (opts.agentId && entry.agentId !== opts.agentId) return;
    if (opts.branch && entry.branch !== opts.branch) return;
    if (opts.modifiedAfter && entry.updatedAt < opts.modifiedAfter) return;
    if (opts.modifiedBefore && entry.updatedAt > opts.modifiedBefore) return;
    if (opts.keyPattern && !opts.keyPattern.test(key)) return;
    if (opts.valueContains) {
      var val = JSON.stringify(entry.value).toLowerCase();
      if (val.indexOf(opts.valueContains.toLowerCase()) === -1) return;
    }
    results.push({
      key: key,
      value: entry.value,
      version: entry.version,
      agentId: entry.agentId,
      updatedAt: entry.updatedAt,
      branch: entry.branch,
    });
  });
  if (opts.sortBy === 'updatedAt') {
    results.sort(function(a, b) { return b.updatedAt - a.updatedAt; });
  }
  if (opts.limit) results = results.slice(0, opts.limit);
  return results;
}

// ═══════════════════════════════════════════
// CONFLICT DETECTION
// ═══════════════════════════════════════════

function detectConflicts(timeWindowMs) {
  timeWindowMs = timeWindowMs || 60000;
  var cutoff = Date.now() - timeWindowMs;
  var recentWrites = _auditLog.filter(function(e) {
    return e.type === 'write' && e.timestamp > cutoff;
  });

  var keyWrites = {};
  recentWrites.forEach(function(w) {
    if (!keyWrites[w.key]) keyWrites[w.key] = [];
    keyWrites[w.key].push(w);
  });

  var conflicts = [];
  Object.keys(keyWrites).forEach(function(key) {
    var writes = keyWrites[key];
    if (writes.length < 2) return;
    var agents = {};
    writes.forEach(function(w) {
      agents[w.agentId] = true;
    });
    var uniqueAgents = Object.keys(agents);
    if (uniqueAgents.length > 1) {
      conflicts.push({
        key: key,
        agents: uniqueAgents,
        writeCount: writes.length,
        timeSpanMs: writes[writes.length - 1].timestamp - writes[0].timestamp,
      });
    }
  });

  return conflicts;
}

function detectSemanticConflicts(memoryEntries) {
  var conflicts = [];
  var byTopic = {};
  memoryEntries.forEach(function(entry) {
    var topic = extractTopic(entry.key);
    if (!byTopic[topic]) byTopic[topic] = [];
    byTopic[topic].push(entry);
  });

  Object.keys(byTopic).forEach(function(topic) {
    var entries = byTopic[topic];
    if (entries.length < 2) return;
    for (var i = 0; i < entries.length; i++) {
      for (var j = i + 1; j < entries.length; j++) {
        var a = entries[i];
        var b = entries[j];
        if (a.agentId === b.agentId) continue;
        if (typeof a.value === 'string' && typeof b.value === 'string') {
          if (areContradictory(a.value, b.value)) {
            conflicts.push({
              type: 'semantic',
              topic: topic,
              entry1: { key: a.key, agent: a.agentId, value: a.value },
              entry2: { key: b.key, agent: b.agentId, value: b.value },
              // Bug real (2026-07-30), encontrado con un build sin
              // minificar tras reproducir el crash en vivo: los otros dos
              // detectores de conflictos (detectConflicts() de este mismo
              // archivo, y detectAllContradictions() en consensus.js)
              // devuelven `agents: [id1, id2]` en la raiz del objeto.
              // Este era el UNICO que no lo hacia -- los guardaba anidados
              // en entry1.agent/entry2.agent. middleware.js mezcla los
              // tres tipos en un solo array de contradicciones, y
              // crew.js#mediate() recorre ese array asumiendo SIEMPRE
              // `c.agents[0]`/`c.agents[1]` -- con un conflicto semantico
              // en la mezcla, `c.agents` era undefined y crasheaba en
              // cuanto un ensemble con mas de una respuesta real detectaba
              // una contradiccion semantica de verdad. Se anaden los
              // campos comunes sin quitar los anidados (otros consumidores
              // ya leen entry1/entry2 directamente).
              agents: [a.agentId, b.agentId],
              output1: a.value,
              output2: b.value,
              confidence: 0.7,
            });
          }
        }
      }
    }
  });

  return conflicts;
}

// ═══════════════════════════════════════════
// MEMORY COMPACTION & PRUNING
// ═══════════════════════════════════════════

function compact() {
  var removed = 0;
  Object.keys(_store).forEach(function(key) {
    var entry = _store[key];
    if (entry.prevValue !== undefined) {
      entry.prevValue = undefined;
      entry.prevVersion = 0;
      removed++;
    }
  });
  _save();
  return { ok: true, compacted: removed };
}

function prune(opts) {
  opts = opts || {};
  var maxAge = opts.maxAgeMs || 7 * 24 * 60 * 60 * 1000;
  var cutoff = Date.now() - maxAge;
  var removed = 0;
  Object.keys(_store).forEach(function(key) {
    var entry = _store[key];
    // Bug real de precedencia, encontrado en auditoria (2026-08-17): con
    // `&&` de izquierda a derecha, `!opts.protect` es `false` en cuanto
    // opts.protect trae CUALQUIER valor -- lo que anulaba la condicion
    // ENTERA para TODAS las claves, no solo la protegida. Pasar
    // `{protect: 'x'}` (con la intencion de podar todo menos 'x') podaba
    // literalmente nada. El chequeo correcto es solo "no es la clave
    // protegida" -- cuando opts.protect no viene, `undefined !== key`
    // siempre es true, asi que se comporta igual que antes (podar todo lo
    // viejo) sin necesitar el `!opts.protect` de mas.
    if (entry.updatedAt < cutoff && opts.protect !== key) {
      delete _store[key];
      removed++;
    }
  });
  _save();
  return { ok: true, pruned: removed };
}

function clear() {
  _store = {};
  _versions = {};
  _branches = {};
  _auditLog = [];
  _locks = {};
  _save();
  return { ok: true };
}

// ═══════════════════════════════════════════
// EXPORTS FORMAT (for injection into prompts)
// ═══════════════════════════════════════════

function formatForPrompt(opts) {
  opts = opts || {};
  var entries = readAll(opts);
  var keys = Object.keys(entries);
  if (!keys.length) return '';
  var lines = ['Memoria compartida entre agentes IA:'];
  keys.forEach(function(k) {
    var e = entries[k];
    var val = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
    lines.push('- [' + e.agentId + '] ' + k + ' (v' + e.version + '): ' + val.slice(0, 200));
  });
  return lines.join('\n');
}

function getStats() {
  var keys = Object.keys(_store);
  var agentIds = {};
  keys.forEach(function(k) {
    agentIds[_store[k].agentId] = true;
  });
  return {
    totalKeys: keys.length,
    totalWrites: _auditLog.filter(function(e) { return e.type === 'write'; }).length,
    activeBranches: Object.keys(_branches).length,
    activeLocks: Object.keys(_locks).length,
    uniqueAgents: Object.keys(agentIds).length,
    auditLogSize: _auditLog.length,
  };
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function preview(val) {
  if (val === null || val === undefined) return String(val);
  var s = typeof val === 'string' ? val : JSON.stringify(val);
  return s.length > 100 ? s.slice(0, 100) + '...' : s;
}

function extractTopic(key) {
  var parts = key.split(/[_\-\.]/);
  return parts[0] || key;
}

function areContradictory(a, b) {
  var na = a.toLowerCase();
  var nb = b.toLowerCase();
  var pairs = [
    ['si', 'no'], ['verdadero', 'falso'], ['correcto', 'incorrecto'],
    ['alta', 'baja'], ['aumenta', 'disminuye'], ['mejora', 'empeora'],
    ['aprobado', 'rechazado'], ['activo', 'inactivo'], ['disponible', 'agotado'],
    ['rentable', 'no rentable'], ['seguro', 'riesgoso'], ['eficiente', 'ineficiente'],
  ];
  for (var i = 0; i < pairs.length; i++) {
    if ((na.indexOf(pairs[i][0]) !== -1 && nb.indexOf(pairs[i][1]) !== -1) ||
        (na.indexOf(pairs[i][1]) !== -1 && nb.indexOf(pairs[i][0]) !== -1)) {
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  write,
  read,
  readBatch,
  readAll,
  compareAndSwap,
  acquireLock,
  releaseLock,
  createBranch,
  mergeBranch,
  getHistory,
  getProvenance,
  query,
  detectConflicts,
  detectSemanticConflicts,
  compact,
  prune,
  clear,
  formatForPrompt,
  getStats,
};
