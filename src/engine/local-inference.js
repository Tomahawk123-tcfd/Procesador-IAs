// ── INFERENCIA LOCAL EN PROCESO, AISLADA POR WORKER -- ESTADO REAL
// (2026-08-17): FIABLE Y VERIFICADO (15/15 llamadas reales limpias en
// secuencia), pero NO es el camino recomendado para wirear al pipeline
// real -- ver el porque al final de esta cabecera. Todavia NO esta
// conectado a backend.js/ensemble-v2.js a proposito (decision explicita de
// la sesion de hoy, ver mas abajo).
//
// Lo que SI esta verificado en vivo: cargar un modelo GGUF y generar
// DIRECTAMENTE en el hilo principal (sin worker) es real y 10-15x mas
// rapido que Ollama por HTTP -- ver scripts/poc-node-llama-cpp.mjs (3/3
// corridas limpias hoy, ~27s total incl. carga de motor+modelo+contexto,
// generacion sola ~10-11s). Tambien esta verificado que resolveGgufPath()
// encuentra el blob correcto sin necesitar copiarlo a .gguf (node-llama-cpp
// lee el contenido, no la extension).
//
// Sesion anterior (2026-08-16): cuelgues/crashes intermitentes sin
// diagnosticar ("colgo mas de 137s pese a un timeout de 30s", "crasheo sin
// mensaje de error").
//
// Sesion de hoy (2026-08-17), diagnostico riguroso (>15 repeticiones reales
// por hipotesis, ver scripts/debug-worker-*.mjs y scripts/debug-child-*.mjs):
// se encontraron DOS causas raiz reales, ambas ya corregidas en este
// archivo y en local-model-worker.js:
//
// 1) `temperature` explicito en session.prompt() (este archivo lo mandaba
//    siempre via workerData.temperature, con default 0.3 en el worker)
//    dispara un fallo nativo intermitente de node-llama-cpp en esta
//    maquina (Windows + Vulkan/AMD iGPU) -- cuelgue o crash (exit code 3)
//    sin patron determinista. Reproducido aislado en worker_thread,
//    child_process.fork() Y proceso principal plano por igual -- confirma
//    que no es un bug de worker_threads. Fix: ya no se manda temperature,
//    se usa el sampler por defecto de la libreria.
//
// 2) worker.terminate() en el camino de EXITO de runInProcessModel() (mas
//    abajo en este archivo) -- fire-and-forget justo antes de resolve(),
//    para no bloquear al llamador -- coincide con un bug documentado de
//    Node en Windows (nodejs/node#41107): un addon nativo cargado en un
//    worker_thread puede crashear el proceso ENTERO al terminar ese hilo,
//    o dejar terminate() colgado sin resolver nunca. Fix: ya no se llama a
//    terminate() en el camino de exito -- el worker se libera solo (natural
//    exit tras postMessage). terminate() se mantiene SOLO en el camino de
//    timeout (worker realmente colgado, riesgo aceptado porque la
//    alternativa es peor: el worker ocupando el proceso para siempre).
//
// Con ambos fixes: 15/15 limpias (scripts/debug-worker-no-temperature-
// repeated.mjs). Sin ninguno: 0/6 (siempre cuelgue o crash).
//
// Por que este archivo SIGUE sin recomendarse para el pipeline real: cada
// worker_thread es un V8 isolate nuevo, asi que CADA llamada recarga el
// modelo GGUF entero (~7-9s medidos, qwen2.5:1.5b) -- no hay forma de
// mantener el modelo caliente entre llamadas con el patron "un worker por
// llamada" de este archivo. Un child_process.fork() persistente (carga el
// modelo UNA vez, responde a multiples peticiones via IPC) da el mismo
// aislamiento de forma mas fuerte (proceso del SO, no isolate de V8 --
// mata el bug #41107 de raiz) y ~65-120ms por llamada tras el primer
// arranque en vez de 7-9s cada vez -- medido en vivo, 45/45 llamadas
// limpias en 3 corridas de 15 (scripts/debug-child-persistent.mjs +
// scripts/debug-child-persistent-inner.mjs). Ese es el camino a construir
// de verdad para el pipeline; este archivo queda como referencia fiable
// del patron worker_thread, no como el que se debe conectar.
//
// Reusa los pesos que Ollama ya descargo -- no se duplica el modelo. Ollama
// guarda cada capa como un blob con hash sha256 (sin extension .gguf) mas
// un manifest JSON que mapea "modelo:tag" -> hash del blob. Se lee ese
// manifest en vez de asumir una ruta fija (los blobs son contenido GGUF
// real, solo les falta el nombre de archivo).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var WORKER_SCRIPT = path.join(__dirname, 'local-model-worker.js');
var OLLAMA_MODELS_DIR = path.join(os.homedir(), '.ollama', 'models');

