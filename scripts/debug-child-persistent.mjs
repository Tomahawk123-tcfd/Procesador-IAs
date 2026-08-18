// Diagnostico (2026-08-17): parent que hace fork() de un child process
// persistente (debug-child-persistent-inner.mjs), le manda N prompts
// secuenciales via IPC, y mide tiempos + fiabilidad. Objetivo: comparar
// contra el patron worker_thread (que crashea en runInProcessModel /
// local-model-worker.js) y contra Ollama-HTTP (callOllamaModel).
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var MODEL_PATH = process.env.LC_MODEL_PATH || 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';
var N = Number(process.argv[2] || 15);
var prompts = ['Di una palabra.', 'Cuenta hasta tres.', 'Nombra un color.', 'Di si o no.', 'Dime tu numero favorito.'];

function main() {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    var child = fork(path.join(__dirname, 'debug-child-persistent-inner.mjs'), [], {
      env: Object.assign({}, process.env, { LC_MODEL_PATH: MODEL_PATH }),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    var results = [];
    var pending = {};
    var readyMs = null;
    var crashed = false;

    child.on('message', function (msg) {
      if (msg.type === 'ready') {
        readyMs = Date.now() - t0;
        console.log('[PARENT] child ready in', readyMs, 'ms, gpu=', msg.gpu, 'ok=', msg.ok !== false);
        sendNext();
      } else if (msg.type === 'result') {
        console.log('[PARENT] result id=' + msg.id, 'ok=' + msg.ok, 'latencyMs=' + msg.latencyMs, msg.error ? 'error=' + msg.error : '');
        results.push(msg);
        if (results.length >= N) {
          finish();
        } else {
          sendNext();
        }
      } else if (msg.type === 'crash') {
        console.log('[PARENT] CHILD REPORTED CRASH (caught):', msg.error);
      }
    });

    child.on('exit', function (code, signal) {
      console.log('[PARENT] child exit code=' + code, 'signal=' + signal);
      if (!crashed && results.length < N) {
        crashed = true;
        finish();
      }
    });

    child.on('error', function (err) {
      console.log('[PARENT] child error event:', err && err.stack || err);
    });

    var i = 0;
    function sendNext() {
      if (i >= N) return;
      i++;
      var id = i;
      var prompt = prompts[(i - 1) % prompts.length];
      pending[id] = Date.now();
      console.log('[PARENT] sending prompt id=' + id);
      var sendOk = child.send({ type: 'prompt', id: id, prompt: prompt, maxTokens: 20 });
      console.log('[PARENT] child.send() returned:', sendOk);
    }

    var settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      console.log('SUMMARY:', JSON.stringify({ readyMs: readyMs, completed: results.length, requested: N, results: results }));
      try { child.kill(); } catch (e) {}
      resolve({ readyMs: readyMs, results: results });
    }

    // Red de seguridad global: si algo se cuelga de verdad, no bloquear para siempre.
    setTimeout(function () {
      if (!settled) {
        console.log('[PARENT] GLOBAL SAFETY TIMEOUT 5min');
        finish();
      }
    }, 5 * 60 * 1000);
  });
}

main().then(function () {
  console.log('ALL_DONE');
  process.exit(0);
});
