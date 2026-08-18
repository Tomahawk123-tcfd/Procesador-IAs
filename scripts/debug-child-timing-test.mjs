// Diagnostico (2026-08-17): compara invocar session.prompt() como parte del
// flujo top-level de arranque (igual que poc-node-llama-cpp.mjs, que SI es
// fiable) frente a invocarlo desde un callback de evento IPC
// (process.on('message')), dentro del MISMO proceso/sesion. Si la llamada
// directa funciona pero la disparada por IPC crashea, la causa no es
// worker_thread ni child_process en si, sino algo especifico de reanudar
// trabajo nativo de node-llama-cpp desde un callback de evento async
// distinto del hilo de arranque inicial.
var t0 = Date.now();
console.log('[CHILD] arrancando, cargando node-llama-cpp...');
var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
var llama = await getLlama();
console.log('[CHILD] motor listo, gpu=', llama.gpu || 'none');
var model = await llama.loadModel({ modelPath: process.env.LC_MODEL_PATH });
console.log('[CHILD] modelo cargado en', Date.now() - t0, 'ms');
var context = await model.createContext({ contextSize: 2048 });
var session = new LlamaChatSession({ contextSequence: context.getSequence() });
console.log('[CHILD] sesion creada en', Date.now() - t0, 'ms');

// PASO A: prompt directo, top-level, SIN pasar por IPC -- replica exacta del POC.
console.log('[CHILD] PASO A: prompt directo (top-level, sin IPC)...');
try {
  var textA = await session.prompt('Di una palabra.', { maxTokens: 20 });
  console.log('[CHILD] PASO A OK:', textA);
} catch (e) {
  console.log('[CHILD] PASO A FALLO:', (e && e.stack) || e);
}

if (process.send) {
  process.send({ type: 'ready_for_ipc_test' });
} else {
  console.log('[CHILD] sin canal IPC (ejecucion standalone), fin del test.');
  process.exit(0);
}

// PASO B: prompts disparados por mensajes IPC del padre.
var count = 0;
process.on('message', async function (msg) {
  if (!msg || msg.type !== 'prompt') return;
  count++;
  console.log('[CHILD] PASO B: prompt #' + count + ' via IPC, invocando session.prompt desde callback de evento...');
  try {
    var text = await session.prompt(msg.prompt, { maxTokens: 20 });
    console.log('[CHILD] PASO B #' + count + ' OK:', text);
    process.send({ type: 'result', id: msg.id, ok: true, text: text });
  } catch (e) {
    console.log('[CHILD] PASO B #' + count + ' FALLO:', (e && e.stack) || e);
    process.send({ type: 'result', id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
});

process.on('uncaughtException', function (e) {
  console.log('[CHILD] uncaughtException:', (e && e.stack) || e);
});