var ggufPathCache = {};

// "llama3.2:1b-instruct-q4_K_M" -> manifests/registry.ollama.ai/library/llama3.2/1b-instruct-q4_K_M
function resolveGgufPath(modelId) {
  if (ggufPathCache[modelId]) return ggufPathCache[modelId];

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
  if (!fs.existsSync(blobPath)) return null;

  // Verificado en vivo (2026-08-16): node-llama-cpp carga el blob de
  // Ollama directamente, SIN necesitar renombrarlo a .gguf -- detecta el
  // formato por contenido (magic bytes GGUF), no por extension. Sin copia,
  // sin duplicar espacio en disco ni tiempo de I/O extra.
  ggufPathCache[modelId] = blobPath;
  return blobPath;
}

export function isLocalInferenceAvailable(modelId) {
  return resolveGgufPath(modelId) !== null;
}

// Misma forma de resultado que callOllamaModel (backend.js) a proposito --
// cualquier consumidor existente (callAI, G-STACK via callAI, el ensemble)
// puede usar este camino sin que le cambie el contrato.
export async function runInProcessModel(modelId, prompt, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  var ggufPath = resolveGgufPath(modelId);
  if (!ggufPath) {
    return { ok: false, model: modelId, error: 'modelo_no_encontrado_en_ollama' };
  }

  return new Promise(function (resolve) {
    var worker = new Worker(WORKER_SCRIPT, {
      workerData: {
        modelPath: ggufPath,
        prompt: prompt,
        contextSize: opts.contextSize || 2048,
        maxTokens: opts.maxTokens || 400,
        // Ya NO se manda `temperature` a workerData (2026-08-17) --
        // local-model-worker.js ya no la lee, ver el porque en la cabecera
        // de ese archivo (bug real: temperature explicito crashea/cuelga
        // el sampler nativo de node-llama-cpp en esta maquina).
      },
    });

    var settled = false;
    var timeoutMs = opts.timeoutMs || 60000;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      // terminate() en el camino de timeout SI sigue siendo necesario --
      // sin el, un worker realmente colgado se queda ocupando el proceso
      // para siempre. Riesgo conocido y aceptado (ver mas abajo): esta
      // MISMA llamada puede volver a crashear o colgar el proceso por el
      // bug de Windows documentado en nodejs/node#41107 (addon nativo +
      // terminate() de worker_thread). No hay alternativa mejor en este
      // camino -- ya es una ejecucion degradada.
      worker.terminate().catch(function () {});
      resolve({ ok: false, model: modelId, error: 'timeout' });
    }, timeoutMs);

    worker.on('message', function (msg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Bug real, confirmado en vivo (2026-08-17): llamar a
      // worker.terminate() aqui, en el camino de EXITO (fire-and-forget,
      // justo antes de resolve(), para no bloquear al llamador) es la
      // causa real del cuelgue/crash intermitente reportado en la sesion
      // anterior -- no la creacion del worker en si. Matches un bug
      // documentado de Node en Windows (nodejs/node#41107): un addon
      // nativo (aqui, node-llama-cpp/Vulkan) cargado en un worker_thread
      // puede crashear el PROCESO ENTERO con violacion de acceso al
      // terminar ese hilo, y a veces terminate() simplemente nunca
      // resuelve (el hilo nativo no llega a liberar sus recursos), dejando
      // el proceso vivo pero colgado para siempre aunque este handler ya
      // haya "resuelto" logicamente. Verificado: quitar esta llamada y
      // dejar que el worker termine solo (ver worker.on('exit') mas abajo,
      // que ya no fuerza nada) dio 15/15 llamadas reales limpias en
      // secuencia -- ver scripts/debug-worker-no-temperature-repeated.mjs.
      // El worker se libera solo cuando su propio script termina de
      // ejecutar (no le queda trabajo pendiente tras postMessage), sin
      // necesitar que el padre lo mate.
      if (msg && msg.ok) {
        resolve({ ok: true, model: modelId, text: msg.text, latencyMs: Date.now() - startedAt, provider: 'node-llama-cpp-worker' });
      } else {
        resolve({ ok: false, model: modelId, error: (msg && msg.error) || 'sin_respuesta' });
      }
    });

    // Verificado en vivo (2026-08-17): este handler SI se dispara en un
    // crash nativo real de vez en cuando (no siempre -- ver cabecera del
    // archivo, el otro modo de fallo es un cuelgue sin ningun evento).
    worker.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, model: modelId, error: (err && err.message) || 'worker_crash' });
    });

    worker.on('exit', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, model: modelId, error: 'worker_exit_' + code });
    });
  });
}
