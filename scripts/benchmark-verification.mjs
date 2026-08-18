#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// BENCHMARK DE VERIFICACIÓN — vNPU.VERIFY / vNPU.CROSSCHECK
// (2026-08-17, corpus externalizado 2026-08-18)
//
// Mide, con numeros reales de una ejecucion real (nunca estimados), si
// LinkCore de verdad mejora sobre una IA jefe sin ayuda: le da a VERIFY y
// CROSSCHECK un corpus de casos (2 borradores por caso, uno correcto y uno
// con un fallo real inyectado), y calcula tasa de aciertos reales, tasa de
// falsos positivos, y latencia -- por opcode y por categoria. Sin
// resultados esperados hardcodeados, sin descartar casos ambiguos: si un
// fallo inyectado no se detecta, se cuenta como fallo del sistema, no se
// excluye del corpus.
//
// Importa runVNPUInstruction() DIRECTAMENTE (src/engine/vnpu-core.js) en
// vez de pasar por el CLI/tuberia con nombre -- mas fiable para una tanda
// larga de llamadas (sin coste de arrancar un proceso Node nuevo por
// llamada, sin depender de que el servicio de fondo este vivo) y evita
// contencion sobre la misma tuberia si el servicio esta corriendo a la vez.
// No toca backend.js/ensemble-v2.js ni ningun archivo de produccion.
//
// Uso:
//   node scripts/benchmark-verification.mjs
//   node scripts/benchmark-verification.mjs --opcodes=VERIFY
//   node scripts/benchmark-verification.mjs --categories=math,code --limit=2
//   node scripts/benchmark-verification.mjs --out=scripts/mi-resultado.json
//   node scripts/benchmark-verification.mjs --corpus=scripts/benchmark-corpus-independent.mjs
//
// Corpus (2026-08-18): extraido a un modulo aparte, cargable con --corpus.
// Por defecto usa benchmark-corpus-self-authored.mjs (el corpus original,
// escrito por la misma IA que arreglo los verificadores hasta que pasaran
// estos casos -- real, pero no independiente). --corpus permite correr el
// mismo runner contra un corpus construido por un agente que nunca vio el
// codigo de los verificadores (ver benchmark-corpus-independent.mjs).
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runVNPUInstruction, VNPU_OPCODES } from '../src/engine/vnpu-core.js';
import { shutdownAllPersistentModels } from '../src/engine/local-inference-child.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

function argVal(name, def) {
  var prefix = '--' + name + '=';
  var found = process.argv.find(function (a) { return a.indexOf(prefix) === 0; });
  return found ? found.slice(prefix.length) : def;
}

var corpusPath = argVal('corpus', path.join(__dirname, 'benchmark-corpus-self-authored.mjs'));
var corpusAbsPath = path.isAbsolute(corpusPath) ? corpusPath : path.join(process.cwd(), corpusPath);
var corpusMod = await import(pathToFileURL(corpusAbsPath).href);
var CASES = corpusMod.CASES;
console.log('[benchmark-verification] corpus: ' + path.basename(corpusPath) + ' (' + CASES.length + ' casos)\n');

// ═══════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════
var onlyCategories = argVal('categories', null);
var categoryFilter = onlyCategories ? onlyCategories.split(',').map(function (s) { return s.trim().toLowerCase(); }) : null;
var opcodesArg = argVal('opcodes', 'VERIFY,CROSSCHECK');
var opcodeFilter = opcodesArg.split(',').map(function (s) { return s.trim().toUpperCase(); });
var limitArg = argVal('limit', null);
var limit = limitArg ? parseInt(limitArg, 10) : null;
var outFile = argVal('out', path.join(__dirname, 'benchmark-verification-results.json'));

var selectedCases = CASES.filter(function (c) {
  return !categoryFilter || categoryFilter.indexOf(c.category) !== -1;
});
if (limit) selectedCases = selectedCases.slice(0, limit);

// ═══════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════
async function runVerify(caseObj, draftType, draftText) {
  var t0 = Date.now();
  var result = await runVNPUInstruction(VNPU_OPCODES.VERIFY, { draft: draftText, query: caseObj.query });
  var latencyMs = Date.now() - t0;
  return {
    opcode: 'VERIFY', caseId: caseObj.id, category: caseObj.category, draftType,
    latencyMs, ok: true, degraded: false,
    caught: !!(result && result.hasFindings),
    raw: { hasFindings: result && result.hasFindings, text: result && result.text },
  };
}

