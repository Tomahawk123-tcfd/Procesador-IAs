// ═══════════════════════════════════════════════════════════════
// LOCAL-FIRST AI MESH: Malla de IA Soberana
//
// Protocolo de red descentralizado que permite a múltiples IAs
// locales compartir recursos de hardware y conocimiento:
//
// 1. TCP Socket Server: Acepta conexiones de otras instancias
// 2. Node Discovery: UDP broadcast para encontrar nodos en LAN
// 3. Inference Pooling: Distribuye inferencia entre nodos disponibles
// 4. Memory Sync: Sincroniza knowledge graphs entre nodos
// 5. Failover: Failover automático si un nodo falla
//
// Seguridad: Solo conexiones LAN, nunca expuesto a internet. Cada nodo
// tiene un ID único, y las operaciones que mutan estado local o consumen
// recursos (graph_sync, inference_request, task_delegation) exigen un
// secreto compartido -- ver MESH_SECRET mas abajo. Sin esto (bug real:
// esta linea llevaba tiempo prometiendo "verifica la integridad de
// datos" sin que el codigo lo hiciera -- ver la nota junto a
// verifyMeshToken), cualquier dispositivo en la misma LAN podia conectar
// al puerto TCP y (a) inyectar datos arbitrarios en el grafo de
// conocimiento persistente via graph_sync -- que mas tarde se inyecta en
// prompts reales, un vector de envenenamiento de contexto -- o (b) hacer
// que este nodo ejecutara inferencia/tareas por cuenta de un desconocido.
// heartbeat/ping/pong/node_announce quedan sin autenticar a proposito:
// son presencia y capacidad, ya publicas por diseño via broadcast UDP en
// claro -- protegerlas no añade seguridad real, solo rompe el
// descubrimiento basico de la malla.
// ═══════════════════════════════════════════════════════════════

import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { graphReport, exportGraph, importGraph, flush } from './memory-bus.js';

// ── CONSTANTS ──
var MESH_TCP_PORT = 17890;
var MESH_UDP_PORT = 17891;
var MESH_DISCOVERY_INTERVAL = 30000;
var MESH_NODE_TIMEOUT = 90000;
var MESH_MAX_NODES = 10;
var MESH_PROTOCOL_VERSION = 1;
var MESH_BACKPRESSURE_THRESHOLD = 16 * 1024 * 1024; // 16MB
var MESH_HEARTBEAT_INTERVAL = 30000; // 30s ping/pong
var MESH_HEARTBEAT_TIMEOUT = 10000; // 10s to respond

// ── SECRETO COMPARTIDO DE LA MALLA ──
// Emparejamiento simple tipo API-key: para que dos instalaciones de
// LinkCore formen malla, sus dueños copian el mismo secreto (fichero
// local, nunca se transmite). Un dispositivo que no lo tenga puede seguir
// viendo el broadcast UDP (presencia, ya publica), pero cualquier mensaje
// TCP que mute estado local o consuma recursos se rechaza sin el HMAC
// correcto. Autogenerado en el primer arranque -- no requiere
// configuracion manual para el caso de un solo nodo (que es el 100% de
// las instalaciones hasta que alguien empareja un segundo dispositivo a
// proposito).
var MESH_SECRET_FILE = path.join(os.homedir(), '.linkcore', 'mesh-secret.txt');

function loadOrCreateMeshSecret() {
  try {
    if (fs.existsSync(MESH_SECRET_FILE)) {
      var existing = fs.readFileSync(MESH_SECRET_FILE, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch (e) {}
  var fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(MESH_SECRET_FILE), { recursive: true });
    fs.writeFileSync(MESH_SECRET_FILE, fresh, 'utf-8');
  } catch (e) {}
  return fresh;
}

var _meshSecret = loadOrCreateMeshSecret();

// Serializa un valor de forma canonica (claves de objeto ordenadas) para
// que el hash del payload no dependa del orden de insercion -- si no,
// mensajes legitimos con el mismo contenido pero distinto orden de claves
// (p.ej. JSON reconstruido por otro cliente) fallarian la verificacion.
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  var keys = Object.keys(value).sort();
  return '{' + keys.map(function(k) {
    return JSON.stringify(k) + ':' + canonicalStringify(value[k]);
  }).join(',') + '}';
}

