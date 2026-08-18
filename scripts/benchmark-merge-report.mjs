#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// FUSIONA los resultados parciales del benchmark de verificación
// (VERIFY completo + CROSSCHECK por categoría, cada uno corrido por
// separado para no exceder el tiempo de una sola llamada en esta
// máquina sin GPU) en un único informe final. No recalcula nada que
// benchmark-verification.mjs no haya calculado ya con datos reales --
// solo concatena los `results` de cada archivo parcial y reutiliza la
// misma lógica de reporte. (2026-08-17)
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

var PARTIAL_FILES = [
  'bench-verify-full.json',
  'bench-cc-math.json',
  'bench-cc-code.json',
  'bench-cc-factual.json',
  'bench-cc-temporal.json',
  'bench-cc-reasoning.json',
];

var allResults = [];
var allCasesById = {};
var missing = [];

PARTIAL_FILES.forEach(function (f) {
  var p = path.join(__dirname, f);
  if (!fs.existsSync(p)) { missing.push(f); return; }
  var data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  data.results.forEach(function (r) { allResults.push(r); });
  data.cases.forEach(function (c) { allCasesById[c.id] = c; });
});

if (missing.length) {
  console.log('AVISO: no se encontraron estos archivos parciales (se omiten del informe, no se inventan datos): ' + missing.join(', ') + '\n');
}

var cases = Object.values(allCasesById);

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

var opcodes = Array.from(new Set(allResults.map(function (r) { return r.opcode; })));
var categories = Array.from(new Set(cases.map(function (c) { return c.category; })));

console.log('═══════════════════════════════════════════════════════════');
console.log(' INFORME FINAL FUSIONADO — vNPU.VERIFY / vNPU.CROSSCHECK');
console.log(' Casos con datos: ' + cases.length + ' · Llamadas totales: ' + allResults.length);
console.log('═══════════════════════════════════════════════════════════\n');

console.log('───────────────────────────────────────────────────────────');
console.log(' TASA DE ACIERTO REAL (true positive) — sobre borradores FLAWED');
console.log('───────────────────────────────────────────────────────────');
opcodes.forEach(function (op) {
  var flawed = allResults.filter(function (r) { return r.opcode === op && r.draftType === 'flawed'; });
  var caught = flawed.filter(function (r) { return r.caught; }).length;
  var degraded = flawed.filter(function (r) { return r.degraded; }).length;
  console.log('  ' + op.padEnd(11) + ': ' + caught + '/' + flawed.length + ' detectados (' + pct(caught, flawed.length) + ')' +
    (degraded ? '  [' + degraded + ' degradado(s)/error, contados como NO detectado]' : ''));
});
if (opcodes.indexOf('VERIFY') !== -1 && opcodes.indexOf('CROSSCHECK') !== -1) {
  var ccCaseIds = Array.from(new Set(allResults.filter(function (r) { return r.opcode === 'CROSSCHECK'; }).map(function (r) { return r.caseId; })));
  var eitherCaught = 0, eitherTotal = 0;
  ccCaseIds.forEach(function (id) {
    var v = allResults.find(function (r) { return r.caseId === id && r.draftType === 'flawed' && r.opcode === 'VERIFY'; });
    var cc = allResults.find(function (r) { return r.caseId === id && r.draftType === 'flawed' && r.opcode === 'CROSSCHECK'; });
    if (!v && !cc) return;
    eitherTotal++;
    if ((v && v.caught) || (cc && cc.caught)) eitherCaught++;
  });
  console.log('  ' + 'EITHER'.padEnd(11) + ': ' + eitherCaught + '/' + eitherTotal + ' (' + pct(eitherCaught, eitherTotal) + ') — VERIFY o CROSSCHECK detectó el fallo (solo sobre los casos que tienen AMBOS opcodes medidos)');
}

console.log('\n───────────────────────────────────────────────────────────');
console.log(' TASA DE FALSOS POSITIVOS — sobre borradores CORRECT');
console.log('───────────────────────────────────────────────────────────');
opcodes.forEach(function (op) {
  var correct = allResults.filter(function (r) { return r.opcode === op && r.draftType === 'correct'; });
  var flagged = correct.filter(function (r) { return r.caught; }).length;
  console.log('  ' + op.padEnd(11) + ': ' + flagged + '/' + correct.length + ' marcados incorrectamente (' + pct(flagged, correct.length) + ')');
  if (flagged > 0) {
    correct.filter(function (r) { return r.caught; }).forEach(function (r) {
      console.log('      · falso positivo en ' + r.caseId);
    });
  }
});

console.log('\n───────────────────────────────────────────────────────────');
console.log(' LATENCIA (ms)');
console.log('───────────────────────────────────────────────────────────');
opcodes.forEach(function (op) {
  var lat = allResults.filter(function (r) { return r.opcode === op; }).map(function (r) { return r.latencyMs; });
  console.log('  ' + op.padEnd(11) + ': avg=' + Math.round(mean(lat)) + 'ms  median=' + Math.round(median(lat)) +
    'ms  p95=' + Math.round(percentile(lat, 95)) + 'ms  min=' + Math.min.apply(null, lat) + 'ms  max=' + Math.max.apply(null, lat) + 'ms  (n=' + lat.length + ')');
});

console.log('\n───────────────────────────────────────────────────────────');
console.log(' DESGLOSE POR CATEGORÍA');
console.log('───────────────────────────────────────────────────────────');
categories.forEach(function (cat) {
  console.log('\n  ' + cat.toUpperCase() + ':');
  opcodes.forEach(function (op) {
    var flawed = allResults.filter(function (r) { return r.opcode === op && r.draftType === 'flawed' && r.category === cat; });
    var correct = allResults.filter(function (r) { return r.opcode === op && r.draftType === 'correct' && r.category === cat; });
    if (!flawed.length && !correct.length) return;
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
  gapCases.forEach(function (c) { console.log('  · ' + c.id + ': ' + c.note); });
}

var degradedResults = allResults.filter(function (r) { return r.degraded; });
if (degradedResults.length) {
  console.log('\n───────────────────────────────────────────────────────────');
  console.log(' LLAMADAS DEGRADADAS (sin voces locales válidas / error / timeout)');
  console.log('───────────────────────────────────────────────────────────');
  degradedResults.forEach(function (r) { console.log('  · ' + r.caseId + ' (' + r.draftType + ', ' + r.opcode + '): ' + r.error); });
}

var outPath = path.join(__dirname, 'benchmark-final-merged.json');
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases: cases, results: allResults }, null, 2), 'utf-8');
console.log('\n═══════════════════════════════════════════════════════════');
console.log('Fusión guardada en: ' + outPath);
