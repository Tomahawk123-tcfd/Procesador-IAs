import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProcessorPacket } from '../src/engine/processor-packet.js';

function baseResult() {
  return {
    text: 'REST simplifica cacheo; GraphQL flexibiliza las consultas.',
    model: 'mediator-a',
    ensemble: {
      models: ['model-a', 'model-b'],
      mediation: { used: true, model: 'mediator-a' },
      round2: [
        { model: 'model-a', revised: true, text: 'REST simplifica el cacheo.' },
        { model: 'model-b', revised: false, text: 'GraphQL flexibiliza las consultas.' },
      ],
    },
    intermediation: {
      profile: { workloadType: 'comparison', brokerCategory: 'reasoning', riskLevel: 'high' },
      path: 'escalated',
      escalated: true,
      escalationReason: 'low_consensus',
      verification: { hasFindings: false },
      collaboration: { actualVoices: 2, revisedVoices: 1, degradedToSingle: false },
      confidence: {
        score: 0.84,
        band: 'high',
        contentConfidence: 0.81,
        consensusScore: 0.79,
        contradictionCount: 0,
      },
      improvement: {
        confidenceGain: 0.16,
        consensusGain: 0.21,
        contradictionsResolved: 1,
        verificationResolved: true,
        voicesAdded: 1,
        keptEscalatedResult: true,
      },
    },
  };
}

test('buildProcessorPacket exposes a structured contract for the primary AI', function () {
  var packet = buildProcessorPacket('Compara REST y GraphQL', baseResult());

  assert.equal(packet.protocol, 'linkcore.processor.packet');
  assert.equal(packet.output.guidance.mode, 'ready_for_primary_ai');
  assert.equal(packet.input.workloadType, 'comparison');
  assert.deepEqual(packet.processing.models, ['model-a', 'model-b']);
  assert.equal(packet.processing.mediationUsed, true);
  assert.equal(packet.reliability.verificationResolved, true);
  assert.equal(packet.improvement.confidenceGain, 0.16);
  assert.equal(packet.voices.length, 2);
});

test('buildProcessorPacket warns the primary AI about unresolved reliability issues', function () {
  var result = baseResult();
  result.intermediation.verification.hasFindings = true;
  result.intermediation.confidence.band = 'low';
  result.intermediation.confidence.contradictionCount = 2;
  result.intermediation.collaboration.degradedToSingle = true;

  var packet = buildProcessorPacket('Consulta de riesgo', result);

  assert.equal(packet.output.guidance.mode, 'review_before_use');
  assert.deepEqual(packet.output.guidance.reasons, [
    'verification_findings',
    'unresolved_contradictions',
    'low_confidence',
    'degraded_to_single_voice',
  ]);
});

test('buildProcessorPacket preserves voice provenance without inventing models', function () {
  var result = baseResult();
  result.ensemble.models = ['model-a', 'model-a', 'model-b'];

  var packet = buildProcessorPacket('Consulta', result);

  assert.deepEqual(packet.processing.models, ['model-a', 'model-b']);
  assert.equal(packet.voices[0].model, 'model-a');
  assert.equal(packet.voices[0].revised, true);
});
