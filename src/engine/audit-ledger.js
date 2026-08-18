// ═══════════════════════════════════════════════════════════════
// LINKCORE AUDIT LEDGER — rastro de auditoría append-only con
// evidencia de manipulación (hash chain + firma HMAC por instalación)
//
// El problema que resuelve (2026-08-18): hasta hoy el procesador
// verificaba un borrador, imprimia los avisos, y se olvidaba. Una
// empresa regulada que compra una capa de verificación esta comprando
// REDUCCIÓN DE RESPONSABILIDAD, y eso exige PRUEBA: meses despues, ante
// un auditor, hay que poder contestar que salidas de IA se comprobaron,
// con que chequeos, cuando, que se encontro, que voces participaron, y
// demostrar que ese registro no se toco despues. Sin eso la verificación
// es folclore no falsable.
//
// ── QUÉ SE GARANTIZA EXACTAMENTE (leer antes de vender nada) ──
// 1. Encadenado: cada registro incluye el hash del anterior, y su propio
//    hash cubre TODO su contenido (incluido prevHash). Editar a mano el
//    contenido de un registro rompe su hash; recalcular ese hash rompe la
//    firma HMAC (no se puede firmar sin el secreto); borrar un registro
//    rompe el prevHash del siguiente y deja un hueco en `seq`.
//    verifyLedgerIntegrity() nombra el índice exacto donde se rompe.
// 2. Firma real: HMAC-SHA256 con el secreto por instalación que ya existe
//    (~/.linkcore/arbitrage-secret.txt, creado por
//    neural-arbitrage.js#loadOrCreateArbitrageSecret). NO se inventa un
//    segundo secreto ni un segundo esquema: es el mismo secreto y el
//    mismo tipo de comparación (crypto.timingSafeEqual) que ya usa
//    verifyReportSignature() ahi.
// 3. Cola protegida: la cabecera (`head`) va firmada aparte, asi que
//    borrar los ULTIMOS registros tambien se detecta (sin ella, truncar
//    la cola dejaria una cadena perfectamente valida y mas corta).
//
// ── QUÉ NO SE GARANTIZA (limites reales, no letra pequeña) ──
// a. Esto es tamper-EVIDENT, no tamper-PROOF. Quien tenga acceso de
//    lectura al secreto (el propio usuario del equipo, o un
//    administrador) puede reescribir el fichero entero de forma
//    consistente y esta capa no lo detectara. La defensa real contra eso
//    es sacar la cabeza de la cadena fuera de la maquina (WORM externo,
//    testigo remoto) -- LinkCore NO hace eso hoy, y afirmar lo contrario
//    seria exactamente el tipo de capacidad fingida que este proyecto
//    prohibe.
// b. Rotación: ver el bloque grande junto a rotateIfNeeded(). Resumen:
//    de los registros que salen de la ventana de retención sobrevive la
//    PRUEBA DE QUE EXISTIERON Y CUANTOS FUERON (ancla firmada +
//    numeración `seq` global que nunca se reutiliza), pero su CONTENIDO
//    se pierde de forma irreversible tras dos rotaciones.
// c. draftHash/queryHash son SHA-256 sin sal a proposito: un auditor con
//    una copia del borrador tiene que poder recalcular el hash y probar
//    "esta salida es la que se audito en el registro 412". El precio es
//    que un contenido corto y adivinable puede confirmarse por fuerza
//    bruta -- es un compromiso deliberado a favor de la verificabilidad
//    externa, no un descuido.
// d. Un unico escritor: el servicio (src/index.js) es el unico proceso
//    que escribe. El CLI solo lee. Dos escritores concurrentes sobre el
//    mismo fichero se pisarian (mismo problema ya documentado para
//    storage.json), y esta capa no lo arbitra.
//
// Escritura atomica: tmp con PID + rename, el mismo patron con el que ya
// se corrigio la corrupción real de storage.json (localstorage-shim.js) y
// que usa memory-bus.js -- nunca un writeFileSync directo sobre el
// fichero bueno.
// ═══════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadOrCreateArbitrageSecret } from './neural-arbitrage.js';

var DATA_DIR = path.join(os.homedir(), '.linkcore');
export var AUDIT_LEDGER_FILE = path.join(DATA_DIR, 'audit-ledger.json');
export var AUDIT_ARCHIVE_SUFFIX = '.old';

