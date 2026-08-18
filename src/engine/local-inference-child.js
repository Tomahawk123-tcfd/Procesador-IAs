// ── INFERENCIA LOCAL EN PROCESO -- CAMINO DE PRODUCCION REAL (2026-08-17).
// child_process.fork() PERSISTENTE, uno por ruta de modelo, reutilizado
// entre llamadas. Este es el camino verificado como el bueno para wirear
// al pipeline real -- NO local-inference.js/local-model-worker.js (ver las
// cabeceras de esos dos archivos para la investigacion completa que lo
// demuestra). Resumen honesto de la diferencia:
//
//   local-inference.js#runInProcessModel() lanza un worker_thread NUEVO
//   por cada llamada. Fiable (15/15 en pruebas reales) con los mismos dos
//   fixes de abajo, pero cada worker_thread es un V8 isolate nuevo, asi
//   que CADA llamada recarga el modelo GGUF entero desde cero (~7-9s
//   medidos, qwen2.5:1.5b) -- no hay forma de mantener el modelo caliente
//   entre llamadas con ese patron.
//
//   Este archivo mantiene un REGISTRO de child processes vivos (uno por
//   ruta de modelo resuelta) y los REUTILIZA: getOrCreatePersistentModel()
//   solo hace fork() si no hay ya un child vivo para esa ruta. El modelo
//   se carga UNA VEZ (~8s) y las llamadas siguientes van via IPC sobre un
//   proceso ya caliente -- medido en la investigacion de esta sesion,
//   45/45 llamadas limpias en 3 corridas de 15, 65-122ms por llamada tras
//   el arranque (scripts/debug-child-persistent.mjs +
//   scripts/debug-child-persistent-inner.mjs). El script hijo real que
//   corre dentro de cada child es local-inference-child-worker.js,
//   contraparte de produccion de ese script de diagnostico -- preserva el
//   mismo patron exacto, con dos fixes de raiz encontrados esa noche:
//
//   1) Nunca pasar `temperature` explicito a session.prompt() -- dispara
//      un fallo nativo intermitente (cuelgue o crash) en node-llama-cpp
//      3.20.0 sobre esta maquina (Windows + Vulkan/AMD iGPU).
//   2) El primer session.prompt() del proceso hijo se hace como
//      "calentamiento" en la cadena top-level de init(), ANTES de
//      registrar el listener de IPC -- dispararlo desde un callback de
//      evento crasheo de forma reproducible en la investigacion.
//
// Todavia NO esta conectado a backend.js/ensemble-v2.js a proposito
// (decision explicita de esta sesion) -- ese wiring es trabajo real pero
// separado. Misma forma de resultado que callOllamaModel() (backend.js) a
// proposito -- {ok, text, model, provider, latencyMs} -- para que un
// futuro consumidor pueda tratarlo como un proveedor alternativo mas sin
// que le cambie el contrato.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var CHILD_SCRIPT = path.join(__dirname, 'local-inference-child-worker.js');
var OLLAMA_MODELS_DIR = path.join(os.homedir(), '.ollama', 'models');

// Registro de children vivos, uno por ruta de modelo resuelta y
// normalizada (Windows no distingue mayusculas/minusculas en rutas).
// registryKey -> entry (ver forma de entry en getOrCreatePersistentModel).
var registry = new Map();

// Contador de forks REALES por ruta de modelo, separado del registro --
// sobrevive a un crash/shutdown para que el numero de spawns real quede
// visible incluso despues de que la entry se borre del registro.
var spawnCounts = new Map();

// Mismo algoritmo que resolveGgufPath() en local-inference.js, duplicado a
// proposito (este modulo no depende de la forma interna de ese archivo):
// "modelo:tag" de Ollama -> ruta del blob GGUF real en disco.
function resolveOllamaModelPath(modelId) {
  var parts = modelId.split(':');
  var name = parts[0];
  var tag = parts[1] || 'latest';
  var manifestPath = path.join(OLLAMA_MODELS_DIR, 'manifests', 'registry.ollama.ai', 'library', name, tag);
  if (!fs.existsSync(manifestPath)) return null;

  var manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return null;
  }

  var modelLayer = (manifest.layers || []).find(function (l) {
    return l.mediaType === 'application/vnd.ollama.image.model';
  });
  if (!modelLayer || !modelLayer.digest) return null;

  var blobHash = modelLayer.digest.replace('sha256:', 'sha256-');
  var blobPath = path.join(OLLAMA_MODELS_DIR, 'blobs', blobHash);
  return fs.existsSync(blobPath) ? blobPath : null;
}

