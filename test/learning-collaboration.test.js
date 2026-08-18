import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobalShim } from '../src/memory-bus.js';
installGlobalShim();

import { clear, recordCollaboration, getCollaborationBias, getPreferredCollaborators } from '../src/engine/learning-loop.js';

test('recordCollaboration learns positive pair bias after repeated successful runs', function () {
  clear();
  for (var i = 0; i < 3; i++) {
    recordCollaboration(['model-a', 'model-b'], 'reasoning', {
      ok: true,
      latencyMs: 1200,
      quality: 0.86,
      consensusScore: 0.82,
      contradictions: 0,
      mediated: true,
    });
  }

  var bias = getCollaborationBias(['model-a'], 'model-b', 'reasoning');
  assert.ok(bias > 0, 'expected positive collaboration bias');
});

test('recordCollaboration penalizes contradictory pairs after repeated poor runs', function () {
  clear();
  for (var i = 0; i < 3; i++) {
    recordCollaboration(['model-a', 'model-c'], 'reasoning', {
      ok: true,
      latencyMs: 1800,
      quality: 0.35,
      consensusScore: 0.28,
      contradictions: 3,
      mediated: false,
    });
  }

  var bias = getCollaborationBias(['model-a'], 'model-c', 'reasoning');
  assert.ok(bias < 0, 'expected negative collaboration bias');
});

test('getCollaborationBias uses learned topology of three voices when available', function () {
  clear();
  for (var i = 0; i < 3; i++) {
    recordCollaboration(['model-a', 'model-b', 'model-d'], 'code', {
      ok: true,
      latencyMs: 1600,
      quality: 0.92,
      consensusScore: 0.9,
      contradictions: 0,
      mediated: true,
    });
  }

  var bias = getCollaborationBias(['model-a', 'model-b'], 'model-d', 'code');
  assert.ok(bias > 0, 'expected positive topology bias');
});

test('getPreferredCollaborators recommends the strongest learned collaborator for a seed voice', function () {
  clear();
  for (var i = 0; i < 3; i++) {
    recordCollaboration(['model-a', 'model-b'], 'reasoning', {
      ok: true,
      latencyMs: 1200,
      quality: 0.9,
      consensusScore: 0.88,
      contradictions: 0,
      mediated: true,
    }, { riskLevel: 'high', workloadType: 'math' });
    recordCollaboration(['model-a', 'model-c'], 'reasoning', {
      ok: true,
      latencyMs: 1600,
      quality: 0.51,
      consensusScore: 0.44,
      contradictions: 2,
      mediated: false,
    }, { riskLevel: 'high', workloadType: 'comparison' });
  }

  var preferred = getPreferredCollaborators(['model-a'], 'reasoning', 2);
  assert.deepEqual(preferred, ['model-b']);
});

test('getPreferredCollaborators can specialize by workload context', function () {
  clear();
  for (var i = 0; i < 3; i++) {
    recordCollaboration(['model-a', 'model-b'], 'reasoning', {
      ok: true,
      latencyMs: 1100,
      quality: 0.92,
      consensusScore: 0.89,
      contradictions: 0,
      mediated: true,
      verificationResolved: true,
      confidenceGain: 0.18,
      consensusGain: 0.12,
      escalated: true,
    }, { riskLevel: 'high', workloadType: 'math' });
    recordCollaboration(['model-a', 'model-c'], 'reasoning', {
      ok: true,
      latencyMs: 1150,
      quality: 0.93,
      consensusScore: 0.9,
      contradictions: 0,
      mediated: true,
      verificationResolved: true,
      confidenceGain: 0.17,
      consensusGain: 0.11,
      escalated: true,
    }, { riskLevel: 'high', workloadType: 'comparison' });
  }

  assert.deepEqual(getPreferredCollaborators(['model-a'], 'reasoning', 1, { riskLevel: 'high', workloadType: 'math' }), ['model-b']);
  assert.deepEqual(getPreferredCollaborators(['model-a'], 'reasoning', 1, { riskLevel: 'high', workloadType: 'comparison' }), ['model-c']);
});
