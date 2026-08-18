// ═══════════════════════════════════════════════════════════════
// LINKCORE SDK TEST
// Verifica que el SDK funciona contra el servicio corriendo.
// Requiere: linkcore start en otra terminal
// ═══════════════════════════════════════════════════════════════

import { LinkCore } from './index.js';

var passed = 0;
var failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

var lc = new LinkCore({ timeout: 60000 });

console.log('LinkCore SDK Tests\n');

// Test 1: health
console.log('=== Test 1: health ===');
var health = await lc.health();
assert(health.ok === true, 'health returns ok');
assert(health.service === 'linkcore-core-service', 'health returns service name');
assert(health.version, 'health returns version');
console.log('  → Service: ' + health.service + ' v' + health.version);
console.log('  → Uptime: ' + health.uptime + 's');
console.log('  → Ollama: ' + (health.ollama ? 'running' : 'not running'));

// Test 2: status
console.log('\n=== Test 2: status ===');
var status = await lc.status();
assert(status.service === 'linkcore-core-service', 'status returns service');
assert(status.ollama, 'status returns ollama info');
console.log('  → Models in catalog: ' + (status.ollama ? status.ollama.catalogo : 0));
console.log('  → Models loaded: ' + (status.ollama ? status.ollama.modelosCargados.join(', ') : 'none'));

// Test 3: chip
console.log('\n=== Test 3: chip ===');
var chip = await lc.chip();
assert(chip.health, 'chip returns health');
assert(chip.learning, 'chip returns learning stats');
console.log('  → Cache entries: ' + (chip.health.cache ? chip.health.cache.entries : 0));
console.log('  → Total queries: ' + (chip.learning ? chip.learning.totalQueries : 0));

// Test 4: models
console.log('\n=== Test 4: models ===');
var models = await lc.models();
assert(Array.isArray(models.installed), 'models returns installed list');
console.log('  → Installed: ' + models.installed.length + ' models');

// Test 5: ask
console.log('\n=== Test 5: ask ===');
var result = await lc.ask('responde solo: hola mundo');
assert(result.text && result.text.length > 0, 'ask returns text');
assert(result.model, 'ask returns model');
assert(result.provider, 'ask returns provider');
assert(result.latencyMs > 0, 'ask returns latency');
console.log('  → Text: "' + result.text.slice(0, 80) + '..."');
console.log('  → Model: ' + result.model);
console.log('  → Provider: ' + result.provider);
console.log('  → Latency: ' + result.latencyMs + 'ms');

// Test 6: ask with cache
console.log('\n=== Test 6: ask (cache hit) ===');
var result2 = await lc.ask('responde solo: hola mundo');
assert(result2.text && result2.text.length > 0, 'cached ask returns text');
console.log('  → Latency: ' + result2.latencyMs + 'ms (should be faster)');

console.log('\n================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
