// ── PROCESO HIJO PERSISTENTE (2026-08-17): carga un modelo GGUF con
// node-llama-cpp UNA VEZ y sirve prompts sucesivos via IPC mientras el
// proceso vive. NO se importa ni se ejecuta directamente -- lo levanta
// local-inference-child.js con child_process.fork(). Es la contraparte de
// produccion del script de diagnostico
// scripts/debug-child-persistent-inner.mjs, y preserva EXACTAMENTE el
// mismo patron que se demostro fiable ahi (45/45 llamadas limpias en 3
// corridas de 15, ver la cabecera de local-inference-child.js para el
// porque completo de cada fix):
//
//   1) Nunca se pasa `temperature` explicito a session.prompt() -- dispara
//      un fallo nativo intermitente (cuelgue o crash exit code 3) en
//      node-llama-cpp 3.20.0 sobre esta maquina (Windows + Vulkan/AMD
//      iGPU). Se usa el sampler por defecto de la libreria.
//
//   2) El PRIMER session.prompt() de todo el proceso ("calentamiento") se
//      hace en la cadena top-level de init(), ANTES de registrar
//      process.on('message'). Disparar la primera generacion del proceso
//      desde un callback de evento IPC crasheo de forma reproducible en
//      la investigacion (scripts/debug-child-timing-*.mjs); un
//      calentamiento directo en init(), con el listener registrado
//      DESPUES, fue fiable. No reordenar esto sin repetir esa
//      investigacion.
var modelPath = process.env.LC_MODEL_PATH;
var contextSize = Number(process.env.LC_CONTEXT_SIZE || 2048);

var session = null;

async function init() {
  var t0 = Date.now();
  if (!modelPath) {
    process.send({ type: 'ready', ok: false, error: 'LC_MODEL_PATH no definido' });
    return;
  }

  var llama;
  try {
    var mod = await import('node-llama-cpp');
    llama = await mod.getLlama();
    var model = await llama.loadModel({ modelPath: modelPath });
    var context = await model.createContext({ contextSize: contextSize });
    session = new mod.LlamaChatSession({ contextSequence: context.getSequence() });
    // Calentamiento obligatorio -- ver punto 2) en la cabecera. Directo en
    // la cadena de init(), fuera de cualquier callback de evento.
    await session.prompt('Hola.', { maxTokens: 5 });
  } catch (e) {
    process.send({ type: 'ready', ok: false, error: (e && e.message) || String(e) });
    return;
  }

  // Registrado SOLO despues de terminar el calentamiento -- ver punto 2).
  //
  // Soporte de systemPrompt por llamada (2026-08-17, wiring real a
  // backend.js#callOllamaModel): el child se reusa entre llamadas de
  // distintos llamadores (gstack.js, crew.js, orchestrator.js...), cada
  // uno con su propia "persona" de sistema (revisor, mediador,
  // planificador...) -- session.prompt() a secas no tiene forma de
  // cambiar el system prompt tras la construccion de la sesion.
  // session.setChatHistory() SI permite sustituir el historial completo
  // antes de cada prompt, con un unico turno 'system' -- exactamente el
  // mismo comportamiento sin estado que ya tiene el camino HTTP
  // (backend.js manda system+user nuevos en cada llamada, sin acumular
  // historial de conversacion entre llamadas). Sin systemPrompt explicito
  // se deja el historial tal cual (compatibilidad con el test que no lo
  // pasa).
  process.on('message', async function (msg) {
    if (!msg || msg.type !== 'prompt') return;
    var t1 = Date.now();
    try {
      if (msg.systemPrompt) {
        session.setChatHistory([{ type: 'system', text: msg.systemPrompt }]);
      }
      var text = await session.prompt(msg.prompt, { maxTokens: msg.maxTokens || 400 });
      process.send({ type: 'result', id: msg.id, ok: true, text: text, latencyMs: Date.now() - t1 });
    } catch (e) {
      process.send({ type: 'result', id: msg.id, ok: false, error: (e && e.message) || String(e) });
    }
  });

  process.send({ type: 'ready', ok: true, loadMs: Date.now() - t0, gpu: (llama && llama.gpu) || 'none' });
}

// Crashes nativos reales (tipo segfault) no pasan por aqui -- el padre los
// ve como un evento 'exit' con codigo distinto de 0, sin mensaje previo.
// Esto cubre el otro modo de fallo: una excepcion JS normal que se escapa
// (bug en el handler de mensaje, promesa sin catch). Deliberadamente
// DISTINTO del script de diagnostico (que solo reporta y sigue vivo): aqui
// se fuerza process.exit(1) tras avisar al padre, porque seguir vivo con
// el estado interno (sesion, contexto nativo) en condicion desconocida es
// peor que dejar que el padre trate este child como perdido y decida si
// relanzarlo -- ver getOrCreatePersistentModel() en local-inference-
// child.js, que ya trata cualquier 'exit' inesperado como fallo limpio.
process.on('uncaughtException', function (e) {
  try { process.send({ type: 'crash', error: (e && e.stack) || String(e) }); } catch (e2) {}
  setImmediate(function () { process.exit(1); });
});
process.on('unhandledRejection', function (e) {
  try { process.send({ type: 'crash', error: 'unhandledRejection: ' + ((e && e.stack) || String(e)) }); } catch (e2) {}
  setImmediate(function () { process.exit(1); });
});

init();
