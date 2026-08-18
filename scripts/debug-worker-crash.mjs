import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', function (e) {
  console.log('[MAIN] uncaughtException:', e && e.stack || e);
});
process.on('unhandledRejection', function (e) {
  console.log('[MAIN] unhandledRejection:', e && e.stack || e);
});

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var workerScript = path.join(__dirname, 'debug-worker-inner.mjs');

console.log('[MAIN] creando worker...');
var worker = new Worker(workerScript, {
  workerData: {
    modelPath: 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57',
    prompt: 'Explica en una frase que es una variable.',
  },
});

worker.on('message', function (msg) {
  console.log('[MAIN] mensaje del worker:', JSON.stringify(msg));
  process.exit(0);
});
worker.on('error', function (err) {
  console.log('[MAIN] worker.on(error):', err && err.stack || err);
  process.exit(1);
});
worker.on('exit', function (code) {
  console.log('[MAIN] worker.on(exit), code:', code);
});

setTimeout(function () {
  console.log('[MAIN] timeout de seguridad a los 60s, el proceso principal SIGUE VIVO');
  process.exit(2);
}, 60000);
