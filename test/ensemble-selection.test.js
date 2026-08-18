import test from 'node:test';
import assert from 'node:assert/strict';

import { selectDiverseEnsembleModels } from '../src/engine/ensemble-v2.js';

function model(id, family) {
  return { id: id, family: family, installed: true, tier: 'small' };
}

test('selectDiverseEnsembleModels prioritizes independent model families', function () {
  var selected = selectDiverseEnsembleModels([
    model('llama-a', 'llama'),
    model('llama-b', 'llama'),
    model('qwen-a', 'qwen'),
    model('coder-a', 'qwen-coder'),
  ], 3, {});

  assert.deepEqual(selected.map(function (m) { return m.id; }), ['llama-a', 'qwen-a', 'coder-a']);
  assert.equal(new Set(selected.map(function (m) { return m.family; })).size, 3);
});

test('selectDiverseEnsembleModels respects exclusions before filling ensemble slots', function () {
  var selected = selectDiverseEnsembleModels([
    model('llama-a', 'llama'),
    model('qwen-a', 'qwen'),
    model('coder-a', 'qwen-coder'),
  ], 2, { excludeFamilies: ['llama'], excludeModelIds: ['coder-a'] });

  assert.deepEqual(selected.map(function (m) { return m.id; }), ['qwen-a']);
});

test('selectDiverseEnsembleModels boosts learned preferences without collapsing family diversity', function () {
  var selected = selectDiverseEnsembleModels([
    model('llama-a', 'llama'),
    model('qwen-a', 'qwen'),
    model('coder-a', 'qwen-coder'),
  ], 2, { preferredModelIds: ['coder-a'] });

  assert.deepEqual(selected.map(function (m) { return m.id; }), ['coder-a', 'llama-a']);
  assert.equal(new Set(selected.map(function (m) { return m.family; })).size, 2);
});
