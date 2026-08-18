import { parentPort, workerData } from 'node:worker_threads';

process.on('uncaughtException', function (e) {
  console.log('[WORKER] uncaughtException:', e && e.stack || e);
  parentPort.postMessage({ ok: false, error: 'uncaughtException: ' + (e && e.message) });
});

async function run() {
  console.log('[WORKER] arrancando, importando node-llama-cpp...');
  var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  console.log('[WORKER] modulo importado, llamando getLlama(debug:true)...');
  var llama = await getLlama({ debug: true });
  console.log('[WORKER] motor listo, cargando modelo:', workerData.modelPath);
  var model = await llama.loadModel({ modelPath: workerData.modelPath });
  console.log('[WORKER] modelo cargado, creando contexto...');
  var context = await model.createContext({ contextSize: 2048 });
  console.log('[WORKER] contexto creado, creando sesion...');
  var session = new LlamaChatSession({ contextSequence: context.getSequence() });
  console.log('[WORKER] sesion creada, generando...');
  var text = await session.prompt(workerData.prompt, { maxTokens: 100 });
  console.log('[WORKER] generacion completa');
  parentPort.postMessage({ ok: true, text: text });
}

run().catch(function (e) {
  console.log('[WORKER] error capturado en run():', e && e.stack || e);
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
});