async function runCrosscheck(caseObj, draftType, draftText) {
  var t0 = Date.now();
  var result;
  try {
    result = await runVNPUInstruction(VNPU_OPCODES.CROSSCHECK, {
      query: caseObj.query, draft: draftText, agentName: 'benchmark-claude',
    });
  } catch (e) {
    var latencyErr = Date.now() - t0;
    return {
      opcode: 'CROSSCHECK', caseId: caseObj.id, category: caseObj.category, draftType,
      latencyMs: latencyErr, ok: false, degraded: true, error: 'exception: ' + e.message, caught: false,
    };
  }
  var latencyMs = Date.now() - t0;
  if (!result || !result.ok) {
    return {
      opcode: 'CROSSCHECK', caseId: caseObj.id, category: caseObj.category, draftType,
      latencyMs, ok: false, degraded: true, error: (result && result.error) || 'sin_resultado', caught: false,
    };
  }
  var factCount = (result.factDisagreements || []).length;
  var numCount = (result.numericDisagreements || []).length;
  var contraCount = (result.contradictions || []).length;
  var caught = factCount > 0 || numCount > 0 || contraCount > 0;
  return {
    opcode: 'CROSSCHECK', caseId: caseObj.id, category: caseObj.category, draftType,
    latencyMs, ok: true, degraded: false, caught,
    raw: {
      factDisagreements: result.factDisagreements,
      numericDisagreements: result.numericDisagreements,
      contradictions: result.contradictions,
      localVoicesConsulted: result.localVoicesConsulted,
      consensus: result.consensus,
    },
  };
}

function fmtMs(ms) { return ms + 'ms'; }

async function main() {
  var results = [];
  var totalRuns = selectedCases.length * 2 * opcodeFilter.length;
  var done = 0;
  var startedAll = Date.now();

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BENCHMARK DE VERIFICACIÓN — vNPU.VERIFY / vNPU.CROSSCHECK');
  console.log(' Casos: ' + selectedCases.length + ' · Opcodes: ' + opcodeFilter.join(', ') + ' · Llamadas totales: ' + totalRuns);
  console.log('═══════════════════════════════════════════════════════════\n');

  for (var i = 0; i < selectedCases.length; i++) {
    var c = selectedCases[i];
    var drafts = [['correct', c.correctDraft], ['flawed', c.flawedDraft]];
    for (var d = 0; d < drafts.length; d++) {
      var draftType = drafts[d][0];
      var draftText = drafts[d][1];
      for (var o = 0; o < opcodeFilter.length; o++) {
        var opcode = opcodeFilter[o];
        var r;
        if (opcode === 'VERIFY') r = await runVerify(c, draftType, draftText);
        else if (opcode === 'CROSSCHECK') r = await runCrosscheck(c, draftType, draftText);
        else { console.error('opcode no soportado por este benchmark: ' + opcode); continue; }
        results.push(r);
        done++;
        var flag = r.degraded ? 'DEGRADADO' : (r.caught ? 'HALLAZGO' : 'sin hallazgo');
        console.log(
          '[' + done + '/' + totalRuns + '] ' + c.id.padEnd(12) + ' ' + draftType.padEnd(8) + ' ' +
          opcode.padEnd(11) + ' ' + fmtMs(r.latencyMs).padStart(8) + '  ' + flag
        );
      }
    }
  }

  var totalWallMs = Date.now() - startedAll;
  console.log('\nEjecución completa en ' + Math.round(totalWallMs / 1000) + 's.\n');

  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), cases: selectedCases, results }, null, 2), 'utf-8');
  console.log('Resultados crudos guardados en: ' + outFile + '\n');

  printReport(selectedCases, results);
}

// ═══════════════════════════════════════════════════════════════
// ESTADÍSTICAS Y REPORTE
// ═══════════════════════════════════════════════════════════════
function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var idx = (p / 100) * (s.length - 1);
  var lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (idx - lo) * (s[hi] - s[lo]);
}
function pct(n, d) { return d === 0 ? 'n/a' : ((n / d) * 100).toFixed(1) + '%'; }

