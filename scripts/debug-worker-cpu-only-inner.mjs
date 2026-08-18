import { parentPort, workerData } from 'node:worker_threads';

async function run() {
  var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  var llama = await getLlama({ gpu: false });
  parentPort.postMessage({ ok: true, checkpoint: 'backend', gpu: llama.gpu || 'none' });
  var model = await llama.loadModel({ modelPath: workerData.modelPath });
  var context = await model.createContext({ contextSize: 2048 });
  var session = new LlamaChatSession({ contextSequence: context.getSequence() });
  var text = await session.prompt(workerData.prompt, { maxTokens: 20 });
  parentPort.postMessage({ ok: true, checkpoint: 'generated', text: text });
}

run().catch(function (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});
