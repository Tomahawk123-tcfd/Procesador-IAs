import { parentPort } from 'node:worker_threads';

async function run() {
  var { getLlama } = await import('node-llama-cpp');
  var llama = await getLlama();
  parentPort.postMessage({ ok: true, gpu: llama.gpu || 'none' });
}

run().catch(function (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});
