// ═══════════════════════════════════════════════════════════════
// LINKCORE CORE SERVICE — punto de entrada
//
// El shim de localStorage se instala ANTES de cualquier import del
// motor (backend.js, engine/*) -- esos archivos llaman a
// `localStorage.getItem/setItem` tal cual, sin saber que corren en
// Node, y necesitan que el global ya exista en el momento en que se
// ejecuta esa llamada (no en el momento en que se importan).
// ═══════════════════════════════════════════════════════════════

import os from 'node:os';
import { installGlobalShim } from './memory-bus.js';
var dataFile = installGlobalShim();

// Bug real, encontrado en vivo (2026-08-18): el servicio murio una noche sin
// ninguna traza de apagado en ~/.linkcore/service.log -- no paso por
// gracefulShutdown() (confirmado: ese log no tiene el "cerrando..." que esa
// funcion siempre imprime primero). Este archivo no tenia NINGUN listener
// para 'uncaughtException'/'unhandledRejection': el registro previo
// (local-inference-child-worker.js) los cubre solo para el proceso hijo de
// inferencia, no para este, el proceso padre real. stdout/stderr de este
// proceso van redirigidos a service.log via spawn() en bin/linkcore-cli.js
// (stdio: ['ignore', out, err]), asi que console.error aqui SI queda
// grabado en disco -- no hace falta abrir el archivo a mano. Esto no arregla
// una muerte por presion de memoria real del sistema operativo (Windows no
// entrega una señal limpia para eso, y si el SO mata el proceso a la fuerza
// ningun listener de Node puede correr) pero SI deja rastro real de
// cualquier excepcion/rechazo de promesa sin capturar que antes moria en
// silencio. Se sale con process.exit(1) tras registrar -- mismo
// comportamiento de muerte que ya tenia el proceso sin este listener (Node
// mata el proceso por defecto ante uncaughtException; y desde Node 15 hace
// lo mismo ante unhandledRejection sin listener), solo que ahora con una
// traza real en vez de silencio. No es un watchdog: no reinicia nada.
process.on('uncaughtException', function (err) {
  console.error('[LinkCore] uncaughtException fatal, cerrando el proceso: ' + ((err && err.stack) || String(err)));
  process.exit(1);
});
process.on('unhandledRejection', function (reason) {
  console.error('[LinkCore] unhandledRejection fatal, cerrando el proceso: ' + ((reason && reason.stack) || String(reason)));
  process.exit(1);
});

var { smartQuery } = await import('./backend.js');
var { applyDeterministicVerification } = await import('./engine/verification-pipeline.js');
var { runVNPUInstruction } = await import('./engine/vnpu-core.js');
var { startPipeServer, PIPE_PATH } = await import('./pipe-server.js');
var ollamaCatalog = await import('./engine/ollama-catalog.js');
var OLLAMA_MODELS = ollamaCatalog.OLLAMA_MODELS;
var chipCore = await import('./engine/chip-core.js');
var learningLoop = await import('./engine/learning-loop.js');
var mesh = await import('./mesh.js');
var kimiK3 = await import('./engine/kimi-k3.js');

