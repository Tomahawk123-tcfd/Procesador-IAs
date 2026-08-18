// ═══════════════════════════════════════════════════════════════
// localStorage SHIM PARA NODE.JS
//
// El motor (engine/memory.js, intent-memory.js, work-ledger.js,
// settings.js, learning-loop.js, backend.js, github-agent.js, repos.js,
// services.js, tools.js) llama a `localStorage.getItem/setItem` tal
// cual, sin ninguna comprobacion de entorno -- exactamente como se
// escribio para el navegador. En vez de tocar esos archivos (el motor
// se mantiene igual, segun se pidio), se instala un objeto global
// `localStorage` con la MISMA interfaz antes de importar nada del
// motor, respaldado por un fichero JSON en disco en vez de en memoria
// del navegador.
//
// Todo el motor ya envuelve sus lecturas/escrituras en try/catch
// silencioso (el mismo patron que loadManualMemory/saveManualMemory
// en backend.js) -- si este shim fallara por lo que sea, el motor
// simplemente pierde la persistencia, nunca crashea por su culpa.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

var DATA_DIR = path.join(os.homedir(), '.linkcore');
var DATA_FILE = path.join(DATA_DIR, 'storage.json');

function readAll() {
  try {
    var raw = fs.readFileSync(DATA_FILE, 'utf-8');
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

// mtime del fichero tal y como lo vio este proceso la ultima vez que
// leyo o escribio. Se usa solo como deteccion best-effort de un
// segundo escritor (bug 2) -- no hay merge real, solo aviso.
function getMtimeMs() {
  try {
    return fs.statSync(DATA_FILE).mtimeMs;
  } catch (e) {
    return null;
  }
}

function writeAll(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Deteccion best-effort de dos escritores (bug 2, 2026-08-17): si el
    // mtime en disco ya no coincide con el que vimos en la ultima
    // lectura/escritura propia, otro proceso escribio storage.json entre
    // medias. No hacemos merge (requeriria rediseno grande) -- solo se
    // avisa, porque el writeAll de mas abajo va a pisar ese cambio ajeno.
    var currentMtimeMs = getMtimeMs();
    if (_lastSeenMtimeMs !== null && currentMtimeMs !== null && currentMtimeMs !== _lastSeenMtimeMs) {
      console.warn('[LinkCore] storage.json fue modificado por otro proceso desde la ultima lectura -- posible perdida de datos');
    }

    // Escritura atomica (bug 1, 2026-08-17): escribir directo con
    // writeFileSync deja el fichero truncado/invalido si el proceso
    // muere a mitad de escritura (crash, taskkill, corte de luz).
    // readAll() interpretaria eso como JSON invalido y devolveria {} en
    // el siguiente arranque -- perdida silenciosa de cache, circuit
    // breaker, MCTS, work-ledger, cache semantica e intent-memory.
    // Escribir a un temporal (con pid para no chocar con otro proceso
    // que escriba a la vez) y hacer rename() -- atomico en el mismo
    // filesystem -- deja siempre el fichero viejo valido o el nuevo
    // completo, nunca algo a medias.
    var tmpFile = DATA_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(store), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);

    _lastSeenMtimeMs = getMtimeMs();
  } catch (e) {
    // Silencioso a proposito: el motor ya asume que setItem puede no
    // persistir de verdad (mismo contrato que localStorage del
    // navegador en modo privado, que tambien puede fallar en silencio).
  }
}

// Cache en memoria del proceso para no leer el fichero entero en cada
// getItem -- se recarga solo al arrancar el proceso. Un servicio de
// fondo vive en UN proceso durante horas/dias, asi que releer el
// fichero en cada llamada seria I/O innecesario; el propio proceso es
// el unico escritor mientras esta vivo.
var _cache = readAll();
var _lastSeenMtimeMs = getMtimeMs();

export var localStorage = {
  getItem: function (key) {
    return Object.prototype.hasOwnProperty.call(_cache, key) ? _cache[key] : null;
  },
  setItem: function (key, value) {
    _cache[key] = String(value);
    writeAll(_cache);
  },
  removeItem: function (key) {
    delete _cache[key];
    writeAll(_cache);
  },
  clear: function () {
    _cache = {};
    writeAll(_cache);
  },
  key: function (index) {
    var keys = Object.keys(_cache);
    return index >= 0 && index < keys.length ? keys[index] : null;
  },
  get length() {
    return Object.keys(_cache).length;
  },
};

// Se instala como global ANTES de que cualquier import toque el motor
// -- installGlobalShim() debe ser lo primero que se llama en
// index.js/bin/linkcore-cli.js, antes de cualquier `import`.
export function installGlobalShim() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
  if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage.__linkcoreShim) {
    globalThis.localStorage = localStorage;
    globalThis.localStorage.__linkcoreShim = true;
  }
  return DATA_FILE;
}
