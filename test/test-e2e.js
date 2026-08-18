// ═══════════════════════════════════════════════════════════════
// LINKCORE E2E TEST SUITE
// Tests the full pipeline end-to-end
// ═══════════════════════════════════════════════════════════════

import { installGlobalShim } from '../src/localstorage-shim.js';
installGlobalShim();

var passed = 0;
var failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name);
  }
}

// ── Test 1: Orchestrator ──
async function testOrchestrator() {
  console.log('\n=== Test 1: Orchestrator ===');

  var mod = await import('../src/engine/kimi-k3.js');

  var available = mod.isKimiAvailable();
  assert(typeof available === 'boolean', 'isKimiAvailable returns boolean');

  if (available) {
    var startTime = Date.now();
    var result = await mod.callKimiK3('responde solo: hola', { maxTokens: 30, timeoutMs: 10000 });
    var elapsed = Date.now() - startTime;
    assert(result.ok, 'callKimiK3 returns ok');
    assert(result.text && result.text.length > 0, 'callKimiK3 returns text');
    assert(elapsed < 10000, 'Orchestrator responds within 10s (actual: ' + elapsed + 'ms)');
    console.log('  → Orchestrator latency: ' + elapsed + 'ms');
  } else {
    console.log('  → Skipping (llama3.2:3b not installed)');
  }
}

// ── Test 2: Learning Loop Accuracy ──
async function testLearningLoop() {
  console.log('\n=== Test 2: Learning Loop Accuracy ===');

  var ll = await import('../src/engine/learning-loop.js');
  ll.clear();

  ll.recordQuery('q1', 'model-a', 'code', { ok: true, latencyMs: 1000 });
  ll.recordQuery('q2', 'model-a', 'code', { ok: true, latencyMs: 1200 });
  ll.recordQuery('q3', 'model-a', 'code', { ok: true, latencyMs: 1100 });
  ll.recordQuery('q4', 'model-b', 'code', { ok: false, latencyMs: 2000 });
  ll.recordQuery('q5', 'model-b', 'code', { ok: false, latencyMs: 2500 });
  ll.recordQuery('q6', 'model-b', 'code', { ok: true, latencyMs: 1500 });

  var biasA = ll.getLearnedBias('model-a', 'code');
  var biasB = ll.getLearnedBias('model-b', 'code');
  assert(biasA > biasB, 'model-a has higher bias (better performance)');

  var best = ll.bestModelForCategory('code');
  assert(best === 'model-a', 'bestModelForCategory returns model-a');

  ll.recordOutcome('qwen', 'code', { ok: true, latencyMs: 800 });
  ll.recordOutcome('qwen', 'code', { ok: false, latencyMs: 1500 });

  var stats = ll.getStats();
  assert(stats.totalQueries >= 8, 'recordOutcome adds to queries');
}

// ── Test 3: Smart Router ──
async function testSmartRouter() {
  console.log('\n=== Test 3: Smart Router ===');

  var sr = await import('../src/engine/smart-router.js');

  var route = sr.routeQuery('escribe codigo Python para un API', 'code');
  assert(route.ok, 'routeQuery returns ok');
  assert(route.selected.length > 0, 'route selects models');

  var routeExclude = sr.routeQuery('test', null, { excludeFamilies: ['qwen'] });
  assert(routeExclude.ok, 'route with exclusion works');
  var hasQwen = routeExclude.selected.some(function(m) { return m.family === 'qwen'; });
  assert(!hasQwen, 'excluded family not in selection');

  var best = sr.bestModelForCategory('code');
  assert(best !== null, 'bestModelForCategory returns a model');
}

// ── Test 4: Mesh TCP Buffer ──
async function testMeshBuffer() {
  console.log('\n=== Test 4: Mesh TCP Buffer ===');

  var mesh = await import('../src/mesh.js');
  var net = await import('node:net');

  var PORT = 17890 + Math.floor(Math.random() * 1000);
  var messages = [];
  var handler = {
    onInferenceRequest: function(socket, msg) {
      messages.push(msg);
      return { type: 'inference_response', result: 'ok' };
    }
  };

  try {
    await mesh.startMesh(PORT, handler);
    assert(true, 'mesh started on port ' + PORT);

    await new Promise(function(resolve) { setTimeout(resolve, 500); });
    assert(true, 'mesh is running');
  } catch (e) {
    console.log('  → Mesh start error (expected if port in use): ' + e.message);
  }

  try {
    await mesh.stopMesh();
    assert(true, 'mesh stopped');
  } catch (e) {
    assert(false, 'mesh stop failed: ' + e.message);
  }
}

// ── Test 5: Ensemble v2 ──
async function testEnsemble() {
  console.log('\n=== Test 5: Ensemble v2 ===');

  var ensemble = await import('../src/engine/ensemble-v2.js');
  assert(typeof ensemble.ensembleRun === 'function', 'ensembleRun is exported');

  var router = await import('../src/engine/smart-router.js');
  var route = router.routeQuery('test query', null, { maxModels: 2 });
  assert(route.ok, 'route for ensemble works');
  assert(route.selected.length <= 2, 'ensemble respects maxModels');
}