async function detectAndWarmUp() {
  var detection = await ollamaCatalog.detectInstalledModels();
  if (detection.ok) {
    console.log('[LinkCore] auto-detect: ' + detection.installed.length + ' modelos instalados en Ollama');
  }
  // Bug real, encontrado probando el arranque real del servicio (2026-08-02):
  // este bucle precalentaba TODOS los modelos instalados sin esperar
  // (detectAndWarmUp() se llama sin await desde el arranque), incluidos
  // modelos de hasta ~20GB (qwen2.5-coder:32b, qwen3.6:latest) en una
  // maquina SIN GPU. Una peticion `ask` real hecha justo despues de
  // arrancar competia por CPU/RAM con Ollama cargando esos modelos
  // gigantes en segundo plano -- verificado en vivo: hasta el modelo mas
  // pequeño (smollm2:135m, que en aislamiento responde en ~20s, justo al
  // limite del timeout adaptativo) fallaba con "all_models_failed" por
  // culpa de esa contencion. Los modelos medium/large no son los que el
  // camino rapido por defecto usa de todas formas (ensemble-v2.js ya
  // filtra a tier tiny/small para el ensemble, ver la nota alli) -- no
  // tiene sentido pagar el coste de cargarlos preventivamente si ademas
  // degrada las primeras peticiones reales del usuario.
  // Bug real, GRAVE, encontrado en vivo (2026-08-12) al medir por que una
  // consulta justo tras reiniciar el servicio se colgaba: este bucle
  // precalentaba TODO tier tiny+small con `keep_alive: '30m'` -- 8 modelos
  // reales en esta maquina, que suman ~7.2GB (807+2019+2019+397+986+270+725
  // MB) CLAVADOS en RAM media hora... en una maquina con 5.83GB TOTALES
  // (medido, Win32_OperatingSystem). Es mas RAM de la que hay: garantiza
  // desalojo y recarga continua de pesos, que es precisamente el sintoma
  // que se lleva persiguiendo toda la sesion (modelos rancios ocupando
  // 4.1GB, "all_models_failed" por contencion, primeras consultas lentas).
  //
  // Ademas la justificacion original de incluir 'tiny' ("ensemble-v2.js ya
  // filtra a tier tiny/small") quedo OBSOLETA el 2026-08-09: desde
  // entonces los tiny (smollm2:135m/360m) estan EXCLUIDOS del ensemble Y
  // del fallback de backend.js por alucinar tema con apariencia legitima.
  // Se precalentaba RAM para modelos que ya no pueden ser elegidos.
  //
  // Ahora: solo tier 'small', bajo un presupuesto real de RAM, y el
  // modelo de embeddings SIEMPRE (lo necesita la cache semantica y es
  // pequeño). El resto se carga on-demand cuando de verdad se elige.
  //
  // Bug real, GRAVE, encontrado en vivo (2026-08-18): el presupuesto se
  // calculaba como 40% del RAM TOTAL fisico (os.totalmem()), sin mirar
  // nunca cuanta RAM estaba REALMENTE libre en ese instante
  // (os.freemem()). En esta maquina (5.83GB totales) eso reservaba hasta
  // 2332MB para precalentar modelos SIN IMPORTAR que ya solo quedaran
  // ~132MB libres porque Spotify/Chrome/el propio Claude Desktop ya
  // estaban usando el resto -- confirmado en vivo que el servicio murio
  // sin pasar por gracefulShutdown() justo despues de un arranque con esa
  // presion de memoria. Un presupuesto basado en el total fisico no
  // generaliza: cada usuario tiene una cantidad de RAM distinta Y una
  // cantidad de RAM libre distinta en cada instante (depende de que mas
  // tenga abierto). Ahora el presupuesto sale de min(techo por total,
  // libre actual menos un colchon para el SO y las apps del usuario) --
  // si casi no hay RAM libre, el presupuesto cae a 0 y el servicio arranca
  // sin precalentar nada (degradado mas lento en la primera consulta) en
  // vez de competir por memoria y arriesgarse a que lo mate el sistema.
  var totalRamMB = Math.round(os.totalmem() / 1024 / 1024);
  var freeRamMB = Math.round(os.freemem() / 1024 / 1024);
  var WARMUP_CEILING_FRACTION = 0.4; // nunca mas de esto del total, aunque sobre RAM libre
  var MIN_FREE_AFTER_WARMUP_MB = 512; // colchon que se deja siempre al SO y a las apps del usuario
  var warmupCeilingMB = Math.round(totalRamMB * WARMUP_CEILING_FRACTION);
  var warmupBudgetMB = Math.max(0, Math.min(warmupCeilingMB, freeRamMB - MIN_FREE_AFTER_WARMUP_MB));
  var spentMB = 0;
  var warmed = [];

  if (warmupBudgetMB <= 0) {
    console.log('[LinkCore] precalentado OMITIDO por completo: solo ' + freeRamMB + 'MB libres de ' +
      totalRamMB + 'MB totales (se necesitan >' + MIN_FREE_AFTER_WARMUP_MB + 'MB libres de colchon). ' +
      'Los modelos se cargaran on-demand en la primera consulta real.');
    return;
  }

  var candidates = OLLAMA_MODELS.filter(function (m) {
    if (m.installed === false) return false;
    if (m.id.indexOf('embed') !== -1) return true; // el embedder entra siempre
    return m.tier === 'small';
  }).sort(function (a, b) {
    // El embedder primero (imprescindible y barato), luego los mas ligeros.
    var aEmbed = a.id.indexOf('embed') !== -1 ? 0 : 1;
    var bEmbed = b.id.indexOf('embed') !== -1 ? 0 : 1;
    if (aEmbed !== bEmbed) return aEmbed - bEmbed;
    return (a.sizeMB || 0) - (b.sizeMB || 0);
  });

  for (var i = 0; i < candidates.length; i++) {
    var m = candidates[i];
    var costMB = m.sizeMB || 0;
    if (spentMB + costMB > warmupBudgetMB) {
      console.log('[LinkCore] precalentado OMITIDO (presupuesto RAM ' + warmupBudgetMB + 'MB agotado): ' + m.id + ' (' + costMB + 'MB)');
      continue;
    }
    try {
      await fetch('http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: m.id,
          messages: [{ role: 'user', content: 'hola' }],
          max_tokens: 1,
          keep_alive: '30m',
        }),
      });
      spentMB += costMB;
      warmed.push(m.id);
      console.log('[LinkCore] precalentado: ' + m.id + ' (' + costMB + 'MB, total ' + spentMB + '/' + warmupBudgetMB + 'MB)');
    } catch (e) {}
  }
  console.log('[LinkCore] precalentado: ' + warmed.length + ' modelo(s), ' + spentMB + 'MB de ' + totalRamMB + 'MB fisicos');
}

