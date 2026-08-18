// Test real del wiring (2026-08-17): src/backend.js#callOllamaModel con el
// camino rapido node-llama-cpp-child ya integrado delante del fetch HTTP.
// Mide ANTES (HTTP puro contra Ollama, el unico camino que existia hasta
// hoy) vs DESPUES (callOllamaModel real, que intenta el fast path primero y
// cae a HTTP si falla) para N llamadas secuenciales al MISMO modelo, con
// prompts rotados para no pisar la cache semantica de chip-core.js.
import { callOllamaModel } from '../src/backend.js';

var MODEL = process.env.LC_MODEL_PATH || 'qwen2.5:1.5b';
var N = Number(process.argv[2] || 8);
var PROMPTS = [
  'Di una palabra.',
  'Cuenta hasta tres.',
  'Nombra un color.',
  'Di si o no.',
  'Dime tu numero favorito.',
  'Nombra un animal.',
  'Di el nombre de un pais.',
  'Nombra una fruta.',
];

async function measureHttpBaseline() {
  console.log('=== BASELINE: HTTP puro contra Ollama (' + N + ' llamadas, ' + MODEL + ') ===');
  var latencies = [];
  for (var i = 0; i < N; i++) {
    var prompt = 'BASELINE-' + i + ': ' + PROMPTS[i % PROMPTS.length];
    var t0 = Date.now();
    var res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'Responde EN ESPANOL de forma clara y util.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        keep_alive: '5m',
        options: { num_predict: 20 },
      }),
    });
    var json = await res.json();
    var latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    console.log('  http ' + (i + 1) + '/' + N + ': latencyMs=' + latencyMs + ' text="' + String(json.message && json.message.content).slice(0, 40).replace(/\n/g, ' ') + '"');
  }
  return latencies;
}

async function measureFastPath() {
  console.log('=== DESPUES: callOllamaModel real (fast path + fallback), ' + N + ' llamadas, ' + MODEL + ' ===');
  var latencies = [];
  var providers = [];
  for (var i = 0; i < N; i++) {
    var prompt = 'FASTPATH-' + i + ': ' + PROMPTS[i % PROMPTS.length];
    var r = await callOllamaModel(MODEL, prompt, { maxTokens: 20, timeoutMs: 30000 });
    latencies.push(r.latencyMs);
    providers.push(r.provider);
    console.log('  fastpath ' + (i + 1) + '/' + N + ': ok=' + r.ok + ' provider=' + r.provider + ' latencyMs=' + r.latencyMs +
      (r.ok ? ' text="' + String(r.text).slice(0, 40).replace(/\n/g, ' ') + '"' : ' error=' + r.error));
  }
  return { latencies: latencies, providers: providers };
}

function stats(arr) {
  var avg = arr.reduce(function (a, b) { return a + b; }, 0) / (arr.length || 1);
  return { avg: Number(avg.toFixed(1)), min: Math.min.apply(null, arr), max: Math.max.apply(null, arr) };
}

async function main() {
  var httpLatencies = await measureHttpBaseline();
  var fp = await measureFastPath();

  var httpStats = stats(httpLatencies);
  var fpStats = stats(fp.latencies);
  var fastPathEngaged = fp.providers.filter(function (p) { return p === 'node-llama-cpp-child'; }).length;

  console.log('=== RESUMEN ===');
  console.log(JSON.stringify({
    model: MODEL,
    n: N,
    httpBaseline: httpStats,
    fastPath: fpStats,
    fastPathEngagedCalls: fastPathEngaged + '/' + N,
    providersUsed: fp.providers,
  }, null, 2));
}

main().catch(function (e) {
  console.error('TEST CRASH:', (e && e.stack) || e);
  process.exit(1);
});
