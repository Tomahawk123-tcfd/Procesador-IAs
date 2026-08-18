import { computeContentConfidence, looksLikeTopicMismatch } from './translation.js';

function clamp01(value) {
  if (!isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function asNumber(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

export function evaluateProcessorOutput(query, output) {
  output = output || {};
  var text = String(output.text || '');
  var verification = output.verification || null;
  var topicMismatch = typeof output.topicMismatch === 'boolean'
    ? output.topicMismatch
    : (text ? looksLikeTopicMismatch(query, text) : true);
  var malformed = !!output.malformed || !text.trim();
  var hasFindings = !!(verification && verification.hasFindings);
  var contentConfidence = asNumber(output.contentConfidence, text ? computeContentConfidence(text) : 0);

  // La puntuación comparativa solo evalúa propiedades observables de la
  // salida. No premia usar más modelos, mediación o una ruta más compleja:
  // LinkCore debe ganar por calidad y fiabilidad, no por arquitectura.
  var qualityScore = 0;
  qualityScore += clamp01(contentConfidence) * 0.45;
  qualityScore += (topicMismatch ? 0 : 1) * 0.25;
  qualityScore += (hasFindings ? 0 : 1) * 0.20;
  qualityScore += (malformed ? 0 : 1) * 0.10;
  qualityScore = clamp01(qualityScore);

  var issueCount = 0;
  if (topicMismatch) issueCount++;
  if (malformed) issueCount++;
  if (hasFindings) issueCount++;
  issueCount += Math.max(0, asNumber(output.contradictionCount, 0));

  return {
    qualityScore: qualityScore,
    contentConfidence: clamp01(contentConfidence),
    topicMismatch: topicMismatch,
    malformed: malformed,
    hasFindings: hasFindings,
    issueCount: issueCount,
    contradictionCount: Math.max(0, asNumber(output.contradictionCount, 0)),
    consensusScore: output.consensusScore === null || typeof output.consensusScore === 'undefined'
      ? null
      : clamp01(output.consensusScore),
    latencyMs: Math.max(0, asNumber(output.latencyMs, 0)),
    voices: Math.max(1, asNumber(output.voices, 1)),
    mediated: !!output.mediated,
  };
}

export function compareProcessorOutputs(singleEvaluation, processorEvaluation, opts) {
  opts = opts || {};
  var threshold = typeof opts.minimumMeaningfulGain === 'number' ? opts.minimumMeaningfulGain : 0.03;
  var qualityGain = processorEvaluation.qualityScore - singleEvaluation.qualityScore;
  var issuesResolved = Math.max(0, singleEvaluation.issueCount - processorEvaluation.issueCount);
  var issuesIntroduced = Math.max(0, processorEvaluation.issueCount - singleEvaluation.issueCount);
  var findingResolved = singleEvaluation.hasFindings && !processorEvaluation.hasFindings;
  var regression = issuesIntroduced > 0 || qualityGain < -threshold;
  var improved = !regression && (findingResolved || issuesResolved > 0 || qualityGain > threshold);

  return {
    outcome: regression ? 'regression' : (improved ? 'win' : 'tie'),
    qualityGain: Math.round(qualityGain * 1000) / 1000,
    issuesResolved: issuesResolved,
    issuesIntroduced: issuesIntroduced,
    findingResolved: findingResolved,
    latencyDeltaMs: processorEvaluation.latencyMs - singleEvaluation.latencyMs,
    latencyMultiplier: singleEvaluation.latencyMs > 0
      ? Math.round((processorEvaluation.latencyMs / singleEvaluation.latencyMs) * 100) / 100
      : null,
  };
}

export function summarizeProcessorBenchmark(results) {
  results = (results || []).filter(Boolean);
  var total = results.length;
  var wins = 0;
  var regressions = 0;
  var ties = 0;
  var qualityGainSum = 0;
  var resolvableFindings = 0;
  var resolvedFindings = 0;
  var latencyMultipliers = [];

  results.forEach(function (result) {
    if (result.comparison.outcome === 'win') wins++;
    else if (result.comparison.outcome === 'regression') regressions++;
    else ties++;
    qualityGainSum += result.comparison.qualityGain;
    if (result.single.hasFindings) {
      resolvableFindings++;
      if (result.comparison.findingResolved) resolvedFindings++;
    }
    if (typeof result.comparison.latencyMultiplier === 'number') {
      latencyMultipliers.push(result.comparison.latencyMultiplier);
    }
  });

  var averageLatencyMultiplier = latencyMultipliers.length
    ? latencyMultipliers.reduce(function (sum, value) { return sum + value; }, 0) / latencyMultipliers.length
    : null;

  return {
    totalCases: total,
    wins: wins,
    regressions: regressions,
    ties: ties,
    winRate: total ? wins / total : 0,
    regressionRate: total ? regressions / total : 0,
    processorValueRate: total ? (wins + ties * 0.5) / total : 0,
    averageQualityGain: total ? qualityGainSum / total : 0,
    findingResolutionRate: resolvableFindings ? resolvedFindings / resolvableFindings : null,
    averageLatencyMultiplier: averageLatencyMultiplier,
  };
}

export function evaluateReadinessGate(summary, thresholds) {
  thresholds = Object.assign({
    minimumCases: 30,
    minimumWinRate: 0.65,
    maximumRegressionRate: 0.10,
    minimumAverageQualityGain: 0.05,
    minimumFindingResolutionRate: 0.50,
    maximumAverageLatencyMultiplier: 8,
  }, thresholds || {});

  var checks = {
    enoughCases: summary.totalCases >= thresholds.minimumCases,
    winRate: summary.winRate >= thresholds.minimumWinRate,
    regressionRate: summary.regressionRate <= thresholds.maximumRegressionRate,
    qualityGain: summary.averageQualityGain >= thresholds.minimumAverageQualityGain,
    findingResolution: summary.findingResolutionRate === null
      ? false
      : summary.findingResolutionRate >= thresholds.minimumFindingResolutionRate,
    latency: summary.averageLatencyMultiplier === null
      ? false
      : summary.averageLatencyMultiplier <= thresholds.maximumAverageLatencyMultiplier,
  };

  return {
    passed: Object.keys(checks).every(function (key) { return checks[key]; }),
    checks: checks,
    thresholds: thresholds,
  };
}