var LEDGER_VERSION = 1;
var GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
var DEFAULT_MAX_ACTIVE_RECORDS = 2000;
var MAX_STORED_CONTENT_CHARS = 4000;
var MAX_RELATED_SEQS = 8;
var MAX_VOICES = 12;
var MAX_VERIFIERS = 32;

// ── UTILIDADES DE HASH/FIRMA ──

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Serialización canónica: las claves se ordenan siempre igual, asi que el
// hash de un registro no depende del orden en que se construyo el objeto
// (si dependiera, releer y reescribir el JSON podria "romper" la cadena
// sin que nadie la haya manipulado).
function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  var keys = Object.keys(value).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(JSON.stringify(keys[i]) + ':' + canonical(value[keys[i]]));
  }
  return '{' + parts.join(',') + '}';
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ── LOCK ENTRE PROCESOS (bug real, 2026-08-18) ──
// Hallazgo en prueba adversarial: 4 procesos node reales escribiendo 25
// registros cada uno (100 esperados) al MISMO fichero de ledger perdieron
// 67 -- solo sobrevivieron 33. Causa raiz: cada proceso mantiene su propio
// `state.records` en memoria (cargado una vez al arrancar) y persist()
// hace un writeFileSync atomico del ARCHIVO ENTERO -- atomico frente a una
// lectura a medias, pero NO frente a otro escritor: el ultimo persist()
// gana y se lleva por delante los registros que el otro proceso ya habia
// escrito, exactamente el mismo patron ya documentado y corregido para
// storage.json (ver CLAUDE.md #72/#75). verifyLedgerIntegrity() seguia
// diciendo intact:true tras la perdida porque lo que quedaba en el
// fichero final SI formaba una cadena valida -- esta capa no puede
// detectar perdida de registros que nunca coexistieron en un mismo
// fichero, solo manipulacion de lo que si esta.
//
// Arreglo: lock de exclusion mutua a nivel de sistema de archivos
// (fs.openSync con flag 'wx', que en Windows y POSIX falla con EEXIST si
// el fichero ya existe -- la misma primitiva atomica que usa
// atomicWriteJSON via rename, aplicada aqui a la creacion). Cada
// recordVerification() adquiere el lock, RELEE el fichero desde disco
// (loadFromDisk(), asi que ve los registros que otro proceso acabe de
// escribir), calcula seq/prevHash sobre ese estado fresco, escribe, y
// libera el lock -- convierte la seccion critica en una cola serializada
// entre procesos. Lock viejo (proceso que murio con el lock tomado) se
// considera huerfano y se roba tras LOCK_STALE_MS.
var LOCK_RETRY_MS = 15;
var LOCK_TIMEOUT_MS = 4000;
var LOCK_STALE_MS = 8000;

function sleepSyncMs(ms) {
  // No hay sleep sincrono nativo en Node; Atomics.wait sobre un
  // SharedArrayBuffer bloquea el hilo de verdad (no es un busy-loop que
  // queme CPU) y funciona en el hilo principal, no solo en workers.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    // Entorno sin SharedArrayBuffer/Atomics (no deberia pasar en Node
    // >=18, ver package.json#engines): degradar a busy-wait corto en vez
    // de romper la escritura de auditoria por esto.
    var until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

function acquireLock(lockFile) {
  var start = Date.now();
  for (;;) {
    try {
      var fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid) + '@' + Date.now());
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        var st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Lock huerfano (el proceso que lo tomo murio o se colgo antes
          // de liberarlo): robarlo en vez de bloquear la auditoria para
          // siempre. unlinkSync puede perder la carrera contra otro
          // proceso que tambien lo esta robando -- eso es aceptable, el
          // siguiente intento de openSync('wx') decide quien gana.
          try { fs.unlinkSync(lockFile); } catch (e2) {}
          continue;
        }
      } catch (e3) { /* stat fallo: el lock pudo desaparecer justo ahora, reintentar */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        return false;
      }
      sleepSyncMs(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (e) {}
}

// Misma comparación en tiempo constante que ya usa
// neural-arbitrage.js#verifyReportSignature -- no se cambia de esquema.
function safeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var bufA, bufB;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch (e) { return false; }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch (e) { return false; }
}

