// ── WORKER AISLADO: ejecuta un modelo GGUF dentro de un worker_thread propio
// -- ESTADO REAL (2026-08-17): FIABLE Y VERIFICADO, con dos condiciones --
// ver el detalle honesto abajo antes de retomar o wirear este archivo.
//
// Sesion anterior (2026-08-16): cuelgues/crashes intermitentes sin causa
// diagnosticada ("colgo mas de 137s pese a un timeout de 30s", "crasheo sin
// mensaje de error"). Sesion de hoy (2026-08-17): diagnostico riguroso con
// >15 repeticiones reales por hipotesis (ver scripts/debug-worker-*.mjs,
// scripts/debug-child-*.mjs, scripts/debug-temperature-test.mjs,
// scripts/debug-two-prompts-plain.mjs) encontro DOS causas raiz reales,
// no una:
//
// 1) Pasar `temperature` explicito a session.prompt() (este archivo lo
//    hacia SIEMPRE, con un default hardcodeado 0.3) dispara un fallo nativo
//    intermitente en node-llama-cpp 3.20.0 sobre Windows + Vulkan/AMD iGPU
//    -- a veces cuelga indefinidamente, a veces crashea el proceso entero
//    (exit code 3). Reproducido de forma AISLADA en tres contextos
//    distintos (worker_thread, child_process.fork(), proceso principal sin
//    threading de ningun tipo) -- confirma que NO es un bug de
//    worker_threads, es el sampler de temperatura personalizado de
//    node-llama-cpp. Coherente con reportes externos de crashes 0xC0000005
//    en llama.cpp ligados al sampler chain en Windows. Ver
//    fix real abajo: ya no se pasa temperature a session.prompt().
//
// 2) worker.terminate() llamado en el camino de EXITO (en local-inference.js,
//    fire-and-forget justo antes de resolve()) es la otra causa real --
//    coincide con un bug documentado de Node en Windows (nodejs/node#41107):
//    un addon nativo cargado en un worker_thread puede crashear el proceso
//    ENTERO al terminar ese hilo, o dejar el terminate() colgado para
//    siempre sin resolver. Fix real: dejar que el worker termine SOLO
//    (natural exit tras postMessage, sin terminate() forzado) -- ver el
//    detalle en local-inference.js.
//
// Con AMBOS fixes aplicados: 15/15 llamadas reales limpias, en secuencia,
// mismo proceso Node de larga duracion (scripts/debug-worker-no-temperature-
// repeated.mjs, 2026-08-17). Sin ninguno de los dos fixes: 0/6 llamadas
// limpias en la misma prueba (siempre cuelgue o crash).
//
// PERO -- limitacion real que SIGUE en pie y no es un bug, es arquitectura:
// cada worker_thread es un V8 isolate nuevo, asi que cada llamada
// (incluida la primera) recarga el modelo GGUF entero desde cero
// (~7-9s medidos, qwen2.5:1.5b). No hay forma de mantener el modelo
// cargado entre llamadas dentro de este patron "un worker por llamada".
// Para el objetivo real (inferencia repetida rapida durante la vida del
// servicio), un child_process.fork() persistente que carga el modelo UNA
// VEZ y responde a multiples peticiones via IPC es net mejor: mismo fix de
// temperature, mismo aislamiento (a nivel de proceso del SO en vez de
// isolate de V8, evitando el bug #41107 de raiz porque matar el proceso no
// depende de que el addon nativo coopere), y ~65-120ms por llamada tras el
// primer arranque en vez de 7-9s cada vez -- medido en vivo, 45/45 llamadas
// limpias en 3 corridas de 15 (ver scripts/debug-child-persistent.mjs +
// scripts/debug-child-persistent-inner.mjs). Ese es el camino recomendado
// para wirear de verdad -- este archivo queda fiable pero no es el que
// deberia conectarse al pipeline real.
import { parentPort, workerData } from 'node:worker_threads';

async function run() {
  try {
    var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    var llama = await getLlama();
    var model = await llama.loadModel({ modelPath: workerData.modelPath });
    // Bug real, medido en vivo (2026-08-16): sin contextSize explicito,
    // node-llama-cpp usa por defecto la ventana de contexto MAXIMA del
    // modelo (a menudo 32K+ tokens) -- crear la sesion con eso tardo 385s
    // en esta maquina (reserva/pre-calcula estructuras de cache de
    // atencion para toda esa ventana). Acotado a un tamano real para lo
    // que LinkCore pregunta, la misma sesion tardo 2.9s -- 130x mas rapido,
    // mismo modelo, mismo hardware.
    var context = await model.createContext({ contextSize: workerData.contextSize || 2048 });
    var session = new LlamaChatSession({ contextSequence: context.getSequence() });
    // Bug real, confirmado en vivo (2026-08-17): pasar `temperature`
    // explicito a session.prompt() -- incluido el default hardcodeado 0.3
    // que este archivo aplicaba siempre antes de hoy -- dispara un fallo
    // nativo intermitente (cuelgue indefinido O crash con exit code 3,
    // sin patron determinista) en node-llama-cpp 3.20.0 sobre esta
    // combinacion Windows + Vulkan/AMD iGPU. Reproducido de forma aislada
    // en TRES contextos distintos (worker_thread, child_process.fork(),
    // y proceso principal plano sin threading de ningun tipo) -- no tiene
    // relacion con worker_threads en si, es el sampler de temperatura
    // personalizado de node-llama-cpp. Ver scripts/debug-temperature-test.mjs
    // y scripts/debug-two-prompts-plain.mjs. Coherente con reportes
    // externos de crashes 0xC0000005 en llama.cpp ligados al sampler
    // chain/temperatura en Windows. Sin pasar temperature (sampler por
    // defecto de la libreria), 15/15 llamadas reales limpias -- ver
    // scripts/debug-worker-no-temperature-repeated.mjs.
    var text = await session.prompt(workerData.prompt, {
      maxTokens: workerData.maxTokens || 400,
    });
    parentPort.postMessage({ ok: true, text: text });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || 'error desconocido en el worker' });
  }
}

run();
