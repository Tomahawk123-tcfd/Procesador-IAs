// Diagnostico (2026-08-17): hipotesis GPU/Vulkan como causa raiz del
// crash/hang al crear multiples worker_threads con node-llama-cpp en el
// mismo proceso. Identico a local-model-worker.js pero con
// getLlama({ gpu: false }) -- fuerza CPU puro, sin backend Vulkan. Si esto
// elimina la inestabilidad, GPU/Vulkan es la causa raiz real.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var MODEL_PATH = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';
var N = Number(process.argv[2] || 5);

function runOnce(label) {
  return new Promise(function (resolve) {
    var w = new Worker(path.join(__dirname, 'debug-worker-cpu-only-inner.mjs'), {
      workerData: { modelPath: MODEL_PATH, prompt: 'Di una palabra.' },
    });
    var settled = false;
    var t0 = Date.now();

    var safetyTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.log('[' + label + '] SAFETY TIMEOUT a los 90s');
      w.terminate().catch(function () {});
      resolve({ ok: false, error: 'safety_timeout', dt: Date.now() - t0 });
    }, 90000);

    w.on('message', function (msg) {
      if (msg.checkpoint === 'generated' && !settled) {
        settled = true;
        clearTimeout(safetyTimer);
        console.log('[' + label + '] generated ok, terminating...');
        w.terminate().then(function () {
          console.log('[' + label + '] terminate() resolved');
        }).catch(function (e) {
          console.log('[' + label + '] terminate() rejected:', e);
        }).finally(function () {
          resolve({ ok: true, dt: Date.now() - t0 });
        });
      } else {
        console.log('[' + label + '] checkpoint:', JSON.stringify(msg));
      }
    });
    w.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      console.log('[' + label + '] error event:', (err && err.stack) || err);
      resolve({ ok: false, error: String(err), dt: Date.now() - t0 });
    });
    w.on('exit', function (code) {
      console.log('[' + label + '] exit code:', code);
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
