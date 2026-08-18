// Diagnostico (2026-08-17): aisla si pasar temperature explicito a
// session.prompt() (en vez de dejar el default de la libreria) es la causa
// real del crash -- totalmente independiente de worker_threads/child_process/
// IPC. Plano, main thread, misma sesion, dos prompts: uno CON temperature
// explicito, otro SIN.
var { getLlama, LlamaChatSession } = await import('node-llama-cpp');
var llama = await getLlama();
var model = await llama.loadModel({ modelPath: process.env.LC_MODEL_PATH });
var context = await model.createContext({ contextSize: 2048 });
var session = new LlamaChatSession({ contextSequence: context.getSequence() });
console.log('setup done, gpu=', llama.gpu || 'none');

console.log('--- prompt SIN temperature explicito ---');
var r1 = await session.prompt('Di una palabra.', { maxTokens: 20 });
console.log('OK:', r1);

console.log('--- prompt CON temperature: 0.3 ---');
var r2 = await session.prompt('Di otra palabra.', { maxTokens: 20, temperature: 0.3 });
console.log('OK:', r2);

console.log('ALL_OK');
process.exit(0);
