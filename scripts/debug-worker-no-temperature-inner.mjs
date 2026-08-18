// Diagnostico (2026-08-17): identico a local-model-worker.js pero SIN pasar
// temperature a session.prompt() -- prueba directa de la hipotesis real
// encontrada hoy: pasar temperature explicito (incluido el fallback
// hardcodeado 0.3 de local-model-worker.js) parece disparar un crash/cuelgue
// nativo intermitente (visto en child_process Y en worker_thread). Sin
// temperature, node-llama-cpp usa su sampler por defecto.
import { parentPort, workerData } from 'node:worker_threads';

async function run() {
  try {
    var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    var llama = await getLlama();
    var model = await llama.loadModel({ modelPath: workerData.modelPath });
    var context = await model.createContext({ contextSize: workerData.contextSize || 2048 });
    var session = new LlamaChatSession({ contextSequence: context.getSequence() });
    var text = await session.prompt(workerData.prompt, {
      maxTokens: workerData.maxTokens || 400,
      // SIN temperature -- a proposito, ver cabecera del archivo.
    });
    parentPort.postMessage({ ok: true, text: text });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || 'error desconocido en el worker' });
  }
}

run();
