function clamp01(value) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function unique(values) {
  var seen = {};
  return (values || []).filter(function (value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function modelsFrom(result) {
  if (result && result.ensemble && Array.isArray(result.ensemble.models)) {
    return unique(result.ensemble.models);
  }
  return result && result.model ? [result.model] : [];
}

function buildGuidance(intermediation) {
  var confidence = intermediation.confidence || {};
  var verification = intermediation.verification || {};
  var collaboration = intermediation.collaboration || {};
  var reasons = [];

  if (verification.hasFindings) reasons.push('verification_findings');
  if ((confidence.contradictionCount || 0) > 0) reasons.push('unresolved_contradictions');
  if (confidence.band === 'low') reasons.push('low_confidence');
  if (collaboration.degradedToSingle) reasons.push('degraded_to_single_voice');

  return {
    mode: reasons.length ? 'review_before_use' : 'ready_for_primary_ai',
    reasons: reasons,
    instruction: reasons.length
      ? 'Usa la salida como material procesado, pero revisa las señales de cautela antes de incorporarla a tu respuesta.'
      : 'Puedes usar la salida procesada como base; conserva tu propio juicio y contexto de conversación.',
  };
}

export function buildProcessorPacket(query, result) {
  result = result || {};
  var intermediation = result.intermediation || {};
  var profile = intermediation.profile || {};
  var confidence = intermediation.confidence || {};
  var verification = intermediation.verification || {};
  var collaboration = intermediation.collaboration || {};
  var improvement = intermediation.improvement || {};
  var mediation = result.ensemble && result.ensemble.mediation ? result.ensemble.mediation : {};
  var voices = result.ensemble && Array.isArray(result.ensemble.round2)
    ? result.ensemble.round2.map(function (voice) {
      return {
        model: voice.model,
        revised: !!voice.revised,
        text: voice.text || '',
      };
    })
    : [];

  return {
    protocol: 'linkcore.processor.packet',
    version: '1.0',
    input: {
      query: String(query || ''),
      workloadType: profile.workloadType || 'general',
      brokerCategory: profile.brokerCategory || 'general',
      riskLevel: profile.riskLevel || 'unknown',
    },
    output: {
      text: result.text || result.response || '',
      guidance: buildGuidance(intermediation),
    },
    reliability: {
      confidenceScore: clamp01(confidence.score),
      confidenceBand: confidence.band || 'unknown',
      contentConfidence: clamp01(confidence.contentConfidence),
      consensusScore: clamp01(confidence.consensusScore),
      contradictionCount: confidence.contradictionCount || 0,
      verificationFindings: !!verification.hasFindings,
      verificationResolved: !!improvement.verificationResolved,
    },
    processing: {
      path: intermediation.path || 'unknown',
      escalated: !!intermediation.escalated,
      escalationReason: intermediation.escalationReason || null,
      models: modelsFrom(result),
      actualVoices: collaboration.actualVoices || modelsFrom(result).length,
      revisedVoices: collaboration.revisedVoices || 0,
      degradedToSingle: !!collaboration.degradedToSingle,
      mediationUsed: !!mediation.used,
    },
    improvement: {
      confidenceGain: typeof improvement.confidenceGain === 'number' ? improvement.confidenceGain : null,
      consensusGain: typeof improvement.consensusGain === 'number' ? improvement.consensusGain : null,
      contradictionsResolved: improvement.contradictionsResolved || 0,
      voicesAdded: improvement.voicesAdded || 0,
      keptEscalatedResult: typeof improvement.keptEscalatedResult === 'boolean' ? improvement.keptEscalatedResult : null,
    },
    voices: voices,
  };
}
