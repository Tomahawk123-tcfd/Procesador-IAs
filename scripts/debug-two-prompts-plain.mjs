// Diagnostico (2026-08-17): control mas limpio posible -- CERO worker_thread,
// CERO child_process, CERO IPC. Dos prompts secuenciales en el MISMO
// proceso principal, misma sesion, uno detras de otro. Si esto tambien
// crashea en el segundo prompt, el problema NO tiene nada que ver con
// threading/procesos en absoluto -- es reusar la misma sesion/contexto de
// node-llama-cpp para una SEGUNDA generacion, punto.
var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
var t0 = Date.now();
var llama = await getLlama();
var model = await llama.loadModel({ modelPath: process.env.LC_MODEL_PATH });
var context = await model.createContext({ contextSize: 2048 });
var session = new LlamaChatSession({ contextSequence: context.getSequence() });
console.log('setup done in', Date.now() - t0, 'ms, gpu=', llama.gpu || 'none');

console.log('--- prompt 1 ---');
var t1 = Date.now();
var r1 = await session.prompt('Di una palabra.', { maxTokens: 20 });
console.log('prompt 1 OK in', Date.now() - t1, 'ms:', r1);

console.log('--- prompt 2 (misma sesion) ---');
var t2 = Date.now();
var r2 = await session.prompt('Di otra palabra.', { maxTokens: 20 });
console.log('prompt 2 OK in', Date.now() - t2, 'ms:', r2);

console.log('--- prompt 3 (misma sesion) ---');
var t3 = Date.now();
var r3 = await session.prompt('Di una tercera palabra.', { maxTokens: 20 });
console.log('prompt 3 OK in', Date.now() - t3, 'ms:', r3);

console.log('ALL_THREE_OK');
process.exit(0);
