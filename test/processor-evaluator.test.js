import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareProcessorOutputs,
  evaluateProcessorOutput,
  evaluateReadinessGate,
  summarizeProcessorBenchmark,
} from '../src/engine/processor-evaluator.js';

function evaluated(query, overrides) {
  return evaluateProcessorOutput(query, Object.assign({
    text: 'Respuesta clara, completa y directamente relacionada con la consulta.',
    verification: { hasFindings: false },
    topicMismatch: false,
    malformed: false,
    latencyMs: 100,
  }, overrides || {}));
}

test('evaluateProcessorOutput does not reward architecture complexity', function () {
  var single = evaluated('Explica REST', { voices: 1, mediated: false });
  var processor = evaluated('Explica REST', { voices: 3, mediated: true });

  assert.equal(processor.qualityScore, single.qualityScore);
});

test('compareProcessorOutputs reports a win when the processor resolves findings', function () {
  var single = evaluated('Calcula 12% de 340', {
    verification: { hasFindings: true },
    latencyMs: 100,
  });
  var processor = evaluated('Calcula 12% de 340', {
    verification: { hasFindings: false },
    latencyMs: 300,
  });

  var comparison = compareProcessorOutputs(single, processor);

  assert.equal(comparison.outcome, 'win');
  assert.equal(comparison.findingResolved, true);
  assert.equal(comparison.issuesResolved, 1);
});

test('compareProcessorOutputs reports a regression when processing introduces an issue', function () {
  var single = evaluated('Compara REST y GraphQL');
  var processor = evaluated('Compara REST y GraphQL', {
    topicMismatch: true,
    latencyMs: 400,
  });

  var comparison = compareProcessorOutputs(single, processor);

  assert.equal(comparison.outcome, 'regression');
  assert.equal(comparison.issuesIntroduced, 1);
});

test('summarizeProcessorBenchmark aggregates wins, regressions and latency', function () {
  var singleA = evaluated('A', { verification: { hasFindings: true }, latencyMs: 100 });
  var processorA = evaluated('A', { verification: { hasFindings: false }, latencyMs: 300 });
  var singleB = evaluated('B', { latencyMs: 100 });
  var processorB = evaluated('B', { topicMismatch: true, latencyMs: 500 });

  var summary = summarizeProcessorBenchmark([
    { single: singleA, processor: processorA, comparison: compareProcessorOutputs(singleA, processorA) },
    { single: singleB, processor: processorB, comparison: compareProcessorOutputs(singleB, processorB) },
  ]);

  assert.equal(summary.totalCases, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.regressions, 1);
  assert.equal(summary.findingResolutionRate, 1);
  assert.equal(summary.averageLatencyMultiplier, 4);
});

test('evaluateReadinessGate refuses small or regression-heavy evidence', function () {
  var gate = evaluateReadinessGate({
    totalCases: 12,
    winRate: 0.75,
    regressionRate: 0.17,
    averageQualityGain: 0.08,
    findingResolutionRate: 0.8,
    averageLatencyMultiplier: 4,
  });

  assert.equal(gate.passed, false);
  assert.equal(gate.checks.enoughCases, false);
  assert.equal(gate.checks.regressionRate, false);
});

test('evaluateReadinessGate passes only evidence that clears every threshold', function () {
  var gate = evaluateReadinessGate({
    totalCases: 40,
    winRate: 0.72,
    regressionRate: 0.075,
    averageQualityGain: 0.09,
    findingResolutionRate: 0.7,
    averageLatencyMultiplier: 5.5,
  });

  assert.equal(gate.passed, true);
  assert.ok(Object.values(gate.checks).every(Boolean));
});
