import { detectTaskType, isSimpleQuery } from '../task-decomposer.js';
import {
  computeContentConfidence,
  looksLikeContextLeak,
  looksLikeEcho,
  looksLikeRefusal,
  looksLikeRepetitiveGarbage,
  looksLikeTopicMismatch,
} from './translation.js';
import { getPreferredCollaborators as getLearnedPreferredCollaborators } from './learning-loop.js';

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function unique(list) {
  var out = [];
  var seen = {};
  (list || []).forEach(function (item) {
    if (!item || seen[item]) return;
    seen[item] = true;
    out.push(item);
  });
  return out;
}

function hasSignal(text, regex) {
  return regex.test(text || '');
}

function modelsFromResult(result) {
  if (result && result.ensemble && Array.isArray(result.ensemble.models) && result.ensemble.models.length) {
    return unique(result.ensemble.models);
  }
  return result && result.model ? [result.model] : [];
}

function getConsensusScore(result) {
  return result && result.neuralArbitrage && typeof result.neuralArbitrage.consensusScore === 'number'
    ? result.neuralArbitrage.consensusScore
    : null;
}

function getContradictionCount(result) {
  return result && result.neuralArbitrage && typeof result.neuralArbitrage.contradictionCount === 'number'
    ? result.neuralArbitrage.contradictionCount
    : 0;
}

function getRound2Revisions(result) {
  if (!result || !result.ensemble || !Array.isArray(result.ensemble.round2)) return 0;
  return result.ensemble.round2.filter(function (step) { return step && step.revised; }).length;
}

function mergePreferredModelIds(base, extra) {
  return unique((base || []).concat(extra || []));
}

export function buildLearningContext(profile) {
  profile = profile || {};
  return {
    riskLevel: profile.riskLevel || 'unknown',
    workloadType: profile.workloadType || profile.brokerCategory || 'general',
  };
}

function shouldKeepEscalatedResult(initialEvaluation, finalEvaluation, initialVerification, finalVerification) {
  if (!initialEvaluation || !finalEvaluation) return true;
  var initialHasFindings = !!(initialVerification && initialVerification.hasFindings);
  var finalHasFindings = !!(finalVerification && finalVerification.hasFindings);

  if (finalHasFindings && !initialHasFindings) return false;
  if (finalEvaluation.malformed && !initialEvaluation.malformed) return false;
  if (finalEvaluation.topicMismatch && !initialEvaluation.topicMismatch) return false;
  if (finalEvaluation.contradictionCount > initialEvaluation.contradictionCount + 1) return false;
  // G-STACK con voto real (2026-08-16): mismo trato que hasFindings arriba
  // -- si la ronda escalada TAMBIEN sale mal segun el revisor (o peor que
  // la inicial), no se sustituye una respuesta ya criticada por otra igual
  // o peor de mala solo por tener mas voces.
  if (finalEvaluation.gstackCritical && !initialEvaluation.gstackCritical) return false;

  if (!finalHasFindings && initialHasFindings) return true;
  if (initialEvaluation.gstackCritical && !finalEvaluation.gstackCritical) return true;
  // Bug real, encontrado probando el propio fix de arriba (2026-08-16): con
  // AMBAS rondas criticas segun G-STACK, ninguna de las dos guardias
  // anteriores dispara (ninguna es "la unica mala"), asi que la decision
  // caia en la heuristica de "mas voces, puntuacion parecida" (unas lineas
  // mas abajo) y se quedaba con la ronda escalada solo por tener 3 voces
  // en vez de 2 -- aunque su propia puntuacion de G-STACK fuera PEOR (20
  // vs 25 en la prueba real). Cuando las dos son criticas, se decide por
  // cual de las dos puntuo menos mal segun el propio revisor, antes de que
  // la heuristica de "mas voces" pueda anular ese criterio.
  if (initialEvaluation.gstackCritical && finalEvaluation.gstackCritical) {
    return (finalEvaluation.gstackScore || 0) > (initialEvaluation.gstackScore || 0);
  }
  if (finalEvaluation.contradictionCount < initialEvaluation.contradictionCount) return true;
  if ((finalEvaluation.consensusScore || 0) > (initialEvaluation.consensusScore || 0) + 0.08) return true;
  if (finalEvaluation.score >= initialEvaluation.score - 0.03 && finalEvaluation.actualVoices > initialEvaluation.actualVoices) return true;
  if (finalEvaluation.score + 0.06 < initialEvaluation.score) return false;

  return finalEvaluation.score >= initialEvaluation.score;
}

