import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import fs from 'node:fs';

var blobPath = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-183715c435899236895da3869489cc30ac241476b4971a20285b1a462818a5b4';
var ggufPath = 'C:\\Users\\tomas\\AppData\\Local\\Temp\\claude\\C--Users-tomas-Desktop-C--\\541ff8ca-4a39-436b-9d14-63dca60a6ef3\\scratchpad\\qwen2.5-1.5b.gguf';

if (!fs.existsSync(ggufPath)) {
  console.log('copiando blob a .gguf...');
  fs.copyFileSync(blobPath, ggufPath);
}

var t0 = Date.now();
console.log('cargando motor Llama...');
var llama = await getLlama();
console.log('motor cargado en', Date.now() - t0, 'ms');

var t1 = Date.now();
console.log('cargando modelo (qwen2.5:1.5b)...');
var model = await llama.loadModel({ modelPath: ggufPath });
console.log('modelo cargado en', Date.now() - t1, 'ms');

var t2 = Date.now();
var context = await model.createContext({ contextSize: 2048 });
var session = new LlamaChatSession({ contextSequence: context.getSequence() });
console.log('sesion creada en', Date.now() - t2, 'ms');

var t3 = Date.now();
var respuesta = await session.prompt('Explica brevemente que es una variable en programacion.');
console.log('generacion completada en', Date.now() - t3, 'ms');
console.log('TOTAL:', Date.now() - t0, 'ms');
console.log('respuesta completa:', respuesta);

process.exit(0);
