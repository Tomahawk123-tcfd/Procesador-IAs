// Diagnostico (2026-08-17): worker A siempre completa TODO (generate).
// Worker B (segundo, mismo proceso) se detiene en la etapa indicada por
// argv[2] -- import / backend / model / context / session / generate --
// para localizar exactamente que etapa del SEGUNDO worker dispara el
// crash STATUS_STACK_BUFFER_OVERRUN (0xC0000409) visto en
// debug-worker-repeated.mjs.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var MODEL_PATH = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';
var stageB = process.argv[2] || 'model';

function runWorker(label, stage) {
  return new Promise(function (resolve) {
    var w = new Worker(path.join(__dirname, 'debug-worker-staged-inner.mjs'), {
      workerData: { modelPath: MODEL_PATH, prompt: 'Di una palabra.', stage: stage },
    });
    var lastMsg = null;
    w.on('message', function (msg) {
      lastMsg = msg;
      console.log('[' + label + '] checkpoint:', JSON.stringify(msg));
    });
    w.on('error', function (err) {
      console.log('[' + label + '] error event:', (err && err.stack) || err);
      resolve({ ok: false, error: String(err) });
    });
    w.on('exit', function (code) {
      console.log('[' + label + '] exit code:', code);
      resolve({ ok: true, lastMsg: lastMsg, exitCode: code });
    });
  });
}

async function main() {
  console.log('=== worker A: full run (generate) ===');
  var a = await runWorker('A', 'generate');
  console.log('A done:', JSON.stringify(a));

  console.log('=== worker B: stage=' + stageB + ' ===');
  var b = await runWorker('B', stageB);
  console.log('B done:', JSON.stringify(b));

  console.log('ALL DONE, main process alive, stageB=' + stageB);
}

main();