// Acepta una ruta de archivo GGUF directa (la usa tal cual -- es lo que
// esperan los scripts de diagnostico via LC_MODEL_PATH) o un "modelo:tag"
// de Ollama (lo resuelve al blob real). null si no encuentra nada.
function resolveModelPath(modelPathOrId) {
  if (fs.existsSync(modelPathOrId)) return modelPathOrId;
  return resolveOllamaModelPath(modelPathOrId);
}

function registryKey(resolvedPath) {
  return resolvedPath.toLowerCase();
}

export function isPersistentModelAvailable(modelPathOrId) {
  return resolveModelPath(modelPathOrId) !== null;
}

// Devuelve un "handle" -- el mismo objeto de registro interno, con
// handle.ok indicando si esta listo para usarse. Si ya hay un child vivo
// para esta ruta de modelo, lo reutiliza SIN forkear uno nuevo (esa es la
// diferencia real frente a local-inference.js). opts.contextSize solo
// aplica al fork nuevo -- si se reutiliza un child existente, mantiene el
// contextSize con el que arranco.
export function getOrCreatePersistentModel(modelPath, opts) {
  opts = opts || {};
  var resolved = resolveModelPath(modelPath);
  if (!resolved) {
    return Promise.resolve({ ok: false, error: 'modelo_no_encontrado: ' + modelPath });
  }
  var key = registryKey(resolved);

  var existing = registry.get(key);
  if (existing && (existing.state === 'ready' || existing.state === 'starting')) {
    existing.reuseCount = (existing.reuseCount || 0) + 1;
    return existing.readyPromise.then(function () {
      return existing;
    });
  }

  var spawnCount = (spawnCounts.get(key) || 0) + 1;
  spawnCounts.set(key, spawnCount);

  var entry = {
    ok: false,
    error: null,
    modelPath: resolved,
    child: null,
    state: 'starting',
    nextRequestId: 1,
    pending: new Map(),
    spawnCount: spawnCount,
    reuseCount: 0,
    createdAt: Date.now(),
    loadMs: null,
    gpu: null,
    pid: null,
  };
  registry.set(key, entry);

  entry.readyPromise = new Promise(function (resolveReady) {
    var contextSize = opts.contextSize || 2048;
    var child = fork(CHILD_SCRIPT, [], {
      env: Object.assign({}, process.env, {
        LC_MODEL_PATH: resolved,
        LC_CONTEXT_SIZE: String(contextSize),
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    entry.child = child;
    entry.pid = child.pid;

    child.stdout && child.stdout.on('data', function (buf) {
      console.log('[LinkCore] local-inference-child(' + child.pid + '): ' + buf.toString().trim());
    });
    child.stderr && child.stderr.on('data', function (buf) {
      console.error('[LinkCore] local-inference-child(' + child.pid + ') stderr: ' + buf.toString().trim());
    });

    var settledReady = false;
    var readyTimeoutMs = opts.readyTimeoutMs || 60000;
    var readyTimer = setTimeout(function () {
      if (settledReady) return;
      settledReady = true;
      entry.ok = false;
      entry.error = 'timeout_esperando_ready';
      entry.state = 'crashed';
      try { child.kill(); } catch (e) {}
      resolveReady();
    }, readyTimeoutMs);

    child.on('message', function (msg) {
      if (!msg) return;

      if (msg.type === 'ready') {
        if (settledReady) return;
        settledReady = true;
        clearTimeout(readyTimer);
        if (msg.ok === false) {
          entry.ok = false;
          entry.error = msg.error || 'fallo_init_child';
          entry.state = 'crashed';
        } else {
          entry.ok = true;
          entry.state = 'ready';
          entry.gpu = msg.gpu;
          entry.loadMs = msg.loadMs;
        }
        resolveReady();
        return;
      }

      if (msg.type === 'result') {
        var pending = entry.pending.get(msg.id);
        if (!pending) return;
        entry.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve({ ok: true, text: msg.text, latencyMs: msg.latencyMs });
        } else {
          pending.resolve({ ok: false, error: msg.error || 'sin_respuesta' });
        }
        return;
      }

      if (msg.type === 'crash') {
        console.error('[LinkCore] local-inference-child(' + child.pid + ') crash reportado: ' + msg.error);
      }
    });

    // Cubre TANTO un crash nativo (exit code distinto de 0/null sin
    // mensaje previo) COMO una salida limpia inesperada (p.ej. alguien
    // llama a child.kill() por fuera de shutdownPersistentModel). En
    // cualquier caso: cualquier peticion todavia en vuelo no va a recibir
    // nunca su 'result' -- se resuelve aqui como fallo limpio, nunca se
    // deja una promesa colgada para siempre.
    child.on('exit', function (code, signal) {
      entry.state = entry.state === 'shutdown' ? 'shutdown' : 'crashed';
      if (!settledReady) {
        settledReady = true;
        clearTimeout(readyTimer);
        entry.ok = false;
        entry.error = 'child_exit_antes_de_ready code=' + code + ' signal=' + signal;
        resolveReady();
      }
      entry.pending.forEach(function (pending) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: 'child_exit code=' + code + ' signal=' + signal });
      });
      entry.pending.clear();
      if (registry.get(key) === entry) registry.delete(key);
    });

    child.on('error', function (err) {
      if (!settledReady) {
        settledReady = true;
        clearTimeout(readyTimer);
        entry.ok = false;
        entry.error = (err && err.message) || 'child_error';
        entry.state = 'crashed';
        resolveReady();
      }
    });
  });

  return entry.readyPromise.then(function () {
    return entry;
  });
}

