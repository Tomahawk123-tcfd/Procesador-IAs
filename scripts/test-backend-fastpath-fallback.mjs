// Test real (2026-08-17): confirma que callOllamaModel() cae limpio al
// camino HTTP existente cuando el fast path no puede resolver el modelo a
// un .gguf real (isPersistentModelAvailable() devuelve false) -- mismo
// comportamiento que ANTES de wirear el fast path, sin excepciones ni
// promesas colgadas.
import { callOllamaModel } from '../src/backend.js';
import { isPersistentModelAvailable } from '../src/engine/local-inference-child.js';
import { shutdownAllPersistentModels } from '../src/engine/local-inference-child.js';

var FAKE_MODEL = 'modelo-que-no-existe-nunca:9999b';

async function main() {
  console.log('=== TEST: resolucion de gguf falla -> isPersistentModelAvailable ===');
  var available = isPersistentModelAvailable(FAKE_MODEL);
  console.log('isPersistentModelAvailable(' + FAKE_MODEL + ') = ' + available + ' (esperado: false)');

  console.log('=== TEST: callOllamaModel real con modelo inexistente ===');
  var t0 = Date.now();
  var result = await callOllamaModel(FAKE_MODEL, 'Di hola.', { maxTokens: 10, timeoutMs: 15000 });
  var elapsedMs = Date.now() - t0;
  console.log('resultado: ' + JSON.stringify(result) + ' (elapsedMs=' + elapsedMs + ')');

  var cleanFallback = result && result.ok === false && typeof result.error === 'string'
    && result.provider !== 'node-llama-cpp-child';
  console.log('VEREDICTO: cayo limpio al camino HTTP (sin provider node-llama-cpp-child, ok:false, error presente) = ' + cleanFallback);

  await shutdownAllPersistentModels();
  process.exit(cleanFallback ? 0 : 1);
}

main().catch(function (e) {
  console.error('TEST CRASH (no deberia pasar -- justo lo que este test verifica que NO ocurra):', (e && e.stack) || e);
  process.exit(1);
});
