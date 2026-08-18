#!/usr/bin/env node
// ── PUERTA DE CALIDAD DEL PROPIO PROCESADOR ──
//
// Corre AUDIT sobre el conjunto etiquetado de quality-gate/regression-set.json
// y sale con codigo 1 si la puerta no se supera. Es exactamente lo que una
// empresa cliente pondria en su CI, aplicado aqui a nosotros mismos: si un
// cambio en un canal sube recall a costa de un falso positivo, este script lo
// para antes del merge.
//
// Llama a runBatchAudit() directamente en vez de pasar por la tuberia: en un
// CI no hay servicio arrancado, y arrancarlo para una verificacion determinista
// que no necesita ningun modelo seria un requisito inventado.
//
//   node scripts/quality-gate.mjs [ruta/al/conjunto.json] [--json]
//
// Comparacion entre despliegues (esto es lo que corta un merge que empeora la
// calidad sin bajar el recall agregado):
//
//   node scripts/quality-gate.mjs --save main          # fija la referencia
//   node scripts/quality-gate.mjs --compare main       # audita y compara
//
// `--compare` sale con 1 si algun caso que estaba limpio empieza a disparar,
// aunque la puerta absoluta se supere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBatchAudit } from '../src/engine/batch-audit.js';
import { saveAuditSnapshot, loadAuditSnapshot, diffAuditSnapshots } from '../src/engine/audit-store.js';

function flagValue(argv, name) {
  var i = argv.indexOf(name);
  if (i === -1) return null;
  var next = argv[i + 1];
  return next && next.charAt(0) !== '-' ? next : 'latest';
}

var here = path.dirname(fileURLToPath(import.meta.url));
var args = process.argv.slice(2);
var asJson = args.indexOf('--json') !== -1;
var saveLabel = flagValue(args, '--save');
var compareLabel = flagValue(args, '--compare');
// El valor de --save/--compare no es la ruta del conjunto: se descarta de los
// posicionales para que `--compare main conjunto.json` siga funcionando.
var positionals = args.filter(function (a, i) {
  if (a.charAt(0) === '-') return false;
  var prev = args[i - 1];
  return prev !== '--save' && prev !== '--compare';
});
var setPath = positionals[0]
  || path.join(here, '..', 'quality-gate', 'regression-set.json');

var spec = JSON.parse(fs.readFileSync(setPath, 'utf-8'));
// Los catalogos de referencia se declaran en el conjunto por RUTA relativa al
// propio conjunto (no dentro del JSON) para que la empresa pueda versionar su
// taxonomia aparte del conjunto de regresion y compartirla entre varios.
var catalogs = (spec.catalogs || []).map(function (rel) {
  return JSON.parse(fs.readFileSync(path.resolve(path.dirname(setPath), rel), 'utf-8'));
});
var result = await runBatchAudit({ items: spec.items, gate: spec.gate, catalogs: catalogs });

if (!result.ok) {
  console.error('[quality-gate] no se pudo auditar: ' + result.error);
  process.exit(1);
}
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  var s = result.summary;
  console.log('Conjunto: ' + path.basename(setPath) + ' — ' + s.audited + '/' + s.items + ' auditados en ' + s.latencyMs + 'ms');
  if (result.summary.catalogs.length > 0) {
    console.log('Catálogos de referencia: ' + result.summary.catalogs.join(', '));
  }
  console.log('Recall: ' + (s.recall === null ? 'no calculable' : Math.round(s.recall * 100) + '%')
    + ' · falsos positivos: ' + (s.falsePositiveRate === null ? 'no calculable' : Math.round(s.falsePositiveRate * 100) + '%'));
  // Los fallos individuales son lo unico accionable de esta salida: sin ellos
  // el CI dice "no pasa" y quien lo lea tiene que reproducirlo a mano.
  result.results.forEach(function (r) {
    if (r.error) console.log('  ! ' + r.id + ': ' + r.error);
    else if (r.expectFindings === true && !r.hasFindings) console.log('  MISS ' + r.id + ': el ALU no vio el defecto');
    else if (r.expectFindings === false && r.hasFindings) console.log('  FALSO POSITIVO ' + r.id + ': disparó ' + r.channels.join(', '));
  });
  console.log(result.passed ? '✓ Puerta superada.' : '✗ Puerta NO superada:');
  result.violations.forEach(function (v) {
    console.log('  ' + v.regla + ': límite ' + v.limite + ', medido ' + (v.medido === null ? 'n/d' : v.medido));
  });
}

var setName = path.basename(setPath, '.json');
var worseThanBaseline = false;
if (compareLabel) {
  var baseline = loadAuditSnapshot({ set: setName, label: compareLabel });
  var diff = diffAuditSnapshots(baseline, {
    label: 'candidato', passed: result.passed, summary: result.summary, results: result.results,
  });
  if (!diff.comparable) {
    // Sin referencia no se inventa un veredicto de comparacion: se dice que no
    // hay con que comparar y se deja que decida la puerta absoluta.
    console.log('Comparación: no hay snapshot «' + compareLabel + '» para «' + setName + '» (' + diff.reason + ').');
  } else {
    console.log('Comparación contra «' + diff.baselineLabel + '» (' + diff.baselineSavedAt + ', ' + diff.compared + ' casos):');
    diff.regressions.forEach(function (r) { console.log('  REGRESIÓN ' + r.id + ': ahora dispara ' + r.canales.join(', ')); });
    diff.fixes.forEach(function (r) { console.log('  arreglado ' + r.id); });
    if (diff.removed.length) console.log('  casos que ya no se auditan: ' + diff.removed.join(', '));
    if (diff.added.length) console.log('  casos nuevos: ' + diff.added.join(', '));
    if (diff.metrics.recall) console.log('  recall: ' + diff.metrics.recall.antes + ' → ' + diff.metrics.recall.ahora);
    console.log(diff.worse ? '✗ Peor que la referencia.' : '✓ Sin regresiones respecto a la referencia.');
    worseThanBaseline = diff.worse;
  }
}
if (saveLabel) {
  var saved = saveAuditSnapshot(result, {
    set: setName,
    label: saveLabel === 'latest' ? 'baseline' : saveLabel,
    meta: { commit: process.env.GITHUB_SHA || null, ref: process.env.GITHUB_REF || null },
  });
  console.log('Snapshot guardado en ' + saved.path);
}
process.exit(result.passed && !worseThanBaseline ? 0 : 1);
