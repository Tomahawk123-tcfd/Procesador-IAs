import { parentPort, workerData } from 'node:worker_threads';

async function run() {
  var stage = workerData.stage;
  var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  parentPort.postMessage({ ok: true, checkpoint: 'imported' });
  if (stage === 'import') return;

  var llama = await getLlama();
  parentPort.postMessage({ ok: true, checkpoint: 'backend', gpu: llama.gpu || 'none' });
  if (stage === 'backend') return;

  var model = await llama.loadModel({ modelPath: workerData.modelPath });
  parentPort.postMessage({ ok: true, checkpoint: 'model_loaded' });
  if (stage === 'model') return;

  var context = await model.createContext({ contextSize: 2048 });
  parentPort.postMessage({ ok: true, checkpoint: 'context_created' });
  if (stage === 'context') return;

  var session = new LlamaChatSession({ contextSequence: context.getSequence() });
  parentPort.postMessage({ ok: true, checkpoint: 'session_created' });
  if (stage === 'session') return;

  var text = await session.prompt(workerData.prompt, { maxTokens: 20 });
  parentPort.postMessage({ ok: true, checkpoint: 'generated', text: text });
}

run().catch(function (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});