function summarizeImprovement(initialEvaluation, finalEvaluation, initialVerification, finalVerification, escalated, keptEscalated) {
  initialEvaluation = initialEvaluation || {};
  finalEvaluation = finalEvaluation || {};
  var initialScore = typeof initialEvaluation.score === 'number' ? initialEvaluation.score : 0;
  var finalScore = typeof finalEvaluation.score === 'number' ? finalEvaluation.score : 0;
  var initialConsensus = typeof initialEvaluation.consensusScore === 'number' ? initialEvaluation.consensusScore : null;
  var finalConsensus = typeof finalEvaluation.consensusScore === 'number' ? finalEvaluation.consensusScore : null;
  return {
    escalated: !!escalated,
    keptEscalatedResult: !!keptEscalated,
    confidenceGain: Math.round((finalScore - initialScore) * 1000) / 1000,
    consensusGain: initialConsensus === null || finalConsensus === null
      ? null
      : Math.round((finalConsensus - initialConsensus) * 1000) / 1000,
    contradictionsResolved: Math.max(0, (initialEvaluation.contradictionCount || 0) - (finalEvaluation.contradictionCount || 0)),
    verificationResolved: !!(initialVerification && initialVerification.hasFindings && !(finalVerification && finalVerification.hasFindings)),
    voicesAdded: Math.max(0, (finalEvaluation.actualVoices || 0) - (initialEvaluation.actualVoices || 0)),
    initialScore: initialScore,
    finalScore: finalScore,
  };
}

export function classifyIntermediationLoad(query, opts) {
  opts = opts || {};
  var text = String(query || '').trim();
  var lowered = text.toLowerCase();
  var taskType = detectTaskType(text) || 'general';
  var simple = isSimpleQuery(text);

  var code = hasSignal(lowered, /\b(codigo|code|funcion|función|script|api|debug|bug|error|regex|sql|typescript|javascript|python|node|react|test|css|html)\b/);
  var math = hasSignal(lowered, /\b(calcula|resuelve|ecuaci[oó]n|porcentaje|inter[eé]s|area|área|volumen|promedio|ratio|margen|finanzas|coste|costo)\b|\d\s*[%€$]|\d\s*[+\-*/=x]/);
  var compare = hasSignal(lowered, /\b(compara|comparaci[oó]n|diferencia|vs\b|versus|mejor|peor|pros y contras|trade-?off)\b/);
  var currentInfo = hasSignal(lowered, /\b(actual(es|idad)?|reciente(s)?|[uú]ltim[oa]s?|noticias?|mercado|fuentes?|tendencias?|precios?|hoy|2026|2027)\b/);
  var planning = hasSignal(lowered, /\b(estrategia|roadmap|arquitectura|plan|benchmark|eval[uú]a|analiza a fondo|audita)\b/);
  var shortFact = text.length > 0 && text.length <= 40 && !code && !math && !compare && !currentInfo && !planning;
  var longForm = text.length > 220;
  var veryLong = text.length > 520;

  var reasons = [];
  if (simple) reasons.push('consulta puntual');
  if (shortFact) reasons.push('hecho corto');
  if (code) reasons.push('codigo');
  if (math) reasons.push('calculo');
  if (compare) reasons.push('comparacion');
  if (currentInfo) reasons.push('informacion externa/actual');
  if (planning) reasons.push('decision estrategica');
  if (longForm) reasons.push('consulta larga');

  var riskLevel = 'low';
  if (code || math || compare || currentInfo || planning || veryLong) riskLevel = 'high';
  else if (!simple && (longForm || taskType !== 'general')) riskLevel = 'medium';

  var brokerCategory = 'general';
  if (code) brokerCategory = 'code';
  else if (math || compare || planning) brokerCategory = 'reasoning';
  else if (currentInfo || longForm) brokerCategory = 'text';

  var workloadType = 'general';
  if (code) workloadType = 'code';
  else if (math) workloadType = 'math';
  else if (compare) workloadType = 'comparison';
  else if (planning) workloadType = 'planning';
  else if (currentInfo) workloadType = 'research';
  else if (longForm) workloadType = 'analysis';
  else if (shortFact || simple) workloadType = 'fact';

  var initialVoices = (simple || shortFact) && riskLevel === 'low' ? 1 : 2;
  var maxVoices = riskLevel === 'high' ? 3 : (initialVoices > 1 ? 2 : 1);
  var gstackReview = riskLevel === 'high';
  var targetConfidence = riskLevel === 'high' ? 0.72 : (riskLevel === 'medium' ? 0.66 : 0.58);

  if (typeof opts.initialVoices === 'number' && opts.initialVoices > 0) initialVoices = opts.initialVoices;
  if (typeof opts.maxVoices === 'number' && opts.maxVoices >= initialVoices) maxVoices = opts.maxVoices;

  return {
    taskType: taskType,
    simple: simple,
    riskLevel: riskLevel,
    brokerCategory: brokerCategory,
    workloadType: workloadType,
    reasons: reasons,
    signals: {
      code: code,
      math: math,
      compare: compare,
      currentInfo: currentInfo,
      planning: planning,
      shortFact: shortFact,
      longForm: longForm,
    },
    initialVoices: initialVoices,
    maxVoices: maxVoices,
    gstackReview: gstackReview,
    targetConfidence: targetConfidence,
  };
}

