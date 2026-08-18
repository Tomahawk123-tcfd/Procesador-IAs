import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLearningContext,
  classifyIntermediationLoad,
  runIntermediationCore,
  shouldEscalateIntermediation,
} from '../src/engine/intermediation-core.js';

test('classifyIntermediationLoad keeps simple factual queries on one voice', function () {
  var profile = classifyIntermediationLoad('Capital de Francia', {});
  assert.equal(profile.riskLevel, 'low');
  assert.equal(profile.brokerCategory, 'general');
  assert.equal(profile.initialVoices, 1);
  assert.equal(profile.maxVoices, 1);
});

test('classifyIntermediationLoad escalates code-heavy queries to collaborative mode', function () {
  var profile = classifyIntermediationLoad('Compara TypeScript vs Python y dame una estrategia de migración con riesgos de API', {});
  assert.equal(profile.riskLevel, 'high');
  assert.equal(profile.brokerCategory, 'code');
  assert.equal(profile.workloadType, 'code');
  assert.equal(profile.initialVoices, 2);
  assert.equal(profile.maxVoices, 3);
  assert.equal(profile.gstackReview, true);
});

test('buildLearningContext maps the intermediation profile to a collaboration context', function () {
  var profile = classifyIntermediationLoad('Calcula el ROI y compara tres estrategias de crecimiento', {});
  assert.deepEqual(buildLearningContext(profile), {
    riskLevel: 'high',
    workloadType: 'math',
  });
});

test('runIntermediationCore returns fast single-voice result when verification is clean', async function () {
  var calls = [];
  var result = await runIntermediationCore('Capital de Francia', {
    initialVoices: 1,
    maxVoices: 3,
    systemPrompt: 'test',
  }, {
    runEnsemble: async function (query, opts) {
      calls.push(opts);
      return {
        ok: true,
        text: 'París',
        model: 'llama3.2:3b',
        provider: 'ensemble-single',
        ensemble: { models: ['llama3.2:3b'] },
      };
    },
    aiCaller: function () {},
    verify: async function (text) {
      return { text: text, hasFindings: false };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].category, 'general');
  assert.equal(result.ok, true);
  assert.equal(result.intermediation.path, 'initial');
  assert.equal(result.intermediation.escalated, false);
  assert.equal(result.intermediation.collaboration.actualVoices, 1);
  assert.match(result.intermediation.label, /1 voz seleccionada por brokerage/);
});

test('runIntermediationCore escalates when deterministic verification finds issues', async function () {
  var calls = [];
  var verifyCalls = 0;

  var result = await runIntermediationCore('Calcula 12% de 340 y explica el resultado', {
    initialVoices: 1,
    maxVoices: 3,
    systemPrompt: 'test',
  }, {
    runEnsemble: async function (query, opts) {
      calls.push(opts);
      if (calls.length === 1) {
        return {
          ok: true,
          text: '12% de 340 = 52',
          model: 'model-a',
          provider: 'ensemble-single',
          ensemble: { models: ['model-a'] },
        };
      }
      return {
        ok: true,
        text: '12% de 340 = 40.8',
        model: 'model-b',
        provider: 'ensemble-v2',
        ensemble: { models: ['model-b', 'model-c'] },
        neuralArbitrage: { consensusScore: 0.81, contradictionCount: 0 },
      };
    },
    aiCaller: function () {},
    getPreferredCollaborators: function (selectedModels, category, limit, context) {
      assert.deepEqual(selectedModels, ['model-a']);
      assert.equal(category, 'reasoning');
      assert.equal(limit, 2);
      assert.deepEqual(context, { riskLevel: 'high', workloadType: 'math' });
      return ['model-c'];
    },
    verify: async function (text) {
      verifyCalls += 1;
      if (verifyCalls === 1) return { text: text, hasFindings: true };
      return { text: text, hasFindings: false };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].category, 'reasoning');
  assert.equal(calls[1].size, 3);
  assert.deepEqual(calls[1].excludeModelIds, ['model-a']);
  assert.deepEqual(calls[1].preferredModelIds, ['model-c']);
  assert.equal(result.intermediation.escalated, true);
  assert.equal(result.intermediation.escalationReason, 'verification_findings');
  assert.equal(result.intermediation.collaboration.actualVoices, 2);
  assert.equal(result.intermediation.improvement.verificationResolved, true);
  assert.equal(result.intermediation.improvement.voicesAdded, 1);
  assert.ok(result.intermediation.improvement.confidenceGain > 0);
});

test('runIntermediationCore escalates when collaborative intent degrades to a single surviving voice', async function () {
  var calls = [];

  var result = await runIntermediationCore('Compara REST vs GraphQL para una API de producto', {
    initialVoices: 2,
    maxVoices: 3,
    systemPrompt: 'test',
  }, {
    runEnsemble: async function (query, opts) {
      calls.push(opts);
      if (calls.length === 1) {
        return {
          ok: true,
          text: 'REST y GraphQL tienen trade-offs distintos.',
          model: 'model-a',
          provider: 'ensemble-single',
          ensemble: { models: ['model-a'] },
        };
      }
      return {
        ok: true,
        text: 'REST destaca por simplicidad y cacheo; GraphQL por flexibilidad de consulta.',
        model: 'model-b',
        provider: 'ensemble-v2',
        ensemble: { models: ['model-b', 'model-c'] },
        neuralArbitrage: { consensusScore: 0.74, contradictionCount: 0 },
      };
    },
    aiCaller: function () {},
    verify: async function (text) {
      return { text: text, hasFindings: false };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].category, 'code');
  assert.equal(result.intermediation.escalated, true);
  assert.equal(result.intermediation.escalationReason, 'degraded_to_single_voice');
  assert.match(result.intermediation.label, /escalado a 2 voces/);
});

test('runIntermediationCore keeps the initial result when escalation degrades output quality', async function () {
  var calls = 0;
  var result = await runIntermediationCore('Compara dos estrategias de pricing', {
    initialVoices: 1,
    maxVoices: 3,
    systemPrompt: 'test',
  }, {
    runEnsemble: async function () {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          text: 'La estrategia premium protege margen y la de penetracion acelera adopcion.',
          model: 'model-a',
          provider: 'ensemble-single',
          ensemble: { models: ['model-a'] },
        };
      }
      return {
        ok: true,
        text: 'No se puede determinar con certeza.',
        model: 'model-b',
        provider: 'ensemble-v2',
        ensemble: { models: ['model-b', 'model-c'] },
        neuralArbitrage: { consensusScore: 0.22, contradictionCount: 2 },
      };
    },
    aiCaller: function () {},
    verify: async function (text) {
      return { text: text, hasFindings: false };
    },
  });

  assert.equal(result.text, 'La estrategia premium protege margen y la de penetracion acelera adopcion.');
  assert.equal(result.intermediation.escalated, true);
  assert.equal(result.intermediation.improvement.keptEscalatedResult, false);
});

test('shouldEscalateIntermediation reports low-consensus multi-voice outputs', function () {
  var profile = { initialVoices: 2, maxVoices: 3, targetConfidence: 0.7 };
  var evaluation = {
    topicMismatch: false,
    malformed: false,
    verificationFindings: false,
    degradedToSingle: false,
    contradictionCount: 0,
    consensusScore: 0.31,
    actualVoices: 2,
    score: 0.62,
  };
  var decision = shouldEscalateIntermediation(profile, evaluation, { ok: true, text: 'ok' });
  assert.deepEqual(decision, { escalate: true, reason: 'low_consensus' });
});
