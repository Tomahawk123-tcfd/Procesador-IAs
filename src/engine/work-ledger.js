// ═══════════════════════════════════════════════════════════════
// LINKCORE WORK LEDGER
// Registro persistido de tareas ya completadas, para detectar
// solapamiento ENTRE SESIONES -- no solo dentro de una misma
// ejecucion (eso ya lo hace task-graph.js con buildTaskGraph, pero
// se olvida en cuanto termina esa llamada). Este modulo es lo que
// hace que "no os solapeis entre vosotras" sea verificable: cada
// tarea completada queda registrada, y antes de despachar una nueva
// se compara contra TODO el historial, no solo contra lo que ya se
// planeo en la peticion actual.
//
// No pretende telepatia entre herramientas externas (OpenCode,
// DeepSeek, un chat de Claude) -- LinkCore no puede ver que se hizo
// alli. Lo que hace, honesto y verificable: registra lo que EL
// PROPIO LinkCore ejecuto (via runOrchestration o runCrew), y avisa
// si una nueva peticion se parece demasiado a algo que ya se hizo,
// con el dato concreto de cuando y con que resultado -- no una
// promesa vaga, una comparacion medible.
// ═══════════════════════════════════════════════════════════════

import { detectTaskOverlap } from './task-graph.js';

var STORAGE_KEY = 'x1_work_ledger';
var MAX_LEDGER_SIZE = 500;
var DEFAULT_THRESHOLD = 0.55; // mismo umbral que usa buildTaskGraph internamente

var _ledger = [];

function _hasStorage() {
  try { return typeof localStorage !== 'undefined' && localStorage !== null; } catch (e) { return false; }
}

function _load() {
  if (!_hasStorage()) return;
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    var data = JSON.parse(raw);
    if (data && Array.isArray(data.entries)) _ledger = data.entries;
  } catch (e) { /* storage corrupto o inaccesible: arranca en blanco */ }
}

function _save() {
  if (!_hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: _ledger, savedAt: Date.now() }));
  } catch (e) { /* cuota excedida: no interrumpe la escritura en RAM */ }
}

_load();

// ═══════════════════════════════════════════
// REGISTRO
// ═══════════════════════════════════════════

// task: {label, desc, category} -- misma forma que espera task-graph.js.
// opts: {query, resultPreview, source, sessionId}
function recordCompletedWork(task, opts) {
  opts = opts || {};
  if (!task || !task.label) return { ok: false, error: 'task.label requerido' };

  var entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: task.label,
    desc: task.desc || '',
    category: task.category || 'text',
    query: opts.query || null,
    resultPreview: opts.resultPreview ? String(opts.resultPreview).slice(0, 300) : null,
    source: opts.source || 'unknown', // 'orchestrator' | 'crew' | 'manual'
    sessionId: opts.sessionId || null,
    completedAt: Date.now(),
  };

  _ledger.push(entry);
  if (_ledger.length > MAX_LEDGER_SIZE) _ledger = _ledger.slice(-MAX_LEDGER_SIZE);

  _save();
  return { ok: true, entry: entry };
}

// ═══════════════════════════════════════════
// DETECCION DE SOLAPAMIENTO ENTRE SESIONES
// ═══════════════════════════════════════════

// candidateTask: {label, desc, category}
// opts: {threshold, limit, excludeSessionId, sinceMs}
// Devuelve coincidencias REALES con score, no una alarma generica --
// cada una trae con que tarea pasada coincide, cuando se hizo, y con
// que resultado, para que quien la reciba pueda decidir reusar o
// repetir con conocimiento de causa, no que LinkCore decida en secreto.
function checkOverlap(candidateTask, opts) {
  opts = opts || {};
  var threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  var limit = opts.limit || 3;
  var cutoff = opts.sinceMs ? Date.now() - opts.sinceMs : 0;

  if (!candidateTask || !candidateTask.label) return [];

  var matches = [];
  _ledger.forEach(function (entry) {
    if (opts.excludeSessionId && entry.sessionId === opts.excludeSessionId) return;
    if (cutoff && entry.completedAt < cutoff) return;

    var score = detectTaskOverlap(candidateTask, entry);
    if (score >= threshold) {
      matches.push({
        score: score,
        label: entry.label,
        desc: entry.desc,
        category: entry.category,
        query: entry.query,
        resultPreview: entry.resultPreview,
        source: entry.source,
        sessionId: entry.sessionId,
        completedAt: entry.completedAt,
        ageMs: Date.now() - entry.completedAt,
      });
    }
  });

  matches.sort(function (a, b) { return b.score - a.score; });
  return matches.slice(0, limit);
}

// ═══════════════════════════════════════════
// CONSULTA
// ═══════════════════════════════════════════

function getLedger(opts) {
  opts = opts || {};
  var results = _ledger.slice();
  if (opts.category) results = results.filter(function (e) { return e.category === opts.category; });
  if (opts.sessionId) results = results.filter(function (e) { return e.sessionId === opts.sessionId; });
  if (opts.source) results = results.filter(function (e) { return e.source === opts.source; });
  results.sort(function (a, b) { return b.completedAt - a.completedAt; });
  if (opts.limit) results = results.slice(0, opts.limit);
  return results;
}

function getStats() {
  var sessions = {};
  var categories = {};
  var sources = {};
  _ledger.forEach(function (e) {
    if (e.sessionId) sessions[e.sessionId] = true;
    categories[e.category] = (categories[e.category] || 0) + 1;
    sources[e.source] = (sources[e.source] || 0) + 1;
  });
  return {
    totalEntries: _ledger.length,
    uniqueSessions: Object.keys(sessions).length,
    byCategory: categories,
    bySource: sources,
    oldestMs: _ledger.length ? Date.now() - _ledger[0].completedAt : null,
  };
}

function clear() {
  _ledger = [];
  _save();
  return { ok: true };
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  recordCompletedWork,
  checkOverlap,
  getLedger,
  getStats,
  clear,
};
