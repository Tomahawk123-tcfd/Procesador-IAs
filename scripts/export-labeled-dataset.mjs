#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// EXPORTADOR DE DATASET ETIQUETADO (2026-08-18)
//
// El producto de datos real de LinkCore: convierte texto de IA en bruto
// (los borradores de los tres corpus de benchmark: autoescrito,
// independiente, empresarial) en un dataset limpio, estructurado y
// ETIQUETADO -- cada fila tiene una etiqueta de verdad (correcto/con
// fallo), el fallo real inyectado, y el veredicto REAL que dieron los
// verificadores deterministas de LinkCore al correr contra ese texto. Es
// la misma idea de fondo que "infraestructura de datos para entrenar y
// evaluar modelos de IA" -- aqui la fuente de la etiqueta no es un
// anotador humano, es verificacion determinista reproducible.
//
// Fuente de verdad: los ficheros bench-*.json ya generados por
// scripts/benchmark-verification.mjs en corridas REALES de esta sesion --
// nunca se inventa un veredicto aqui, solo se reestructura uno que ya se
// produjo ejecutando el motor de verdad. Si un fichero de resultados no
// existe, esa corrida simplemente no aporta filas -- no se rellena con
// datos que no se midieron.
//
// Uso:
//   node scripts/export-labeled-dataset.mjs
//   node scripts/export-labeled-dataset.mjs --out=mi-dataset.jsonl
//
// Manifest (2026-08-18): cada corrida escribe ademas un
// <mismo-nombre-base>.manifest.json junto al .jsonl, con un sha256 real
// del .jsonl YA ESCRITO (node:crypto sobre el fichero en disco, no sobre
// las filas en memoria -- asi el hash cubre exactamente los bytes que
// existen en disco), timestamp de la corrida, recuentos reales por
// origen/categoria/etiqueta, y que ficheros de resultados se usaron
// realmente frente a cuales se omitieron. Sirve para que cualquiera
// pueda verificar que un .jsonl no se toco a mano: recalcula el sha256
// del fichero y lo compara contra el del manifest.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

function argVal(name, def) {
  var prefix = '--' + name + '=';
  var found = process.argv.find(function (a) { return a.indexOf(prefix) === 0; });
  return found ? found.slice(prefix.length) : def;
}

var SOURCES = [
  { corpus: 'benchmark-corpus-self-authored.mjs', results: ['bench-verify-full.json'], origin: 'self-authored' },
  { corpus: 'benchmark-corpus-independent.mjs', results: ['bench-verify-independent.json'], origin: 'independent' },
  { corpus: 'benchmark-corpus-enterprise.mjs', results: ['bench-verify-enterprise.json'], origin: 'enterprise' },
];

async function loadCorpus(filename) {
  var abs = path.join(__dirname, filename);
  if (!fs.existsSync(abs)) return null;
  var mod = await import(pathToFileURL(abs).href);
  return mod.CASES;
}

function loadResults(filename) {
  var abs = path.join(__dirname, filename);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, 'utf-8'));
}

