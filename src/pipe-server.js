// ═══════════════════════════════════════════════════════════════
// SERVIDOR DE TUBERIA CON NOMBRE — el "chip virtual"
//
// Sin puerto, sin localhost, sin URL: usa el mecanismo de tuberias con
// nombre del propio sistema operativo (`\\.\pipe\linkcore` en
// Windows). Solo procesos del mismo ordenador pueden hablarle -- nunca
// queda expuesto a la red, ni por accidente.
//
// Protocolo: NDJSON (una linea = un objeto JSON) en ambas direcciones.
// El cliente manda una peticion, el servidor responde con 0+ lineas de
// progreso y una linea final de tipo 'done' o 'error'.
//
//   Peticiones que acepta:
//     {"type":"status"}                     -> info del servicio + proveedores
//     {"type":"ask","query":"..."}          -> orquesta + intermedia + responde
//     {"type":"chip"}                       -> reporte completo del chip
//     {"type":"vnpu","opcode":"vNPU.EXEC","payload":{...}}
//                                            -> instruccion real al procesador
//                                               (ver src/engine/vnpu-core.js);
//                                               via real de `linkcore vnpu`
//     {"type":"quality","action":"report"}   -> inteligencia agregada sobre
//                                               el historial de verificacion
//                                               (ver engine/quality-engine.js)
//     {"type":"quality","action":"label","eventId":"..","problemConfirmed":true}
//     {"type":"audit"}                       -> registros recientes del libro
//                                               de auditoria + veredicto de
//                                               integridad (ver engine/audit-ledger.js)
//     {"type":"audit","action":"verify"}     -> verificacion completa forzada
//                                               de la cadena (rotacion + ancla)
// ═══════════════════════════════════════════════════════════════

import net from 'node:net';
import os from 'node:os';
import readline from 'node:readline';

// ── PAQUETE vNPU: metadatos reales de la peticion, no inventados ──
// Cada campo sale de un dato que `result` (lo que smartQuery() devuelve
// de verdad) ya trae, o de una relectura barata (~4ms, ya medido hoy) del
// texto final -- nunca un valor fijo tipo "MCTS_OPTIMAL" puesto a mano.
// Si un dato no esta disponible para esta peticion concreta, el campo se
// omite en vez de rellenarse con algo inventado.
async function buildVnpuPacket(result, applyDeterministicVerification, query) {
  var pkt = {
    cyclesMs: typeof result.latencyMs === 'number' ? result.latencyMs : null,
    cacheHit: !!result.fromCache,
  };

  if (result.judgeReason) pkt.routingDecision = result.judgeReason;

  var chiplets = [];
  if (result.ensemble && Array.isArray(result.ensemble.models) && result.ensemble.models.length) {
    chiplets = result.ensemble.models;
  } else if (result.model) {
    chiplets = [result.model];
  }
  if (chiplets.length) pkt.chipletsEngaged = chiplets;

  // "Traduccion de bus": solo se cuenta si de verdad hubo ronda 2 (los
  // modelos se vieron entre si y revisaron), que es cuando
  // translateForModel()/buildContextPacket() entran en juego de verdad.
  if (result.ensemble && Array.isArray(result.ensemble.round2)) {
    pkt.busTranslations = result.ensemble.round2.filter(function (r) { return r && r.revised; }).length;
  }

  // Desglose real por ALU (2026-08-13): antes era un unico booleano
  // agregado (hasFindings) -- no distinguia CUAL verificador encontro algo.
  // Cada categoria se llama por separado, con su propio veredicto
  // PASSED/FAILED, igual que un CPU real reporta el estado de cada unidad
  // de ejecucion por separado, no un "algo fallo" generico.
  if (result.response) {
    try {
      var mathMod = await import('./engine/math-verify.js');
      var codeMod = await import('./engine/code-verify.js');
      var translationMod = await import('./engine/translation.js');

      var mathFindings = mathMod.verifyCalculations(result.response);
      var opFindings = query ? mathMod.verifyOperationMatchesQuery(query, result.response) : [];
      var codeFindings = await codeMod.verifyCodeBlocks(result.response);
      var topicMismatch = query ? translationMod.looksLikeTopicMismatch(query, result.response) : false;

      pkt.aluVerification = {
        math: (mathFindings.length === 0 && opFindings.length === 0) ? 'PASSED' : 'FAILED',
        code: codeFindings.length === 0 ? 'PASSED' : 'FAILED',
        topic: topicMismatch ? 'FAILED' : 'PASSED',
      };
    } catch (e) {
      // Si algun verificador individual falla al importarse/ejecutarse, se
      // cae al agregado existente (applyDeterministicVerification) en vez
      // de dejar el campo a medias o con un PASSED que no se comprobo.
      try {
        if (applyDeterministicVerification) {
          var verifiedFallback = await applyDeterministicVerification(result.response, query || '');
          pkt.aluVerification = { hasFindings: !!(verifiedFallback && verifiedFallback.hasFindings) };
        }
      } catch (e2) {
        // No se pudo verificar: se omite el campo en vez de fingir un resultado.
      }
    }
  }

  return pkt;
}

var PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\linkcore'
  : '/tmp/linkcore.sock';

function send(socket, obj) {
  try { socket.write(JSON.stringify(obj) + '\n'); } catch (e) { /* socket ya cerrado */ }
}

// handlers = { status: async () => {...}, ask: async (query, onProgress) => {...}, chip: async () => {...} }
export function startPipeServer(handlers) {
  var server = net.createServer(function (socket) {
    var rl = readline.createInterface({ input: socket });

    rl.on('line', function (line) {
      var req;
      try { req = JSON.parse(line); } catch (e) {
        send(socket, { type: 'error', error: 'json_invalido' });
        return;
      }

      if (req.type === 'status') {
        handlers.status().then(function (info) {
          send(socket, { type: 'status', data: info });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message });
        });
        return;
      }

      if (req.type === 'chip') {
        if (!handlers.chip) {
          send(socket, { type: 'error', error: 'chip_handler_not_registered' });
          return;
        }
        handlers.chip().then(function (info) {
          send(socket, { type: 'chip', data: info });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message });
        });
        return;
      }

      if (req.type === 'graph') {
        if (!handlers.graph) {
          send(socket, { type: 'error', error: 'graph_handler_not_registered' });
          return;
        }
        handlers.graph().then(function (info) {
          send(socket, { type: 'graph', data: info });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message });
        });
        return;
      }

      if (req.type === 'mesh') {
        if (!handlers.mesh) {
          send(socket, { type: 'error', error: 'mesh_handler_not_registered' });
          return;
        }
        handlers.mesh().then(function (info) {
          send(socket, { type: 'mesh', data: info });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message });
        });
        return;
      }

      if (req.type === 'vnpu') {
        if (!handlers.vnpu) {
          send(socket, { type: 'error', error: 'vnpu_handler_not_registered' });
          return;
        }
        if (!req.opcode) {
          send(socket, { type: 'error', error: 'opcode_requerido' });
          return;
        }
        handlers.vnpu(req.opcode, req.payload || {}).then(function (result) {
          send(socket, { type: 'vnpu', opcode: req.opcode, data: result });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message || String(e) });
        });
        return;
      }

      // Inteligencia agregada de calidad (2026-08-18): mismo patron que
      // los handlers de arriba. `action` distingue leer el reporte de
      // etiquetar el resultado real de una verificacion concreta -- esa
      // etiqueta es lo unico que puede volver calculable la calibracion
      // de la Unidad de Confianza (ver engine/quality-engine.js).
      if (req.type === 'quality') {
        if (!handlers.quality) {
          send(socket, { type: 'error', error: 'quality_handler_not_registered' });
          return;
        }
        handlers.quality(req).then(function (info) {
          send(socket, { type: 'quality', data: info });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message || String(e) });
        });
        return;
      }

      // Libro de auditoria (2026-08-18): mismo patron que 'quality' de arriba.
      if (req.type === 'audit') {
        if (!handlers.audit) {
          send(socket, { type: 'error', error: 'audit_handler_not_registered' });
          return;
        }
        handlers.audit(req).then(function (info) {
          send(socket, { type: 'audit', data: info });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message || String(e) });
        });
        return;
      }

      if (req.type === 'ask') {
        if (!req.query || !String(req.query).trim()) {
          send(socket, { type: 'error', error: 'query_vacia' });
          return;
        }
        handlers.ask(req.query, function onProgress(ev) {
          send(socket, { type: 'progress', event: ev });
        }).then(async function (result) {
          var vnpu = await buildVnpuPacket(result, handlers.verify, req.query);
          send(socket, { type: 'done', vnpu: vnpu, data: result });
        }).catch(function (e) {
          send(socket, { type: 'error', error: e.message || String(e) });
        });
        return;
      }

      send(socket, { type: 'error', error: 'tipo_de_peticion_desconocido: ' + req.type });
    });

    socket.on('error', function () { /* cliente se desconecto abruptamente, nada que hacer */ });
  });

  return new Promise(function (resolve, reject) {
    server.on('error', function (e) {
      if (e.code === 'EADDRINUSE') {
        reject(new Error('Ya hay un LinkCore corriendo (la tuberia ' + PIPE_PATH + ' esta ocupada). Para el otro proceso primero.'));
      } else {
        reject(e);
      }
    });
    server.listen(PIPE_PATH, function () {
      resolve({ server: server, pipePath: PIPE_PATH, close: function() { server.close(); } });
    });
  });
}

export { PIPE_PATH };