// Umbral de veredicto critico de G-STACK. qualityScore es 0-100 (ver
// extractQualityScore, ensemble-v2.js). Por debajo de esto, el revisor
// (CEO/Eng Manager/Reviewer/QA Lead, segun el rol que le tocara) esta
// diciendo que el resultado tiene problemas reales, no solo mejorables --
// el mismo criterio que ya separa "hay sugerencias" (se anaden al texto,
// <80) de "esto esta mal de verdad" (fuerza reintento, <50).
var GSTACK_CRITICAL_SCORE = 50;

function evaluateResult(query, result, verification, profile) {
  var text = result && result.text ? result.text : '';
  var actualVoices = modelsFromResult(result).length;
  var consensusScore = getConsensusScore(result);
  var contradictionCount = getContradictionCount(result);
  var round2Revisions = getRound2Revisions(result);
  var topicMismatch = text ? looksLikeTopicMismatch(query, text) : false;
  var malformed = text ? (
    looksLikeContextLeak(text) ||
    looksLikeEcho(text) ||
    looksLikeRepetitiveGarbage(text) ||
    looksLikeRefusal(text)
  ) : true;
  var contentConfidence = text ? computeContentConfidence(text) : 0;

  // Bug real, confirmado en vivo (2026-08-16), pedido explicitamente por el
  // usuario: G-STACK revisaba de verdad (CEO/Eng Manager/Reviewer/QA Lead
  // opinando sobre el resultado, con su propio modelo, no una heuristica) y
  // su veredicto SI cambiaba el texto final (anadia "Mejoras sugeridas" si
  // qualityScore < 80, ver gstackReview en ensemble-v2.js) y alimentaba el
  // aprendizaje a largo plazo (recordGStackReview) -- pero nunca llegaba
  // hasta AQUI, la funcion que decide si intermediation-core debe escalar
  // a mas voces AHORA MISMO. Un veredicto de G-STACK genuinamente malo
  // (<50, no solo mejorable) solo conseguia una lista de sugerencias
  // pegada a una respuesta que seguia siendo, en el fondo, la misma
  // respuesta mala -- nunca forzaba un reintento real. Se le da peso real
  // en la puntuacion y, mas abajo en chooseEscalationReason(), poder de
  // forzar la escalada -- el mismo trato que ya tienen los hallazgos del
  // verificador determinista.
  var gstackReview = result && result.gstackReview;
  var gstackScore = gstackReview && typeof gstackReview.qualityScore === 'number' ? gstackReview.qualityScore : null;
  var gstackCritical = gstackScore !== null && gstackScore < GSTACK_CRITICAL_SCORE;

  var score = 0;
  score += contentConfidence * 0.45;
  score += (actualVoices >= 2 ? 0.18 : 0.08);
  score += (consensusScore === null ? (actualVoices >= 2 ? 0.10 : 0.05) : clamp01(consensusScore) * 0.20);
  score += (verification && verification.hasFindings ? 0.02 : 0.12);
  score += contradictionCount > 0 ? 0 : 0.05;
  score += round2Revisions > 0 ? 0.03 : 0;

  if (topicMismatch) score -= 0.35;
  if (malformed) score -= 0.30;
  if (result && result.provider === 'ensemble-single' && profile.initialVoices > 1) score -= 0.15;
  if (contradictionCount > 0) score -= Math.min(0.20, contradictionCount * 0.08);
  if (gstackCritical) score -= 0.25;

  score = clamp01(score);

  return {
    actualVoices: actualVoices,
    consensusScore: consensusScore,
    contradictionCount: contradictionCount,
    round2Revisions: round2Revisions,
    topicMismatch: topicMismatch,
    malformed: malformed,
    verificationFindings: !!(verification && verification.hasFindings),
    contentConfidence: contentConfidence,
    degradedToSingle: !!(result && result.provider === 'ensemble-single' && profile.initialVoices > 1),
    gstackScore: gstackScore,
    gstackCritical: gstackCritical,
    score: score,
    band: score >= 0.78 ? 'high' : (score >= 0.58 ? 'medium' : 'low'),
  };
}

