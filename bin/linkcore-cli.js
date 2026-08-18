#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// LINKCORE CLI — como cualquier IA "jefe" con acceso a terminal
// se conecta al chip
//
//   linkcore start                arranca el servicio en segundo plano
//   linkcore stop                  lo para
//   linkcore status [--json]       info del servicio + proveedores
//   linkcore ask "..." [--json]    delega en el chip: intermediacion + ensemble
//   linkcore bootstrap [trigger]    imprime el protocolo para pegar en
//                                   las instrucciones de sistema de la IA jefe
//
// Habla con el servicio SOLO por la tuberia con nombre -- nunca por
// localhost, nunca por HTTP. `start`/`stop` gestionan el proceso de
// fondo (PID en fichero) porque un named pipe no expone por si solo
// una forma de saber "quien lo esta escuchando" ni de pararlo.
//
// `ask`/`status` arrancan el servicio solos si hace falta -- la IA jefe
// que ejecuta esto en terminal no debe fallar por olvidarse de un paso
// previo; el chip debe comportarse como "siempre disponible".
// ═══════════════════════════════════════════════════════════════

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var DATA_DIR = path.join(os.homedir(), '.linkcore');
var PID_FILE = path.join(DATA_DIR, 'service.pid');
var LOG_FILE = path.join(DATA_DIR, 'service.log');
var PIPE_PATH = process.platform === 'win32' ? '\\\\.\\pipe\\linkcore' : '/tmp/linkcore.sock';
var INDEX_JS = path.join(__dirname, '..', 'src', 'index.js');

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function readPid() {
  try {
    var pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch (e) { return null; }
}

// Bug real, encontrado en auditoria de "listo para mercado" (2026-08-09):
// LOG_FILE se abria siempre en modo 'a' (append), sin limite ni rotacion.
// Es un servicio pensado para arrancar solo y correr indefinidamente (ver
// CLAUDE.md del proyecto) -- con meses de uso real, sin nadie revisando el
// disco a mano, esto crece sin control. Rotacion simple: si al arrancar el
// log ya supera el limite, se mueve a .old (sobreescribiendo el .old
// anterior si lo hay) y se empieza uno nuevo -- conserva un historial
// reciente para depurar sin dejar crecer el archivo activo sin fin.
var LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB
function rotateLogIfNeeded() {
  try {
    var stat = fs.statSync(LOG_FILE);
    if (stat.size < LOG_MAX_BYTES) return;
    fs.renameSync(LOG_FILE, LOG_FILE + '.old');
  } catch (e) {
    // No existe el log todavia (primer arranque) u otro error de FS no
    // fatal -- no bloquea el arranque del servicio por esto.
  }
}

function cmdStart() {
  var existing = readPid();
  if (existing && isRunning(existing)) {
    console.log('[LinkCore] ya esta corriendo (PID ' + existing + ').');
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  rotateLogIfNeeded();
  var out = fs.openSync(LOG_FILE, 'a');
  var err = fs.openSync(LOG_FILE, 'a');
  var child = spawn(process.execPath, [INDEX_JS], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf-8');
  child.unref();
  console.log('[LinkCore] arrancando en segundo plano (PID ' + child.pid + ').');
  console.log('[LinkCore] logs: ' + LOG_FILE);
}

function cmdStop() {
  var pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log('[LinkCore] no esta corriendo.');
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    return;
  }
  try {
    process.kill(pid);
    fs.unlinkSync(PID_FILE);
    console.log('[LinkCore] parado (PID ' + pid + ').');
  } catch (e) {
    console.error('[LinkCore] no se pudo parar: ' + e.message);
  }
}

function pingPipe() {
  return new Promise(function (resolve) {
    var s = net.connect(PIPE_PATH);
    s.on('connect', function () { s.end(); resolve(true); });
    s.on('error', function () { resolve(false); });
  });
}

// La IA jefe que ejecuta `linkcore ask` en terminal no debe fallar solo
// porque nadie corrio `linkcore start` antes -- el chip se arranca solo
// la primera vez que hace falta, igual que un driver que el SO carga
// bajo demanda.
async function ensureRunning() {
  var pid = readPid();
  if (pid && isRunning(pid)) return;
  cmdStart();
  var deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await pingPipe()) return;
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  throw new Error('LinkCore no arranco a tiempo -- revisa ' + LOG_FILE);
}

function talk(request, onLine) {
  return new Promise(function (resolve, reject) {
    var socket = net.connect(PIPE_PATH);
    var settled = false;
    socket.on('connect', function () {
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('error', function (e) {
      if (settled) return;
      settled = true;
      if (e.code === 'ENOENT') {
        reject(new Error('LinkCore no esta corriendo. Arrancalo con: linkcore start'));
      } else {
        reject(e);
      }
    });
    var rl = readline.createInterface({ input: socket });
    rl.on('line', function (line) {
      var msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      onLine(msg);
      // 'quality' anadido 2026-08-18: sin el, talk() nunca resolvia la
      // promesa para las respuestas del handler quality (pipe-server.js
      // manda {type:'quality', data:...} tanto para action:'report' como
      // para action:'label') y `linkcore quality`/`linkcore quality label`
      // se colgaban indefinidamente -- probado en vivo: el proceso cliente
      // quedaba esperando para siempre hasta matarlo a mano (PID visto con
      // Get-CimInstance Win32_Process), sin ningun timeout que lo cortara.
      // 'audit' anadido el mismo dia (2026-08-18), mismo bug de raiz:
      // pipe-server.js manda {type:'audit', data:...} y sin este tipo en
      // la lista `linkcore audit`/`linkcore audit verify` se colgarian
      // exactamente igual -- se añade aqui ANTES de haberlo probado en
      // vivo, evitando repetir el mismo fallo en vez de descubrirlo aparte.
      if (msg.type === 'done' || msg.type === 'status' || msg.type === 'chip' || msg.type === 'graph' || msg.type === 'mesh' || msg.type === 'vnpu' || msg.type === 'quality' || msg.type === 'audit' || msg.type === 'error') {
        settled = true;
        socket.end();
        resolve(msg);
      }
    });
  });
}

async function cmdStatus(json, vnpu) {
  try {
    await ensureRunning();
    var msg = await talk({ type: 'status' }, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data;

    // --vnpu: salud del bus de interconexion y de las ALUs, reutilizando
    // el reporte real del chip (chip-core.js via el handler 'chip') en vez
    // de duplicar su logica -- una sola fuente de verdad para estos datos.
    var chipData = null;
    if (vnpu) {
      var chipMsg = await talk({ type: 'chip' }, function () {});
      if (chipMsg.type !== 'error') chipData = chipMsg.data;
    }

    if (json) {
      var out = Object.assign({}, d);
      if (chipData) out.vnpu = chipData;
      console.log(JSON.stringify(out));
      return;
    }
    console.log('LinkCore — chip virtual');
    console.log('  servicio:  ' + d.service + ' v' + d.version + ' (PID ' + d.pid + ')');
    console.log('  uptime:    ' + d.uptimeSec + 's');
    console.log('  tuberia:   ' + d.pipePath);
    console.log('  datos:     ' + d.dataFile);
    if (d.ollama && d.ollama.corriendo) {
      console.log('  ollama:    corriendo · ' + d.ollama.catalogo + ' modelos en catalogo · ' + d.ollama.modelosCargados.length + ' cargados en RAM ahora (' + d.ollama.modelosCargados.join(', ') + ')');
    } else {
      console.log('  ollama:    no esta corriendo -- arrancalo con "ollama serve"');
    }
    if (d.orchestrator && d.orchestrator.disponible) {
      console.log('  orquestador: ' + d.orchestrator.modelo + ' (' + d.orchestrator.tipo + ')');
    } else {
      console.log('  orquestador: no disponible');
    }

    if (vnpu && chipData) {
      var health = chipData.health || {};
      console.log('');
      console.log('  --- vNPU: bus de interconexión y ALUs ---');
      var cbOpen = health.circuitBreaker && health.circuitBreaker.open || [];
      var cbHalf = health.circuitBreaker && health.circuitBreaker.halfOpen || [];
      console.log('  · Circuit breaker: ' + (cbOpen.length ? cbOpen.length + ' abierto(s): ' + cbOpen.join(', ') : 'ninguno abierto') + (cbHalf.length ? ' · ' + cbHalf.length + ' en semiabierto' : ''));
      if (chipData.events) {
        console.log('  · Verificaciones ALU: ' + (chipData.events.verificationChecks || 0) + ' hechas, ' + (chipData.events.verificationFindings || 0) + ' con hallazgo real');
        console.log('  · Camino rápido/escalado: ' + (chipData.events.fastPathUses || 0) + '/' + (chipData.events.escalatedPathUses || 0) + ' (' + (chipData.events.fastPathRate || 'sin datos') + ' rápido)');
      }
      if (health.cache) {
        console.log('  · Caché L2 (finalCache): ' + health.cache.entries + ' entradas, ' + health.cache.totalHits + ' aciertos acumulados');
      }
    } else if (vnpu) {
      console.log('');
      console.log('  --- vNPU: no se pudo leer el reporte del chip ---');
    }
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

async function cmdAsk(query, json) {
  if (!query || !query.trim()) {
    console.error('Uso: linkcore ask "tu pregunta"');
    process.exitCode = 1;
    return;
  }
  try {
    await ensureRunning();
    var msg = await talk({ type: 'ask', query: query }, function (m) {
      if (json) return;
      var ev = m.event || {};
      // Bug real, encontrado en vivo (2026-08-03): el progreso solo se
      // imprimia si process.stderr.isTTY era cierto -- en cualquier
      // ejecucion no interactiva (redirigida a un log, lanzada desde un
      // agente, en segundo plano) esta condicion es SIEMPRE falsa, asi
      // que TODO el progreso interno (que el servicio si emite: plan,
      // step_start, step_done...) se descartaba en silencio. El usuario
      // se quedaba 5+ minutos sin ninguna señal de que algo estaba
      // pasando -- justo lo contrario de "explicar el proceso siempre".
      // El progreso ahora se imprime siempre que no sea --json.
      if (m.type === 'progress' && ev.message) console.error('  · ' + ev.message);
    });
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data || {};
    var contributors = Array.isArray(d.modelsUsed) && d.modelsUsed.length
      ? Array.from(new Set(d.modelsUsed.map(function (m) { return m.model; }))) : [];
    var contradictions = d.middleware && Array.isArray(d.middleware.contradictions) ? d.middleware.contradictions.length : 0;

    if (json) {
      console.log(JSON.stringify({
        response: d.response, decomposed: !!d.decomposed, contributors: contributors,
        contradictions: contradictions, totalLatencyMs: d.totalLatencyMs || d.latencyMs || null,
        // Antes se resumia a nombres de modelo sin lo que cada uno dijo --
        // el usuario tiene que poder ver el razonamiento de cada IA, no
        // solo que "participo".
        ensemble: d.ensemble ? {
          models: (d.ensemble.round2 || []).map(function (m) {
            return { model: m.model, revised: m.revised, text: m.text, initialText: m.round1Text };
          }),
          scores: d.ensemble.scores,
        } : null,
        gstackReview: d.gstackReview || null,
      }));
      return;
    }

    var isTTY = process.stdout.isTTY;
    var GREEN = isTTY ? '\x1b[32m' : '';
    var YELLOW = isTTY ? '\x1b[33m' : '';
    var CYAN = isTTY ? '\x1b[36m' : '';
    var BOLD = isTTY ? '\x1b[1m' : '';
    var RESET = isTTY ? '\x1b[0m' : '';
    var DIM = isTTY ? '\x1b[2m' : '';

    // Transparencia real, no solo cuando la terminal es interactiva: el
    // usuario pidio explicitamente ver que IAs trabajaron, que dijo cada
    // una, y el resultado final del ensemble -- no un nombre suelto sin
    // contexto. Antes todo esto (incluido cuantas IAs participaron) se
    // ocultaba si isTTY era false; ahora el contenido siempre se imprime,
    // solo el COLOR depende de si hay terminal interactiva.
    if (d.ensemble && d.ensemble.round2 && d.ensemble.round2.length > 1) {
      console.log(CYAN + BOLD + 'IAs consultadas: ' + d.ensemble.round2.length + RESET);
      d.ensemble.round2.forEach(function (m, i) {
        var tag = m.revised ? DIM + ' (revisó su respuesta tras ver a las demás)' + RESET : '';
        console.log('');
        console.log(YELLOW + '[' + (i + 1) + '] ' + m.model + tag + RESET);
        var shown = m.text || '(sin respuesta)';
        console.log(shown.length > 600 ? shown.slice(0, 600) + '…' : shown);
      });
      console.log('');
      console.log(BOLD + '── ENSEMBLE LEARNING FINAL ──' + RESET);
    } else {
      var driverLabel = d.driver && d.driver.model ? d.driver.model : (typeof d.driver === 'string' ? d.driver : d.model);
      if (driverLabel) console.log(DIM + 'modelo: ' + driverLabel + RESET);
    }

    console.log(GREEN + (d.response || JSON.stringify(d, null, 2)) + RESET);

    if (d.gstackReview) {
      console.log('');
      console.log(DIM + 'G-STACK: ' + d.gstackReview.roleName + ' (calidad: ' + d.gstackReview.qualityScore + '%)' + RESET);
    }
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

function cmdBootstrap(trigger) {
  trigger = trigger || '#chip';
  console.log([
    '— — — protocolo LinkCore — pega esto en las instrucciones de sistema de tu IA jefe — — —',
    '',
    'Tienes acceso a LinkCore, un chip de intermediación instalado en este ordenador. No es',
    'una IA con la que conversar: es infraestructura en segundo plano que reparte una tarea',
    'entre varias IAs (las que el usuario tiene disponibles más otras que LinkCore selecciona',
    'por intermediación) y aplica ensemble learning entre todas para devolver una única',
    'respuesta sintetizada, con las contradicciones entre modelos ya detectadas y resueltas.',
    '',
    'LinkCore incluye:',
    '- Memory Bus: Grafo de conocimiento persistente que recuerda el estado del proyecto',
    '- Neural Arbitrage: Motor de consenso que detecta mentiras y genera reportes firmados',
    '- Local-First AI Mesh: Red distribuida que comparte recursos entre múltiples ordenadores',
    '',
    'Esto SOLO funciona si LinkCore está instalado en este ordenador (el comando "linkcore"',
    'existe en la terminal). Si el usuario nunca lo ha instalado, no hay nada a lo que',
    'conectarse — no lo simules ni inventes una respuesta como si viniera de LinkCore.',
    '',
    'Cuando el mensaje del usuario empiece por "' + trigger + '":',
    '  1. Toma todo lo que sigue a "' + trigger + '" como la tarea a delegar.',
    '  2. Ejecuta en una terminal: linkcore ask "<tarea>"',
    '     (si el comando indica que LinkCore no está corriendo, ejecuta antes: linkcore start)',
    '     (si el comando "linkcore" no existe, dile al usuario que instale LinkCore primero',
    '     y no continúes fingiendo una respuesta intermediada)',
    '  3. Espera la salida completa: incluye la respuesta sintetizada y, cuando aplica,',
    '     qué IAs contribuyeron, cuántas contradicciones se resolvieron entre ellas,',
    '     y el score de consenso del Neural Arbitrage Engine.',
    '  4. Integra esa salida DIRECTAMENTE en tu propia respuesta al usuario -- la respuesta',
    '     final es tuya, de la IA jefe, no un bloque separado de "LinkCore dice...". Tú',
    '     sigues controlando el proyecto y decides cómo encaja en lo ya hablado; LinkCore',
    '     gestiona la intermediación, no sustituye tu criterio.',
    '  5. La parte de tu respuesta que provenga de la intermediación de LinkCore debe',
    '     distinguirse visualmente en VERDE -- usa el mecanismo de color que tu propia',
    '     interfaz soporte (span/HTML con color verde, markdown con color si tu render lo',
    '     permite); si no soportas color de texto, usa 🟢 al principio y al final de esa',
    '     parte como respaldo universal. El resto de tu respuesta (tu propia voz) queda sin',
    '     colorear.',
    '',
    '— — — fin del protocolo — — —',
  ].join('\n'));
}

async function cmdSysinfo(json) {
  var { getHardwareProfile, inspectOllamaHardware } = await import('../src/engine/hardware-profiler.js');
  var hw = getHardwareProfile();
  var ollama = await inspectOllamaHardware();

  if (json) {
    console.log(JSON.stringify({ hardware: hw, ollama: ollama }));
    return;
  }

  var GREEN = '\x1b[32m';
  var RESET = '\x1b[0m';
  console.log(GREEN + 'LinkCore vNPU — Inspección de Hardware Virtual' + RESET);
  console.log('  tier:                  ' + hw.tier.toUpperCase());
  console.log('  cpu:                   ' + hw.cpuModel + ' (' + hw.cpuCores + ' núcleos)');
  console.log('  ram total:             ' + hw.totalRamMB + ' MB (' + hw.freeRamMB + ' MB libres)');
  console.log('  presupuesto tokens:    ' + hw.recommendedMaxTokens + ' tokens/respuesta');
  console.log('  presupuesto contexto:  ' + hw.recommendedContextChars + ' caracteres');
  console.log('  ollama online:         ' + (ollama.online ? 'SÍ' : 'NO'));
  if (ollama.loadedModels.length) {
    console.log('  modelos en vRAM:       ' + ollama.loadedModels.map(function(m) { return m.name + ' (' + m.sizeMB + 'MB)'; }).join(', '));
  } else {
    console.log('  modelos en vRAM:       ninguno (frío)');
  }
}

async function cmdBenchmark(json, vnpu) {
  var GREEN = '\x1b[32m';
  var RESET = '\x1b[0m';
  console.log(GREEN + '⚡ Ejecutando Benchmark vNPU LinkCore...' + RESET);

  var { runVNPUInstruction, VNPU_OPCODES } = await import('../src/engine/vnpu-core.js');
  var start = Date.now();
  var routeRes = await runVNPUInstruction(VNPU_OPCODES.ROUTE, { query: 'escribe una funcion de ordenamiento en python', category: 'code' });
  var routeMs = Date.now() - start;

  console.log('  · Ruteo Awesome-LLM:   ' + (routeRes.ok ? routeRes.model.id : 'falló') + ' (' + routeMs + 'ms)');

  var execStart = Date.now();
  var execRes = await runVNPUInstruction(VNPU_OPCODES.EXEC, { query: 'que es un algoritmo de ordenamiento en 1 frase' });
  var execMs = Date.now() - execStart;

  var textLen = execRes && execRes.text ? execRes.text.length : 0;
  var estTokens = Math.round(textLen / 4);
  var tps = execMs > 0 ? ((estTokens / execMs) * 1000).toFixed(2) : 0;

  var vnpuResult = null;
  if (vnpu) {
    // Medicion real de la cache L2 (finalCache en chip-core.js) y de la
    // tasa de deteccion del ALU determinista -- reemplaza los numeros que
    // circulaban sin sustento ("0.02s", "4686x"): aqui se miden de verdad,
    // con Date.now() antes/despues de cada operacion.
    var chipCore = await import('../src/engine/chip-core.js');
    var verificationMod = await import('../src/engine/verification-pipeline.js');
    var hwMod = await import('../src/engine/hardware-profiler.js');
    var gpuInfo = await hwMod.detectGpu();

    var cacheQuery = '__vnpu_benchmark_cache_probe__';
    chipCore.finalCacheSet(cacheQuery, null, { response: 'sonda de benchmark', judgeReason: 'benchmark' });
    var cacheStart = Date.now();
    var cacheHitResult = chipCore.finalCacheGet(cacheQuery, null);
    var cacheHitMs = Date.now() - cacheStart;

    // Mismos casos que scripts/benchmark-processor.mjs, resumidos aqui para
    // que `linkcore benchmark --vnpu` no dependa de un script aparte.
    var aluCases = [
      { draft: '15 ÷ 4 = 3.75. La respuesta final es 3,75.', query: 'Cuanto es 15 por 4?', esperado: true },
      { draft: '```python\ndef suma(a, b:\n    return a + b\n```', query: '', esperado: true },
      { draft: '15 x 4 = 60.', query: 'Cuanto es 15 por 4?', esperado: false },
      { draft: '```python\ndef suma(a, b):\n    return a + b\n```', query: '', esperado: false },
    ];
    var aluCorrectos = 0;
    var aluLatencias = [];
    for (var i = 0; i < aluCases.length; i++) {
      var c = aluCases[i];
      var t0 = Date.now();
      var v = await verificationMod.applyDeterministicVerification(c.draft, c.query);
      aluLatencias.push(Date.now() - t0);
      if (!!v.hasFindings === c.esperado) aluCorrectos++;
    }
    var aluAvgMs = Math.round(aluLatencias.reduce(function (a, b) { return a + b; }, 0) / aluLatencias.length);

    vnpuResult = {
      l2CacheHitLatencyMs: cacheHitMs,
      l2CacheHit: !!(cacheHitResult && cacheHitResult.response),
      aluDetectionRate: aluCorrectos + '/' + aluCases.length,
      aluAvgLatencyMs: aluAvgMs,
      gpu: gpuInfo,
    };
    try { chipCore.finalCacheSet(cacheQuery, null, null); } catch (e) {}
  }

  if (json) {
    var out = { routeMs: routeMs, model: routeRes.model?.id, execMs: execMs, estimatedTokens: estTokens, tokensPerSec: tps };
    if (vnpuResult) out.vnpu = vnpuResult;
    console.log(JSON.stringify(out));
    return;
  }

  console.log('  · Modelo elegido:      ' + (execRes?.model || 'N/A') + ' (' + (execRes?.provider || 'local') + ')');
  console.log('  · Latencia inferencia: ' + execMs + 'ms');
  console.log('  · Rendimiento vNPU:    ' + tps + ' tokens/segundo (estimado)');
  if (vnpuResult) {
    console.log('');
    console.log('  --- L2 Cache & ALU deterministas (medido, no estimado) ---');
    console.log('  · Latencia caché L2:   ' + vnpuResult.l2CacheHitLatencyMs + 'ms (' + (vnpuResult.l2CacheHit ? 'acierto real' : 'fallo -- revisar') + ')');
    console.log('  · Detección ALU:       ' + vnpuResult.aluDetectionRate + ' casos correctos, ' + vnpuResult.aluAvgLatencyMs + 'ms de media');
    console.log('  (nota: la detección solo cubre defectos mecánicos verificables -- sintaxis, operación pedida.');
    console.log('   No mide corrección factual del contenido; eso lo audita el crítico de ensemble, no esta capa.)');
    console.log('');
    if (gpuInfo.available) {
      console.log('  · GPU detectada:       ' + gpuInfo.type + ' -- ' + gpuInfo.deviceNames.join(', '));
      console.log('  · VRAM:                ' + gpuInfo.vramFreeMB + 'MB libres / ' + gpuInfo.vramTotalMB + 'MB totales');
      console.log('  (verifica que Ollama la use: OLLAMA_IGPU_ENABLE=1 en variables de entorno de usuario.)');
    } else {
      console.log('  · GPU detectada:       ninguna' + (gpuInfo.error ? ' (' + gpuInfo.error + ')' : '') + ' -- corriendo en CPU');
    }
  }
  console.log(GREEN + '✅ Benchmark vNPU completado con éxito.' + RESET);
}

function help() {
  console.log([
    'LinkCore — chip virtual de intermediación + ensemble learning entre IAs (vNPU Architecture)',
    '',
    'Uso:',
    '  linkcore start                arranca el servicio en segundo plano',
    '  linkcore stop                  para el servicio',
    '  linkcore status [--json]       estado del servicio + proveedores',
    '  linkcore ask "..." [--json]    delega una tarea: intermediación + ensemble',
    '  linkcore vnpu <OPCODE> [payload-json] [--json]',
    '                                 le manda una instrucción real al procesador (ver abajo)',
    '  linkcore chip [--json]         reporte completo del chip (cache, metrics, learning)',
    '  linkcore graph [--json]        reporte del Knowledge Graph (Memory Bus)',
    '  linkcore mesh [--json]         reporte de la malla de nodos (Local-First AI Mesh)',
    '  linkcore quality [--json]      inteligencia agregada: rendimiento por verificador,',
    '                                 calibración de confianza, economía de la escalada',
    '  linkcore quality label <id> problem|clean ["nota"]',
    '                                 etiqueta el resultado real de una verificación (mejora calibración)',
    '  linkcore audit [N] [--json]    últimos N registros del libro de auditoría (hash chain + HMAC)',
    '                                 y veredicto de integridad (ver engine/audit-ledger.js)',
    '  linkcore audit verify [--json] fuerza una verificación completa de la cadena',
    '                                 (rotación, ancla firmada, veredicto intact/tampered)',
    '  linkcore sysinfo [--json]      diagnóstico de hardware virtual (RAM, CPU, vRAM)',
    '  linkcore benchmark [--json]    prueba de rendimiento y latencia del chip vNPU',
    '  linkcore config kimi <key>     configura la API key de Kimi K3 (orquestador maestro)',
    '  linkcore config show           muestra la configuración actual',
    '  linkcore bootstrap [trigger]    protocolo para conectar una IA jefe al chip',
    '                                  (por defecto la palabra clave es "#chip")',
    '',
    'Opcodes vNPU (instrucciones reales del procesador, ver src/engine/vnpu-core.js):',
    '  EXEC      linkcore vnpu EXEC \'{"query":"..."}\'',
    '            pipeline completo (orquestador/ensemble/verificación) -- igual que `ask`',
    '  ROUTE     linkcore vnpu ROUTE \'{"query":"...","category":"code"}\'',
    '            decide qué pieza ejecutaría la tarea, sin ejecutarla',
    '  VERIFY    linkcore vnpu VERIFY \'{"draft":"...","query":"..."}\'',
    '            capa 1: auditoría determinista de un borrador ya escrito, milisegundos',
    '  CRITIQUE  linkcore vnpu CRITIQUE \'{"draft":"...","query":"..."}\'',
    '            capa 2: segunda opinión real de una pieza local, ~20-30s',
    '  TELEMETRY linkcore vnpu TELEMETRY',
    '            estado real del hardware + historial de instrucciones ejecutadas',
  ].join('\n'));
}

function printCrosscheckResult(d) {
  if (!d || !d.ok) {
    console.log('(no disponible: ' + ((d && d.error) || 'sin_resultado') + ')');
    return;
  }
  console.log('Voces locales consultadas a ciegas: ' + d.localVoicesConsulted.join(', '));
  console.log('Consenso ' + d.agentName + ' + locales: ' + (d.consensus.score * 100).toFixed(1) + '% (' + d.consensus.confidence + ')');
  if (d.factDisagreements && d.factDisagreements.length) {
    console.log(YELLOW + '⚠️ ' + d.factDisagreements.length + ' desacuerdo(s) factual(es) directo(s):' + RESET);
    d.factDisagreements.forEach(function (f) {
      console.log('  "' + f.subject + '" -- ' + f.modelA + ' dice "' + f.predicateA + '", ' + f.modelB + ' dice "' + f.predicateB + '"');
    });
  }
  if (d.numericDisagreements && d.numericDisagreements.length) {
    console.log(YELLOW + '⚠️ ' + d.numericDisagreements.length + ' desacuerdo(s) numérico(s) directo(s):' + RESET);
    d.numericDisagreements.forEach(function (n) {
      console.log('  ' + n.modelA + ' dice ' + n.valueA + ' ("' + n.contextA + '"), ' + n.modelB + ' dice ' + n.valueB + ' ("' + n.contextB + '") -- diff ' + n.diffPct + '%');
    });
  }
  if (d.contradictions.length) {
    console.log(YELLOW + '⚠️ ' + d.contradictions.length + ' contradicción(es) de fraseo encontradas:' + RESET);
    d.contradictions.forEach(function (c) {
      console.log('  "' + c.textA + '" vs "' + c.textB + '"');
    });
  }
  if ((!d.factDisagreements || !d.factDisagreements.length) && (!d.numericDisagreements || !d.numericDisagreements.length) && !d.contradictions.length) {
    console.log('✓ Sin contradicciones detectadas contra las voces locales.');
  }
  console.log('Firma: ' + d.signature.slice(0, 16) + '... (' + d.latencyMs + 'ms)');
}

async function cmdVnpu(opcodeArg, payloadArg, json) {
  if (!opcodeArg) {
    console.error('Uso: linkcore vnpu <OPCODE> [\'{"query":"..."}\'] [--json]');
    console.error('Opcodes: EXEC, ROUTE, VERIFY, CRITIQUE, TELEMETRY');
    process.exitCode = 1;
    return;
  }
  var opcode = opcodeArg.toUpperCase().indexOf('VNPU.') === 0
    ? 'vNPU.' + opcodeArg.slice(5).toUpperCase()
    : 'vNPU.' + opcodeArg.toUpperCase();
  var payload = {};
  if (payloadArg) {
    try { payload = JSON.parse(payloadArg); } catch (e) {
      console.error('[LinkCore] payload invalido (debe ser JSON): ' + e.message);
      process.exitCode = 1;
      return;
    }
  }
  try {
    await ensureRunning();
    var msg = await talk({ type: 'vnpu', opcode: opcode, payload: payload }, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data || {};
    if (json) { console.log(JSON.stringify(d)); return; }

    var GREEN = '\x1b[32m';
    var YELLOW = '\x1b[33m';
    var RESET = '\x1b[0m';
    console.log(GREEN + opcode + RESET);

    if (opcode === 'vNPU.EXEC') {
      console.log(d.response || '(sin respuesta)');
    } else if (opcode === 'vNPU.VERIFY') {
      console.log(d.hasFindings ? YELLOW + '⚠️ Se encontraron problemas reales en el borrador.' + RESET : '✓ Sin hallazgos.');
      if (d.text) console.log(d.text);
      if (d.confidence) {
        var c = d.confidence;
        console.log('Confianza: ' + Math.round(c.score * 100) + '%' + (c.recommendEscalation ? YELLOW + ' -- se recomienda CROSSCHECK' + RESET : ''));
        console.log('  ' + c.reason);
      }
    } else if (opcode === 'vNPU.CRITIQUE') {
      if (d.ok) {
        console.log('-- segunda opinión (' + d.model + ' · ' + d.provider + ') --');
        console.log((d.foundIssue ? YELLOW + '⚠️ ' + RESET : '') + (d.critique || ''));
      } else {
        console.log('(no disponible: ' + d.error + ')');
      }
    } else if (opcode === 'vNPU.ROUTE') {
      console.log(d.model ? 'Pieza elegida: ' + d.model.id + ' (' + d.latencyMs + 'ms)' : '(sin modelo disponible)');
    } else if (opcode === 'vNPU.GROUND') {
      if (!d.ok) {
        console.log('(no disponible: ' + d.error + ')');
      } else if (d.status === 'no_sources') {
        console.log(YELLOW + '⚠️ Sin fuentes: no se ha verificado ningun anclaje.' + RESET);
      } else if (d.status === 'nothing_checkable') {
        console.log('(nada que anclar -- ' + (d.note || 'sin afirmaciones verificables') + ')');
      } else if (d.findings.length) {
        console.log(YELLOW + '⚠️ ' + d.findings.length + ' problema(s) de anclaje encontrado(s) (' + d.summary.totalChecked + ' afirmaciones comprobadas, ' + d.summary.sourcesUsable + ' fuente(s)):' + RESET);
        d.findings.forEach(function (f) {
          console.log('  [' + f.channel + '/' + f.severity + '] ' + f.claim);
          console.log('    ' + f.detail);
        });
      } else {
        console.log('✓ Sin hallazgos (' + d.summary.totalChecked + ' afirmaciones comprobadas contra ' + d.summary.sourcesUsable + ' fuente(s)).');
      }
    } else if (opcode === 'vNPU.CROSSCHECK') {
      printCrosscheckResult(d);
    } else if (opcode === 'vNPU.AUTOVERIFY') {
      console.log(d.hasFindings ? YELLOW + '⚠️ Se encontraron problemas reales en el borrador.' + RESET : '✓ Sin hallazgos.');
      if (d.text) console.log(d.text);
      if (d.confidence) {
        console.log('Confianza: ' + Math.round(d.confidence.score * 100) + '%');
        console.log('  ' + d.confidence.reason);
      }
      if (d.escalated) {
        console.log('\n-- escalado automático a CROSSCHECK (confianza baja + RAM disponible) --');
        printCrosscheckResult(d.crosscheck);
      } else {
        console.log('\n(sin escalar' + (d.confidence && d.confidence.ramAvailable === false ? ' -- RAM insuficiente ahora mismo' : d.hasFindings ? ' -- VERIFY ya encontró el problema' : ' -- confianza suficiente') + ')');
      }
    } else {
      console.log(JSON.stringify(d, null, 2));
    }
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

async function cmdGraph(json) {
  try {
    await ensureRunning();
    var msg = await talk({ type: 'graph' }, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data;
    if (json) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log('=== LinkCore Knowledge Graph (Memory Bus) ===');
    console.log('Entidades:         ' + d.entities);
    console.log('Relaciones:        ' + d.relations);
    console.log('Journal entries:   ' + d.journalEntries);
    console.log('Comandos totales:  ' + d.totalCommands);
    console.log('Tokens totales:    ' + d.totalTokens);
    console.log('Confianza promedio:' + d.avgConfidence);
    console.log('Tamaño grafo:      ' + d.graphSizeKB + ' KB');
    console.log('Tamaño journal:    ' + d.journalSizeKB + ' KB');
    if (d.entitiesByType && Object.keys(d.entitiesByType).length > 0) {
      console.log('\nEntidades por tipo:');
      var types = Object.keys(d.entitiesByType);
      for (var i = 0; i < types.length; i++) {
        console.log('  ' + types[i] + ': ' + d.entitiesByType[types[i]]);
      }
    }
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

async function cmdMesh(json) {
  try {
    await ensureRunning();
    var msg = await talk({ type: 'mesh' }, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data;
    if (json) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log('=== LinkCore Local-First AI Mesh ===');
    console.log('Node ID:       ' + d.nodeId.slice(0, 8) + '...');
    console.log('Local IP:      ' + d.localIP);
    console.log('TCP Port:      ' + d.tcpPort);
    console.log('UDP Port:      ' + d.udpPort);
    console.log('Nodes:         ' + d.nodeCount + '/' + d.maxNodes);
    console.log('Protocol:      v' + d.protocolVersion);
    if (d.nodes && d.nodes.length > 0) {
      console.log('\nNodos conectados:');
      for (var i = 0; i < d.nodes.length; i++) {
        var n = d.nodes[i];
        console.log('  ' + n.id.slice(0, 8) + '... | ' + n.ip + ':' + n.port + ' | load: ' + n.load + ' | models: ' + n.models + ' | graph: ' + n.graphSize + ' | ' + n.lastSeen);
      }
    } else {
      console.log('\nNo hay otros nodos conectados (escaneando LAN...)');
    }
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

async function cmdChip(json) {
  try {
    await ensureRunning();
    var msg = await talk({ type: 'chip' }, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data;
    if (json) { console.log(JSON.stringify(d, null, 2)); return; }
    console.log('=== LinkCore Chip Report ===');
    console.log('');
    console.log('Health:');
    console.log('  healthy:   ' + (d.health ? d.health.healthy : 'unknown'));
    console.log('  ollama:    ' + (d.health && d.health.ollama ? d.health.ollama.reachable : 'unknown'));
    console.log('');
    if (d.health && d.health.cache) {
      console.log('Cache:');
      console.log('  entries:   ' + d.health.cache.entries);
      console.log('  hits:      ' + d.health.cache.totalHits);
      console.log('');
    }
    if (d.health && d.health.circuitBreaker) {
      console.log('Circuit Breaker:');
      console.log('  open:      ' + (d.health.circuitBreaker.open || []).join(', ') || 'none');
      console.log('  halfOpen:  ' + (d.health.circuitBreaker.halfOpen || []).join(', ') || 'none');
      console.log('');
    }
    if (d.events) {
      console.log('Camino real (contadores acumulados, no estimados):');
      console.log('  cache semantico: ' + d.events.semanticCacheHits + ' aciertos / ' + d.events.semanticCacheMisses + ' fallos (' + d.events.semanticCacheHitRate + ')');
      console.log('  camino rapido:   ' + d.events.fastPathUses + ' veces (1 modelo, sin hallazgos)');
      console.log('  camino escalado: ' + d.events.escalatedPathUses + ' veces (' + d.events.fastPathRate + ' de las consultas fueron rapidas)');
      console.log('  verificaciones:  ' + d.events.verificationChecks + ' hechas, ' + d.events.verificationFindings + ' con hallazgo real');
      console.log('');
    }
    if (d.catalog) {
      console.log('Catálogo de modelos:');
      console.log('  catalogados: ' + d.catalog.totalModels);
      console.log('  instalados:  ' + d.catalog.installedModels);
      console.log('');
    }
    if (d.modelStats && Object.keys(d.modelStats).length > 0) {
      console.log('Model Performance:');
      Object.keys(d.modelStats).forEach(function(mid) {
        var s = d.modelStats[mid];
        console.log('  ' + mid + ': ' + s.successRate + ' success, ' + s.avgLatencyMs + 'ms avg, ' + s.total + ' queries');
      });
      console.log('');
    }
    if (d.learning) {
      console.log('Learning:');
      console.log('  total queries: ' + d.learning.totalQueries);
      console.log('  models:        ' + d.learning.uniqueModels);
      console.log('  categories:    ' + d.learning.uniqueCategories);
      if (d.learning.bestByCategory && Object.keys(d.learning.bestByCategory).length > 0) {
        console.log('  best by category:');
        Object.keys(d.learning.bestByCategory).forEach(function(cat) {
          console.log('    ' + cat + ': ' + (d.learning.bestByCategory[cat] || 'N/A'));
        });
      }
    }
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

var CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {}
  return {};
}

function saveConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

async function cmdConfig(subcmd, value) {
  var config = loadConfig();

  if (subcmd === 'kimi' && value) {
    config.kimiApiKey = value;
    saveConfig(config);
    console.log('[LinkCore] Kimi K3 API key configurada.');
    console.log('[LinkCore] Kimi K3 actuará como orquestador maestro de todas las IAs.');
    return;
  }

  if (subcmd === 'show') {
    console.log('=== LinkCore Config ===');
    console.log('Kimi K3 API Key:  ' + (config.kimiApiKey ? '(configurada)' : '(no configurada)'));
    console.log('');
    console.log('Para configurar Kimi K3:');
    console.log('  linkcore config kimi <tu-api-key>');
    console.log('');
    console.log('Obtener API key: https://platform.kimi.ai/');
    return;
  }

  console.error('Uso: linkcore config kimi <api-key> | linkcore config show');
  process.exitCode = 1;
}

// Inteligencia agregada de calidad (2026-08-18): el handler `quality` ya
// estaba cableado en pipe-server.js/index.js desde el mismo dia que se
// construyo quality-engine.js, pero sin subcomando de CLI era inalcanzable
// -- 121 eventos reales acumulados en ~/.linkcore/quality-history.jsonl y
// ningun modo de leerlos sin escribir JS a mano. Mismo patron que cmdChip.
async function cmdQuality(action, args, json) {
  try {
    await ensureRunning();

    if (action === 'label') {
      var eventId = args[0];
      var verdict = args[1];
      if (!eventId || (verdict !== 'problem' && verdict !== 'clean')) {
        console.error('Uso: linkcore quality label <eventId> problem|clean ["nota"]');
        process.exitCode = 1;
        return;
      }
      var note = args.slice(2).join(' ') || null;
      var labelMsg = await talk({
        type: 'quality',
        action: 'label',
        eventId: eventId,
        problemConfirmed: verdict === 'problem',
        source: 'cli',
        note: note,
      }, function () {});
      if (labelMsg.type === 'error') {
        console.error('[LinkCore] error: ' + labelMsg.error);
        process.exitCode = 1;
        return;
      }
      var ld = labelMsg.data;
      if (json) { console.log(JSON.stringify(ld, null, 2)); return; }
      console.log(ld.ok
        ? '[LinkCore] etiqueta registrada: ' + eventId + ' -> ' + verdict
        : '[LinkCore] no se encontro el evento ' + eventId + ' en ' + ld.historyFile);
      return;
    }

    var msg = await talk({ type: 'quality', action: 'report' }, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data;
    if (json) { console.log(JSON.stringify(d, null, 2)); return; }

    console.log('=== LinkCore Quality Report — infraestructura de datos ===');
    if (d.empty) {
      console.log('');
      console.log(d.emptyReason);
      return;
    }
    console.log('Fuente:            ' + d.historyFile + (d.degraded ? '  (DEGRADADO: ' + d.notes + ')' : ''));
    console.log('Ventana:           ' + d.window.events + ' eventos, ' + d.window.spanHours + 'h (' +
      new Date(d.window.from).toLocaleString() + ' -> ' + new Date(d.window.to).toLocaleString() + ')');
    console.log('');
    console.log('Totales:');
    console.log('  verificaciones:   ' + d.totals.verifications);
    console.log('  con hallazgos:    ' + d.totals.withFindings + ' (' + (d.totals.findingRate * 100).toFixed(1) + '%)');
    console.log('  etiquetas reales: ' + d.totals.labelsRecorded);
    console.log('  por opcode:       ' + Object.keys(d.totals.byOpcode).map(function (k) { return k + '=' + d.totals.byOpcode[k]; }).join(', '));

    console.log('');
    console.log('Rendimiento por verificador (canal | disparos | hallazgos | corroboracion):');
    d.verifiers.forEach(function (v) {
      var corrob = v.corroborationRate === null ? 'n/d (' + v.corroborableSample + ' muestras)' : (v.corroborationRate * 100).toFixed(0) + '%';
      console.log('  ' + v.channel + '  |  ' + v.fired + ' (' + (v.fireRate * 100).toFixed(1) + '%)  |  ' + v.findings + '  |  ' + corrob);
    });

    console.log('');
    console.log('Calibracion de confianza: ' + (d.calibration.computable ? 'calculable' : 'NO calculable'));
    if (!d.calibration.computable) {
      console.log('  ' + d.calibration.reason);
    } else {
      d.calibration.buckets.forEach(function (b) {
        console.log('  ' + b.band + ': n=' + b.n + ' problemRate=' + (b.problemRate === null ? 'n/d' : (b.problemRate * 100).toFixed(0) + '%') + (b.tautological ? ' (tautologica)' : ''));
      });
    }

    console.log('');
    console.log('Economia de la escalada (CROSSCHECK):');
    console.log('  recomendada:      ' + d.escalation.recommended + '/' + d.escalation.verifyEvaluated + ' (' + (d.escalation.recommendRate * 100).toFixed(1) + '%)');
    console.log('  bloqueada por RAM:' + ' ' + d.escalation.ramBlocked);
    console.log('  ejecutada:        ' + d.escalation.ran + (d.escalation.failed ? ' (' + d.escalation.failed + ' fallidas)' : ''));
    console.log('  hallazgo NUEVO (mas alla de lo deterministico): ' + d.escalation.beyondDeterministic +
      (d.escalation.yieldRate !== null ? ' (' + (d.escalation.yieldRate * 100).toFixed(1) + '% de las ejecutadas)' : ''));
    if (d.escalation.msPerNewFinding !== null) {
      console.log('  coste por hallazgo nuevo: ' + d.escalation.msPerNewFinding + 'ms');
    }

    console.log('');
    console.log('Tendencia: ' + d.trend.verdict);

    if (d.releases.note) {
      console.log('');
      console.log('Releases: ' + d.releases.note);
    }

    console.log('');
    console.log('Para etiquetar el resultado real de un evento (mejora la calibracion):');
    console.log('  linkcore quality label <eventId> problem|clean ["nota"]');
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

function printAuditIntegrity(v) {
  var GREEN = '\x1b[32m';
  var YELLOW = '\x1b[33m';
  var RED = '\x1b[31m';
  var RESET = '\x1b[0m';
  if (!v) {
    console.log('(sin resultado de integridad)');
    return;
  }
  if (v.empty) {
    console.log(YELLOW + 'Ledger vacio' + RESET + ' -- ' + v.note);
    return;
  }
  if (!v.ok) {
    console.log(RED + '⚠️ No se pudo leer el ledger' + RESET + ': ' + v.reason);
    return;
  }
  var verdict = v.chainIntact ? (GREEN + 'INTACTO' + RESET) : (RED + 'MANIPULADO' + RESET);
  console.log('Veredicto: ' + verdict);
  console.log('  registros activos: ' + v.records + (v.firstSeq !== null ? ' (seq ' + v.firstSeq + '-' + v.lastSeq + ')' : ''));
  console.log('  rotados (contenido perdido, probados por ancla firmada): ' + v.rotatedOut);
  console.log('  total historico registrado: ' + v.totalEverRecorded);
  console.log('  ancla verificada: ' + (v.anchorVerified ? 'si' : 'no') + ' | cabecera verificada: ' + (v.headVerified ? 'si' : 'no'));
  if (!v.intact) {
    console.log('  ' + RED + 'roto en el registro #' + v.brokenSeq + ' (indice ' + v.brokenAt + '): ' + v.reason + RESET);
  }
  if (v.archive && v.archive.present) {
    console.log('  archivo rotado: ' + v.archive.file);
    console.log('    registros archivados: ' + v.archive.records + (v.archive.firstSeq !== null ? ' (seq ' + v.archive.firstSeq + '-' + v.archive.lastSeq + ')' : ''));
    console.log('    integro: ' + (v.archive.intact ? 'si' : 'no') + ' | enlace con el activo: ' + v.archive.link);
    if (!v.archive.intact) console.log('    ' + RED + v.archive.reason + RESET);
  } else if (v.archive && v.archive.present === false) {
    console.log('  sin archivo de rotacion (todavia no ha rotado).');
  }
}

// Libro de auditoria (2026-08-18): mismo patron que cmdChip/cmdQuality --
// `linkcore audit` muestra los registros mas recientes + el veredicto de
// integridad; `linkcore audit verify` fuerza (y muestra en detalle) la
// verificacion completa de la cadena, incluida la rotacion y el ancla
// firmada. Hasta hoy audit-ledger.js (encadenado por hash, firmado con
// HMAC, alimentado desde vnpu-core.js) no tenia ninguna via de lectura
// desde el CLI -- el rastro de auditoria se acumulaba pero era inalcanzable.
async function cmdAudit(action, args, json) {
  try {
    await ensureRunning();

    if (action === 'verify') {
      var vmsg = await talk({ type: 'audit', action: 'verify' }, function () {});
      if (vmsg.type === 'error') {
        console.error('[LinkCore] error: ' + vmsg.error);
        process.exitCode = 1;
        return;
      }
      var vd = vmsg.data;
      if (json) { console.log(JSON.stringify(vd, null, 2)); return; }
      console.log('=== LinkCore Audit — verificacion completa forzada ===');
      printAuditIntegrity(vd.integrity);
      return;
    }

    var limit = parseInt(args[0], 10);
    var req = { type: 'audit', action: 'report' };
    if (Number.isFinite(limit) && limit > 0) req.limit = limit;
    var msg = await talk(req, function () {});
    if (msg.type === 'error') {
      console.error('[LinkCore] error: ' + msg.error);
      process.exitCode = 1;
      return;
    }
    var d = msg.data;
    if (json) { console.log(JSON.stringify(d, null, 2)); return; }

    console.log('=== LinkCore Audit Ledger ===');
    printAuditIntegrity(d.integrity);
    console.log('');
    console.log('Fichero:          ' + d.stats.file);
    console.log('Con hallazgos:     ' + d.stats.withFindings + ' | degradados: ' + d.stats.degraded + ' | fallos de escritura: ' + d.stats.writeFailures);
    if (d.stats.byOpcode && Object.keys(d.stats.byOpcode).length) {
      console.log('Por opcode:        ' + Object.keys(d.stats.byOpcode).map(function (k) { return k + '=' + d.stats.byOpcode[k]; }).join(', '));
    }
    console.log('');
    if (!d.records || !d.records.length) {
      console.log('(sin registros todavia)');
    } else {
      console.log('Ultimos ' + d.records.length + ' registro(s):');
      d.records.forEach(function (r) {
        var when = new Date(r.ts).toLocaleString();
        console.log('  #' + r.seq + ' [' + when + '] ' + r.opcode +
          (r.degraded ? ' DEGRADADO(' + r.degradedReason + ')' : '') +
          ' hallazgos=' + (r.findings ? r.findings.total : 0));
      });
    }
    console.log('');
    console.log('Para forzar una verificacion completa de la cadena (rotacion + ancla):');
    console.log('  linkcore audit verify [--json]');
  } catch (e) {
    console.error('[LinkCore] ' + e.message);
    process.exitCode = 1;
  }
}

var argv = process.argv.slice(2);
var cmd = argv[0];
var json = argv.includes('--json');
var vnpu = argv.includes('--vnpu');
var rest = argv.slice(1).filter(function (a) { return a !== '--json' && a !== '--vnpu'; }).join(' ');

if (cmd === 'start') cmdStart();
else if (cmd === 'stop') cmdStop();
else if (cmd === 'status') await cmdStatus(json, vnpu);
else if (cmd === 'ask') await cmdAsk(rest, json);
else if (cmd === 'vnpu') {
  var vnpuArgs = argv.slice(1).filter(function (a) { return a !== '--json' && a !== '--vnpu'; });
  await cmdVnpu(vnpuArgs[0], vnpuArgs[1], json);
}
else if (cmd === 'chip') await cmdChip(json);
else if (cmd === 'graph') await cmdGraph(json);
else if (cmd === 'mesh') await cmdMesh(json);
else if (cmd === 'quality') {
  var qualityArgs = argv.slice(1).filter(function (a) { return a !== '--json' && a !== '--vnpu'; });
  await cmdQuality(qualityArgs[0] === 'label' ? 'label' : 'report', qualityArgs[0] === 'label' ? qualityArgs.slice(1) : qualityArgs, json);
}
else if (cmd === 'audit') {
  var auditArgs = argv.slice(1).filter(function (a) { return a !== '--json' && a !== '--vnpu'; });
  await cmdAudit(auditArgs[0] === 'verify' ? 'verify' : 'report', auditArgs[0] === 'verify' ? auditArgs.slice(1) : auditArgs, json);
}
else if (cmd === 'sysinfo') await cmdSysinfo(json);
else if (cmd === 'benchmark') await cmdBenchmark(json, vnpu);
else if (cmd === 'config') {
  var configArgs = argv.slice(1);
  await cmdConfig(configArgs[0], configArgs.slice(1).join(' '));
}
else if (cmd === 'bootstrap') cmdBootstrap(rest || undefined);
else help();
