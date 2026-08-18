// ── SNAPSHOTS DE AUDITORIA: LA MEMORIA DE CALIDAD ENTRE DESPLIEGUES ──
//
// AUDIT ya contesta "¿como esta este conjunto hoy?". La pregunta que de verdad
// bloquea un despliegue es otra: "¿esto esta PEOR que lo que ya teniamos?".
// Para contestarla hace falta que la auditoria de ayer siga existiendo, y hasta
// ahora se imprimia y se perdia: compareAudits() existia pero nadie tenia dos
// auditorias que comparar salvo en la misma ejecucion.
//
// Este modulo guarda el resultado de un AUDIT como snapshot en disco y lo
// recupera por etiqueta o por "el ultimo". Con eso, el CI de una empresa puede
// fijar una referencia ("main"), auditar la rama, y cortar el merge cuando un
// caso que estaba limpio empieza a disparar -- aunque el recall agregado no se
// mueva, que es exactamente como se cuelan las regresiones de calidad.
//
// ── QUE SE GUARDA Y QUE NO ──
// Se guarda el veredicto y el detalle POR ELEMENTO (id, canales, hallazgos,
// etiqueta), que es lo unico necesario para comparar. NO se guardan los textos
// (`text`): un conjunto de evaluacion puede contener datos de cliente y un
// snapshot de calidad no es sitio para almacenarlos; ademas multiplicaria el
// tamaño del fichero sin aportar nada a la comparacion.
//
// Escritura atomica (tmp con PID + rename), el mismo patron que audit-ledger.js
// y memory-bus.js: un CI que muere a mitad de escritura no deja un snapshot
// corrupto que luego se lea como referencia buena.
//
// Esto NO es el rastro de auditoria firmado (audit-ledger.js): ahi va la
// evidencia encadenada de cada verificacion, aqui van instantaneas de
// conjuntos, reemplazables y sin garantia anti-manipulacion. Confundir ambas
// cosas seria prometer una garantia que este fichero no da.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

var SNAPSHOT_VERSION = 1;

function defaultRoot() {
  // Misma raiz que el resto de estado del procesador (~/.linkcore). La variable
  // de entorno existe para el CI y para los tests: un test que escriba en el
  // ~/.linkcore real contaminaria la instalacion de quien lo corra.
  return process.env.LINKCORE_AUDIT_DIR || path.join(os.homedir(), '.linkcore', 'audits');
}

function slug(s) {
  return String(s || 'sin-nombre').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sin-nombre';
}

function setDir(opts) {
  var o = opts || {};
  return path.join(o.dir || defaultRoot(), slug(o.set));
}

// El detalle minimo que compareAudits() necesita, sin los textos auditados.
function trimResults(results) {
  return (results || []).map(function (r) {
    return {
      id: r.id,
      hasFindings: !!r.hasFindings,
      channels: r.channels || [],
      findingCounts: r.findingCounts || {},
      channelErrors: r.channelErrors || [],
      expectFindings: r.expectFindings === undefined ? null : r.expectFindings,
      error: r.error,
    };
  });
}

export function saveAuditSnapshot(result, opts) {
  var o = opts || {};
  if (!result || !result.ok) throw new Error('no se guarda un snapshot de una auditoria que fallo');
  var dir = setDir(o);
  fs.mkdirSync(dir, { recursive: true });
  var snapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    set: o.set || 'sin-nombre',
    label: o.label ? slug(o.label) : 'sin-etiqueta',
    savedAt: new Date().toISOString(),
    // Contexto del despliegue que produjo esta auditoria (commit, modelo,
    // version de prompt...). Es lo que convierte una comparacion en una
    // explicacion: sin esto, "empeoro" no dice QUE cambio.
    meta: o.meta || {},
    passed: !!result.passed,
    gate: result.gate || {},
    violations: result.violations || [],
    summary: result.summary || {},
    results: trimResults(result.results),
  };
  var file = path.join(dir, snapshot.label + '.json');
  var tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return { path: file, snapshot: snapshot };
}

export function listAuditSnapshots(opts) {
  var dir = setDir(opts);
  var files;
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  return files
    .filter(function (f) { return /\.json$/.test(f); })
    .map(function (f) {
      var full = path.join(dir, f);
      var stat = fs.statSync(full);
      return { label: f.replace(/\.json$/, ''), path: full, savedAt: stat.mtime.toISOString() };
    })
    .sort(function (a, b) { return a.savedAt < b.savedAt ? 1 : -1; });
}

export function loadAuditSnapshot(opts) {
  var o = opts || {};
  var file;
  if (o.label === 'latest' || o.label === undefined) {
    var all = listAuditSnapshots(o);
    if (all.length === 0) return null;
    file = all[0].path;
  } else {
    file = path.join(setDir(o), slug(o.label) + '.json');
    if (!fs.existsSync(file)) return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Comparacion de despliegue: que casos empeoraron, cuales se arreglaron y como
// se movieron las metricas. `worse` es la señal accionable del CI -- se marca
// por REGRESIONES POR CASO, no por el agregado: un conjunto puede mantener el
// mismo recall mientras cambia que casos falla, y eso es una regresion real.
export function diffAuditSnapshots(baseline, candidate) {
  if (!baseline) return { comparable: false, reason: 'sin_snapshot_de_referencia' };
  var base = {};
  (baseline.results || []).forEach(function (r) { base[r.id] = r; });
  var cand = {};
  (candidate.results || []).forEach(function (r) { cand[r.id] = r; });

  var regressions = [];
  var fixes = [];
  Object.keys(cand).forEach(function (id) {
    var prev = base[id];
    var now = cand[id];
    if (!prev || prev.error || now.error) return;
    if (!prev.hasFindings && now.hasFindings) regressions.push({ id: id, canales: now.channels });
    if (prev.hasFindings && !now.hasFindings) fixes.push({ id: id, canales: prev.channels });
  });
  // Casos que estaban en la referencia y ya no se auditan: no son una
  // regresion, pero borrar el caso que fallaba tampoco es arreglarlo, asi que
  // se nombran aparte en vez de desaparecer del informe.
  var removed = Object.keys(base).filter(function (id) { return !cand[id]; });
  var added = Object.keys(cand).filter(function (id) { return !base[id]; });

  function delta(field) {
    var a = baseline.summary ? baseline.summary[field] : null;
    var b = candidate.summary ? candidate.summary[field] : null;
    if (a === null || a === undefined || b === null || b === undefined) return null;
    return { antes: a, ahora: b, delta: parseFloat((b - a).toFixed(4)) };
  }

  return {
    comparable: true,
    baselineLabel: baseline.label,
    baselineSavedAt: baseline.savedAt,
    compared: Object.keys(base).length,
    regressions: regressions,
    fixes: fixes,
    removed: removed,
    added: added,
    metrics: {
      recall: delta('recall'),
      falsePositiveRate: delta('falsePositiveRate'),
      findingRate: delta('findingRate'),
    },
    gateFlipped: !!baseline.passed && !candidate.passed,
    worse: regressions.length > 0 || (!!baseline.passed && !candidate.passed),
  };
}
