// Diagnostico (2026-08-17): compara terminar el worker con worker.terminate()
// (patron real de local-inference.js, runInProcessModel) frente a dejar que
// el worker acabe solo (return de run(), patron de debug-worker-staged.mjs
// que SI funciono limpio 2 veces seguidas). Ambos workers hacen la
// generacion completa. argv[2] = 'terminate' | 'natural'.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var MODEL_PATH = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';
var mode = process.argv[2] || 'terminate';

function runWorker(label) {
  return new Promise(function (resolve) {
    var w = new Worker(path.join(__dirname, 'debug-worker-staged-inner.mjs'), {
      workerData: { modelPath: MODEL_PATH, prompt: 'Di una palabra.', stage: 'generate' },
    });
    var settled = false;
    w.on('message', function (msg) {
      console.log('[' + label + '] message:', JSON.stringify(msg));
      if (msg.checkpoint === 'generated' && !settled) {
        settled = true;
        if (mode === 'terminate') {
          console.log('[' + label + '] calling worker.terminate() NOW (mimics runInProcessModel)');
          w.terminate().then(function () {
            console.log('[' + label + '] terminate() promise resolved');
            resolve({ ok: true });
          }).catch(function (e) {
            console.log('[' + label + '] terminate() promise rejected:', e);
            resolve({ ok: false, error: String(e) });
          });
        } else {
          console.log('[' + label + '] NOT terminating, waiting for natural exit');
          resolve({ ok: true });
        }
      }
    });
    w.on('error', function (err) {
      console.log('[' + label + '] error event:', (err && err.stack) || err);
      if (!settled) { settled = true; resolve({ ok: false, error: String(err) }); }
    });
    w.on('exit', function (code) {
      console.log('[' + label + '] exit code:', code);
    });
  });
}

async function main() {
  console.log('=== MODE: ' + mode + ' ===');
  console.log('--- worker A ---');
  var a = await runWorker('A');
  console.log('A settled:', JSON.stringify(a));

  console.log('--- worker B ---');
  var b = await runWorker('B');
  console.log('B settled:', JSON.stringify(b));

  console.log('ALL DONE, main process alive, mode=' + mode);
}

main();
