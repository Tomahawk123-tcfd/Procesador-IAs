// Test real (2026-08-17) del modulo de produccion
// src/engine/local-inference-child.js. Verifica en vivo, sin mockear
// nada: (1) arranque de un child persistente, (2) >=10 prompts
// secuenciales con latencia real, (3) reuso del MISMO child en una
// segunda llamada a getOrCreatePersistentModel (mismo PID, sin fork
// nuevo), (4) apagado limpio confirmado via `tasklist` (no solo
// asumido) -- que el PID deja de existir de verdad, no solo que la
// promesa resolvio.
import { execSync } from 'node:child_process';
import {
  getOrCreatePersistentModel,
  promptPersistentModel,
  shutdownPersistentModel,
} from '../src/engine/local-inference-child.js';

var MODEL = process.env.LC_MODEL_PATH || 'qwen2.5:1.5b';
var N = Number(process.argv[2] || 12);

function pidAlive(pid) {
  try {
    var out = execSync('tasklist /FI "PID eq ' + pid + '"').toString();
    return out.indexOf(String(pid)) !== -1;
  } catch (e) {
    return false;
  }
}

async function main() {
  console.log('=== TEST 1: arrancar modelo persistente (' + MODEL + ') ===');
  var t0 = Date.now();
  var handle1 = await getOrCreatePersistentModel(MODEL);
  console.log('getOrCreatePersistentModel #1:', JSON.stringify({
    ok: handle1.ok, pid: handle1.pid, spawnCount: handle1.spawnCount,
    loadMs: handle1.loadMs, gpu: handle1.gpu, tookMs: Date.now() - t0,
  }));
  if (!handle1.ok) {
    console.log('FALLO: no se pudo arrancar el modelo:', handle1.error);
    process.exit(1);
  }

  console.log('=== TEST 2: ' + N + ' prompts secuenciales ===');
  var prompts = ['Di una palabra.', 'Cuenta hasta tres.', 'Nombra un color.', 'Di si o no.', 'Dime tu numero favorito.'];
  var latencies = [];
  var failures = 0;
  for (var i = 0; i < N; i++) {
    var prompt = prompts[i % prompts.length];
    var r = await promptPersistentModel(handle1, prompt, { maxTokens: 20 });
    console.log('  prompt ' + (i + 1) + '/' + N + ': ok=' + r.ok + ' latencyMs=' + r.latencyMs +
      (r.ok ? ' text="' + String(r.text).replace(/\n/g, ' ').slice(0, 50) + '"' : ' error=' + r.error));
    if (!r.ok) { failures++; } else { latencies.push(r.latencyMs); }
  }
  var avg = latencies.reduce(function (a, b) { return a + b; }, 0) / (latencies.length || 1);
  var max = latencies.length ? Math.max.apply(null, latencies) : 0;
  var min = latencies.length ? Math.min.apply(null, latencies) : 0;
  console.log('RESUMEN prompts: completados=' + latencies.length + '/' + N + ' fallos=' + failures +
    ' avgMs=' + avg.toFixed(1) + ' minMs=' + min + ' maxMs=' + max);

  console.log('=== TEST 3: reuso del mismo child (segunda llamada a getOrCreatePersistentModel) ===');
  var handle2 = await getOrCreatePersistentModel(MODEL);
  var reused = handle2.pid === handle1.pid && handle2.spawnCount === handle1.spawnCount;
  console.log('getOrCreatePersistentModel #2: pid=' + handle2.pid + ' spawnCount=' + handle2.spawnCount +
    ' (esperado pid=' + handle1.pid + ' spawnCount=' + handle1.spawnCount + ') -> REUSO_CONFIRMADO=' + reused);

  console.log('=== TEST 4: apagado limpio, verificado via tasklist ===');
  var pidBeforeShutdown = handle1.pid;
  var aliveBefore = pidAlive(pidBeforeShutdown);
  console.log('proceso ' + pidBeforeShutdown + ' vivo antes de shutdown (tasklist): ' + aliveBefore);
  var shutdownResult = await shutdownPersistentModel(handle1);
  await new Promise(function (r) { setTimeout(r, 800); });
  var aliveAfter = pidAlive(pidBeforeShutdown);
  console.log('shutdownPersistentModel:', JSON.stringify(shutdownResult));
  console.log('proceso ' + pidBeforeShutdown + ' vivo despues de shutdown (tasklist): ' + aliveAfter +
    ' -> EXIT_LIMPIO_CONFIRMADO=' + !aliveAfter);

  console.log('=== VEREDICTO FINAL ===');
  var allGood = handle1.ok && failures === 0 && reused && !aliveAfter;
  console.log(JSON.stringify({
    allGood: allGood, spawnCount: handle1.spawnCount,
    promptsOk: latencies.length, promptsFailed: failures,
    avgLatencyMs: Number(avg.toFixed(1)), minLatencyMs: min, maxLatencyMs: max,
    reuseConfirmed: reused, cleanShutdownConfirmed: !aliveAfter,
  }));
  process.exit(allGood ? 0 : 1);
}

main().catch(function (e) {
  console.error('TEST CRASH:', (e && e.stack) || e);
  process.exit(1);
});
