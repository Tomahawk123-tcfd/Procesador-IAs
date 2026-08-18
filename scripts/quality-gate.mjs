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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBatchAudit } from '../src/engine/batch-audit.js';

var here = path.dirname(fileURLToPath(import.meta.url));
var args = process.argv.slice(2);
var asJson = args.indexOf('--json') !== -1;
var setPath = args.filter(function (a) { return a.charAt(0) !== '-'; })[0]
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
process.exit(result.passed ? 0 : 1);
