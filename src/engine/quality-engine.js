// ═══════════════════════════════════════════════════════════════
// MOTOR DE CALIDAD AGREGADA (2026-08-18)
//
// vnpu-core.js#recordTelemetry ya guardaba telemetria POR LLAMADA, pero
// en una lista plana, en memoria del proceso del servicio, con tope de
// 500 entradas y solo cuatro campos utiles (opcode, modelo, latencia,
// exito). Con eso NO se puede responder a ninguna de las preguntas que
// de verdad deciden si una capa de verificacion vale su coste:
//
//   - que verificador dispara de verdad en trafico real (y cual no ha
//     disparado nunca -> peso muerto que el operador merece saber),
//   - que clase de error domina,
//   - si la Unidad de Confianza esta CALIBRADA (cuando dice 40%, ¿esos
//     casos salen mal mas a menudo que los de 85%?),
//   - cuanto cuesta el camino caro (CROSSCHECK) y cuanto encuentra que la
//     capa determinista no vio,
//   - si todo eso mejora o empeora con el tiempo.
//
// Este modulo agrega historial REAL a esas metricas. Reglas duras que se
// respetan en todo el archivo (CLAUDE.md §4):
//   1. Nunca se imprime un numero que parezca calculado y sea en realidad
//      un supuesto. Si el dato no da para calcularlo, el campo vale null
//      y viene acompañado de una nota que dice exactamente QUE falta.
//   2. La fuente de datos se declara siempre (`source`) y se marca
//      `degraded: true` cuando se cae a una fuente mas pobre.
//   3. Ningun agregado inventa una muestra: cada porcentaje lleva su n.
//
// FUENTES, en orden de preferencia:
//   a) audit-ledger.js -- si otro modulo lo construye, es la fuente rica.
//      Se importa de forma DEFENSIVA (mismo estilo que los import()
//      dinamicos de vnpu-core.js): si no existe, no se rompe nada; si
//      existe pero no expone una forma reconocible, se dice en las notas
//      en vez de adivinar su API.
//   b) ~/.linkcore/quality-history.jsonl -- persistencia propia de este
//      modulo (una linea JSON por evento). Es la unica fuente que
//      sobrevive a un reinicio del servicio, que es justo lo que hace
//      falta para inteligencia ENTRE ejecuciones.
//   c) telemetryLedger en memoria (vnpu-core.js) -- ultimo recurso.
//      Solo tiene opcode/latencia/exito: sirve para contar volumen, no
//      para rendimiento por verificador ni calibracion. Se marca como
//      degradada y esas secciones salen como no calculables.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

var DATA_DIR = path.join(os.homedir(), '.linkcore');
var HISTORY_FILE = path.join(DATA_DIR, 'quality-history.jsonl');
var HISTORY_MAX_BYTES = 8 * 1024 * 1024;
var SCHEMA_VERSION = 1;

// Minimo de muestras para AFIRMAR algo de un bucket. Por debajo de esto
// el bucket se reporta con su n pero sin tasa: 3 de 4 no es un 75% de
// nada, es ruido, y presentarlo como porcentaje seria exactamente el
// tipo de numero falsamente preciso que este proyecto prohibe.
var MIN_BUCKET_N = 5;

var CALIBRATION_BANDS = [
  { label: '0-20%', lo: 0.0, hi: 0.2 },
  { label: '20-40%', lo: 0.2, hi: 0.4 },
  { label: '40-60%', lo: 0.4, hi: 0.6 },
  { label: '60-80%', lo: 0.6, hi: 0.8 },
  { label: '80-100%', lo: 0.8, hi: 1.0001 },
];

// ── PERSISTENCIA ──

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// Misma politica de rotacion que el log del servicio (bin/linkcore-cli.js#
// rotateLogIfNeeded): es un fichero de un servicio pensado para correr
// indefinidamente, sin nadie mirando el disco. Se conserva un .old.
function rotateHistoryIfNeeded() {
  try {
    var stat = fs.statSync(HISTORY_FILE);
    if (stat.size < HISTORY_MAX_BYTES) return;
    fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.old');
  } catch (e) {}
}