// ── NORMALIZACIÓN DE ENTRADA ──
// Todo lo que entra al cuerpo firmado se normaliza a un tipo concreto:
// un `undefined` colado dentro del objeto haria que canonical() y
// JSON.stringify() discrepen y la cadena pareceria rota sin estarlo.

function normStringArray(value, max) {
  if (!Array.isArray(value)) return [];
  var out = [];
  for (var i = 0; i < value.length && out.length < max; i++) {
    if (typeof value[i] === 'string' && value[i]) out.push(value[i].slice(0, 80));
  }
  return out;
}

function normFindings(findings) {
  var channels = {};
  var total = 0;
  if (findings && typeof findings === 'object' && findings.channels && typeof findings.channels === 'object') {
    var keys = Object.keys(findings.channels).sort();
    for (var i = 0; i < keys.length && i < MAX_VERIFIERS; i++) {
      var n = findings.channels[keys[i]];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        channels[keys[i].slice(0, 60)] = Math.round(n);
        total += Math.round(n);
      }
    }
  }
  // `total` se DERIVA de los canales, nunca se copia de lo que diga el
  // caller: un total que no cuadre con el desglose seria un numero
  // fabricado dentro de un registro de auditoria.
  return { total: total, channels: channels };
}

function normVoices(voices) {
  if (!Array.isArray(voices)) return [];
  var out = [];
  for (var i = 0; i < voices.length && out.length < MAX_VOICES; i++) {
    var v = voices[i];
    if (!v || typeof v !== 'object' || !v.model) continue;
    out.push({
      model: String(v.model).slice(0, 120),
      family: v.family ? String(v.family).slice(0, 60) : null,
      role: v.role ? String(v.role).slice(0, 30) : null,
    });
  }
  return out;
}

function normSeqs(seqs) {
  if (!Array.isArray(seqs)) return [];
  var out = [];
  for (var i = 0; i < seqs.length && out.length < MAX_RELATED_SEQS; i++) {
    if (typeof seqs[i] === 'number' && Number.isFinite(seqs[i])) out.push(Math.round(seqs[i]));
  }
  return out;
}

// ── INSTANCIA DE LEDGER ──
// Se expone como factoria (createAuditLedger) ademas de como singleton
// para que los tests puedan trabajar sobre un fichero temporal propio sin
// tocar el ledger real del operador -- un test que contamina el rastro de
// auditoria de produccion seria inaceptable en esta pieza concreta.