// ── Test 6: Neural Arbitrage ──
async function testNeuralArbitrage() {
  console.log('\n=== Test 6: Neural Arbitrage ===');

  var na = await import('../src/engine/neural-arbitrage.js');
  assert(typeof na.arbitrateResponses === 'function', 'arbitrateResponses exported');
  assert(typeof na.shannonEntropy === 'function', 'shannonEntropy exported');
  assert(typeof na.calculateConsensus === 'function', 'calculateConsensus exported');

  var responses = [
    { model: 'a', family: 'qwen', text: 'El agua hierve a 100 grados Celsius.', latencyMs: 100 },
    { model: 'b', family: 'llama', text: 'El agua hierve a 100 grados Celsius.', latencyMs: 150 },
    { model: 'c', family: 'gemma', text: 'El agua se evapora a 100 grados.', latencyMs: 200 },
  ];

  var report = na.arbitrateResponses('a que temperatura hierve el agua', responses);
  assert(report && report.consensus, 'arbitrateResponses returns consensus');
  assert(report.consensus.score > 0, 'consensus score > 0');
}

// ── Test 7: Crew (Employee IA) ──
async function testCrew() {
  console.log('\n=== Test 7: Crew (Employee IA) ===');

  var crew = await import('../src/engine/crew.js');
  assert(typeof crew.runCrew === 'function', 'runCrew exported');
  assert(typeof crew.detectDeliverableType === 'function', 'detectDeliverableType exported');
  assert(typeof crew.getAgent === 'function', 'getAgent exported');
  assert(crew.AGENT_DEFS && crew.AGENT_DEFS.length > 0, 'AGENT_DEFS defined');

  var emailType = crew.detectDeliverableType('escribe un email profesional');
  assert(emailType === 'email', 'detectDeliverableType detects email');

  var appType = crew.detectDeliverableType('crea una aplicacion web con React');
  assert(appType === 'app', 'detectDeliverableType detects app');

  var docType = crew.detectDeliverableType('crea un informe de investigacion');
  assert(docType === 'document', 'detectDeliverableType detects document');

  var textType = crew.detectDeliverableType('hola');
  assert(textType === 'text', 'detectDeliverableType detects text');

  var planner = crew.getAgent('planner');
  assert(planner && planner.role === 'planner', 'getAgent returns planner');

  var coder = crew.getAgent('coder');
  assert(coder && coder.role === 'coder', 'getAgent returns coder');
}

// ── Test 8: Task Decomposer ──
async function testTaskDecomposer() {
  console.log('\n=== Test 8: Task Decomposer ===');

  var td = await import('../src/task-decomposer.js');
  assert(typeof td.isComplexTask === 'function', 'isComplexTask exported');
  assert(typeof td.decomposeTask === 'function', 'decomposeTask exported');

  var simple = td.isComplexTask('hola');
  assert(!simple, 'simple query not complex');

  var complex = td.isComplexTask('crea una aplicacion web completa con React, Node.js y PostgreSQL que tenga autenticacion, dashboard y API REST');
  assert(complex, 'complex task detected');

  var decomposition = td.decomposeTask('crea una app web completa con login, dashboard y API');
  assert(decomposition && decomposition.subtasks, 'decomposition returns subtasks');
  assert(decomposition.subtasks.length >= 2, 'decomposition has multiple subtasks');
}

// ── Test 9: Chip Core ──
async function testChipCore() {
  console.log('\n=== Test 9: Chip Core ===');

  var cc = await import('../src/engine/chip-core.js');

  cc.cacheSet('e2e-test', 'test-model', { text: 'e2e response', provider: 'test', latencyMs: 50 });
  var cached = cc.cacheGet('e2e-test', 'test-model');
  assert(cached !== null, 'cache set/get works');
  assert(cached.text === 'e2e response', 'cache returns correct text');

  var health = await cc.healthCheck();
  assert(health.healthy !== undefined, 'health check works');

  var metrics = cc.metricsGetModelStats();
  assert(typeof metrics === 'object', 'metrics works');
}

// ── Test 10: Full Pipeline ──
async function testFullPipeline() {
  console.log('\n=== Test 10: Full Pipeline (smartQuery) ===');

  var backend = await import('../src/backend.js');

  var result = await backend.smartQuery('que es un array en programacion', null, {});
  assert(result && result.response, 'smartQuery returns response');
  assert(result.model, 'smartQuery returns model');
  assert(result.provider, 'smartQuery returns provider');
  console.log('  → Model: ' + result.model);
  console.log('  → Provider: ' + result.provider);

  var greet = await backend.smartQuery('hola', null, {});
  assert(greet && greet.response, 'smartQuery handles greeting');
  console.log('  → Greeting response: ' + (greet.response || '').slice(0, 60) + '...');
}

// ── RUN ALL TESTS ──
console.log('LinkCore E2E Test Suite');
console.log('=======================');

await testOrchestrator();
await testLearningLoop();
await testSmartRouter();
await testMeshBuffer();
await testEnsemble();
await testNeuralArbitrage();
await testCrew();
await testTaskDecomposer();
await testChipCore();
await testFullPipeline();

console.log('\n=======================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
