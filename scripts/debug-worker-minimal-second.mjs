// Diagnostico (2026-08-17): aisla si el crash (STATUS_STACK_BUFFER_OVERRUN,
// 0xC0000409) al crear un SEGUNDO worker_thread con node-llama-cpp en el
// mismo proceso ocurre ya en getLlama() (registro del backend nativo) o
// solo mas adelante (carga de modelo / contexto). Cada worker solo llama a
// getLlama() y responde -- nada de modelo.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

function runWorker(label) {
  return new Promise(function (resolve) {
    var w = new Worker(path.join(__dirname, 'debug-worker-minimal-second-inner.mjs'));
    var done = false;
    w.on('message', function (msg) {
      done = true;
      console.log('[' + label + '] message:', JSON.stringify(msg));
      resolve({ ok: true });
    });
    w.on('error', function (err) {
      done = true;
      console.log('[' + label + '] error event:', err && err.stack || err);
      resolve({ ok: false, error: String(err) });
    });
    w.on('exit', function (code) {
      console.log('[' + label + '] exit code:', code, 'done=', done);
      if (!done) resolve({ ok: false, error: 'exit_' + code });
    });
  });
}

async function main() {
  console.log('=== worker A (first) ===');
  var a = await runWorker('A');
  console.log('A result:', JSON.stringify(a));

  console.log('=== worker B (second, same process) ===');
  var b = await runWorker('B');
  console.log('B result:', JSON.stringify(b));

  console.log('ALL DONE, main process still alive');
}

main();