// Extrae y hashea los campos de payload relevantes segun el tipo de
// mensaje. Se incluye en la base firmada para que un atacante on-path no
// pueda reescribir query/options/graphData de un mensaje ya firmado
// validamente y que verifyMeshToken lo siga aceptando.
function payloadDigest(msg) {
  var payload;
  switch (msg.type) {
    case 'inference_request':
      payload = { query: msg.query, options: msg.options };
      break;
    case 'graph_sync':
      payload = { graphData: msg.graphData };
      break;
    case 'task_delegation':
      payload = { query: msg.query };
      break;
    default:
      payload = {};
  }
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

// Firma un mensaje saliente sensible: HMAC sobre nodeId+type+campos que
// identifican la peticion+hash del payload real (query/options/graphData
// segun el tipo), para que el HMAC ate la firma al contenido concreto y no
// solo a los metadatos de la peticion.
function signMeshMessage(msg) {
  // nodeId debe fijarse ANTES de calcular la base -- verifyMeshToken() en
  // el receptor reconstruye la misma base a partir de msg.nodeId (no
  // conoce el _nodeId del emisor por ningun otro medio), asi que si aqui
  // se usara el _nodeId local sin escribirlo tambien en el mensaje, la
  // base firmada y la base verificada nunca coincidirian -- ni para
  // peticiones legitimas.
  if (!msg.nodeId) msg.nodeId = _nodeId;
  var basis = msg.nodeId + ':' + msg.type + ':' + (msg.requestId || msg.taskId || '') + ':' + payloadDigest(msg);
  msg.auth = crypto.createHmac('sha256', _meshSecret).update(basis).digest('hex');
  return msg;
}

// Verifica un mensaje entrante sensible. Comparacion en tiempo constante
// -- timingSafeEqual exige buffers del mismo tamaño, asi que un HMAC de
// longitud distinta (ausente, corto, mal formado) se rechaza primero sin
// comparar, en vez de dejar pasar una excepcion.
function verifyMeshToken(msg) {
  if (!msg || typeof msg.auth !== 'string') return false;
  var basis = (msg.nodeId || '') + ':' + msg.type + ':' + (msg.requestId || msg.taskId || '') + ':' + payloadDigest(msg);
  var expected = crypto.createHmac('sha256', _meshSecret).update(basis).digest('hex');
  var a = Buffer.from(msg.auth, 'hex');
  var b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// ── STATE
var _nodeId = crypto.randomUUID ? crypto.randomUUID() : 'node-' + Date.now();
var _nodes = {};
var _tcpServer = null;
var _udpSocket = null;
var _discoveryTimer = null;
var _cleanupTimer = null;
var _heartbeatTimer = null;
var _onInferenceRequest = null;
var _onNodeUpdate = null;
var _installedModels = [];
var _socketBuffers = new Map(); // socket -> { size, paused, pending }

// ── NODE IDENTITY
export function getNodeId() { return _nodeId; }
export function getNodes() { return Object.values(_nodes); }
export function getNodeCount() { return Object.keys(_nodes).length; }

// ── GET LOCAL IP ──
function getLocalIP() {
  var interfaces = os.networkInterfaces();
  var names = Object.keys(interfaces);
  for (var i = 0; i < names.length; i++) {
    var addrs = interfaces[names[i]];
    for (var j = 0; j < addrs.length; j++) {
      var addr = addrs[j];
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

// ── TCP SERVER ──
// Handles incoming connections from other LinkCore instances

function startTCPServer(port, handlers) {
  return new Promise(function(resolve, reject) {
    _tcpServer = net.createServer(function(socket) {
      var state = { size: 0, paused: false, pending: '' };
      _socketBuffers.set(socket, state);

      socket.on('data', function(chunk) {
        state.size += chunk.length;

        if (!state.paused && state.size > MESH_BACKPRESSURE_THRESHOLD) {
          socket.pause();
          state.paused = true;
        }

        state.pending += chunk.toString();
        var lines = state.pending.split('\n');
        state.pending = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;

          try {
            var msg = JSON.parse(line);
            handleMessage(socket, msg, handlers);
          } catch (e) {
            sendToSocket(socket, { type: 'error', error: 'invalid_json' });
          }
        }

        // Reduce buffer size estimate after processing
        state.size = Math.max(0, state.size - chunk.length);

        // RESUME: If buffer drained, resume socket
        if (state.paused && state.size < MESH_BACKPRESSURE_THRESHOLD / 2) {
          socket.resume();
          state.paused = false;
        }
      });

      socket.on('error', function(err) {
        _socketBuffers.delete(socket);
      });

      socket.on('close', function() {
        _socketBuffers.delete(socket);
      });
    });

    _tcpServer.on('error', function(err) {
      reject(err);
    });

    _tcpServer.listen(port, function() {
      resolve(_tcpServer);
    });
  });
}

function handleMessage(socket, msg, handlers) {
  switch (msg.type) {
    case 'heartbeat':
      respondToHeartbeat(socket, msg);
      break;
    case 'heartbeat_response':
      handleHeartbeatResponse(msg);
      break;
    case 'ping':
      sendToSocket(socket, { type: 'pong', nodeId: _nodeId, timestamp: Date.now() });
      break;
    case 'pong':
      handlePong(msg);
      break;
    case 'inference_request':
      if (!verifyMeshToken(msg)) { sendToSocket(socket, { type: 'error', error: 'auth_failed' }); break; }
      handleInferenceRequest(socket, msg, handlers);
      break;
    case 'inference_response':
      handleInferenceResponse(msg);
      break;
    case 'graph_sync':
      if (!verifyMeshToken(msg)) { sendToSocket(socket, { type: 'error', error: 'auth_failed' }); break; }
      handleGraphSync(socket, msg);
      break;
    case 'node_announce':
      handleNodeAnnounce(msg, socket);
      break;
    case 'task_delegation':
      if (!verifyMeshToken(msg)) { sendToSocket(socket, { type: 'error', error: 'auth_failed' }); break; }
      handleTaskDelegation(socket, msg, handlers);
      break;
    default:
      sendToSocket(socket, { type: 'error', error: 'unknown_type: ' + msg.type });
  }
}

function sendToSocket(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch (e) {}
}

// ── HEARTBEAT ──
function respondToHeartbeat(socket, msg) {
  sendToSocket(socket, {
    type: 'heartbeat_response',
    nodeId: _nodeId,
    timestamp: Date.now(),
    load: getSystemLoad(),
    models: getAvailableModels(),
    graphSize: graphReport().entities,
  });
}

// ── ACTIVE HEARTBEAT (PING/PONG) ──
// Detects zombie connections that passive timeout misses

function handleHeartbeatResponse(msg) {
  if (!msg.nodeId) return;
  var node = _nodes[msg.nodeId];
  if (node) {
    node.lastSeen = Date.now();
    node.load = msg.load || 0;
    node.pinging = false;
  }
}

function handlePong(msg) {
  if (!msg.nodeId) return;
  var node = _nodes[msg.nodeId];
  if (node) {
    node.lastSeen = Date.now();
    node.pinging = false;
  }
}

function sendActiveHeartbeat() {
  var ids = Object.keys(_nodes);
  for (var i = 0; i < ids.length; i++) {
    var node = _nodes[ids[i]];
    if (node.pinging) continue;

    var staleThreshold = MESH_HEARTBEAT_INTERVAL * 2;
    if (Date.now() - node.lastSeen > staleThreshold) {
      delete _nodes[ids[i]];
      if (_onNodeUpdate) _onNodeUpdate('node_zombie_removed', node);
      continue;
    }

    node.pinging = true;
    var client = net.createConnection(node.port, node.ip, function() {
      sendToSocket(client, { type: 'ping', nodeId: _nodeId, timestamp: Date.now() });
    });
    client.on('error', function() {});
    client.on('data', function() {});
    (function(n, c) {
      setTimeout(function() {
        if (n.pinging) {
          n.pinging = false;
          n.consecutiveFailures = (n.consecutiveFailures || 0) + 1;
          if (n.consecutiveFailures >= 3) {
            delete _nodes[n.id];
            if (_onNodeUpdate) _onNodeUpdate('node_failed', n);
          }
          try { c.end(); } catch (e) {}
        }
      }, MESH_HEARTBEAT_TIMEOUT);
    })(node, client);
  }
}

function handleNodeAnnounce(msg, socket) {
  if (!msg.nodeId || msg.nodeId === _nodeId) return;

  var isNew = !_nodes[msg.nodeId];

  // Cupo de la malla: node_announce llega sin autenticar (a proposito, ver
  // cabecera del fichero), asi que sin este limite cualquier cliente TCP
  // podria registrar nodos falsos sin fin y agotar memoria en _nodes. Las
  // actualizaciones de un nodeId ya registrado siempre se permiten -- solo
  // se bloquean altas nuevas una vez lleno el cupo.
  if (isNew && Object.keys(_nodes).length >= MESH_MAX_NODES) return;

  // Via TCP (socket presente), la IP real es la del socket, nunca msg.ip
  // -- node_announce no esta autenticado, asi que confiar en msg.ip deja
  // que cualquier cliente anuncie una IP arbitraria (spoofing de nodo,
  // p.ej. para desviar delegateInference/delegateTask/syncGraphWithNode a
  // una maquina distinta de quien realmente conecto). El descubrimiento
  // UDP (mas abajo) ya hace lo correcto usando rinfo.address en vez del
  // cuerpo del mensaje; aqui replicamos lo mismo para el camino TCP.
  var ip = msg.ip;
  if (socket && socket.remoteAddress) {
    ip = socket.remoteAddress.replace(/^::ffff:/, '');
  }

  _nodes[msg.nodeId] = {
    id: msg.nodeId,
    ip: ip,
    port: msg.port || MESH_TCP_PORT,
    lastSeen: Date.now(),
    load: msg.load || 0,
    models: msg.models || [],
    graphSize: msg.graphSize || 0,
    version: msg.version || 0,
  };

  if (isNew && _onNodeUpdate) {
    _onNodeUpdate('node_joined', _nodes[msg.nodeId]);
  } else if (!isNew && _onNodeUpdate) {
    _onNodeUpdate('node_updated', _nodes[msg.nodeId]);
  }
}

// ── INFERENCE POOLING ──
// Distributes inference tasks across available nodes

async function handleInferenceRequest(socket, msg, handlers) {
  if (!handlers || !handlers.infer) {
    sendToSocket(socket, { type: 'error', error: 'no_inference_handler' });
    return;
  }

  try {
    var result = await handlers.infer(msg.query, msg.model, msg.options);
    sendToSocket(socket, {
      type: 'inference_response',
      requestId: msg.requestId,
      nodeId: _nodeId,
      result: result,
    });
  } catch (e) {
    sendToSocket(socket, {
      type: 'inference_response',
      requestId: msg.requestId,
      nodeId: _nodeId,
      error: e.message,
    });
  }
}

function handleInferenceResponse(msg) {
  // Store response for pending requests
  if (msg.requestId && _pendingRequests[msg.requestId]) {
    _pendingRequests[msg.requestId].resolve(msg);
    delete _pendingRequests[msg.requestId];
  }
}

var _pendingRequests = {};

export async function delegateInference(query, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 30000;
  var preferredNode = opts.preferredNode || null;

  // Find available nodes
  var available = Object.values(_nodes).filter(function(n) {
    return (Date.now() - n.lastSeen) < MESH_NODE_TIMEOUT && n.load < 0.9;
  });

  if (available.length === 0) {
    return { ok: false, error: 'no_nodes_available' };
  }

  // Sort by load (prefer less loaded)
  available.sort(function(a, b) { return a.load - b.load; });

  // Use preferred node if available
  var target = available[0];
  if (preferredNode) {
    var preferred = _nodes[preferredNode];
    if (preferred && (Date.now() - preferred.lastSeen) < MESH_NODE_TIMEOUT) {
      target = preferred;
    }
  }

  var requestId = crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now();

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      delete _pendingRequests[requestId];
      reject(new Error('Inference timeout'));
    }, timeout);

    _pendingRequests[requestId] = {
      resolve: function(result) {
        clearTimeout(timer);
        resolve(result);
      },
      reject: function(err) {
        clearTimeout(timer);
        reject(err);
      },
    };

    // Connect to target node and send request
    var client = net.createConnection(target.port, target.ip, function() {
      sendToSocket(client, signMeshMessage({
        type: 'inference_request',
        requestId: requestId,
        query: query,
        options: opts,
      }));
    });

    client.on('error', function(err) {
      clearTimeout(timer);
      delete _pendingRequests[requestId];
      reject(err);
    });

    client.on('data', function(chunk) {
      var lines = chunk.toString().split('\n');
      for (var i = 0; i < lines.length; i++) {
        try {
          var msg = JSON.parse(lines[i]);
          if (msg.type === 'inference_response' && msg.requestId === requestId) {
            client.end();
            if (msg.error) {
              reject(new Error(msg.error));
            } else {
              resolve(msg.result);
            }
          }
        } catch (e) {}
      }
    });
  });
}

