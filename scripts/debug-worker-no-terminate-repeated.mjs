// Diagnostico (2026-08-17): variante de local-inference.js/runInProcessModel
// que NO llama a worker.terminate() en el camino de exito -- se limita a
// resolve() al recibir el mensaje, dejando que el worker termine solo
// (exit natural). terminate() solo se usa como red de seguridad en el
// camino de timeout real (ahi el worker ya esta en un estado desconocido,
// no hay nada que perder). Hipotesis: el crash/cuelgue viene de forzar
// terminate() mientras el addon nativo de node-llama-cpp (hilos propios en
// C++, sea backend GPU o CPU) todavia esta liberando recursos.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var WORKER_SCRIPT = path.join(__dirname, '..', 'src', 'engine', 'local-model-worker.js');
var MODEL_PATH = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';
var N = Number(process.argv[2] || 8);

function runOnce(label) {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    var worker = new Worker(WORKER_SCRIPT, {
      workerData: { modelPath: MODEL_PATH, prompt: 'Di una palabra.', contextSize: 2048, maxTokens: 20 },
    });
    var settled = false;

    var safetyTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.log('[' + label + '] SAFETY TIMEOUT a los 90s');
      worker.terminate().catch(function () {});
      resolve({ ok: false, error: 'safety_timeout', dt: Date.now() - t0 });
    }, 90000);

    worker.on('message', function (msg) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      console.log('[' + label + '] message received (NOT calling terminate):', JSON.stringify(msg).slice(0, 100));
      resolve({ ok: !!(msg && msg.ok), error: msg && msg.error, dt: Date.now() - t0 });
    });

    worker.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      console.log('[' + label + '] error event:', (err && err.stack) || err);
      resolve({ ok: false, error: String(err), dt: Date.now() - t0 });
    });

    worker.on('exit', function (code) {
      console.log('[' + label + '] natural exit, code:', code);
    });
  });
}

async function main() {
  var results = [];
  for (var i = 1; i <= N; i++) {
    console.log('--- call ' + i + '/' + N + ' ---');
    var r = await runOnce('call' + i);
    console.log('call ' + i + ' result:', JSON.stringify(r));
    results.push(r);
  }
  console.log('SUMMARY:', JSON.stringify(results));
  console.log('ALL_CALLS_DONE');
}

main();
