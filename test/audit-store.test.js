import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAuditSnapshot, listAuditSnapshots, loadAuditSnapshot, diffAuditSnapshots } from '../src/engine/audit-store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linkcore-audits-'));
}

function auditResult(overrides) {
  return Object.assign({
    ok: true,
    passed: true,
    gate: { minRecall: 1 },
    violations: [],
    summary: { items: 2, audited: 2, recall: 1, falsePositiveRate: 0, findingRate: 0.5 },
    results: [
      { id: 'a', hasFindings: true, channels: ['math'], findingCounts: { math: 1 }, expectFindings: true, text: 'texto que no debe guardarse' },
      { id: 'b', hasFindings: false, channels: [], findingCounts: {}, expectFindings: false, text: 'otro texto' },
    ],
  }, overrides || {});
}

test('el snapshot se guarda por etiqueta y no arrastra los textos auditados', function () {
  var dir = tmpDir();
  var saved = saveAuditSnapshot(auditResult(), { set: 'regression-set', label: 'main', dir: dir, meta: { commit: 'abc123' } });
  assert.ok(fs.existsSync(saved.path));
  var onDisk = JSON.parse(fs.readFileSync(saved.path, 'utf-8'));
  assert.equal(onDisk.label, 'main');
  assert.equal(onDisk.meta.commit, 'abc123');
  assert.equal(onDisk.results.length, 2);
  assert.equal(onDisk.results[0].text, undefined);
  assert.match(fs.readFileSync(saved.path, 'utf-8'), /^(?![\s\S]*no debe guardarse)[\s\S]*$/);
  assert.deepEqual(listAuditSnapshots({ set: 'regression-set', dir: dir }).map(function (s) { return s.label; }), ['main']);
  assert.equal(loadAuditSnapshot({ set: 'regression-set', label: 'main', dir: dir }).passed, true);
});

test('no se guarda el snapshot de una auditoria que fallo', function () {
  var dir = tmpDir();
  assert.throws(function () {
    saveAuditSnapshot({ ok: false, error: 'items_vacio' }, { set: 's', label: 'x', dir: dir });
  }, /no se guarda/);
});

test('sin referencia la comparacion no inventa veredicto', function () {
  var diff = diffAuditSnapshots(null, auditResult());
  assert.equal(diff.comparable, false);
  assert.equal(diff.reason, 'sin_snapshot_de_referencia');
});

test('un caso que estaba limpio y ahora dispara es regresion aunque el recall no baje', function () {
  var baseline = { label: 'main', savedAt: 't0', passed: true, summary: { recall: 1, falsePositiveRate: 0, findingRate: 0.5 }, results: [
    { id: 'a', hasFindings: true, channels: ['math'] },
    { id: 'b', hasFindings: false, channels: [] },
  ] };
  var candidate = { label: 'pr', passed: true, summary: { recall: 1, falsePositiveRate: 0, findingRate: 0.5 }, results: [
    { id: 'a', hasFindings: false, channels: [] },
    { id: 'b', hasFindings: true, channels: ['unit'] },
  ] };
  var diff = diffAuditSnapshots(baseline, candidate);
  assert.equal(diff.worse, true);
  assert.deepEqual(diff.regressions, [{ id: 'b', canales: ['unit'] }]);
  assert.deepEqual(diff.fixes, [{ id: 'a', canales: ['math'] }]);
  assert.equal(diff.metrics.recall.delta, 0);
});

test('la comparacion nombra los casos borrados y los nuevos sin llamarlos regresion', function () {
  var baseline = { label: 'main', savedAt: 't0', passed: true, summary: {}, results: [{ id: 'a', hasFindings: true, channels: ['math'] }] };
  var candidate = { label: 'pr', passed: true, summary: {}, results: [{ id: 'c', hasFindings: true, channels: ['unit'] }] };
  var diff = diffAuditSnapshots(baseline, candidate);
  assert.deepEqual(diff.removed, ['a']);
  assert.deepEqual(diff.added, ['c']);
  assert.equal(diff.worse, false);
});

test('una puerta que pasaba y deja de pasar cuenta como peor', function () {
  var baseline = { label: 'main', savedAt: 't0', passed: true, summary: {}, results: [] };
  var diff = diffAuditSnapshots(baseline, { label: 'pr', passed: false, summary: {}, results: [] });
  assert.equal(diff.gateFlipped, true);
  assert.equal(diff.worse, true);
});