function chooseEscalationReason(profile, evaluation, result) {
  if (!result || !result.ok || !result.text) return 'initial_failure';
  if (evaluation.topicMismatch) return 'topic_mismatch';
  if (evaluation.malformed) return 'malformed_output';
  if (evaluation.verificationFindings) return 'verification_findings';
  // G-STACK con voto real (2026-08-16): si el revisor (CEO/Eng Manager/
  // Reviewer/QA Lead) dio un veredicto critico (<50/100), eso pesa igual
  // que un hallazgo del verificador determinista -- fuerza reintento con
  // mas voces en vez de quedarse con una lista de sugerencias pegada a
  // una respuesta que el propio revisor considero mala.
  if (evaluation.gstackCritical) return 'gstack_critical_review';
  if (evaluation.degradedToSingle) return 'degraded_to_single_voice';
  if (evaluation.contradictionCount > 0) return 'contradictions_detected';
  if (evaluation.consensusScore !== null && evaluation.consensusScore < 0.58 && profile.maxVoices > evaluation.actualVoices) {
    return 'low_consensus';
  }
  if (profile.riskLevel === 'low' && evaluation.actualVoices === 1) return null;
  // Bug real, medido en vivo (2026-08-16): con todas las señales REALES ya
  // limpias en este punto (sin hallazgos del verificador determinista, sin
  // fuga de tema, sin formato roto, sin contradicciones, con colaboración
  // real de 2+ voces), la unica razon que quedaba para escalar era
  // `score < targetConfidence` -- un umbral interno (0.72 para riesgo alto)
  // que no mide nada que el verificador o el resto de senales ya no hayan
  // comprobado, solo una heuristica de confianza de texto. Medido en el
  // benchmark de calidad: una comparacion REST-vs-GraphQL ya perfecta (sin
  // hallazgos, 2 voces, sin fuga) escalaba igual a 3 voces + G-STACK,
  // gastando 225s (10x mas que una sola IA) para terminar con la MISMA
  // puntuacion de calidad -- tiempo tirado sin ninguna mejora medible. Si
  // ya hay colaboracion real (2+ voces) y todas las senales de verdad
  // (verificacion, tema, formato, contradicciones) estan limpias, no se
  // persigue el umbral de confianza en solitario -- el verificador
  // determinista, no una heuristica de texto, es quien decide si hace
  // falta mas trabajo.
  if (evaluation.actualVoices >= 2) return null;
  if (evaluation.score < profile.targetConfidence) return 'low_confidence';
  return null;
}

