// Diagnostico (2026-08-17): llama repetidamente runInProcessModel() -- el
// camino REAL de produccion en local-inference.js -- dentro de un unico
// proceso Node de larga duracion (igual que el servicio principal de
// LinkCore), sin forzar process.exit() a mitad de nada. Objetivo: separar
// "la inferencia en si falla" de "el apagado del proceso tras exit() falla",
// que es lo que parecen mostrar debug-worker-crash.mjs (ver ese archivo).
import { runInProcessModel } from '../src/engine/local-inference.js';

var N = Number(process.argv[2] || 6);
var results = [];

process.on('uncaughtException', function (e) {
  console.log('[MAIN] uncaughtException:', (e && e.stack) || e);
});
process.on('unhandledRejection', function (e) {
  console.log('[MAIN] unhandledRejection:', (e && e.stack) || e);
});

async function main() {
  for (var i = 1; i <= N; i++) {
    var t0 = Date.now();
    console.log('--- call ' + i + '/' + N + ' ---');
    var r = await runInProcessModel('qwen2.5:1.5b', 'Di una palabra.', { maxTokens: 20, timeoutMs: 60000 });
    var dt = Date.now() - t0;
    console.log('call ' + i + ' result:', JSON.stringify(r).slice(0, 200), 'took', dt, 'ms');
    results.push({ i: i, ok: r.ok, error: r.error, dt: dt });
  }
  console.log('SUMMARY:', JSON.stringify(results));
  console.log('ALL_CALLS_DONE, process still alive, exiting naturally now');
}

main();