// Señal determinista y barata del tipo de contenido auditado. NO es un
// clasificador entrenado ni una opinion de un modelo: son dos deteccion
// de patrones sobre el texto, documentadas aqui para que nadie lea mas
// en el dato del que hay. Sirve para responder "que tipo de contenido es
// desproporcionadamente poco fiable", no para etiquetar semantica.
function classifyContent(text) {
  var t = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (!t.trim()) return 'empty';
  var hasCode = /```/.test(t) || /^\s*(function|def|class|const|let|var|import|public|package)\s/m.test(t) || /=>|;\s*$/m.test(t);
  var hasArith = /\d\s*[+\-*/=×÷]\s*\d|\d\s*x\s*\d/i.test(t);
  if (hasCode && hasArith) return 'mixed';
  if (hasCode) return 'code';
  if (hasArith) return 'numeric';
  return 'prose';
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

// Version del procesador que produjo el evento. Se lee del package.json
// real, no se escribe a mano. Aviso honesto (2026-08-18): hoy ese campo
// esta clavado en 0.1.0 y NO se sube por release, asi que sirve para
// separar historial de versiones futuras pero NO permite todavia comparar
// "release contra release" -- ver la nota `releaseComparison` del reporte.
var PROC_VERSION = (function () {
  try {
    var pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || null;
  } catch (e) {
    return null;
  }
})();

// recordQualityEvent(ev) -> id | null
// Append-only, una linea por evento. Devuelve el id para que quien
// invoque pueda etiquetar el resultado real mas tarde
// (recordOutcomeLabel), que es la unica via para volver la calibracion
// calculable sobre casos de confianza alta -- ver computeCalibration().
//
// Limitacion real y conocida (2026-08-18): dos procesos distintos
// (servicio + un script de benchmark que importe vnpu-core directamente)
// escriben el mismo fichero. appendFileSync abre con O_APPEND y las
// lineas son cortas (<2KB), asi que en la practica no se entrelazan; no
// hay un lock de verdad. loadQualityHistory() descarta lineas corruptas
// y las cuenta (skippedLines) en vez de romperse.
function recordQualityEvent(ev) {
  try {
    ensureDataDir();
    rotateHistoryIfNeeded();
    var entry = {
      v: SCHEMA_VERSION,
      id: newId(),
      ts: Date.now(),
      opcode: ev.opcode || null,
      contentType: ev.contentType || 'empty',
      category: ev.category || null,
      draftChars: ev.draftChars || 0,
      channels: Array.isArray(ev.channels) ? ev.channels : [],
      channelErrors: Array.isArray(ev.channelErrors) ? ev.channelErrors : [],
      findingCounts: ev.findingCounts || {},
      hasFindings: !!ev.hasFindings,
      confScore: typeof ev.confScore === 'number' ? ev.confScore : null,
      confEscalate: typeof ev.confEscalate === 'boolean' ? ev.confEscalate : null,
      confRam: typeof ev.confRam === 'boolean' ? ev.confRam : null,
      escalated: !!ev.escalated,
      cc: ev.cc || null,
      verifyMs: typeof ev.verifyMs === 'number' ? ev.verifyMs : null,
      totalMs: typeof ev.totalMs === 'number' ? ev.totalMs : null,
      procVersion: ev.procVersion || PROC_VERSION,
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    return entry.id;
  } catch (e) {
    // Registrar calidad NUNCA puede tumbar la instruccion que se estaba
    // ejecutando: si el disco falla, se pierde el evento y ya.
    return null;
  }
}

// recordOutcomeLabel(eventId, outcome) -> bool
// Etiqueta EXTERNA del resultado real de un borrador ya verificado
// ("resulto tener un problema de verdad" / "estaba limpio"), aportada por
// quien si lo sabe (la IA jefe tras adjudicar, o una persona). Es el
// unico dato que puede hacer calculable la calibracion en la banda de
// confianza alta: ahi CROSSCHECK casi nunca corre (por diseño), asi que
// sin etiqueta externa no hay ninguna señal independiente. Ver la nota
// `missingField` que devuelve computeCalibration().
//
// Fix real (2026-08-18): antes devolvia `true` para CUALQUIER eventId con
// forma de string, sin comprobar que existiera en el historial. La CLI
// (bin/linkcore-cli.js#cmdQuality) confia en ese booleano para elegir entre
// "etiqueta registrada" y "no se encontro el evento ... " -- probado en
// vivo, `recordOutcomeLabel('id-inventado', ...)` devolvia true Y escribia
// la etiqueta huerfana en disco, asi que la rama de "no encontrado" de la
// CLI era codigo muerto y un typo de eventId se reportaba como exito falso.
// recordQualityEvent() SIEMPRE escribe en HISTORY_FILE (independientemente
// de que loadQualityHistory() use audit-ledger.js como fuente del reporte),
// asi que comprobar existencia contra el jsonl propio es correcto y no
// depende de la fuente activa.
function recordOutcomeLabel(eventId, outcome) {
  if (!eventId || typeof eventId !== 'string') return false;
  try {
    var existing = readJsonlHistory();
    var found = !!(existing && existing.events.some(function (e) { return e.id === eventId; }));
    if (!found) return false;
    ensureDataDir();
    var line = {
      v: SCHEMA_VERSION,
      type: 'outcome',
      ts: Date.now(),
      eventId: eventId,
      problemConfirmed: !!(outcome && outcome.problemConfirmed),
      source: (outcome && outcome.source) || 'manual',
      note: (outcome && outcome.note) || null,
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(line) + '\n', 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// ── CARGA DE HISTORIAL ──

function readJsonlHistory() {
  var raw;
  try {
    raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
  } catch (e) {
    return null;
  }
  var lines = raw.split('\n');
  var events = [];
  var labels = [];
  var skipped = 0;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (!l) continue;
    var obj;
    try { obj = JSON.parse(l); } catch (e) { skipped++; continue; }
    if (obj && obj.type === 'outcome') labels.push(obj);
    else if (obj && obj.ts) events.push(obj);
    else skipped++;
  }
  return { events: events, labels: labels, skipped: skipped };
}

// Import defensivo del audit-ledger: puede que otro modulo lo construya
// mas tarde. No se adivina su API -- se prueban los nombres de export mas
// plausibles y, si ninguno devuelve algo con la forma que este agregador
// necesita, se dice en las notas ("presente pero no reconocido") y se
// sigue con la fuente propia. Nunca se rompe por un modulo que puede no
// estar, ni se finge haberlo usado.
var AUDIT_LOADER_CANDIDATES = ['readAuditLedger', 'loadAuditLedger', 'getAuditEvents', 'readAuditEvents', 'loadEvents', 'readAll'];

async function tryAuditLedger() {
  var mod;
  try {
    mod = await import('./audit-ledger.js');
  } catch (e) {
    return { present: false };
  }
  for (var i = 0; i < AUDIT_LOADER_CANDIDATES.length; i++) {
    var name = AUDIT_LOADER_CANDIDATES[i];
    if (typeof mod[name] !== 'function') continue;
    try {
      var out = await mod[name]();
      var arr = Array.isArray(out) ? out : (out && Array.isArray(out.events) ? out.events : null);
      if (!arr) continue;
      // Solo se acepta si los registros traen al menos marca de tiempo:
      // sin `ts` no se puede hacer ni ventana ni tendencia.
      var usable = arr.filter(function (e) { return e && typeof e.ts === 'number'; });
      if (!usable.length && arr.length) continue;
      return { present: true, recognized: true, via: name, events: usable, labels: [] };
    } catch (e) {
      return { present: true, recognized: false, error: e.message };
    }
  }
  return { present: true, recognized: false };
}

async function loadQualityHistory(opts) {
  opts = opts || {};
  var notes = [];

  var audit = await tryAuditLedger();
  if (audit.present && audit.recognized) {
    return finalize(audit.events, audit.labels, 'audit-ledger.js#' + audit.via, false, notes, 0);
  }
  if (audit.present && !audit.recognized) {
    notes.push('audit-ledger.js existe pero no expone ninguna funcion de lectura reconocible (' + AUDIT_LOADER_CANDIDATES.join('/') + ')' + (audit.error ? ': ' + audit.error : '') + ' -- se usa el historial propio en vez de adivinar su API.');
  }

  var jsonl = readJsonlHistory();
  if (jsonl && (jsonl.events.length || jsonl.labels.length)) {
    if (jsonl.skipped) notes.push(jsonl.skipped + ' linea(s) del historial estaban corruptas y se descartaron.');
    return finalize(jsonl.events, jsonl.labels, HISTORY_FILE, false, notes, jsonl.skipped);
  }

  // Ultimo recurso: telemetria en memoria del proceso actual. Solo
  // existe si esto corre DENTRO del servicio y solo trae opcode/latencia.
  try {
    var vnpuMod = await import('./vnpu-core.js');
    var stats = vnpuMod.getVNPUStats();
    if (stats && stats.totalInferences > 0) {
      notes.push('Sin historial persistido: se cae al telemetryLedger EN MEMORIA de vnpu-core.js (' + stats.totalInferences + ' entradas, se pierde al reiniciar). Solo permite contar volumen -- no trae que verificador disparo ni la puntuacion de confianza, asi que rendimiento por verificador, clases de error y calibracion NO son calculables desde esta fuente.');
      var coarse = (stats.recentTelemetry || []).map(function (t) {
        return { ts: t.ts, opcode: t.opcode, coarse: true, totalMs: t.latencyMs, channels: [], hasFindings: null, confScore: null };
      });
      return finalize(coarse, [], 'vnpu-core.js#telemetryLedger (memoria)', true, notes, 0);
    }
  } catch (e) {}

  return finalize([], [], HISTORY_FILE, false, notes, 0);

  function finalize(events, labels, source, degraded, noteList, skipped) {
    var filtered = events;
    if (typeof opts.sinceMs === 'number') {
      filtered = filtered.filter(function (e) { return e.ts >= opts.sinceMs; });
    }
    filtered = filtered.slice().sort(function (a, b) { return a.ts - b.ts; });
    if (typeof opts.limit === 'number' && filtered.length > opts.limit) {
      filtered = filtered.slice(-opts.limit);
    }
    var byId = {};
    for (var i = 0; i < labels.length; i++) {
      byId[labels[i].eventId] = labels[i];
    }
    for (var j = 0; j < filtered.length; j++) {
      if (filtered[j].id && byId[filtered[j].id]) filtered[j].label = byId[filtered[j].id];
    }
    return {
      source: source,
      degraded: degraded,
      notes: noteList,
      skippedLines: skipped,
      events: filtered,
      labels: labels,
    };
  }
}

// ── AGREGADOS ──

function rate(num, den) {
  if (!den) return null;
  return num / den;
}

function median(arr) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function mean(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length);
}

// Un evento tiene "señal de resultado independiente" si algo distinto del
// propio verificador determinista dijo si habia problema o no: o corrio
// CROSSCHECK (voces locales generadas a ciegas), o hay una etiqueta
// externa. El hallazgo del propio VERIFY NO cuenta como independiente --
// usarlo para validar la confianza seria circular, porque la Unidad de
// Confianza asigna 0.15 exactamente cuando VERIFY encontro algo.
function independentOutcome(ev) {
  if (ev.label) {
    return { problem: !!ev.label.problemConfirmed, source: 'label' };
  }
  if (ev.cc && ev.cc.ran) {
    return { problem: !!ev.cc.found, source: 'crosscheck' };
  }
  return null;
}

async function knownChannels() {
  try {
    var mod = await import('./verification-pipeline.js');
    if (Array.isArray(mod.VERIFICATION_CHANNELS)) return mod.VERIFICATION_CHANNELS.slice();
  } catch (e) {}
  return [];
}

function computeVerifierYield(events, known) {
  var verifyEvents = events.filter(function (e) { return !e.coarse; });
  var observed = {};
  known.forEach(function (c) { observed[c] = true; });
  verifyEvents.forEach(function (e) {
    (e.channels || []).forEach(function (c) { observed[c] = true; });
    (e.channelErrors || []).forEach(function (c) { observed[c] = true; });
  });

  return Object.keys(observed).map(function (ch) {
    var fired = verifyEvents.filter(function (e) { return (e.channels || []).indexOf(ch) !== -1; });
    var errored = verifyEvents.filter(function (e) { return (e.channelErrors || []).indexOf(ch) !== -1; });
    var findings = fired.reduce(function (sum, e) { return sum + ((e.findingCounts && e.findingCounts[ch]) || 0); }, 0);
    var corroborable = fired.filter(function (e) { return !!independentOutcome(e); });
    var corroborated = corroborable.filter(function (e) { return independentOutcome(e).problem; });
    return {
      channel: ch,
      fired: fired.length,
      fireRate: rate(fired.length, verifyEvents.length),
      findings: findings,
      errors: errored.length,
      corroborableSample: corroborable.length,
      corroborated: corroborated.length,
      corroborationRate: corroborable.length >= MIN_BUCKET_N ? rate(corroborated.length, corroborable.length) : null,
    };
  }).sort(function (a, b) { return b.fired - a.fired || a.channel.localeCompare(b.channel); });
}

function computeErrorClasses(events) {
  var counts = {};
  var total = 0;
  events.forEach(function (e) {
    var fc = e.findingCounts || {};
    Object.keys(fc).forEach(function (ch) {
      counts[ch] = (counts[ch] || 0) + fc[ch];
      total += fc[ch];
    });
  });
  return {
    totalFindings: total,
    classes: Object.keys(counts).map(function (ch) {
      return { channel: ch, findings: counts[ch], share: rate(counts[ch], total) };
    }).sort(function (a, b) { return b.findings - a.findings; }),
  };
}

function computeCalibration(events) {
  var scored = events.filter(function (e) { return typeof e.confScore === 'number'; });
  var buckets = CALIBRATION_BANDS.map(function (band) {
    var inBand = scored.filter(function (e) { return e.confScore >= band.lo && e.confScore < band.hi; });
    var withOutcome = inBand.filter(function (e) { return !!independentOutcome(e); });
    var problems = withOutcome.filter(function (e) { return independentOutcome(e).problem; });
    // Banda tautologica: assessConfidence() devuelve 0.15 EXACTAMENTE
    // cuando VERIFY ya encontro un problema (confidence-unit.js). Que esa
    // banda "salga mal" el 100% de las veces no valida nada -- es la
    // definicion de la banda. Se marca para que nadie lo lea como
    // evidencia de calibracion.
    var tautological = inBand.length > 0 && inBand.every(function (e) { return e.hasFindings === true; });
    return {
      band: band.label,
      n: inBand.length,
      nWithIndependentOutcome: withOutcome.length,
      problems: problems.length,
      problemRate: withOutcome.length >= MIN_BUCKET_N ? rate(problems.length, withOutcome.length) : null,
      tautological: tautological,
    };
  });

  var usable = buckets.filter(function (b) { return b.problemRate !== null && !b.tautological; });
  var computable = usable.length >= 2;
  return {
    buckets: buckets,
    computable: computable,
    scoredEvents: scored.length,
    reason: computable
      ? null
      : 'Calibracion NO calculable con los datos registrados: hacen falta al menos 2 bandas de confianza distintas con >=' + MIN_BUCKET_N + ' casos cada una que tengan una señal de resultado INDEPENDIENTE (CROSSCHECK ejecutado, o etiqueta externa). Ahora mismo hay ' + usable.length + '. La causa no es un bug: la politica de escalado solo manda a CROSSCHECK los casos de confianza baja, asi que la banda alta casi nunca recibe una segunda voz y no hay con que contrastarla.',
    missingField: computable
      ? null
      : 'Campo que falta: una etiqueta de resultado real por borrador verificado (problemConfirmed). Ya esta implementada la via para registrarla -- recordOutcomeLabel(eventId, {problemConfirmed}) en este mismo modulo, expuesta como `linkcore quality label <id> problem|clean` -- pero solo se puede rellenar desde fuera (la IA jefe al adjudicar, o una persona). La alternativa seria forzar CROSSCHECK sobre una muestra aleatoria de casos de confianza ALTA, rompiendo la correlacion escalado<->confianza baja; esa politica de muestreo NO esta implementada.',
  };
}

function computeEscalation(events) {
  var verifyish = events.filter(function (e) { return !e.coarse && e.confScore !== null && e.confScore !== undefined; });
  var recommended = verifyish.filter(function (e) { return e.confEscalate === true; });
  var ramBlocked = verifyish.filter(function (e) { return e.confEscalate === false && e.confRam === false; });
  var ran = events.filter(function (e) { return e.cc && e.cc.ran; });
  var failed = events.filter(function (e) { return e.cc && !e.cc.ran; });
  var found = ran.filter(function (e) { return e.cc.found; });
  // El numero que de verdad justifica o mata el camino caro: casos donde
  // la capa determinista NO encontro nada y CROSSCHECK si.
  var beyondDeterministic = ran.filter(function (e) { return e.cc.found && !e.hasFindings; });
  var latencies = ran.map(function (e) { return e.cc.latencyMs; }).filter(function (n) { return typeof n === 'number'; });
  var totalMs = latencies.reduce(function (a, b) { return a + b; }, 0);
  return {
    verifyEvaluated: verifyish.length,
    recommended: recommended.length,
    recommendRate: rate(recommended.length, verifyish.length),
    ramBlocked: ramBlocked.length,
    ran: ran.length,
    failed: failed.length,
    foundSomething: found.length,
    beyondDeterministic: beyondDeterministic.length,
    yieldRate: ran.length ? rate(beyondDeterministic.length, ran.length) : null,
    latencyMedianMs: median(latencies),
    latencyMeanMs: mean(latencies),
    totalLatencyMs: latencies.length ? totalMs : null,
    msPerNewFinding: beyondDeterministic.length ? Math.round(totalMs / beyondDeterministic.length) : null,
  };
}

function computeByContent(events) {
  var groups = {};
  events.filter(function (e) { return !e.coarse; }).forEach(function (e) {
    var k = e.contentType || 'empty';
    if (!groups[k]) groups[k] = { contentType: k, n: 0, withFindings: 0, escalatable: 0 };
    groups[k].n++;
    if (e.hasFindings) groups[k].withFindings++;
    if (e.confEscalate === true) groups[k].escalatable++;
  });
  return Object.keys(groups).map(function (k) {
    var g = groups[k];
    g.findingRate = g.n >= MIN_BUCKET_N ? rate(g.withFindings, g.n) : null;
    return g;
  }).sort(function (a, b) { return b.n - a.n; });
}

function computeByModel(events) {
  var groups = {};
  events.forEach(function (e) {
    if (!e.cc || !e.cc.ran || !Array.isArray(e.cc.voices)) return;
    e.cc.voices.forEach(function (m) {
      if (!groups[m]) groups[m] = { model: m, consulted: 0, inDisagreement: 0 };
      groups[m].consulted++;
      if (e.cc.found) groups[m].inDisagreement++;
    });
  });
  return Object.keys(groups).map(function (m) {
    var g = groups[m];
    g.disagreementRate = g.consulted >= MIN_BUCKET_N ? rate(g.inDisagreement, g.consulted) : null;
    return g;
  }).sort(function (a, b) { return b.consulted - a.consulted; });
}

// "¿mejora o empeora la tasa de captura ENTRE RELEASES?" es una de las
// preguntas del enunciado. Se responde con lo que hay: se agrupa por la
// version que produjo cada evento. Si todas las versiones son la misma
// (que es el caso hoy: package.json lleva 0.1.0 fijo), se dice
// explicitamente que la comparacion entre releases NO es calculable y por
// que -- en vez de presentar una tabla de una sola fila como si fuera una
// comparacion.
function computeReleases(events) {
  var groups = {};
  events.filter(function (e) { return !e.coarse; }).forEach(function (e) {
    var k = e.procVersion || 'desconocida';
    if (!groups[k]) groups[k] = { version: k, n: 0, withFindings: 0 };
    groups[k].n++;
    if (e.hasFindings) groups[k].withFindings++;
  });
  var rows = Object.keys(groups).map(function (k) {
    var g = groups[k];
    g.findingRate = g.n >= MIN_BUCKET_N ? rate(g.withFindings, g.n) : null;
    return g;
  });
  return {
    rows: rows,
    comparable: rows.length >= 2,
    note: rows.length >= 2
      ? null
      : 'Comparacion entre releases NO calculable: todo el historial viene de una sola version (' + (rows[0] ? rows[0].version : 'desconocida') + '). El campo ya se registra por evento (procVersion, leido de package.json); para que sirva, la version tiene que subir de verdad en cada release -- hoy esta fija.',
  };
}

function pickBucketSize(spanMs) {
  var hour = 3600 * 1000;
  if (spanMs <= 6 * hour) return { key: 'hora', ms: hour };
  if (spanMs <= 21 * 24 * hour) return { key: 'dia', ms: 24 * hour };
  return { key: 'semana', ms: 7 * 24 * hour };
}

function bucketLabel(ts, sizeKey) {
  var d = new Date(ts);
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  if (sizeKey === 'hora') return day + ' ' + pad(d.getHours()) + ':00';
  return day;
}

function computeTrend(events) {
  var real = events.filter(function (e) { return !e.coarse; });
  if (!real.length) {
    return { bucketSize: null, buckets: [], verdict: 'sin datos' };
  }
  var span = real[real.length - 1].ts - real[0].ts;
  var size = pickBucketSize(span);
  var groups = {};
  var order = [];
  real.forEach(function (e) {
    var slot = Math.floor(e.ts / size.ms) * size.ms;
    if (!groups[slot]) {
      groups[slot] = { slot: slot, label: bucketLabel(slot, size.key), n: 0, withFindings: 0, escalRecommended: 0, ccRan: 0, ccFound: 0 };
      order.push(slot);
    }
    var g = groups[slot];
    g.n++;
    if (e.hasFindings) g.withFindings++;
    if (e.confEscalate === true) g.escalRecommended++;
    if (e.cc && e.cc.ran) { g.ccRan++; if (e.cc.found) g.ccFound++; }
  });
  order.sort(function (a, b) { return a - b; });
  var buckets = order.map(function (s) {
    var g = groups[s];
    g.findingRate = g.n >= MIN_BUCKET_N ? rate(g.withFindings, g.n) : null;
    return g;
  });
  var solid = buckets.filter(function (b) { return b.findingRate !== null; });
  var verdict;
  var delta = null;
  if (solid.length < 2) {
    verdict = 'insuficiente: hacen falta >=2 periodos con >=' + MIN_BUCKET_N + ' verificaciones cada uno para hablar de tendencia (hay ' + solid.length + ')';
  } else {
    delta = solid[solid.length - 1].findingRate - solid[0].findingRate;
    verdict = (delta > 0.05 ? 'sube' : delta < -0.05 ? 'baja' : 'estable') + ' (' + (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + ' puntos entre ' + solid[0].label + ' y ' + solid[solid.length - 1].label + ')';
  }
  return { bucketSize: size.key, buckets: buckets, verdict: verdict, delta: delta };
}

// computeQualityReport(opts) -> reporte agregado completo
// opts: { sinceMs, limit }
async function computeQualityReport(opts) {
  opts = opts || {};
  var hist = await loadQualityHistory(opts);
  var events = hist.events;
  var known = await knownChannels();

  if (!events.length) {
    return {
      generatedAt: Date.now(),
      source: hist.source,
      degraded: hist.degraded,
      notes: hist.notes,
      empty: true,
      emptyReason: 'No hay historial de verificacion todavia. Este reporte se llena solo cuando se ejecutan instrucciones reales (vNPU.VERIFY / AUTOVERIFY / CROSSCHECK) -- una instalacion recien hecha no tiene nada que agregar, y no se inventa una linea base.',
      knownChannels: known,
      window: null,
      totals: null,
    };
  }

  var real = events.filter(function (e) { return !e.coarse; });
  var byOpcode = {};
  events.forEach(function (e) {
    var k = e.opcode || 'desconocido';
    byOpcode[k] = (byOpcode[k] || 0) + 1;
  });

  var withFindings = real.filter(function (e) { return e.hasFindings; });
  var spanMs = events[events.length - 1].ts - events[0].ts;

  return {
    generatedAt: Date.now(),
    source: hist.source,
    degraded: hist.degraded,
    notes: hist.notes,
    skippedLines: hist.skippedLines,
    empty: false,
    knownChannels: known,
    window: {
      from: events[0].ts,
      to: events[events.length - 1].ts,
      spanHours: parseFloat((spanMs / 3600000).toFixed(2)),
      events: events.length,
      detailedEvents: real.length,
    },
    totals: {
      byOpcode: byOpcode,
      verifications: real.length,
      withFindings: withFindings.length,
      findingRate: rate(withFindings.length, real.length),
      labelsRecorded: hist.labels.length,
    },
    verifiers: computeVerifierYield(events, known),
    errorClasses: computeErrorClasses(real),
    calibration: computeCalibration(real),
    escalation: computeEscalation(events),
    byContent: computeByContent(events),
    byModel: computeByModel(events),
    trend: computeTrend(events),
    releases: computeReleases(events),
  };
}

export {
  recordQualityEvent,
  recordOutcomeLabel,
  loadQualityHistory,
  computeQualityReport,
  classifyContent,
  HISTORY_FILE,
  MIN_BUCKET_N,
};