export function shouldEscalateIntermediation(profile, evaluation, result) {
  if (!profile || profile.maxVoices <= profile.initialVoices) return { escalate: false, reason: null };
  var reason = chooseEscalationReason(profile, evaluation, result);
  return { escalate: !!reason, reason: reason };
}

function buildLabel(profile, finalResult, evaluation, meta) {
  var models = modelsFromResult(finalResult);
  var confidencePct = Math.round(evaluation.score * 100);
  var parts = [];
  var mediationUsed = !!(finalResult && finalResult.ensemble && finalResult.ensemble.mediation && finalResult.ensemble.mediation.used);

  if (meta.escalated) {
    if (evaluation.actualVoices >= 2) {
      parts.push('Intermediación Core: escalado a ' + evaluation.actualVoices + ' voces' + (mediationUsed ? ' con mediación final' : ''));
    } else {
      parts.push('Intermediación Core degradada: solo 1 voz válida tras la mediación');
    }
  } else if (evaluation.actualVoices >= 2) {
    parts.push('Intermediación Core: ' + evaluation.actualVoices + ' voces coordinadas' + (mediationUsed ? ' y mediadas' : ''));
  } else {
    parts.push('Intermediación Core: 1 voz seleccionada por brokerage');
  }

  if (models.length) parts.push(models.join(', '));
  if (meta.escalationReason) parts.push('motivo de escalado: ' + meta.escalationReason.replace(/_/g, ' '));
  if (!evaluation.verificationFindings) parts.push('verificación determinista sin hallazgos');
  if (evaluation.consensusScore !== null) parts.push('consenso ' + Math.round(evaluation.consensusScore * 100) + '%');
  if (evaluation.contradictionCount > 0) parts.push('contradicciones detectadas: ' + evaluation.contradictionCount);
  parts.push('confianza ' + confidencePct + '%');
  return parts.join(' | ');
}