function printReport(cases, results) {
  var opcodes = Array.from(new Set(results.map(function (r) { return r.opcode; })));
  var categories = Array.from(new Set(cases.map(function (c) { return c.category; })));

  console.log('───────────────────────────────────────────────────────────');
  console.log(' TASA DE ACIERTO REAL (true positive) — sobre borradores FLAWED');
  console.log('───────────────────────────────────────────────────────────');
  opcodes.forEach(function (op) {
    var flawed = results.filter(function (r) { return r.opcode === op && r.draftType === 'flawed'; });
    var caught = flawed.filter(function (r) { return r.caught; }).length;
    var degraded = flawed.filter(function (r) { return r.degraded; }).length;
    console.log('  ' + op.padEnd(11) + ': ' + caught + '/' + flawed.length + ' detectados (' + pct(caught, flawed.length) + ')' +
      (degraded ? '  [' + degraded + ' degradado(s)/error, contados como NO detectado]' : ''));
  });
  if (opcodes.indexOf('VERIFY') !== -1 && opcodes.indexOf('CROSSCHECK') !== -1) {
    var flawedIds = Array.from(new Set(results.filter(function (r) { return r.draftType === 'flawed'; }).map(function (r) { return r.caseId; })));
    var eitherCaught = 0;
    flawedIds.forEach(function (id) {
      var v = results.find(function (r) { return r.caseId === id && r.draftType === 'flawed' && r.opcode === 'VERIFY'; });
      var cc = results.find(function (r) { return r.caseId === id && r.draftType === 'flawed' && r.opcode === 'CROSSCHECK'; });
      if ((v && v.caught) || (cc && cc.caught)) eitherCaught++;
    });
    console.log('  ' + 'EITHER'.padEnd(11) + ': ' + eitherCaught + '/' + flawedIds.length + ' detectados (' + pct(eitherCaught, flawedIds.length) + ') — VERIFY o CROSSCHECK detectó el fallo');
  }

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(' TASA DE FALSOS POSITIVOS — sobre borradores CORRECT');
  console.log('───────────────────────────────────────────────────────────');
  opcodes.forEach(function (op) {
    var correct = results.filter(function (r) { return r.opcode === op && r.draftType === 'correct'; });
    var flagged = correct.filter(function (r) { return r.caught; }).length;
    var degraded = correct.filter(function (r) { return r.degraded; }).length;
    console.log('  ' + op.padEnd(11) + ': ' + flagged + '/' + correct.length + ' marcados incorrectamente (' + pct(flagged, correct.length) + ')' +
      (degraded ? '  [' + degraded + ' degradado(s)/error]' : ''));
    if (flagged > 0) {
      correct.filter(function (r) { return r.caught; }).forEach(function (r) {
        console.log('      · falso positivo en ' + r.caseId);
      });
    }
  });

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(' LATENCIA (ms) — todas las llamadas de cada opcode');
  console.log('───────────────────────────────────────────────────────────');
  opcodes.forEach(function (op) {
    var lat = results.filter(function (r) { return r.opcode === op; }).map(function (r) { return r.latencyMs; });
    console.log('  ' + op.padEnd(11) + ': avg=' + Math.round(mean(lat)) + 'ms  median=' + Math.round(median(lat)) +
      'ms  p95=' + Math.round(percentile(lat, 95)) + 'ms  min=' + Math.min.apply(null, lat) + 'ms  max=' + Math.max.apply(null, lat) + 'ms  (n=' + lat.length + ')');
  });

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(' DESGLOSE POR CATEGORÍA');
  console.log('───────────────────────────────────────────────────────────');
  categories.forEach(function (cat) {
    console.log('\n  ' + cat.toUpperCase() + ':');
    opcodes.forEach(function (op) {
      var flawed = results.filter(function (r) { return r.opcode === op && r.draftType === 'flawed' && r.category === cat; });
      var correct = results.filter(function (r) { return r.opcode === op && r.draftType === 'correct' && r.category === cat; });
      var caught = flawed.filter(function (r) { return r.caught; }).length;
      var flagged = correct.filter(function (r) { return r.caught; }).length;
      console.log('    ' + op.padEnd(11) + ': TP ' + caught + '/' + flawed.length + ' (' + pct(caught, flawed.length) + ')' +
        '   FP ' + flagged + '/' + correct.length + ' (' + pct(flagged, correct.length) + ')');
    });
  });

  var gapCases = cases.filter(function (c) { return c.expectedGap; });
  if (gapCases.length) {
    console.log('\n───────────────────────────────────────────────────────────');
    console.log(' CASOS MARCADOS COMO GAP CONOCIDO ANTES DE CORRER (no se excluyeron del corpus)');
    console.log('───────────────────────────────────────────────────────────');
    gapCases.forEach(function (c) {
      console.log('  · ' + c.id + ': ' + c.note);
    });
  }

  var degradedResults = results.filter(function (r) { return r.degraded; });
  if (degradedResults.length) {
    console.log('\n───────────────────────────────────────────────────────────');
    console.log(' LLAMADAS DEGRADADAS (CROSSCHECK sin voces locales válidas / error)');
    console.log('───────────────────────────────────────────────────────────');
    degradedResults.forEach(function (r) {
      console.log('  · ' + r.caseId + ' (' + r.draftType + '): ' + r.error);
    });
  }

  console.log('\n═══════════════════════════════════════════════════════════');
}

// Bug real, encontrado en vivo (2026-08-17): este script nunca llamaba a
// shutdownAllPersistentModels() -- local-inference-child.js#fork() abre un
// canal IPC que Node.js mantiene vivo por defecto, asi que aunque main()
// terminaba e imprimia "Ejecucion completa", el proceso (y su child
// local-inference-child-worker.js, con un modelo entero cargado en RAM/
// VRAM) se quedaba corriendo indefinidamente, invisible a `linkcore
// status` (que solo reporta el registro del SERVICIO, no el de este
// script suelto). Confirmado con `wmic process`: tres corridas de este
// benchmark seguian vivas como zombis tras "completarse", acumulando
// modelos en RAM hasta que la cuarta corrida (reasoning) se cayo con
// GGML_ASSERT/OOM real -- no por el modelo en si, sino por la RAM ya
// agotada por las tres anteriores. Se apaga SIEMPRE al terminar, exito o
// error, y se fuerza process.exit() para no depender de que no quede
// ningun otro handle abierto.
function shutdownAndExit(code) {
  shutdownAllPersistentModels()
    .catch(function () {})
    .then(function () { process.exit(code); });
}

main()
  .then(function () { shutdownAndExit(0); })
  .catch(function (e) {
    console.error('[benchmark-verification] error fatal: ' + e.stack);
    shutdownAndExit(1);
  });