// ── MEMORY SYNC ──
// Synchronize knowledge graphs between nodes

function handleGraphSync(socket, msg) {
  if (!msg.graphData) {
    sendToSocket(socket, { type: 'error', error: 'no_graph_data' });
    return;
  }

  var success = importGraph(msg.graphData);
  sendToSocket(socket, {
    type: 'graph_sync_response',
    nodeId: _nodeId,
    success: success,
    graphSize: graphReport().entities,
  });
}

export async function syncGraphWithNode(nodeId) {
  var node = _nodes[nodeId];
  if (!node) return { ok: false, error: 'node_not_found' };

  return new Promise(function(resolve, reject) {
    var client = net.createConnection(node.port, node.ip, function() {
      sendToSocket(client, signMeshMessage({
        type: 'graph_sync',
        nodeId: _nodeId,
        graphData: exportGraph(),
      }));
    });

    var timer = setTimeout(function() {
      reject(new Error('Sync timeout'));
    }, 15000);

    client.on('data', function(chunk) {
      var lines = chunk.toString().split('\n');
      for (var i = 0; i < lines.length; i++) {
        try {
          var msg = JSON.parse(lines[i]);
          if (msg.type === 'graph_sync_response') {
            clearTimeout(timer);
            client.end();
            resolve({ ok: msg.success, graphSize: msg.graphSize });
          }
        } catch (e) {}
      }
    });

    client.on('error', function(err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── TASK DELEGATION ──
// Delegate a complete task to another node

function handleTaskDelegation(socket, msg, handlers) {
  if (!handlers || !handlers.ask) {
    sendToSocket(socket, { type: 'error', error: 'no_ask_handler' });
    return;
  }

  handlers.ask(msg.query, function() {}).then(function(result) {
    sendToSocket(socket, {
      type: 'task_response',
      taskId: msg.taskId,
      nodeId: _nodeId,
      result: result,
    });
  }).catch(function(e) {
    sendToSocket(socket, {
      type: 'task_response',
      taskId: msg.taskId,
      nodeId: _nodeId,
      error: e.message,
    });
  });
}

export async function delegateTask(query, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 60000;

  var available = Object.values(_nodes).filter(function(n) {
    return (Date.now() - n.lastSeen) < MESH_NODE_TIMEOUT && n.load < 0.8;
  });

  if (available.length === 0) {
    return { ok: false, error: 'no_nodes_available' };
  }

  available.sort(function(a, b) { return a.load - b.load; });
  var target = available[0];

  var taskId = crypto.randomUUID ? crypto.randomUUID() : 'task-' + Date.now();

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('Task delegation timeout'));
    }, timeout);

    var client = net.createConnection(target.port, target.ip, function() {
      sendToSocket(client, signMeshMessage({
        type: 'task_delegation',
        taskId: taskId,
        query: query,
      }));
    });

    client.on('data', function(chunk) {
      var lines = chunk.toString().split('\n');
      for (var i = 0; i < lines.length; i++) {
        try {
          var msg = JSON.parse(lines[i]);
          if (msg.type === 'task_response' && msg.taskId === taskId) {
            clearTimeout(timer);
            client.end();
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        } catch (e) {}
      }
    });

    client.on('error', function(err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── UDP DISCOVERY ──
// Broadcast presence and discover other nodes on LAN

function startDiscovery(port) {
  _udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  _udpSocket.on('message', function(msg, rinfo) {
    try {
      var data = JSON.parse(msg.toString());
      if (data.type === 'linkcore_discovery' && data.nodeId !== _nodeId) {
        handleNodeAnnounce({
          nodeId: data.nodeId,
          ip: rinfo.address,
          port: data.port || MESH_TCP_PORT,
          load: data.load,
          models: data.models,
          graphSize: data.graphSize,
        });
      }
    } catch (e) {}
  });

  _udpSocket.bind(port, function() {
    _udpSocket.setBroadcast(true);
    broadcastPresence();
    _discoveryTimer = setInterval(broadcastPresence, MESH_DISCOVERY_INTERVAL);
  });
}

function broadcastPresence() {
  if (!_udpSocket) return;

  var msg = JSON.stringify({
    type: 'linkcore_discovery',
    nodeId: _nodeId,
    port: MESH_TCP_PORT,
    load: getSystemLoad(),
    models: getAvailableModels(),
    graphSize: graphReport().entities,
    version: MESH_PROTOCOL_VERSION,
  });

  var buffer = Buffer.from(msg);
  // Try subnet broadcast first, fall back to 255.255.255.255
  var broadcastAddr = getSubnetBroadcast() || '255.255.255.255';
  _udpSocket.send(buffer, 0, buffer.length, MESH_UDP_PORT, broadcastAddr, function() {});
  // Also send to general broadcast as fallback
  if (broadcastAddr !== '255.255.255.255') {
    _udpSocket.send(buffer, 0, buffer.length, MESH_UDP_PORT, '255.255.255.255', function() {});
  }
}

function getSubnetBroadcast() {
  var interfaces = os.networkInterfaces();
  var names = Object.keys(interfaces);
  for (var i = 0; i < names.length; i++) {
    var addrs = interfaces[names[i]];
    for (var j = 0; j < addrs.length; j++) {
      var addr = addrs[j];
      if (addr.family === 'IPv4' && !addr.internal && addr.address !== '127.0.0.1') {
        // Calculate broadcast from IP and mask
        var ipParts = addr.address.split('.').map(Number);
        var maskParts = (addr.netmask || '255.255.255.0').split('.').map(Number);
        var broadcast = [];
        for (var k = 0; k < 4; k++) {
          broadcast.push((ipParts[k] | (~maskParts[k] & 255)));
        }
        return broadcast.join('.');
      }
    }
  }
  return null;
}

// ── SYSTEM METRICS ──

function getSystemLoad() {
  var cpus = os.cpus();
  var totalIdle = 0;
  var totalTick = 0;
  for (var i = 0; i < cpus.length; i++) {
    var cpu = cpus[i];
    var times = cpu.times;
    totalIdle += times.idle;
    totalTick += times.user + times.nice + times.sys + times.idle;
  }
  return totalTick > 0 ? 1 - (totalIdle / totalTick) : 0;
}

function getAvailableModels() {
  return _installedModels;
}

// ── NODE CLEANUP ──
// Remove nodes that haven't sent heartbeat recently

function cleanupNodes() {
  var now = Date.now();
  var ids = Object.keys(_nodes);
  for (var i = 0; i < ids.length; i++) {
    var node = _nodes[ids[i]];
    if (now - node.lastSeen > MESH_NODE_TIMEOUT) {
      delete _nodes[ids[i]];
      if (_onNodeUpdate) {
        _onNodeUpdate('node_left', node);
      }
    }
  }
}

// ── MESH REPORT ──

export function meshReport() {
  var nodes = Object.values(_nodes).map(function(n) {
    return {
      id: n.id,
      ip: n.ip,
      port: n.port,
      load: n.load ? (n.load * 100).toFixed(1) + '%' : 'N/A',
      models: n.models.length,
      graphSize: n.graphSize,
      lastSeen: Math.round((Date.now() - n.lastSeen) / 1000) + 's ago',
    };
  });

  return {
    nodeId: _nodeId,
    localIP: getLocalIP(),
    tcpPort: MESH_TCP_PORT,
    udpPort: MESH_UDP_PORT,
    nodeCount: nodes.length,
    maxNodes: MESH_MAX_NODES,
    nodes: nodes,
    protocolVersion: MESH_PROTOCOL_VERSION,
  };
}

// ── START/STOP ──

export async function startMesh(opts) {
  opts = opts || {};
  var tcpPort = opts.tcpPort || MESH_TCP_PORT;
  var udpPort = opts.udpPort || MESH_UDP_PORT;
  var handlers = opts.handlers || {};

  _onInferenceRequest = handlers.infer || null;
  _onNodeUpdate = handlers.onNodeUpdate || null;
  _installedModels = opts.installedModels || [];

  // Start TCP server with retry on port conflict
  var attempts = 0;
  while (attempts < 5) {
    try {
      await startTCPServer(tcpPort, handlers);
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE' && attempts < 4) {
        tcpPort++;
        attempts++;
      } else {
        throw e;
      }
    }
  }

  // Start UDP discovery
  startDiscovery(udpPort);

  // Start node cleanup + active heartbeat
  _cleanupTimer = setInterval(cleanupNodes, MESH_NODE_TIMEOUT / 2);
  _heartbeatTimer = setInterval(sendActiveHeartbeat, MESH_HEARTBEAT_INTERVAL);

  return {
    nodeId: _nodeId,
    tcpPort: tcpPort,
    udpPort: udpPort,
    ip: getLocalIP(),
  };
}

export function stopMesh() {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer);
    _discoveryTimer = null;
  }
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  if (_udpSocket) {
    _udpSocket.close();
    _udpSocket = null;
  }
  if (_tcpServer) {
    _tcpServer.close();
    _tcpServer = null;
  }
  _nodes = {};
  _socketBuffers.clear();
}
