// Test adversarial (pase de verificacion, 2026-08-17): 5 llamadas CONCURRENTES
// (Promise.all, no secuenciales) al MISMO modelo via callOllamaModel() real de
// produccion. Cada job pide un token unico y verificable -- si dos jobs
// comparten el child persistente (mismo modelo -> misma entry de registro) y
// hay una condicion de carrera en session.setChatHistory()/session.prompt()
// sobre la sesion compartida (local-inference-child-worker.js#process.on
// ('message', async ...) no serializa mensajes concurrentes), esto deberia
// verse como texto cruzado (el token de un job aparece en la respuesta de
// otro) o como un child crasheado a mitad de peticion.
import { callOllamaModel } from '../src/backend.js';
import { shutdownAllPersistentModels } from '../src/engine/local-inference-child.js';

var MODEL = process.argv[2] || 'qwen2.5:1.5b';
var N = Number(process.argv[3] || 5);

function buildPrompt(i) {
  var token = 'MARCADOR' + i + '-' + Math.random().toString(36).slice(2, 8);
  return { i: i, token: token, prompt: 'Repite EXACTAMENTE y solo esto, sin nada mas: ' + token };
}

async function main() {
  var jobs = [];
  for (var i = 0; i < N; i++) jobs.push(buildPrompt(i));

  console.log('=== Lanzando ' + N + ' llamadas CONCURRENTES al mismo modelo (' + MODEL + ') ===');
  jobs.forEach(function (j) { console.log('  job ' + j.i + ': token esperado = ' + j.token); });

  var t0 = Date.now();
  var results = await Promise.all(jobs.map(function (j) {
    return callOllamaModel(MODEL, j.prompt, { maxTokens: 30, timeoutMs: 60000 })
      .then(function (r) { return { job: j, result: r }; });
  }));
  var elapsedMs = Date.now() - t0;

  console.log('=== Resultados (elapsedMs total=' + elapsedMs + ') ===');
  var anyCrash = false;
  var anyCrossTalk = false;
  var providers = [];
  results.forEach(function (r) {
    var j = r.job;
    var res = r.result;
    providers.push(res.provider);
    var text = (res.text || '').trim();
    var containsOwnToken = res.ok && text.indexOf(j.token) !== -1;
    var containsOtherToken = res.ok && jobs.some(function (other) {
      return other.i !== j.i && text.indexOf(other.token) !== -1;
    });
    if (!res.ok) anyCrash = true;
    if (containsOtherToken) anyCrossTalk = true;
    console.log('  job ' + j.i + ': ok=' + res.ok + ' provider=' + res.provider +
      ' ownTokenPresente=' + containsOwnToken + ' otroTokenPresente=' + containsOtherToken +
      (res.ok ? ' text="' + text.slice(0, 80).replace(/\n/g, ' ') + '"' : ' error=' + res.error));
  });

  console.log('=== VEREDICTO ===');
  console.log(JSON.stringify({
    allOk: results.every(function (r) { return r.result.ok; }),
    anyCrash: anyCrash,
    anyCrossTalk: anyCrossTalk,
    providersUsed: providers,
    fastPathEngagedCalls: providers.filter(function (p) { return p === 'node-llama-cpp-child'; }).length + '/' + N,
  }, null, 2));

  await shutdownAllPersistentModels();
  process.exit(anyCrash || anyCrossTalk ? 1 : 0);
}

main().catch(function (e) {
  console.error('TEST CRASH:', (e && e.stack) || e);
  process.exit(1);
});