async function handleAsk(query, onProgress) {
  var trimmed = String(query).trim();

  // Bug real, critico, encontrado probando el arranque real del servicio
  // (2026-08-02): este handler -- el que atiende `linkcore ask`, la via
  // DOCUMENTADA (AGENTS.md) para que la IA jefe hable con el chip --
  // llamaba a neuralDecide() (motor simple y duplicado: su propio
  // MCTS/ensemble, sin orquestador, sin work-ledger, sin G-STACK, sin
  // deteccion de contradicciones) como camino PRINCIPAL, y solo caia a
  // smartQuery() (el pipeline real, con TODA la maquinaria de
  // intermediacion que este chip existe para ofrecer) si neuralDecide()
  // LANZABA UNA EXCEPCION. neuralDecide() casi nunca lanza -- captura sus
  // propios fallos y devuelve {ok:false} en vez de fallar -- asi que
  // smartQuery() era, en la practica, inalcanzable desde el comando real
  // que usa la IA jefe. Ademas neuralDecide() devuelve {text,...} y el
  // CLI (cmdAsk en bin/linkcore-cli.js) lee `d.response` (la forma de
  // smartQuery) -- con neuralDecide() como camino principal, el usuario
  // real del CLI veia un volcado JSON crudo en vez del texto limpio que
  // el CLI esta diseñado a mostrar. Se invierte: smartQuery() (superset
  // real de capacidad) es el camino principal; neuralDecide() queda como
  // respaldo de ultimo recurso si smartQuery() de verdad lanza, adaptado
  // a la forma {response,...} que espera el CLI.
  try {
    var result = await smartQuery(trimmed, null, { onProgress: onProgress });
    return result;
  } catch (e) {
    console.log('[LinkCore] smartQuery fallo, respaldo a neuralDecide:', e.message);
    var neuralMod = await import('./engine/neural-decision-engine.js');
    var fallback = await neuralMod.neuralDecide(trimmed, { maxTokens: 500 });
    return {
      response: fallback.text || '(sin respuesta)',
      tools: [],
      judgeReason: 'Respaldo: neural-decision-engine (smartQuery no disponible)',
      model: fallback.model,
      provider: fallback.provider,
      latencyMs: fallback.latencyMs,
      decomposed: false,
      steps: [],
      neural: fallback.neural,
    };
  }
}

