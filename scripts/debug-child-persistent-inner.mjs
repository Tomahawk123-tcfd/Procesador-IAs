// Diagnostico (2026-08-17): child process persistente -- alternativa a
// worker_thread para inferencia en proceso. Carga node-llama-cpp UNA vez,
// mantiene el modelo y la sesion vivos, y responde a multiples peticiones
// via IPC (process.on('message') / process.send()) sin volver a cargar el
// modelo ni destruir/recrear el backend nativo entre llamadas. La
// diferencia clave frente a worker_thread: el aislamiento aqui es a nivel
// de proceso del SO (fork()), no del isolate de V8 -- si hay que matar
// este proceso, se hace con child.kill()/taskkill, que el SO garantiza que
// libera TODOS los recursos nativos (Vulkan, hilos, memoria) sin depender
// de que el addon nativo coopere con un terminate() interno de V8.
var modelPath = process.env.LC_MODEL_PATH;
var contextSize = Number(process.env.LC_CONTEXT_SIZE || 2048);

var llama = null;
var model = null;
var context = null;
var session = null;
var ready = false;

async function init() {
  var t0 = Date.now();
  var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  llama = await getLlama();
  model = await llama.loadModel({ modelPath: modelPath });
  context = await model.createContext({ contextSize: contextSize });
  session = new LlamaChatSession({ contextSequence: context.getSequence() });
  // "Calentamiento" (2026-08-17): la PRIMERA llamada a session.prompt() de
  // todo el proceso, invocada aqui como parte de la cadena top-level de
  // arranque (igual que poc-node-llama-cpp.mjs, fiable en 3/3 pruebas
  // reales), en vez de esperar a que la dispare el primer mensaje IPC
  // entrante. Hipotesis confirmada en vivo (debug-child-timing-test.mjs +
  // debug-child-timing-parent.mjs, 2026-08-17): un session.prompt()
  // disparado como LA PRIMERA generacion del proceso desde un callback de
  // evento IPC (en vez de la cadena top-level inicial) crasheo el proceso
  // (exit code 3) en debug-child-persistent-inner.mjs sin este
  // calentamiento; con un prompt directo primero, las llamadas
  // subsiguientes via IPC (incluida la primera real) funcionaron limpio.
  await session.prompt('Hola.', { maxTokens: 5 });
  ready = true;

  // Registrar el listener de IPC SOLO despues de terminar el calentamiento
  // (2026-08-17) -- en vez de al inicio del modulo. Diferencia real
  // encontrada entre debug-child-timing-test.mjs (fiable) y la version
  // anterior de este archivo (crasheaba en la primera llamada via IPC): el
  // script fiable registraba process.on('message', ...) DESPUES de varios
  // segundos de trabajo nativo ya completado, no de entrada al modulo.
  process.on('message', async function (msg) {
    console.error('[CHILD] got message:', JSON.stringify(msg));
    if (!msg || msg.type !== 'prompt') return;
    var t1 = Date.now();
    try {
      console.error('[CHILD] calling session.prompt...');
      var text = await session.prompt(msg.prompt, { maxTokens: msg.maxTokens || 20 });
      console.error('[CHILD] session.prompt returned:', text);
      process.send({ type: 'result', id: msg.id, ok: true, text: text, latencyMs: Date.now() - t1 });
      console.error('[CHILD] result sent');
    } catch (e) {
      console.error('[CHILD] session.prompt threw:', (e && e.stack) || e);
      process.send({ type: 'result', id: msg.id, ok: false, error: (e && e.message) || String(e) });
    }
  });

  process.send({ type: 'ready', loadMs: Date.now() - t0, gpu: llama.gpu || 'none' });
}

process.on('uncaughtException', function (e) {
  try { process.send({ type: 'crash', error: (e && e.stack) || String(e) }); } catch (e2) {}
});
process.on('unhandledRejection', function (e) {
  try { process.send({ type: 'crash', error: 'unhandledRejection: ' + ((e && e.stack) || String(e)) }); } catch (e2) {}
});

init().catch(function (e) {
  process.send({ type: 'ready', ok: false, error: (e && e.message) || String(e) });
});
