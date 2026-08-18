import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReferenceCatalog, validateCatalog } from '../src/engine/reference-catalog.js';
import { runVNPUInstruction, VNPU_OPCODES } from '../src/engine/vnpu-core.js';

var here = path.dirname(fileURLToPath(import.meta.url));
function loadCatalog(name) {
  return JSON.parse(fs.readFileSync(path.join(here, '..', 'quality-gate', 'catalogs', name), 'utf-8'));
}
var RGPD = loadCatalog('rgpd-articulos.json');
var CWE = loadCatalog('cwe-clasificacion.json');

test('los catalogos que se distribuyen con el procesador son validos', function () {
  assert.deepEqual(validateCatalog(RGPD), []);
  assert.deepEqual(validateCatalog(CWE), []);
});

test('catalogo pilla el articulo equivocado del RGPD y calla con el correcto', function () {
  var mal = 'El derecho de supresión está recogido en el Artículo 12 del RGPD, así que el plazo es de un mes.';
  var findings = verifyReferenceCatalog(mal, RGPD);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].referenciaDelCatalogo, 'Artículo 17');
  assert.equal(findings[0].catalogo, 'rgpd-articulos@2026-08 (Reglamento (UE) 2016/679 (RGPD))');
  assert.deepEqual(
    verifyReferenceCatalog('El derecho de supresión está recogido en el Artículo 17 del RGPD.', RGPD),
    []
  );
});

test('catalogo pilla el CWE equivocado y distingue conceptos vecinos', function () {
  assert.equal(verifyReferenceCatalog('La inyección SQL se clasifica como CWE-79.', CWE).length, 1);
  assert.deepEqual(verifyReferenceCatalog('La inyección SQL se clasifica como CWE-89.', CWE), []);
  // XSS SI es CWE-79: el catalogo no debe arrastrar el aviso al concepto vecino.
  assert.deepEqual(verifyReferenceCatalog('El XSS se clasifica como CWE-79.', CWE), []);
});

test('sin referencia citada el catalogo se calla en vez de suponer', function () {
  // Menciona el concepto pero no cita ningun articulo: no hay nada que cruzar.
  assert.deepEqual(
    verifyReferenceCatalog('El derecho de supresión obliga a borrar los datos del interesado.', RGPD),
    []
  );
  // Cita una referencia de OTRA clase (un CWE en un texto de RGPD): tampoco.
  assert.deepEqual(
    verifyReferenceCatalog('El derecho de supresión no tiene nada que ver con CWE-89.', RGPD),
    []
  );
});

test('el aviso no salta por citar el articulo correcto en otra frase del texto', function () {
  var texto = 'El Artículo 12 regula la transparencia. El derecho de supresión es el Artículo 17.';
  assert.deepEqual(verifyReferenceCatalog(texto, RGPD), []);
});

test('un catalogo mal formado se reporta como error, no como silencio', function () {
  var roto = { id: 'x', version: '1', entries: [{ concept: 'algo' }] };
  var findings = verifyReferenceCatalog('El derecho de supresión es el Artículo 12.', roto);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tipo, 'catalogo_invalido');
  assert.match(findings[0].detalle, /sin_reference/);
});

test('GROUND compone el catalogo con las fuentes aportadas y lo deja en la traza', async function () {
  var res = await runVNPUInstruction(VNPU_OPCODES.GROUND, {
    answer: 'Según el informe, el derecho de supresión es el Artículo 12 del RGPD.',
    sources: [{ id: 'informe', text: 'El informe describe el derecho de supresión sin citar artículos.' }],
    question: '¿Qué artículo regula el derecho de supresión?',
    catalogs: [RGPD],
  }, { _suppressQualityRecord: true, _suppressAuditRecord: true });
  assert.equal(res.ok, true);
  assert.ok(res.channelsRun.includes('REFERENCE_CATALOG'));
  assert.deepEqual(res.catalogsRun, ['rgpd-articulos@2026-08']);
  var catFindings = res.findings.filter(function (f) { return f.channel === 'REFERENCE_CATALOG'; });
  assert.equal(catFindings.length, 1);
});

test('GROUND sin catalogos no inventa el canal ni conocimiento normativo', async function () {
  var res = await runVNPUInstruction(VNPU_OPCODES.GROUND, {
    answer: 'El derecho de supresión es el Artículo 12 del RGPD.',
    sources: [{ id: 'informe', text: 'Texto sin artículos.' }],
  }, { _suppressQualityRecord: true, _suppressAuditRecord: true });
  assert.equal(res.ok, true);
  assert.equal(res.channelsRun.includes('REFERENCE_CATALOG'), false);
  assert.equal(res.catalogsRun, undefined);
  assert.equal(res.findings.filter(function (f) { return f.channel === 'REFERENCE_CATALOG'; }).length, 0);
});

test('AUDIT mete el catalogo en la matriz de confusion del lote', async function () {
  var { runBatchAudit } = await import('../src/engine/batch-audit.js');
  var res = await runBatchAudit({
    catalogs: [RGPD, CWE],
    gate: { minRecall: 1, maxFalsePositiveRate: 0 },
    items: [
      { id: 'mal', query: '¿Qué artículo?', draft: 'El derecho de supresión es el Artículo 12 del RGPD.', expectFindings: true },
      { id: 'bien', query: '¿Qué artículo?', draft: 'El derecho de supresión es el Artículo 17 del RGPD.', expectFindings: false },
      { id: 'cwe-mal', query: 'Clasifícala', draft: 'La inyección SQL es CWE-79.', expectFindings: true },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.passed, true);
  assert.equal(res.summary.recall, 1);
  assert.equal(res.summary.falsePositiveRate, 0);
  assert.equal(res.summary.channelHits.referenceCatalog, 2);
  assert.deepEqual(res.summary.catalogs, ['rgpd-articulos@2026-08', 'cwe-clasificacion@2026-08']);
});

test('AUDIT aborta el lote si el catalogo esta roto en vez de auditar a medias', async function () {
  var { runBatchAudit } = await import('../src/engine/batch-audit.js');
  var res = await runBatchAudit({
    catalogs: [{ id: 'roto', version: '1', entries: [{ concept: 'x' }] }],
    items: [{ id: 'a', draft: 'texto', query: 'q' }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /catalogo_invalido: roto/);
});

test('AUDIT sin catalogos sigue funcionando igual que antes', async function () {
  var { runBatchAudit } = await import('../src/engine/batch-audit.js');
  var res = await runBatchAudit({
    items: [{ id: 'a', query: '¿Qué artículo?', draft: 'El derecho de supresión es el Artículo 12 del RGPD.', expectFindings: false }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.summary.catalogs, []);
  assert.equal(res.summary.channelHits.referenceCatalog, undefined);
});

test('GROUND rechaza catalogs mal tipado antes de verificar nada', async function () {
  var res = await runVNPUInstruction(VNPU_OPCODES.GROUND, {
    answer: 'texto',
    catalogs: { id: 'no-es-array' },
  }, { _suppressQualityRecord: true, _suppressAuditRecord: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'catalogs_debe_ser_array');
});