async function handleStatus() {
  var ollama = null;
  try {
    var oRes = await fetch('http://localhost:11434/api/ps');
    if (oRes.ok) {
      var oData = await oRes.json();
      ollama = {
        corriendo: true,
        modelosCargados: (oData.models || []).map(function (m) { return m.name; }),
        catalogo: OLLAMA_MODELS.length,
      };
    }
  } catch (e) {
    ollama = { corriendo: false };
  }

  var chipHealth = await chipCore.healthCheck();
  var modelStats = chipCore.metricsGetModelStats();
  var learningStats = learningLoop.getStats();
  
  var neuralStats = {};
  try {
    var neuralMod = await import('./engine/neural-decision-engine.js');
    neuralStats = neuralMod.getNeuralStats();
    neuralStats.insights = neuralMod.getLearningInsights();
    neuralStats.strategies = neuralMod.getStrategyPerformance();
    neuralStats.edr = neuralMod.getEDRLog(10);
  } catch (e) {
    neuralStats = { error: e.message };
  }

  return {
    service: 'linkcore-neural-accelerator',
    version: '2.0.0',
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    dataFile: dataFile,
    pipePath: PIPE_PATH,
    ollama: ollama,
    orchestrator: {
      disponible: kimiK3.isKimiAvailable(),
      modelo: 'llama3.2:3b (3B)',
      tipo: 'local-ollama',
    },
    chip: {
      healthy: chipHealth.healthy,
      cache: chipHealth.cache,
      circuitBreaker: chipHealth.circuitBreaker,
      models: modelStats,
      learning: learningStats,
    },
    neural: neuralStats,
  };
}

async function handleChipReport() {
  var health = await chipCore.healthCheck();
  var modelStats = chipCore.metricsGetModelStats();
  var recent = chipCore.metricsGetRecent(50);
  var learningReport = learningLoop.fullReport();
  // Contadores reales del chip (2026-08-11): caché semántico, camino
  // rápido vs escalado, verificación determinista. Si un contador esta a
  // 0 es porque de verdad no ha ocurrido todavia, no un placeholder.
  var events = chipCore.chipEventGetCounts();
  var semanticTotal = events.semanticCacheHit + events.semanticCacheMiss;
  var pathTotal = events.fastPath + events.escalatedPath;
  var collaborationTotal = events.mediatedSynthesis + events.escalatedPath + events.fastPath;
  return {
    health: health,
    modelStats: modelStats,
    recentQueries: recent,
    learning: learningReport,
    processor: {
      topologies: learningLoop.topologyReport(10),
      byCategory: {
        general: learningLoop.topologyReport(5, { category: 'general' }),
        reasoning: learningLoop.topologyReport(5, { category: 'reasoning' }),
        code: learningLoop.topologyReport(5, { category: 'code' }),
        text: learningLoop.topologyReport(5, { category: 'text' }),
      },
    },
    events: {
      semanticCacheHits: events.semanticCacheHit,
      semanticCacheMisses: events.semanticCacheMiss,
      semanticCacheHitRate: semanticTotal ? (events.semanticCacheHit / semanticTotal * 100).toFixed(1) + '%' : 'sin datos',
      fastPathUses: events.fastPath,
      escalatedPathUses: events.escalatedPath,
      fastPathRate: pathTotal ? (events.fastPath / pathTotal * 100).toFixed(1) + '%' : 'sin datos',
      verificationChecks: events.verificationCheck,
      verificationFindings: events.verificationFinding,
      mediatedSyntheses: events.mediatedSynthesis,
      collaborationWins: events.collaborationWin,
      collaborationWinRate: collaborationTotal ? (events.collaborationWin / collaborationTotal * 100).toFixed(1) + '%' : 'sin datos',
    },
    catalog: {
      totalModels: OLLAMA_MODELS.length,
      installedModels: OLLAMA_MODELS.filter(function (m) { return m.installed; }).length,
    },
  };
}

