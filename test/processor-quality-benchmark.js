import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobalShim } from '../src/memory-bus.js';
installGlobalShim();

import { smartQuery, callAI } from '../src/backend.js';
import { applyDeterministicVerification } from '../src/engine/verification-pipeline.js';
import { looksLikeTopicMismatch } from '../src/engine/translation.js';
import {
  compareProcessorOutputs,
  evaluateProcessorOutput,
  evaluateReadinessGate,
  summarizeProcessorBenchmark,
} from '../src/engine/processor-evaluator.js';

var currentDir = path.dirname(fileURLToPath(import.meta.url));
var suitePath = path.resolve(currentDir, '../benchmarks/quality-suite.json');
var BENCHMARK_SUITE = JSON.parse(fs.readFileSync(suitePath, 'utf8'));

function fmtPct(value) {
  if (value === null || typeof value === 'undefined') return 'sin datos';
  return (value * 100).toFixed(1) + '%';
}

async function evaluateSingle(query) {
  var raw = await callAI(query, { maxTokens: 1200, temperature: 0.2, minTier: 'medium' });
  var verification = raw && raw.text
    ? await applyDeterministicVerification(raw.text, query)
    : { text: '', hasFindings: true };

  return evaluateProcessorOutput(query, {
    text: verification.text,
    verification: verification,
    topicMismatch: verification.text ? looksLikeTopicMismatch(query, verification.text) : true,
    latencyMs: raw && raw.latencyMs,
    voices: 1,
    mediated: false,
  });
}

async function evaluateProcessor(query) {
  var raw = await smartQuery(query, null, {});
  var text = raw && raw.response ? raw.response : '';
  var verification = text
    ? await applyDeterministicVerification(text, query)
    : { text: '', hasFindings: true };
  var intermediation = raw && raw.intermediation ? raw.intermediation : {};
  var confidence = intermediation.confidence || {};
  var collaboration = intermediation.collaboration || {};

  return evaluateProcessorOutput(query, {
    text: verification.text,
    verification: verification,
    topicMismatch: text ? looksLikeTopicMismatch(query, text) : true,
    malformed: confidence.band === 'low' && !text,
    contradictionCount: confidence.contradictionCount || 0,
    consensusScore: typeof confidence.consensusScore === 'number' ? confidence.consensusScore : null,
    latencyMs: raw && raw.latencyMs,
    voices: collaboration.actualVoices || 1,
    mediated: !!(raw && raw.ensemble && raw.ensemble.mediation && raw.ensemble.mediation.used),
  });
}

async function runCase(item, index) {
  console.log('\n[' + (index + 1) + '/' + BENCHMARK_SUITE.length + '] ' + item.id + ' (' + item.category + ')');
  console.log(item.query);

  var single = await evaluateSingle(item.query);
  var processor = await evaluateProcessor(item.query);
  var comparison = compareProcessorOutputs(single, processor);

  console.log('  single:    calidad=' + fmtPct(single.qualityScore) + ' issues=' + single.issueCount + ' latencia=' + single.latencyMs + 'ms');
  console.log('  LinkCore:  calidad=' + fmtPct(processor.qualityScore) + ' issues=' + processor.issueCount + ' latencia=' + processor.latencyMs + 'ms');
  console.log('  resultado: ' + comparison.outcome + ' | delta=' + fmtPct(comparison.qualityGain) + ' | issues resueltos=' + comparison.issuesResolved);

  return {
    id: item.id,
    category: item.category,
    single: single,
    processor: processor,
    comparison: comparison,
  };
}

async function main() {
  console.log('=== BENCHMARK LOCAL LINKCORE VS UNA SOLA VOZ ===');
  console.log('La evaluación no premia usar más modelos; solo resultado observable.');

  var results = [];
  for (var i = 0; i < BENCHMARK_SUITE.length; i++) {
    try {
      results.push(await runCase(BENCHMARK_SUITE[i], i));
    } catch (error) {
      console.error('  fallo en ' + BENCHMARK_SUITE[i].id + ': ' + (error && error.message ? error.message : error));
    }
  }

  var summary = summarizeProcessorBenchmark(results);
  var gate = evaluateReadinessGate(summary);

  console.log('\n=== RESUMEN MEDIDO ===');
  console.log('Casos válidos:          ' + summary.totalCases);
  console.log('Victorias LinkCore:     ' + summary.wins + ' (' + fmtPct(summary.winRate) + ')');
  console.log('Regresiones:            ' + summary.regressions + ' (' + fmtPct(summary.regressionRate) + ')');
  console.log('Empates:                ' + summary.ties);
  console.log('Ganancia calidad media: ' + fmtPct(summary.averageQualityGain));
  console.log('Resolución findings:    ' + fmtPct(summary.findingResolutionRate));
  console.log('Multiplicador latencia: ' + (summary.averageLatencyMultiplier === null ? 'sin datos' : summary.averageLatencyMultiplier.toFixed(2) + 'x'));

  console.log('\n=== PUERTA DE CALIDAD ===');
  Object.keys(gate.checks).forEach(function (key) {
    console.log((gate.checks[key] ? '  OK   ' : ' FALLO ') + key);
  });
  console.log(gate.passed ? '\nLISTO: evidencia suficiente para esta puerta.' : '\nNO LISTO: no se debe afirmar 10/10 todavía.');

  if (process.argv.indexOf('--enforce') !== -1 && !gate.passed) process.exitCode = 1;
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
