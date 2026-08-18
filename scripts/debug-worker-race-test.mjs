// Diagnostico (2026-08-17): reproduce el patron EXACTO de
// runInProcessModel (local-inference.js) -- worker.terminate() lanzado
// como "fire and forget" (.catch() sin await) justo antes de resolve(),
// de forma que el llamador puede crear el SIGUIENTE Worker con
// node-llama-cpp mientras el anterior TODAVIA esta liberando sus recursos
// nativos de Vulkan en segundo plano. argv[2] = 'race' (patron actual,
// sin esperar) | 'fixed' (espera confirmada a que el worker anterior haya
// terminado del todo, incluyendo el evento 'exit', antes de continuar).
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var WORKER_SCRIPT = path.join(__dirname, '..', 'src', 'engine', 'local-model-worker.js');
var MODEL_PATH = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';
var mode = process.argv[2] || 'race';

function runOnce(label) {
  return new Promise(function (resolve) {
    var worker = new Worker(WORKER_SCRIPT, {
      workerData: { modelPath: MODEL_PATH, prompt: 'Di una palabra.', contextSize: 2048, maxTokens: 20 },
    });
    var settled = false;

    var safetyTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.log('[' + label + '] SAFETY TIMEOUT a los 90s, terminando worker, proceso principal SIGUE VIVO');
      worker.terminate().catch(function () {});
      resolve({ ok: false, error: 'safety_timeout' });
    }, 90000);

    worker.on('exit', function (code) {
      console.log('[' + label + '] worker exit event, code:', code);
    });

    worker.on('message', function (msg) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      console.log('[' + label + '] message received:', JSON.stringify(msg).slice(0, 120));

      if (mode === 'race') {
        // Patron actual de runInProcessModel: fire-and-forget, resolve
        // inmediatamente sin esperar a que termine terminate().
        worker.terminate().catch(function () {});
        resolve({ ok: true });
      } else {
        // Patron propuesto: esperar a que terminate() Y el evento 'exit'
        // real del hilo hayan ocurrido antes de dejar continuar al
        // llamador (que podria crear otro worker inmediatamente).
        worker.terminate().then(function () {
          console.log('[' + label + '] terminate() promise resolved, esperando exit real...');
        }).finally(function () {
          worker.once('exit', function () {
            console.log('[' + label + '] exit confirmado, ahora si resolve()');
            resolve({ ok: true });
          });
        });
      }
    });

    worker.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      console.log('[' + label + '] error event:', (err && err.stack) || err);
      resolve({ ok: false, error: String(err) });
    });
  });
}

async function main() {
  console.log('=== MODE: ' + mode + ' ===');
  for (var i = 1; i <= 3; i++) {
    console.log('--- call ' + i + ' ---');
    var r = await runOnce('call' + i);
    console.log('call ' + i + ' settled:', JSON.stringify(r));
  }
  console.log('ALL DONE, mode=' + mode);
}

main();