async function main() {
  var rows = [];
  var skipped = [];
  var usedResultFiles = [];

  for (var s = 0; s < SOURCES.length; s++) {
    var src = SOURCES[s];
    var cases = await loadCorpus(src.corpus);
    if (!cases) { skipped.push(src.corpus + ' (corpus no encontrado)'); continue; }
    var caseById = {};
    cases.forEach(function (c) { caseById[c.id] = c; });

    var anyResults = false;
    for (var r = 0; r < src.results.length; r++) {
      var resFile = src.results[r];
      var resultData = loadResults(resFile);
      if (!resultData) { skipped.push(resFile + ' (resultados no encontrados -- corre el benchmark primero)'); continue; }
      anyResults = true;
      usedResultFiles.push({
        origin: src.origin,
        corpus: src.corpus,
        resultsFile: resFile,
        resultsGeneratedAt: resultData.generatedAt || null,
        casesInResultsFile: resultData.cases ? resultData.cases.length : null,
        resultEntries: resultData.results.length,
      });

      resultData.results.forEach(function (res) {
        var c = caseById[res.caseId];
        if (!c) return; // resultado de un caso que ya no esta en el corpus actual -- no se inventa
        var text = res.draftType === 'correct' ? c.correctDraft : c.flawedDraft;
        rows.push({
          datasetId: src.origin + ':' + c.id + ':' + res.draftType,
          origin: src.origin,
          category: c.category,
          text: text,
          groundTruthLabel: res.draftType === 'correct' ? 'clean' : 'flawed',
          groundTruthFlaw: res.draftType === 'flawed' ? c.flaw : null,
          expectedGap: c.expectedGap === true,
          verifierOpcode: res.opcode,
          verifierVerdict: res.caught ? 'flagged' : 'clean',
          verifierCorrect: res.draftType === 'correct' ? !res.caught : res.caught,
          verifierWarningText: (res.raw && res.caught) ? res.raw.text : null,
          latencyMs: res.latencyMs,
          degraded: !!res.degraded,
        });
      });
    }
    if (!anyResults) skipped.push(src.corpus + ': ningun fichero de resultados disponible');
  }

  var outFile = argVal('out', path.join(__dirname, 'linkcore-labeled-dataset.jsonl'));
  var lines = rows.map(function (r) { return JSON.stringify(r); });
  fs.writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');

  // sha256 calculado sobre el .jsonl YA ESCRITO en disco (no sobre las filas
  // en memoria) -- asi el hash del manifest cubre exactamente los bytes que
  // cualquiera puede recalcular despues con `sha256sum` / crypto sobre el
  // mismo fichero, sin depender de como se serializo en memoria.
  var jsonlBuffer = fs.readFileSync(outFile);
  var sha256 = crypto.createHash('sha256').update(jsonlBuffer).digest('hex');

  function countBy(list, keyFn) {
    var out = {};
    list.forEach(function (item) {
      var k = keyFn(item);
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  var correct = rows.filter(function (r) { return r.verifierCorrect; }).length;
  var manifest = {
    generatedAt: new Date().toISOString(),
    outFile: path.resolve(outFile),
    sha256: sha256,
    byteLength: jsonlBuffer.length,
    rowCount: rows.length,
    rowsByOrigin: countBy(rows, function (r) { return r.origin; }),
    rowsByCategory: countBy(rows, function (r) { return r.category; }),
    rowsByGroundTruthLabel: countBy(rows, function (r) { return r.groundTruthLabel; }),
    verifierAccuracy: { correct: correct, total: rows.length, pct: rows.length ? Number((100 * correct / rows.length).toFixed(1)) : null },
    resultsFilesUsed: usedResultFiles,
    skipped: skipped,
  };
  var manifestFile = path.join(path.dirname(outFile), path.basename(outFile, path.extname(outFile)) + '.manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' DATASET ETIQUETADO — LinkCore');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Filas: ' + rows.length);
  console.log(' Origenes: ' + Array.from(new Set(rows.map(function(r){return r.origin;}))).join(', '));
  console.log(' Categorias: ' + Array.from(new Set(rows.map(function(r){return r.category;}))).sort().join(', '));
  console.log(' Etiquetas: ' + rows.filter(function(r){return r.groundTruthLabel==='clean';}).length + ' clean, ' +
    rows.filter(function(r){return r.groundTruthLabel==='flawed';}).length + ' flawed');
  console.log(' Acierto real del verificador sobre este dataset: ' + correct + '/' + rows.length + ' (' + (100*correct/rows.length).toFixed(1) + '%)');
  if (skipped.length) {
    console.log('\n AVISO -- no se incluyeron estas fuentes (no se inventan filas por ellas):');
    skipped.forEach(function (s) { console.log('   · ' + s); });
  }
  console.log('\n Guardado en: ' + outFile);
  console.log(' Manifest: ' + manifestFile + ' (sha256 ' + sha256.slice(0, 16) + '...)');
  console.log('═══════════════════════════════════════════════════════════');
}

main();