async function handleGraphReport() {
  var { graphReport } = await import('./memory-bus.js');
  return graphReport();
}

async function handleMeshReport() {
  return mesh.meshReport();
}

var server = null;

function gracefulShutdown() {
  console.log('\n[LinkCore] cerrando...');
  try { mesh.stopMesh(); } catch (e) {}
  // Bug real, encontrado en vivo (2026-08-17) probando
  // scripts/benchmark-verification.mjs: ningun punto de este archivo
  // llamaba a local-inference-child.js#shutdownAllPersistentModels() al
  // cerrar. fork() abre un canal IPC que mantiene vivo al child aunque el
  // padre haga process.exit() -- confirmado con `wmic process`: tres
  // corridas de ese script "completadas" seguian vivas como zombis con un
  // modelo entero cargado en RAM/VRAM cada una, invisibles a `linkcore
  // status`. El servicio real nunca se pillo con un child cargado justo en
  // el momento de un `linkcore stop` en las pruebas de esta noche (por eso
  // no se habia visto aqui), pero el codigo tiene el mismo hueco -- se
  // cierra explicitamente, con timeout propio, antes de salir.
  var shutdownChildren = import('./engine/local-inference-child.js')
    .then(function (m) { return m.shutdownAllPersistentModels(); })
    .catch(function () {});
  // Mismo riesgo, segunda fuente (2026-08-18): python-worker.js mantiene un
  // interprete de Python vivo entre llamadas (es justo lo que baja la
  // verificacion de codigo de 740ms a 0.58ms). Ese proceso hijo tambien
  // sobrevive a process.exit() del padre si no se mata explicitamente, asi
  // que se cierra aqui por la misma via y bajo el mismo timeout compartido.
  var shutdownPython = import('./engine/python-worker.js')
    .then(function (m) { return m.shutdownPythonWorker(); })
    .catch(function () {});
  Promise.race([
    Promise.all([shutdownChildren, shutdownPython]),
    new Promise(function (resolve) { setTimeout(resolve, 6000); }),
  ]).then(function () {
    try {
      import('./memory-bus.js').then(function(m) {
        m.flush();
        doExit();
      }).catch(function() {
        doExit();
      });
    } catch (e) {
      doExit();
    }
  });

  function doExit() {
    if (server) {
      server.close(function () {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }
}

server = await startPipeServer({
  ask: handleAsk,
  status: handleStatus,
  chip: handleChipReport,
  graph: handleGraphReport,
  mesh: handleMeshReport,
  verify: applyDeterministicVerification,
  // Decodificador de instrucciones del procesador (2026-08-16): unico punto
  // real de entrada para EXEC/ROUTE/VERIFY/CRITIQUE/TELEMETRY -- ver
  // engine/vnpu-core.js. Sustituye a mcp/linkcore-server.js (retirado):
  // cualquier IA jefe le manda una instruccion vNPU, no llama a una "API".
  vnpu: function (opcode, payload) { return runVNPUInstruction(opcode, payload); },
  // Motor de calidad agregada (2026-08-18): convierte el historial real de
  // verificaciones en las metricas operativas que deciden si esta capa se
  // gana su coste (rendimiento por verificador, clases de error,
  // calibracion de la confianza, economia del escalado, tendencia).
  // Import dinamico dentro del handler, no arriba: si el modulo falla, el
  // servicio sigue arrancando y sirviendo el resto de peticiones.
  quality: async function (req) {
    var qe = await import('./engine/quality-engine.js');
    if (req.action === 'label') {
      var ok = qe.recordOutcomeLabel(req.eventId, {
        problemConfirmed: !!req.problemConfirmed,
        source: req.source || 'cli',
        note: req.note || null,
      });
      return { action: 'label', ok: ok, eventId: req.eventId || null, historyFile: qe.HISTORY_FILE };
    }
    var report = await qe.computeQualityReport({ sinceMs: req.sinceMs, limit: req.limit });
    report.historyFile = qe.HISTORY_FILE;
    return report;
  },
  // Libro de auditoria encadenado por hash + firmado con HMAC (2026-08-18):
  // ver engine/audit-ledger.js -- recordVerification() ya lo alimenta desde
  // vnpu-core.js, pero hasta hoy no habia ninguna via para leerlo desde el
  // CLI. Mismo patron que `quality`: import dinamico dentro del handler
  // para que un fallo del modulo (p.ej. fichero de ledger ilegible) no
  // tumbe el resto de peticiones que el servicio sigue sirviendo.
  audit: async function (req) {
    var al = await import('./engine/audit-ledger.js');
    req = req || {};
    if (req.action === 'verify') {
      // Verificacion completa forzada: verifyLedgerIntegrity() ya lee
      // SIEMPRE de disco (nunca del estado en memoria, ver el comentario
      // junto a su definicion), asi que no hace falta ningun paso extra
      // para "forzarla" -- cada llamada es ya una comprobacion real de lo
      // que hay en el fichero ahora mismo, rotacion y ancla incluidas.
      return { action: 'verify', integrity: al.verifyLedgerIntegrity() };
    }
    return {
      action: 'report',
      integrity: al.verifyLedgerIntegrity(),
      stats: al.getAuditStats(),
      records: al.queryLedger({ limit: req.limit, includeArchive: req.includeArchive === true }),
    };
  },
});

console.log('[LinkCore] escuchando en ' + server.pipePath + ' (PID ' + process.pid + ')');
console.log('[LinkCore] LINKCORE_PROXY_SECRET: ' + (process.env.LINKCORE_PROXY_SECRET ? 'configurado (' + process.env.LINKCORE_PROXY_SECRET.slice(0, 8) + '...)' : 'NO configurado'));
detectAndWarmUp();

// Start mesh network
try {
  var installedModels = OLLAMA_MODELS.filter(function(m) { return m.installed !== false; }).map(function(m) { return m.id; });
  var meshInfo = await mesh.startMesh({
    installedModels: installedModels,
    handlers: {
      infer: async function(query, model, opts) {
        return await smartQuery(query, null, opts);
      },
      ask: async function(query, onProgress) {
        return await smartQuery(query, null, { onProgress: onProgress });
      },
      onNodeUpdate: function(event, node) {
        console.log('[LinkCore Mesh] ' + event + ': ' + node.id);
      },
    },
  });
  console.log('[LinkCore Mesh] nodo ' + meshInfo.nodeId.slice(0, 8) + ' activo en ' + meshInfo.ip + ':' + meshInfo.tcpPort);
} catch (e) {
  console.error('[LinkCore Mesh] error:', e.message);
}

// Puente OpenAI-compatible: DESACTIVADO por decision explicita del
// fundador (2026-08-03) -- "nada de localhost". El modulo openai-bridge.js
// se borro (2026-08-12, limpieza de organizacion de archivos): estaba
// importado pero nunca invocado, muerto de verdad, no solo en pausa.
//
// MCP (mcp/linkcore-server.js) tambien se retiro (2026-08-16, decision
// explicita del fundador: "no quiero nada de APIs... algo que haga
// referencia a un procesador de verdad"). La via real ahora es la
// instruccion vNPU sobre la tuberia con nombre (ver el handler `vnpu`
// arriba y engine/vnpu-core.js) -- una IA jefe le manda una instruccion
// con opcode al procesador, igual que el software le manda una
// instruccion a un chip real, no una llamada a herramienta/API.

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