// Manda un prompt al child ya vivo referenciado por `handle` (el objeto
// devuelto por getOrCreatePersistentModel) y resuelve con
// {ok, text, model, provider, latencyMs} -- misma forma que
// callOllamaModel() en backend.js a proposito. Nunca deja la promesa sin
// resolver: timeout real (opts.timeoutMs, default 30s) via setTimeout, y
// cualquier crash/exit del child en medio de la espera resuelve la
// pendiente desde el handler 'exit' de arriba -- no hay camino que quede
// colgado ni que produzca un unhandledRejection.
export function promptPersistentModel(handle, promptText, opts) {
  opts = opts || {};
  var startedAt = Date.now();

  if (!handle || !handle.ok) {
    return Promise.resolve({
      ok: false,
      model: handle && handle.modelPath,
      provider: 'node-llama-cpp-child',
      error: (handle && handle.error) || 'handle_invalido',
    });
  }
  if (handle.state !== 'ready' || !handle.child) {
    return Promise.resolve({
      ok: false,
      model: handle.modelPath,
      provider: 'node-llama-cpp-child',
      error: 'child_no_disponible (state=' + handle.state + ')',
    });
  }

  return new Promise(function (resolve) {
    var id = handle.nextRequestId++;
    var timeoutMs = opts.timeoutMs || 30000;

    var timer = setTimeout(function () {
      if (!handle.pending.has(id)) return;
      handle.pending.delete(id);
      resolve({
        ok: false,
        model: handle.modelPath,
        provider: 'node-llama-cpp-child',
        error: 'timeout',
        latencyMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    handle.pending.set(id, {
      timer: timer,
      resolve: function (result) {
        resolve(Object.assign(
          { model: handle.modelPath, provider: 'node-llama-cpp-child' },
          result,
          { latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : Date.now() - startedAt }
        ));
      },
    });

    var sent;
    try {
      sent = handle.child.send({ type: 'prompt', id: id, prompt: promptText, maxTokens: opts.maxTokens || 400, systemPrompt: opts.systemPrompt || null });
    } catch (e) {
      sent = false;
    }
    if (!sent) {
      clearTimeout(timer);
      handle.pending.delete(id);
      resolve({
        ok: false,
        model: handle.modelPath,
        provider: 'node-llama-cpp-child',
        error: 'ipc_send_fallo (canal cerrado)',
      });
    }
  });
}

// Libera el child referenciado por `handle`. Cualquier peticion en vuelo
// se resuelve como cancelada (nunca colgada). Espera a que el SO confirme
// la salida real del proceso (evento 'exit') antes de resolver -- si no
// llega en 5s, fuerza SIGKILL. El SO garantiza que matar el proceso libera
// TODOS los recursos nativos (Vulkan, hilos, memoria) sin depender de que
// node-llama-cpp coopere -- la misma razon de fondo por la que este
// archivo usa child_process.fork() en vez de worker_threads (ver cabecera).
export function shutdownPersistentModel(handle) {
  if (!handle || !handle.child || handle.state === 'shutdown') {
    return Promise.resolve({ ok: true, alreadyDown: true });
  }

  var child = handle.child;
  var key = registryKey(handle.modelPath);

  handle.pending.forEach(function (pending) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: 'shutdown_solicitado' });
  });
  handle.pending.clear();
  handle.state = 'shutdown';
  if (registry.get(key) === handle) registry.delete(key);

  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve({ ok: true, forced: true });
    }, 5000);

    child.once('exit', function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, forced: false });
    });

    try {
      child.kill();
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, forced: false, killError: (e && e.message) || String(e) });
      }
    }
  });
}

// Apaga TODOS los children vivos del registro -- util al parar el
// servicio entero o al cerrar una suite de tests, para no dejar procesos
// huerfanos aunque el llamador haya perdido la referencia a algun handle.
export function shutdownAllPersistentModels() {
  var handles = Array.from(registry.values());
  return Promise.all(handles.map(shutdownPersistentModel));
}