export function createAuditLedger(opts) {
  opts = opts || {};
  var file = opts.file || AUDIT_LEDGER_FILE;
  var archiveFile = opts.archiveFile || (file + AUDIT_ARCHIVE_SUFFIX);
  var maxActive = (typeof opts.maxActiveRecords === 'number' && opts.maxActiveRecords > 0)
    ? Math.floor(opts.maxActiveRecords) : DEFAULT_MAX_ACTIVE_RECORDS;
  var keepAfter = (typeof opts.keepAfterRotation === 'number' && opts.keepAfterRotation > 0)
    ? Math.floor(opts.keepAfterRotation) : Math.floor(maxActive / 2);
  if (keepAfter >= maxActive) keepAfter = Math.max(1, maxActive - 1);

  var secret = opts.secret || loadOrCreateArbitrageSecret();

  var stats = {
    writeFailures: 0,
    lastWriteError: null,
    unpersistedRecords: 0,
    rotations: 0,
    rotationBlocked: false,
    loadError: null,
  };

  function genesisAnchor() {
    return signAnchor({ seq: 0, hash: GENESIS_HASH, rotatedCount: 0 });
  }

  function signAnchor(a) {
    var body = { seq: a.seq, hash: a.hash, rotatedCount: a.rotatedCount };
    return { seq: body.seq, hash: body.hash, rotatedCount: body.rotatedCount, sig: hmacHex(secret, canonical(body)) };
  }

  function makeHead(records, anchor) {
    var last = records.length ? records[records.length - 1] : null;
    var body = {
      seq: last ? last.seq : anchor.seq,
      hash: last ? last.hash : anchor.hash,
      count: records.length,
    };
    return { seq: body.seq, hash: body.hash, count: body.count, sig: hmacHex(secret, canonical(body)) };
  }

  var state = { anchor: genesisAnchor(), records: [] };

  function loadFromDisk() {
    var raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      // ENOENT en el primer arranque es lo normal, no un error.
      if (e.code !== 'ENOENT') stats.loadError = e.code + ': ' + e.message;
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Fichero ilegible: NO se sobreescribe en silencio (seria destruir
      // el rastro de auditoria justo cuando mas sospechoso es). Se aparta
      // con marca de tiempo la primera vez que haya algo que escribir --
      // aqui solo se anota, porque loadFromDisk() tambien corre en el CLI,
      // que debe ser estrictamente de solo lectura.
      stats.loadError = 'json_ilegible: ' + e.message;
      return;
    }
    if (!parsed || !Array.isArray(parsed.records) || !parsed.anchor) {
      stats.loadError = 'formato_desconocido';
      return;
    }
    state.anchor = parsed.anchor;
    state.records = parsed.records;
  }

  loadFromDisk();

  function handleUnreadableFile() {
    // Solo se aparta un fichero que EXISTE y no se pudo parsear. Un
    // EACCES/EISDIR no se toca: no se pudo leer, asi que moverlo seria
    // destruir algo cuyo contenido ni siquiera se conoce.
    if (!stats.loadError || stats.loadError.indexOf('json_ilegible') !== 0) return false;
    try {
      var aside = file + '.corrupt-' + Date.now();
      fs.renameSync(file, aside);
      stats.loadError = 'apartado_ilegible: ' + aside;
      state.anchor = genesisAnchor();
      state.records = [];
      return true;
    } catch (e) {
      return false;
    }
  }

  function atomicWriteJSON(target, payload) {
    // Escritura atomica: tmp con PID + rename. El PID en el nombre viene
    // del fix real de storage.json (localstorage-shim.js): sin el, dos
    // procesos escribiendo comparten el mismo `.tmp` y uno se lleva por
    // delante el fichero a medio escribir del otro.
    var tmp = target + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  }

  function persist() {
    try {
      atomicWriteJSON(file, {
        version: LEDGER_VERSION,
        anchor: state.anchor,
        head: makeHead(state.records, state.anchor),
        records: state.records,
      });
      stats.unpersistedRecords = 0;
      return true;
    } catch (e) {
      stats.writeFailures++;
      stats.lastWriteError = (e.code ? e.code + ': ' : '') + e.message;
      stats.unpersistedRecords++;
      return false;
    }
  }

  // ── ROTACIÓN: QUÉ SOBREVIVE Y QUÉ NO ──
  // El servicio esta pensado para arrancar solo y correr meses (ver
  // CLAUDE.md), asi que el ledger NO puede crecer sin limite. Patron
  // heredado de la rotación real del log del servicio (bin/linkcore-cli.js
  // #rotateLogIfNeeded): UNA sola generación archivada, y la siguiente
  // rotación la sobreescribe.
  //
  // La parte delicada: rotar NO puede romper la verificabilidad en
  // silencio. Por eso rotar aqui no reescribe ni un solo registro -- solo
  // MUEVE los mas antiguos al archivo y deja en el fichero activo un
  // ANCLA FIRMADA con {seq, hash, rotatedCount} del ultimo registro que
  // salio. El primer registro que se queda ya traia ese hash en su
  // prevHash desde que se escribio, asi que la cadena del tramo retenido
  // sigue cerrando exactamente igual que antes de rotar.
  //
  // Sobrevive a la rotación:
  //   · integridad completa (contenido, orden, no-borrado) del tramo
  //     retenido, y del tramo archivado mientras el archivo exista;
  //   · el enlace entre archivo y activo (el hash del ultimo registro
  //     archivado tiene que ser el ancla del activo);
  //   · la PRUEBA de cuantos registros hubo antes: `seq` es global y no
  //     se reutiliza nunca, y `rotatedCount` va firmado, asi que un
  //     auditor puede afirmar "hubo 5.312 verificaciones, estas 2.000 son
  //     las que conservo" sin poder ser contradicho por alguien que borre
  //     el archivo.
  // NO sobrevive a la rotación:
  //   · el CONTENIDO (hashes, hallazgos, voces) de los registros de la
  //     generación anterior a la ultima archivada: se sobreescriben y no
  //     hay forma de recuperarlos ni de auditar que decian. Si un cliente
  //     necesita retención de N meses, esta capa NO se la da por si sola:
  //     hay que exportar el archivo antes de cada rotación.
  //   · la detección de manipulación DENTRO de un archivo borrado: si
  //     alguien borra el fichero `.old` entero, se detecta que falta un
  //     tramo (el ancla lo prueba) pero no que decia.
  function rotateIfNeeded() {
    if (state.records.length <= maxActive) return null;
    var cut = state.records.length - keepAfter;
    var moved = state.records.slice(0, cut);
    var kept = state.records.slice(cut);
    var last = moved[moved.length - 1];

    try {
      atomicWriteJSON(archiveFile, {
        version: LEDGER_VERSION,
        rotatedAt: Date.now(),
        anchor: state.anchor,
        head: makeHead(moved, state.anchor),
        records: moved,
        nota: 'Generacion unica: la siguiente rotacion sobreescribe este fichero. Exportalo si necesitas retencion mas larga.',
      });
    } catch (e) {
      // Si no se puede archivar, NO se recortan los registros: el fichero
      // activo crece por encima del limite hasta que el archivado vuelva
      // a funcionar. Perder registros de auditoria para respetar un limite
      // de tamaño seria el peor intercambio posible en esta pieza.
      stats.rotationBlocked = true;
      stats.lastWriteError = 'archivado: ' + ((e.code ? e.code + ': ' : '') + e.message);
      return { ok: false, error: stats.lastWriteError };
    }

    state.anchor = signAnchor({
      seq: last.seq,
      hash: last.hash,
      rotatedCount: (state.anchor.rotatedCount || 0) + moved.length,
    });
    state.records = kept;
    stats.rotations++;
    stats.rotationBlocked = false;
    return { ok: true, moved: moved.length, keptActive: kept.length, anchorSeq: last.seq, archiveFile: archiveFile };
  }

  // ── API PUBLICA ──

  function recordVerification(entry) {
    var lockFile = file + '.lock';
    var haveLock = false;
    try {
      entry = entry || {};
      if (!entry.opcode) return { ok: false, error: 'opcode_requerido' };

      // Seccion critica entre procesos: sin esto, dos procesos que
      // escriben a la vez pierden registros de verdad (ver comentario
      // fechado 2026-08-18 junto a acquireLock/releaseLock mas arriba,
      // con la medicion real: 100 escritos, 33 sobrevivientes sin lock).
      haveLock = acquireLock(lockFile);
      if (!haveLock) {
        stats.writeFailures++;
        stats.lastWriteError = 'lock_timeout: otro proceso tiene el ledger bloqueado hace mas de ' + LOCK_TIMEOUT_MS + 'ms';
        return { ok: false, persisted: false, error: stats.lastWriteError };
      }

      // Releer del disco bajo el lock: otro proceso puede haber escrito
      // registros nuevos desde la ultima vez que este proceso toco el
      // fichero. Sin esto, seq/prevHash se calculan sobre una foto vieja
      // y el persist() de este proceso pisa lo que el otro acaba de
      // escribir (perdida silenciosa, exactamente el bug medido).
      loadFromDisk();
      if (stats.loadError && stats.loadError.indexOf('json_ilegible') === 0) handleUnreadableFile();

      var lastRec = state.records.length ? state.records[state.records.length - 1] : null;
      var prevHash = lastRec ? lastRec.hash : state.anchor.hash;
      var seq = (lastRec ? lastRec.seq : state.anchor.seq) + 1;

      var draft = typeof entry.draft === 'string' ? entry.draft : '';
      var query = typeof entry.query === 'string' ? entry.query : '';
      var storeContent = entry.storeContent === true;

      var body = {
        seq: seq,
        ts: (typeof entry.ts === 'number' && Number.isFinite(entry.ts)) ? entry.ts : Date.now(),
        opcode: String(entry.opcode).slice(0, 60),
        draftHash: sha256(draft),
        draftChars: draft.length,
        queryHash: sha256(query),
        queryChars: query.length,
        verifiers: normStringArray(entry.verifiers, MAX_VERIFIERS),
        findings: normFindings(entry.findings),
        voices: normVoices(entry.voices),
        latencyMs: (typeof entry.latencyMs === 'number' && Number.isFinite(entry.latencyMs)) ? Math.round(entry.latencyMs) : null,
        degraded: entry.degraded === true,
        degradedReason: entry.degraded === true
          ? (entry.degradedReason ? String(entry.degradedReason).slice(0, 200) : 'sin_detalle')
          : null,
        escalated: typeof entry.escalated === 'boolean' ? entry.escalated : null,
        relatedSeqs: normSeqs(entry.relatedSeqs),
        // Contenido completo: opt-in explicito por llamada. Por defecto NO
        // se guarda -- es a la vez una propiedad de privacidad (el ledger
        // no acumula lo que el usuario escribio) y de tamaño. Si se guarda
        // y excede el tope, se marca `truncated`: una copia truncada NO
        // reproduce draftHash, y presentarla como si lo hiciera seria
        // mentir en un registro de auditoria.
        content: storeContent ? {
          draft: draft.slice(0, MAX_STORED_CONTENT_CHARS),
          query: query.slice(0, MAX_STORED_CONTENT_CHARS),
          truncated: draft.length > MAX_STORED_CONTENT_CHARS || query.length > MAX_STORED_CONTENT_CHARS,
        } : null,
        prevHash: prevHash,
      };

      var hash = sha256(canonical(body));
      var record = Object.assign({}, body, { hash: hash, sig: hmacHex(secret, hash) });

      state.records.push(record);
      var rotated = rotateIfNeeded();
      var persisted = persist();

      // Bug real, encontrado en verificacion adversarial (2026-08-18,
      // fallo de escritura forzado con EISDIR): `ok` iba fijo a `true`
      // pase lo que pase con la escritura -- un caller que solo mira
      // `.ok` (el nombre de campo que usa el resto de este proyecto para
      // "esto funciono") creia que el registro quedo grabado cuando en
      // realidad `persisted` era `false`. Para un modulo cuyo unico
      // proposito es probar que algo se registro de verdad, `ok:true` con
      // `persisted:false` es exactamente la mentira que este proyecto
      // prohibe. El registro SIGUE en memoria (rotateIfNeeded()/el
      // siguiente record que se persista bien arrastraran este tambien,
      // ver stats.unpersistedRecords) -- eso no cambia -- pero la llamada
      // que fallo debe reportarlo como lo que es.
      return {
        ok: persisted,
        persisted: persisted,
        seq: seq,
        hash: hash,
        rotated: rotated,
        error: persisted ? null : stats.lastWriteError,
      };
    } catch (e) {
      stats.writeFailures++;
      stats.lastWriteError = e.message;
      return { ok: false, error: e.message };
    } finally {
      if (haveLock) releaseLock(lockFile);
    }
  }

  // Recorre un tramo (activo o archivado) y devuelve el PRIMER punto
  // donde deja de cerrar, con su indice real.
  function walkSegment(seg) {
    var out = {
      records: Array.isArray(seg.records) ? seg.records.length : 0,
      intact: false,
      brokenAt: null,
      brokenSeq: null,
      reason: null,
      firstSeq: null,
      lastSeq: null,
      anchorVerified: false,
      headVerified: false,
    };
    if (!seg || !Array.isArray(seg.records) || !seg.anchor) {
      out.reason = 'formato_desconocido';
      return out;
    }

    var a = seg.anchor;
    out.anchorVerified = safeHexEqual(a.sig || '', hmacHex(secret, canonical({ seq: a.seq, hash: a.hash, rotatedCount: a.rotatedCount })));
    if (!out.anchorVerified) {
      out.reason = 'ancla_con_firma_invalida';
      return out;
    }

    var expectedPrev = a.hash;
    var expectedSeq = a.seq + 1;
    for (var i = 0; i < seg.records.length; i++) {
      var r = seg.records[i];
      if (!r || typeof r !== 'object') {
        out.brokenAt = i; out.reason = 'registro_no_es_objeto'; return out;
      }
      if (r.seq !== expectedSeq) {
        out.brokenAt = i; out.brokenSeq = r.seq;
        out.reason = 'seq_no_consecutivo (se esperaba ' + expectedSeq + ', hay ' + r.seq + ') -- registro eliminado o insertado';
        return out;
      }
      if (r.prevHash !== expectedPrev) {
        out.brokenAt = i; out.brokenSeq = r.seq;
        out.reason = 'prevHash_no_enlaza_con_el_registro_anterior';
        return out;
      }
      var body = Object.assign({}, r);
      delete body.hash;
      delete body.sig;
      var recomputed = sha256(canonical(body));
      if (recomputed !== r.hash) {
        out.brokenAt = i; out.brokenSeq = r.seq;
        out.reason = 'contenido_alterado: el hash del registro no corresponde a su contenido';
        return out;
      }
      if (!safeHexEqual(r.sig || '', hmacHex(secret, r.hash))) {
        out.brokenAt = i; out.brokenSeq = r.seq;
        out.reason = 'firma_hmac_invalida: el registro no fue firmado por esta instalacion';
        return out;
      }
      expectedPrev = r.hash;
      expectedSeq = r.seq + 1;
    }

    // La cabecera firmada es lo que hace detectable el borrado de los
    // ULTIMOS registros: sin ella, truncar la cola deja una cadena
    // internamente perfecta, solo mas corta.
    var h = seg.head;
    if (h) {
      out.headVerified = safeHexEqual(h.sig || '', hmacHex(secret, canonical({ seq: h.seq, hash: h.hash, count: h.count })));
      if (!out.headVerified) {
        out.reason = 'cabecera_con_firma_invalida';
        return out;
      }
      if (h.count !== seg.records.length || h.hash !== expectedPrev) {
        out.reason = 'cabecera_no_coincide_con_los_registros (firmados ' + h.count + ', hay ' + seg.records.length + ') -- cola truncada';
        out.brokenAt = seg.records.length;
        return out;
      }
    } else {
      out.reason = 'sin_cabecera_firmada';
      return out;
    }

    out.intact = true;
    out.firstSeq = seg.records.length ? seg.records[0].seq : null;
    out.lastSeq = seg.records.length ? seg.records[seg.records.length - 1].seq : null;
    return out;
  }

  function readSegmentFile(target) {
    var raw;
    try {
      raw = fs.readFileSync(target, 'utf-8');
    } catch (e) {
      return { present: false, error: e.code === 'ENOENT' ? null : (e.code + ': ' + e.message) };
    }
    try {
      return { present: true, data: JSON.parse(raw), bytes: Buffer.byteLength(raw, 'utf8') };
    } catch (e) {
      return { present: true, error: 'json_ilegible: ' + e.message };
    }
  }

  // Lee SIEMPRE del disco, nunca del estado en memoria: la pregunta que
  // contesta es "¿el fichero que hay ahora mismo en disco sigue cerrando?",
  // y validar la copia en RAM no contestaria eso.
  function verifyLedgerIntegrity() {
    var active = readSegmentFile(file);
    if (!active.present) {
      return {
        ok: true, intact: true, empty: true, file: file, records: 0,
        note: active.error ? ('no se pudo leer: ' + active.error) : 'ledger vacio: todavia no se ha registrado ninguna verificacion',
        chainIntact: !active.error,
      };
    }
    if (active.error) {
      return { ok: false, intact: false, chainIntact: false, file: file, reason: active.error, records: 0 };
    }

    var res = walkSegment(active.data);
    var arch = readSegmentFile(archiveFile);
    var archiveReport = { present: false };

    if (arch.present && !arch.error) {
      var archRes = walkSegment(arch.data);
      var link = 'roto';
      var activeAnchorHash = active.data.anchor ? active.data.anchor.hash : null;
      var archHead = arch.data.head;
      if (archHead && archHead.hash === activeAnchorHash) {
        link = 'ok';
      } else if (Array.isArray(arch.data.records) && arch.data.records.some(function (r) { return r && r.hash === activeAnchorHash; })) {
        // El archivo contiene registros POSTERIORES al ancla del activo:
        // eso es una rotacion interrumpida a medias (el archivo se escribe
        // antes que el activo, a proposito, para que un corte pierda como
        // mucho en duplicado y nunca en registros perdidos), no una
        // manipulacion. Se nombra distinto para no acusar de lo que no es.
        link = 'rotacion_interrumpida';
      } else if (activeAnchorHash === GENESIS_HASH) {
        link = 'archivo_huerfano: el ledger activo arranca de cero pero existe un archivo previo';
      }
      archiveReport = {
        present: true, file: archiveFile, records: archRes.records, intact: archRes.intact,
        brokenAt: archRes.brokenAt, brokenSeq: archRes.brokenSeq, reason: archRes.reason,
        firstSeq: archRes.firstSeq, lastSeq: archRes.lastSeq, link: link,
      };
    } else if (arch.present && arch.error) {
      archiveReport = { present: true, file: archiveFile, intact: false, reason: arch.error, link: 'ilegible' };
    }

    var anchor = active.data.anchor || {};
    var rotatedCount = anchor.rotatedCount || 0;
    var chainIntact = res.intact && (!archiveReport.present || (archiveReport.intact && archiveReport.link === 'ok'));

    return {
      ok: true,
      intact: res.intact,
      chainIntact: chainIntact,
      file: file,
      bytes: active.bytes,
      records: res.records,
      firstSeq: res.firstSeq,
      lastSeq: res.lastSeq,
      brokenAt: res.brokenAt,
      brokenSeq: res.brokenSeq,
      reason: res.reason,
      anchorVerified: res.anchorVerified,
      headVerified: res.headVerified,
      rotatedOut: rotatedCount,
      totalEverRecorded: rotatedCount + res.records,
      archive: archiveReport,
    };
  }

  function queryLedger(filters) {
    filters = filters || {};
    var pool = state.records.slice();
    if (filters.includeArchive === true) {
      var arch = readSegmentFile(archiveFile);
      if (arch.present && !arch.error && Array.isArray(arch.data.records)) {
        pool = arch.data.records.concat(pool);
      }
    }
    var since = typeof filters.since === 'number' ? filters.since : null;
    var until = typeof filters.until === 'number' ? filters.until : null;
    var opcode = filters.opcode ? String(filters.opcode).toUpperCase() : null;

    var out = pool.filter(function (r) {
      if (since !== null && r.ts < since) return false;
      if (until !== null && r.ts > until) return false;
      if (opcode && String(r.opcode).toUpperCase().indexOf(opcode) === -1) return false;
      if (filters.hasFindings === true && !(r.findings && r.findings.total > 0)) return false;
      if (filters.hasFindings === false && r.findings && r.findings.total > 0) return false;
      if (filters.degraded === true && r.degraded !== true) return false;
      return true;
    });

    out.sort(function (a, b) { return b.seq - a.seq; });
    var limit = (typeof filters.limit === 'number' && filters.limit > 0) ? Math.floor(filters.limit) : 20;
    return out.slice(0, limit);
  }

  function getAuditStats() {
    var byOpcode = {};
    var withFindings = 0;
    var degraded = 0;
    for (var i = 0; i < state.records.length; i++) {
      var r = state.records[i];
      byOpcode[r.opcode] = (byOpcode[r.opcode] || 0) + 1;
      if (r.findings && r.findings.total > 0) withFindings++;
      if (r.degraded) degraded++;
    }
    var bytes = null;
    try { bytes = fs.statSync(file).size; } catch (e) {}
    var archiveBytes = null;
    try { archiveBytes = fs.statSync(archiveFile).size; } catch (e) {}

    return {
      file: file,
      archiveFile: archiveFile,
      records: state.records.length,
      firstSeq: state.records.length ? state.records[0].seq : null,
      lastSeq: state.records.length ? state.records[state.records.length - 1].seq : null,
      rotatedOut: state.anchor.rotatedCount || 0,
      totalEverRecorded: (state.anchor.rotatedCount || 0) + state.records.length,
      byOpcode: byOpcode,
      withFindings: withFindings,
      degraded: degraded,
      maxActiveRecords: maxActive,
      keepAfterRotation: keepAfter,
      rotations: stats.rotations,
      rotationBlocked: stats.rotationBlocked,
      writeFailures: stats.writeFailures,
      unpersistedRecords: stats.unpersistedRecords,
      lastWriteError: stats.lastWriteError,
      loadError: stats.loadError,
      bytes: bytes,
      archiveBytes: archiveBytes,
    };
  }

  return {
    file: file,
    archiveFile: archiveFile,
    recordVerification: recordVerification,
    verifyLedgerIntegrity: verifyLedgerIntegrity,
    queryLedger: queryLedger,
    getAuditStats: getAuditStats,
  };
}

// ── SINGLETON POR DEFECTO (~/.linkcore/audit-ledger.json) ──

var _default = null;
function defaultLedger() {
  if (!_default) _default = createAuditLedger({});
  return _default;
}

export function recordVerification(entry) { return defaultLedger().recordVerification(entry); }
export function verifyLedgerIntegrity() { return defaultLedger().verifyLedgerIntegrity(); }
export function queryLedger(filters) { return defaultLedger().queryLedger(filters); }
export function getAuditStats() { return defaultLedger().getAuditStats(); }
