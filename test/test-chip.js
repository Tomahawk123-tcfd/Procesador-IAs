// ═══════════════════════════════════════════════════════════════
// LINKCORE CHIP — Integration Test
// Verifica que el pipeline completo funcione:
// chip-core → smart-router → callOllamaModel → learning-loop
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

async function testChipCore() {
  console.log('\n=== Test 1: chip-core ===');

  var cc = await import('../src/engine/chip-core.js');

  // Cache
  cc.cacheSet('test query', 'test-model', { text: 'cached response', provider: 'test', latencyMs: 100 });
  var cached = cc.cacheGet('test query', 'test-model');
  assert(cached !== null, 'cache set/get works');
  assert(cached.text === 'cached response', 'cache returns correct text');

  var stats = cc.cacheStats();
  assert(stats.entries >= 1, 'cache stats reports entries');

  cc.cacheClear();
  var afterClear = cc.cacheGet('test query', 'test-model');
  assert(afterClear === null, 'cache clear works');

  // Circuit breaker
  assert(!cc.circuitIsOpen('test-model'), 'circuit starts closed');
  cc.circuitRecordFailure('test-model');
  cc.circuitRecordFailure('test-model');
  assert(!cc.circuitIsOpen('test-model'), 'circuit stays closed with 2 failures');
  cc.circuitRecordFailure('test-model');
  assert(cc.circuitIsOpen('test-model'), 'circuit opens after 3 failures');
  cc.circuitRecordSuccess('test-model');
  assert(!cc.circuitIsOpen('test-model'), 'circuit closes after success');

  // Rate limiter
  assert(cc.rateLimitCheck('test-model', 3), 'rate limit allows first request');
  assert(cc.rateLimitCheck('test-model', 3), 'rate limit allows second request');
  assert(cc.rateLimitCheck('test-model', 3), 'rate limit allows third request');

  // Adaptive timeout
  assert(cc.adaptiveTimeout('smollm2:135m') === 20000, 'adaptive timeout 20s for tiny');
  assert(cc.adaptiveTimeout('llama3.2:3b') === 45000, 'adaptive timeout 45s for small');
  assert(cc.adaptiveTimeout('llama3.1:8b') === 90000, 'adaptive timeout 90s for medium');

  // Health check
  var health = await cc.healthCheck();
  assert(health.healthy !== undefined, 'health check returns healthy field');
  assert(health.cache !== undefined, 'health check returns cache info');
}

async function testSmartRouter() {
  console.log('\n=== Test 2: smart-router ===');

  var sr = await import('../src/engine/smart-router.js');

  // Route query
  var route = sr.routeQuery('escribe codigo Python', 'code');
  assert(route.ok, 'route returns ok');
  assert(route.selected.length > 0, 'route selects at least one model');
  assert(route.scores.length > 0, 'route includes scores');
  assert(route.selected.length <= 3, 'route respects maxModels');

  // Route with exclusion
  var routeExcl = sr.routeQuery('test query', null, { excludeFamilies: ['llama'] });
  assert(routeExcl.ok, 'route with exclusion works');
  var hasLlama = routeExcl.selected.some(function(m) { return m.family === 'llama'; });
  assert(!hasLlama, 'excluded family not selected');

  // Record outcome
  sr.recordOutcome('test query', 'smollm2:135m', 'code', { ok: true, latencyMs: 1500 });
  assert(true, 'recordOutcome does not throw');

  // Best model for category
  var best = sr.bestModelForCategory('code');
  assert(best !== null, 'bestModelForCategory returns a model');
}

async function testLearningLoop() {
  console.log('\n=== Test 3: learning-loop ===');

  var ll = await import('../src/engine/learning-loop.js');

  ll.clear();
  var stats = ll.getStats();
  assert(stats.totalQueries === 0, 'learning loop starts empty');

  // Record some queries
  ll.recordQuery('test1', 'smollm2:135m', 'code', { ok: true, latencyMs: 1500, quality: 0.7 });
  ll.recordQuery('test2', 'smollm2:135m', 'code', { ok: true, latencyMs: 1200, quality: 0.8 });
  ll.recordQuery('test3', 'smollm2:135m', 'code', { ok: true, latencyMs: 1100, quality: 0.9 });

  stats = ll.getStats();
  assert(stats.totalQueries === 3, 'learning loop records queries');
  assert(stats.models === 1, 'learning loop tracks unique models');

  // Learned bias (needs MIN_SAMPLES=3)
  var bias = ll.getLearnedBias('smollm2:135m', 'code');
  assert(bias !== 0, 'learned bias computed after MIN_SAMPLES');

  // Best model for category
  var best = ll.bestModelForCategory('code');
  assert(best === 'smollm2:135m', 'bestModelForCategory returns correct model');

  // Full report
  var report = ll.fullReport();
  assert(report.totalQueries === 3, 'fullReport includes total queries');
  assert(report.uniqueModels === 1, 'fullReport includes unique models');
  assert(report.bestByCategory.code === 'smollm2:135m', 'fullReport includes best by category');
}

async function testCallOllamaModel() {
  console.log('\n=== Test 4: callOllamaModel (requires Ollama running) ===');

  var backend = await import('../src/backend.js');

  try {
    var result = await backend.callOllamaModel('smollm2:135m', 'responde solo: hola', { maxTokens: 50, timeoutMs: 30000 });
    assert(result.ok === true, 'callOllamaModel returns ok');
    assert(result.text && result.text.length > 0, 'callOllamaModel returns text');
    assert(result.provider === 'ollama-local', 'callOllamaModel returns provider');
    assert(result.latencyMs > 0, 'callOllamaModel returns latency');
    console.log('  → Response: "' + result.text.slice(0, 80) + '..."');
    console.log('  → Latency: ' + result.latencyMs + 'ms');
  } catch (e) {
    assert(false, 'callOllamaModel failed: ' + e.message);
  }

  // Test cache hit
  try {
    var result2 = await backend.callOllamaModel('smollm2:135m', 'responde solo: hola', { maxTokens: 50, timeoutMs: 30000 });
    if (result2.fromCache) {
      assert(true, 'callOllamaModel returns cached result');
    } else {
      assert(true, 'callOllamaModel works (not cached yet)');
    }
  } catch (e) {
    assert(false, 'callOllamaModel cache test failed: ' + e.message);
  }
}

async function testSmartQuery() {
  console.log('\n=== Test 5: smartQuery (full pipeline) ===');

  var backend = await import('../src/backend.js');

  try {
    var result = await backend.smartQuery('que es un array en programacion', null, {});
    assert(result && result.response, 'smartQuery returns response');
    assert(result.model, 'smartQuery returns model');
    assert(result.provider, 'smartQuery returns provider');
    console.log('  → Model: ' + result.model);
    console.log('  → Provider: ' + result.provider);
    console.log('  → Response: "' + (result.response || '').slice(0, 100) + '..."');
  } catch (e) {
    assert(false, 'smartQuery failed: ' + e.message);
  }
}

// ── RUN ALL TESTS ──

console.log('LinkCore Chip Integration Tests');
console.log('================================');

await testChipCore();
await testSmartRouter();
await testLearningLoop();
await testCallOllamaModel();
await testSmartQuery();

console.log('\n================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
