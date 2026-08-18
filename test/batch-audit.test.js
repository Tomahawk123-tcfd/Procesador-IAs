import test from 'node:test';
import assert from 'node:assert/strict';

import { runBatchAudit, compareAudits } from '../src/engine/batch-audit.js';

var WRONG = { id: 'wrong', query: '¿Cuánto es 100/4?', draft: '100 / 4 = 20', expectFindings: true };
var RIGHT = { id: 'right', query: '¿Cuánto es 100/4?', draft: '100 / 4 = 25', expectFindings: false };

test('batch audit measures the confusion matrix on a labelled set', async function () {
  var res = await runBatchAudit({ items: [WRONG, RIGHT] });
  assert.equal(res.ok, true);
  assert.equal(res.summary.audited, 2);
  assert.equal(res.summary.recall, 1);
  assert.equal(res.summary.falsePositiveRate, 0);
  assert.deepEqual(res.summary.confusion, { truePositives: 1, falseNegatives: 0, falsePositives: 0, trueNegatives: 1 });
});

test('batch audit reports null metrics instead of inventing them when unlabelled', async function () {
  var res = await runBatchAudit({ items: [{ query: '¿Cuánto es 100/4?', draft: '100 / 4 = 20' }] });
  assert.equal(res.summary.recall, null);
  assert.equal(res.summary.falsePositiveRate, null);
  assert.equal(res.summary.confusion, null);
  assert.equal(res.summary.findingRate, 1);
});

test('batch audit fails the gate it is given, and says which rule broke', async function () {
  var res = await runBatchAudit({ items: [WRONG, RIGHT], gate: { maxFindingRate: 0.1 } });
  assert.equal(res.passed, false);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].regla, 'maxFindingRate');
  assert.equal(res.violations[0].medido, 0.5);
});

test('a gate that asks for recall on an unlabelled set is a violation, not a pass', async function () {
  // Pasar la puerta sin poder medirla seria peor que fallarla: el operador se
  // quedaria creyendo que hay una garantia donde no hay nada medido.
  var res = await runBatchAudit({ items: [{ query: 'q', draft: '100 / 4 = 20' }], gate: { minRecall: 0.8 } });
  assert.equal(res.passed, false);
  assert.equal(res.violations[0].regla, 'minRecall');
  assert.equal(res.violations[0].medido, null);
});

test('batch audit keeps going when one item breaks', async function () {
  var res = await runBatchAudit({ items: [WRONG, { id: 'roto', query: 'q', draft: null }, RIGHT] });
  assert.equal(res.ok, true);
  assert.equal(res.summary.items, 3);
  assert.equal(res.summary.audited, 3);
});

test('audit comparison reports regressions by id, not by position', async function () {
  var baseline = await runBatchAudit({ items: [RIGHT, WRONG] });
  var candidate = await runBatchAudit({ items: [WRONG, Object.assign({}, RIGHT, { draft: '100 / 4 = 20' })] });
  var diff = compareAudits(baseline, candidate);
  assert.equal(diff.worse, true);
  assert.deepEqual(diff.regressions.map(function (r) { return r.id; }), ['right']);
  assert.deepEqual(diff.fixes, []);
});