export async function runIntermediationCore(query, opts, deps) {
  opts = opts || {};
  deps = deps || {};
  if (typeof deps.runEnsemble !== 'function') throw new Error('runIntermediationCore requiere deps.runEnsemble');
  if (typeof deps.verify !== 'function') throw new Error('runIntermediationCore requiere deps.verify');

  var profile = classifyIntermediationLoad(query, opts);
  var startedAt = Date.now();
  var learningContext = buildLearningContext(profile);
  var common = {
    category: opts.category || profile.brokerCategory || null,
    systemPrompt: opts.systemPrompt || 'Responde en español de forma clara y útil.',
    maxTokens: opts.maxTokens || 1500,
    temperature: opts.temperature || 0.2,
    preferredModelIds: opts.preferredModelIds || [],
    deadlineTs: opts.deadlineTs || null,
    learningContext: learningContext,
  };

  if (deps.recordEvent) {
    try { deps.recordEvent('intermediationCoreStart'); } catch (e) {}
  }

  var initialResult = await deps.runEnsemble(query, {
    size: profile.initialVoices,
    category: common.category,
    systemPrompt: common.systemPrompt,
    maxTokens: common.maxTokens,
    temperature: common.temperature,
    gstackReview: false,
    mediatedSynthesis: profile.initialVoices > 1,
    adaptiveEscalation: profile.initialVoices > 1,
    preferredModelIds: common.preferredModelIds,
    deadlineTs: common.deadlineTs,
    learningContext: common.learningContext,
  }, deps.aiCaller);

  var initialVerification = null;
  if (initialResult && initialResult.ok && initialResult.text) {
    initialVerification = await deps.verify(initialResult.text, query);
    initialResult.text = initialVerification.text;
  }
  var initialEvaluation = evaluateResult(query, initialResult, initialVerification, profile);
  var escalation = shouldEscalateIntermediation(profile, initialEvaluation, initialResult);

  var finalResult = initialResult;
  var finalVerification = initialVerification;
  var finalEvaluation = initialEvaluation;
  var escalated = false;
  var usedModelIds = modelsFromResult(initialResult);

  if (escalation.escalate) {
    escalated = true;
    if (deps.recordEvent) {
      try { deps.recordEvent('intermediationCoreEscalated'); } catch (e) {}
    }
    var collaboratorLookup = typeof deps.getPreferredCollaborators === 'function'
      ? deps.getPreferredCollaborators
      : getLearnedPreferredCollaborators;
    var learnedPreferredIds = collaboratorLookup(usedModelIds, common.category || profile.brokerCategory || 'general', Math.max(0, profile.maxVoices - usedModelIds.length), common.learningContext);
    finalResult = await deps.runEnsemble(query, {
      size: profile.maxVoices,
      category: common.category,
      systemPrompt: common.systemPrompt,
      maxTokens: common.maxTokens,
      temperature: common.temperature,
      gstackReview: profile.gstackReview,
      mediatedSynthesis: true,
      adaptiveEscalation: true,
      preferredModelIds: mergePreferredModelIds(common.preferredModelIds, learnedPreferredIds),
      excludeModelIds: usedModelIds,
      deadlineTs: common.deadlineTs,
      learningContext: common.learningContext,
    }, deps.aiCaller);
    if (finalResult && finalResult.ok && finalResult.text) {
      finalVerification = await deps.verify(finalResult.text, query);
      finalResult.text = finalVerification.text;
    } else {
      finalVerification = null;
    }
    finalEvaluation = evaluateResult(query, finalResult, finalVerification, profile);
  }

  if (escalated && initialResult && initialResult.ok && initialResult.text && finalResult && finalResult.ok && finalResult.text) {
    var keepEscalated = shouldKeepEscalatedResult(initialEvaluation, finalEvaluation, initialVerification, finalVerification);
    if (!keepEscalated) {
      finalResult = initialResult;
      finalVerification = initialVerification;
      finalEvaluation = initialEvaluation;
    }
  }

  if (!finalResult || !finalResult.ok || !finalResult.text) {
    return {
      ok: false,
      error: finalResult && finalResult.error ? finalResult.error : 'intermediation_failed',
      latencyMs: Date.now() - startedAt,
      intermediation: {
        profile: profile,
        path: escalated ? 'escalated' : 'initial',
        escalationReason: escalation.reason,
      },
    };
  }

  var improvement = summarizeImprovement(initialEvaluation, finalEvaluation, initialVerification, finalVerification, escalated, !escalated || finalResult !== initialResult);

  var label = buildLabel(profile, finalResult, finalEvaluation, {
    escalated: escalated,
    escalationReason: escalation.reason,
  });

  return Object.assign({}, finalResult, {
    latencyMs: Date.now() - startedAt,
    intermediation: {
      profile: profile,
      path: escalated ? 'escalated' : 'initial',
      escalated: escalated,
      escalationReason: escalation.reason,
      verification: {
        hasFindings: !!(finalVerification && finalVerification.hasFindings),
        stage: escalated ? 'escalated' : 'initial',
      },
      collaboration: {
        targetInitialVoices: profile.initialVoices,
        targetMaxVoices: profile.maxVoices,
        actualVoices: finalEvaluation.actualVoices,
        revisedVoices: finalEvaluation.round2Revisions,
        degradedToSingle: finalEvaluation.degradedToSingle,
      },
      confidence: {
        score: finalEvaluation.score,
        band: finalEvaluation.band,
        consensusScore: finalEvaluation.consensusScore,
        contradictionCount: finalEvaluation.contradictionCount,
        contentConfidence: finalEvaluation.contentConfidence,
      },
      improvement: improvement,
      learningContext: common.learningContext,
      label: label,
    },
  });
}
