// ═══════════════════════════════════════════════════════════════
// STRESS TEST: 10 nodos Mesh + 5000 chunks + caídas aleatorias
//
// Simula el límite superior del sistema:
// - 10 nodos TCP conectados simultáneamente
// - 5,000 chunks TCP sin delimitador \n por segundo
// - Caídas aleatorias de nodos para testear cleanupTimer
// - Verifica que el Event Loop no se bloquea
// ═══════════════════════════════════════════════════════════════

import net from 'node:net';
import { startMesh, stopMesh, getNodeId, getNodes } from '../src/mesh.js';

var NODE_COUNT = 10;
var CHUNKS_PER_SECOND = 5000;
var TEST_DURATION_MS = 10000;
var CHUNK_SIZE = 256;

var results = {
  nodesConnected: 0,
  chunksSent: 0,
  chunksReceived: 0,
  errors: 0,
  eventLoopBlocked: false,
  zombieNodesDetected: 0,
};

var _clients = [];
var _serverInfo = null;

async function runStressTest() {
  console.log('=== LINKCORE MESH STRESS TEST ===');
  console.log('Nodes: ' + NODE_COUNT + ' | Chunks/s: ' + CHUNKS_PER_SECOND + ' | Duration: ' + TEST_DURATION_MS + 'ms');

  // Start mesh server
  _serverInfo = await startMesh({
    tcpPort: 17890,
    handlers: {
      infer: async function(q) { return { text: 'ok' }; },
      ask: async function(q) { return { response: 'ok' }; },
      onNodeUpdate: function(event, node) {
        if (event === 'node_zombie_removed') results.zombieNodesDetected++;
      },
    },
  });
  console.log('Server started on port ' + _serverInfo.tcpPort);

  // Connect N clients
  for (var i = 0; i < NODE_COUNT; i++) {
    await connectClient(i);
  }
  console.log('Connected ' + results.nodesConnected + '/' + NODE_COUNT + ' clients');

  // Monitor event loop lag
  var lastCheck = Date.now();
  var eventLoopTimer = setInterval(function() {
    var now = Date.now();
    var lag = now - lastCheck - 100; // Expected 100ms
    if (lag > 500) {
      results.eventLoopBlocked = true;
      console.log('WARNING: Event loop blocked for ' + lag + 'ms');
    }
    lastCheck = now;
  }, 100);

  // Send chunks at high rate
  var startTime = Date.now();
  var sendInterval = setInterval(function() {
    var elapsed = Date.now() - startTime;
    if (elapsed > TEST_DURATION_MS) {
      clearInterval(sendInterval);
      return;
    }

    var chunksThisTick = Math.ceil(CHUNKS_PER_SECOND / 100);
    for (var i = 0; i < chunksThisTick; i++) {
      var clientIdx = Math.floor(Math.random() * _clients.length);
      var client = _clients[clientIdx];
      if (!client || client.destroyed) continue;

      var chunk = Buffer.alloc(CHUNK_SIZE);
      crypto.randomFillSync(chunk);
      // Intentionally NO \n — tests backpressure with raw chunks
      client.write(chunk, function(err) {
        if (err) results.errors++;
        else results.chunksSent++;
      });
    }
  }, 10); // 100 ticks/second

  // Random node failures
  var failureTimer = setInterval(function() {
    if (Date.now() - startTime > TEST_DURATION_MS) {
      clearInterval(failureTimer);
      return;
    }
    var idx = Math.floor(Math.random() * _clients.length);
    if (_clients[idx] && !_clients[idx].destroyed) {
      _clients[idx].destroy();
      _clients[idx] = null;
    }
  }, 1500); // Kill a node every 1.5s

  // Wait for test to complete
  await new Promise(function(resolve) {
    setTimeout(resolve, TEST_DURATION_MS + 2000);
  });

  clearInterval(eventLoopTimer);
  clearInterval(failureTimer);

  // Print results
  console.log('\n=== RESULTS ===');
  console.log('Chunks sent:          ' + results.chunksSent);
  console.log('Errors:               ' + results.errors);
  console.log('Event loop blocked:   ' + (results.eventLoopBlocked ? 'YES (FAIL)' : 'NO (PASS)'));
  console.log('Zombie nodes removed: ' + results.zombieNodesDetected);
  console.log('Active nodes:         ' + getNodes().length);

  // Cleanup
  _clients.forEach(function(c) { if (c && !c.destroyed) c.destroy(); });
  stopMesh();

  var passed = !results.eventLoopBlocked && results.chunksSent > 0;
  console.log('\n' + (passed ? 'PASS' : 'FAIL'));
  process.exit(passed ? 0 : 1);
}

function connectClient(idx) {
  return new Promise(function(resolve) {
    var client = net.createConnection(_serverInfo.tcpPort, '127.0.0.1', function() {
      results.nodesConnected++;
      _clients.push(client);

      // Send announce
      client.write(JSON.stringify({
        type: 'node_announce',
        nodeId: 'stress-node-' + idx,
        ip: '127.0.0.1',
        port: _serverInfo.tcpPort,
        load: Math.random(),
        models: ['model-' + idx],
        graphSize: idx,
      }) + '\n');

      resolve();
    });
    client.on('error', function() {
      results.errors++;
      resolve();
    });
  });
}

// Import crypto for random data
import crypto from 'node:crypto';

runStressTest().catch(function(e) {
  console.error('STRESS TEST FAILED:', e);
  process.exit(1);
});
