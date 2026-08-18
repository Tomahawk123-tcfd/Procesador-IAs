// ═══════════════════════════════════════════════════════════════
// LINKCORE SEMANTIC TRANSLATOR
// The core IP: translates between AI thinking styles so
// ensemble learning actually works. Not format normalization —
// semantic context preservation across model boundaries.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════
// THINKING STYLE DETECTION
// ═══════════════════════════════════════════

var THINKING_STYLES = {
  CHAIN_OF_THOUGHT: 'chain-of-thought',
  STRUCTURED: 'structured',
  DIRECT: 'direct',
  ANALYTICAL: 'analytical',
  CREATIVE: 'creative',
  BALANCED: 'balanced',
};

var CHAIN_MARKERS = /\b(por lo tanto|esto implica|siguiendo que|dado que|como[^.:;!?\n]{0,40}entonces|por ende|en consecuencia|lo que lleva a|esto sugiere|se puede concluir|reasoning|therefore|thus|consequently|it follows|this implies)\b/i;
var HEDGING_MARKERS = /\b(podria|posiblemente|tal vez|parece|quizas|no estoy seguro|podria ser|es posible|podria decir|could|might|perhaps|it seems|possibly|uncertain|not sure)\b/i;
var STRUCTURE_MARKERS = /^#{1,3}\s|^\d+[\.\)]\s|^\*\s|^- \[|^- \*|^\|.*\|/m;
// Sin flag 'g': el unico uso (linea ~76) es DATA_MARKERS.test(s) para un
// booleano. Con 'g', .test() muta .lastIndex tras un match, y como este
// regex vive a nivel de modulo (reutilizado en cada llamada a
// detectThinkingStyle() sobre un string DISTINTO cada vez), un match a
// mitad de una respuesta dejaba lastIndex > 0; la siguiente llamada
// empezaba a escanear desde ese offset en un string nuevo, saltandose un
// match real cerca del inicio (o fallando del todo si lastIndex superaba
// la longitud del nuevo string). Bug real: puntuar varias respuestas de
// modelos seguidas en el mismo proceso, algunas fallaban en detectar
// datos de moneda/porcentaje que si contenian, dependiendo de donde
// hubiera terminado el match de la respuesta anterior. Sin 'g', .test()
// siempre revisa desde el principio y no guarda estado.
var DATA_MARKERS = /\$[\d,]+\.?\d*|\d+\.?\d*\s*%|\d+\.\d+\s*(x|veces|times|million|billion|M\b|B\b|K\b)|\d{1,3}(,\d{3})+(\.\d+)?/;
var EMOTION_MARKERS = /\b(excelente|increible|fantastico|terrible|evitar|ama|odio|perfecto|genial|brutal|padrisimo)\b/i;
var CODE_MARKERS = /\b(function|const |let |var |import |class |def |return |if\s*\(|for\s*\(|while\s*\(|try\s*\{|catch\s*\(|async |await )\b/;
var NUMERIC_EVIDENCE = /\b\d+\.?\d*\s*(%|por ciento|x|veces|millones?|billones?|USD|\$|EUR)\b/i;

// Divide en frases SIN romper numeros decimales ni versiones. La version
// ingenua, split(/[.!?\n]+/), partia "2.3x mas rapida" en "2" y "3x mas
// rapida": el dato numerico llegaba corrupto al siguiente modelo y este
// razonaba sobre una cifra que nadie dijo. Bug real, encontrado en la
// primera prueba del traductor sobre una respuesta con benchmarks.
// Aqui solo se corta en un signo de puntuacion seguido de espacio o fin,
// de modo que el punto interior de "2.3" o "v1.2.3" nunca separa.
function splitSentences(text) {
  if (!text) return [];
  return String(text)
    .split(/[.!?]+(?=\s|$)|\n+/)
    .filter(function (s) { return s && s.trim().length > 0; });
}

// Limpia conectores que las regex de decision arrastran al capturar
// ("la recomendacion ES: usar X" -> detail empezaba por "es:").
function cleanDecisionDetail(s) {
  return String(s || '')
    .replace(/^\s*(es|son|is|are|fue|was|seria|would be)\b\s*[:\-,]?\s*/i, '')
    .replace(/^\s*[:\-,]\s*/, '')
    .trim();
}

function detectThinkingStyle(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return THINKING_STYLES.BALANCED;

  var s = rawOutput;
  var scores = {
    chainOfThought: 0,
    structured: 0,
    direct: 0,
    analytical: 0,
    creative: 0,
  };

  if (CHAIN_MARKERS.test(s)) scores.chainOfThought += 2;
  if (s.split(/\n\n+/).length > 4) scores.chainOfThought += 1;
  if (s.length > 800) scores.chainOfThought += 1;

  if (STRUCTURE_MARKERS.test(s)) scores.structured += 2;
  var lines = s.split('\n');
  var structuredLines = lines.filter(function(l) { return /^(\d+[\.\)]\s|-\s|\*\s|#)/.test(l); }).length;
  if (structuredLines > 3) scores.structured += 1;
  if (s.indexOf('|') !== -1 && s.indexOf('---') !== -1) scores.structured += 1;

  if (HEDGING_MARKERS.test(s)) scores.analytical += 2;
  if (NUMERIC_EVIDENCE.test(s)) scores.analytical += 1;
  if (DATA_MARKERS.test(s)) scores.analytical += 1;

  if (EMOTION_MARKERS.test(s)) scores.creative += 2;
  if (s.indexOf('!') !== -1) scores.creative += 1;
  var sentenceParts = splitSentences(s);
  if (sentenceParts.length < 8 && s.length < 400) scores.direct += 2;

  var avgSentenceLen = sentenceParts.reduce(function(a, x) { return a + x.length; }, 0) / Math.max(sentenceParts.length, 1);
  if (avgSentenceLen < 30) scores.direct += 1;
  if (avgSentenceLen > 60) scores.chainOfThought += 1;

  if (CODE_MARKERS.test(s)) scores.structured += 1;

  var best = THINKING_STYLES.BALANCED;
  var bestScore = 0;
  Object.keys(scores).forEach(function(key) {
    if (scores[key] > bestScore) {
      bestScore = scores[key];
      switch (key) {
        case 'chainOfThought': best = THINKING_STYLES.CHAIN_OF_THOUGHT; break;
        case 'structured': best = THINKING_STYLES.STRUCTURED; break;
        case 'direct': best = THINKING_STYLES.DIRECT; break;
        case 'analytical': best = THINKING_STYLES.ANALYTICAL; break;
        case 'creative': best = THINKING_STYLES.CREATIVE; break;
      }
    }
  });

  return best;
}

// ═══════════════════════════════════════════
// DECISION & REASONING EXTRACTION
// ═══════════════════════════════════════════

var DECISION_PATTERNS = [
  /\b(decision|conclusion|recomendacion|recomiendo|propongo|la mejor opcion|la opcion|should|recommend|propose|the best option|decision is)\b[:\s]*([^\n.]+)/i,
  /\b(por lo tanto|therefore|thus|consequently|en consecuencia)[,\s]+([^\n.]+)/i,
  /\b(el resultado|the result|la conclusion|the conclusion)[\s]*(es|:)\s*([^\n.]+)/i,
];

var UNCERTAINTY_MARKERS = [
  { pattern: /\b(no estoy seguro|not sure|incertain|incertidumbre)\b/i, weight: 0.3 },
  { pattern: /\b(puede que|it could be|podria ser|might be)\b/i, weight: 0.2 },
  { pattern: /\b(estimacion|estimate|aproximado|approximate)\b/i, weight: 0.15 },
  { pattern: /\b(basado en|based on|segun|according to)\b/i, weight: -0.1 },
  { pattern: /\b(definitivamente|definitely|claramente|clearly|seguro|certain)\b/i, weight: -0.2 },
];

function extractDecisions(rawOutput) {
  if (!rawOutput) return [];
  var decisions = [];

  DECISION_PATTERNS.forEach(function(p) {
    var match = rawOutput.match(p);
    if (match) {
      var detail = cleanDecisionDetail(match[2] || match[3] || '');
      if (!detail) return;
      decisions.push({
        text: (match[1] || match[0]).trim(),
        detail: detail.slice(0, 300),
        confidence: 0.7,
      });
    }
  });

  var sentences = splitSentences(rawOutput).filter(function(s) { return s.trim().length > 15; });
  sentences.forEach(function(s) {
    var sl = s.toLowerCase();
    if (/\b(es|are|will|should|must|need to|have to|la mejor|the best|recomend|suggest)\b/.test(sl) && s.length < 200) {
      var exists = decisions.some(function(d) { return d.detail.indexOf(s.trim().slice(0, 40)) !== -1; });
      if (!exists) {
        decisions.push({ text: 'derived', detail: s.trim().slice(0, 300), confidence: 0.5 });
      }
    }
  });

  return decisions.slice(0, 5);
}

function extractReasoningChain(rawOutput) {
  if (!rawOutput) return [];
  var chain = [];

  var reasoningMarkers = /(?:porque|because|ya que|since|dado que|given that|esto se debe a|this is because|la razon|the reason|evidently|evidencia|evidence|data|datos|estudio|study|reporte|report|benchmark)/gi;
  var sentences = splitSentences(rawOutput).filter(function(s) { return s.trim().length > 20; });

  sentences.forEach(function(s) {
    if (reasoningMarkers.test(s)) {
      chain.push({
        claim: s.trim().slice(0, 200),
        type: 'evidence',
        strength: 0.7,
      });
      reasoningMarkers.lastIndex = 0;
    }
  });

  var conclusionMarkers = /(?:por lo tanto|therefore|thus|en conclusion|in conclusion|en resumen|in summary|finalmente|finally|lo que implica|which implies|esto demuestra|this proves)/gi;
  sentences.forEach(function(s) {
    if (conclusionMarkers.test(s)) {
      chain.push({
        claim: s.trim().slice(0, 200),
        type: 'conclusion',
        strength: 0.8,
      });
      conclusionMarkers.lastIndex = 0;
    }
  });

  if (chain.length === 0 && sentences.length > 0) {
    chain.push({
      claim: sentences[0].trim().slice(0, 200),
      type: 'statement',
      strength: 0.5,
    });
  }

  return chain.slice(0, 8);
}

function extractDataPoints(rawOutput) {
  if (!rawOutput) return [];
  var points = [];

  var patterns = [
    { regex: /\$[\d,]+\.?\d*/g, type: 'currency' },
    { regex: /\d+\.?\d*\s*%/g, type: 'percentage' },
    { regex: /\d+\.\d+\s*x/gi, type: 'multiplier' },
    { regex: /\d{1,3}(,\d{3})+(\.\d+)?/g, type: 'number' },
  ];

  patterns.forEach(function(p) {
    var match;
    while ((match = p.regex.exec(rawOutput)) !== null) {
      var contextStart = Math.max(0, match.index - 60);
      var contextEnd = Math.min(rawOutput.length, match.index + match[0].length + 60);
      var context = rawOutput.slice(contextStart, contextEnd).replace(/\n/g, ' ').trim();

      points.push({
        value: match[0],
        type: p.type,
        context: context,
        transferable: true,
      });
    }
  });

  return points.slice(0, 10);
}

function extractKeyClaims(rawOutput) {
  if (!rawOutput) return [];
  var claims = [];
  var sentences = splitSentences(rawOutput).filter(function(s) { return s.trim().length > 20 && s.trim().length < 300; });

  sentences.forEach(function(s) {
    var sl = s.toLowerCase();
    var importance = 0;
    if (/\b(es|are|will|should|must)\b/.test(sl)) importance += 1;
    if (/\b(importante|critical|key|main|primary|essential|fundamental)\b/.test(sl)) importance += 2;
    if (/\b(dato|data|evidencia|evidence|estudio|study|numero|number)\b/.test(sl)) importance += 1;
    if (importance > 0) {
      claims.push({ text: s.trim(), importance: importance });
    }
  });

  claims.sort(function(a, b) { return b.importance - a.importance; });
  return claims.slice(0, 5);
}

// ═══════════════════════════════════════════
// CONFIDENCE ASSESSMENT
// ═══════════════════════════════════════════

function assessConfidence(rawOutput, sourceModel) {
  if (!rawOutput) return 0;

  var confidence = 0.6;

  var uncertaintyScore = 0;
  UNCERTAINTY_MARKERS.forEach(function(m) {
    if (m.pattern.test(rawOutput)) uncertaintyScore += m.weight;
  });
  confidence -= uncertaintyScore * 0.3;

  var dataPoints = extractDataPoints(rawOutput);
  if (dataPoints.length > 2) confidence += 0.1;
  if (dataPoints.length > 5) confidence += 0.05;

  var reasoning = extractReasoningChain(rawOutput);
  if (reasoning.length > 2) confidence += 0.1;

  if (rawOutput.length > 500) confidence += 0.05;
  if (rawOutput.length < 100) confidence -= 0.1;

  if (sourceModel) {
    if (sourceModel.elo > 1350) confidence += 0.05;
    if (sourceModel.elo > 1380) confidence += 0.05;
    if (sourceModel.elo < 1250) confidence -= 0.1;
  }

  return Math.min(Math.max(confidence, 0.1), 0.99);
}

// ═══════════════════════════════════════════
// CONTEXT PACKET BUILDER
// ═══════════════════════════════════════════

function buildContextPacket(rawOutput, sourceModel, targetRole) {
  if (!rawOutput) return null;

  var style = detectThinkingStyle(rawOutput);
  var decisions = extractDecisions(rawOutput);
  var reasoning = extractReasoningChain(rawOutput);
  var dataPoints = extractDataPoints(rawOutput);
  var keyClaims = extractKeyClaims(rawOutput);
  var confidence = assessConfidence(rawOutput, sourceModel);

  var packet = {
    decision: decisions.length > 0 ? decisions[0].detail || decisions[0].text : '',
    decisions: decisions,
    reasoning: reasoning,
    dataPoints: dataPoints,
    keyClaims: keyClaims,
    confidence: confidence,
    sourceStyle: style,
    sourceModel: sourceModel ? sourceModel.name : 'unknown',
    sourceModelId: sourceModel ? sourceModel.id : null,
    handoffTo: targetRole || 'unknown',
    rawLength: rawOutput.length,
    timestamp: Date.now(),
  };

  packet.relevantForTarget = filterRelevance(packet, targetRole);
  packet.omitFromTarget = identifyOmissions(packet, targetRole);

  return packet;
}

function filterRelevance(packet, targetRole) {
  var relevance = {};

  switch (targetRole) {
    case 'coder':
      relevance.dataPoints = packet.dataPoints.filter(function(d) { return d.type === 'number' || d.type === 'multiplier'; });
      relevance.decisions = packet.decisions;
      relevance.keyClaims = packet.keyClaims.filter(function(c) { return /\b(api|endpoint|estructura|schema|formato|variable|funcion|component|data|input|output)\b/i.test(c.text); });
      break;
    case 'designer':
      relevance.decisions = packet.decisions;
      relevance.keyClaims = packet.keyClaims.filter(function(c) { return /\b(visual|diseno|color|layout|estilo|brand|usuario|user|experiencia|ux|ui)\b/i.test(c.text); });
      break;
    case 'analyst':
      relevance.dataPoints = packet.dataPoints;
      relevance.reasoning = packet.reasoning;
      relevance.keyClaims = packet.keyClaims;
      break;
    case 'writer':
      relevance.decisions = packet.decisions;
      relevance.keyClaims = packet.keyClaims;
      relevance.reasoning = packet.reasoning;
      break;
    case 'planner':
      relevance.decisions = packet.decisions;
      relevance.reasoning = packet.reasoning;
      relevance.keyClaims = packet.keyClaims;
      break;
    default:
      relevance.decisions = packet.decisions;
      relevance.keyClaims = packet.keyClaims;
      relevance.dataPoints = packet.dataPoints;
  }

  return relevance;
}

function identifyOmissions(packet, targetRole) {
  var omissions = [];

  switch (targetRole) {
    case 'coder':
      omissions.push('market analysis details', 'emotional assessment', 'brand guidelines');
      break;
    case 'designer':
      omissions.push('financial projections', 'technical architecture details', 'API specifications');
      break;
    case 'analyst':
      omissions.push('visual design decisions', 'code implementation details');
      break;
    case 'writer':
      omissions.push('raw data tables', 'code snippets', 'technical specifications');
      break;
  }

  return omissions;
}

// ═══════════════════════════════════════════
// CHAIN TRANSLATOR
// ═══════════════════════════════════════════

function translateForModel(contextPacket, targetProfile) {
  if (!contextPacket) return '';
  if (!targetProfile) return buildGenericTranslation(contextPacket);

  var style = targetProfile.thinkingStyle || 'balanced';
  var output = '';

  switch (style) {
    case THINKING_STYLES.CHAIN_OF_THOUGHT:
      output = buildChainOfThoughtInput(contextPacket);
      break;
    case THINKING_STYLES.STRUCTURED:
      output = buildStructuredInput(contextPacket);
      break;
    case THINKING_STYLES.DIRECT:
      output = buildDirectInput(contextPacket);
      break;
    case THINKING_STYLES.ANALYTICAL:
      output = buildAnalyticalInput(contextPacket);
      break;
    case THINKING_STYLES.CREATIVE:
      output = buildCreativeInput(contextPacket);
      break;
    default:
      output = buildGenericTranslation(contextPacket);
  }

  if (targetProfile.promptStyle === 'cautious' && contextPacket.confidence < 0.7) {
    output += '\n\nNota: La confianza en este analisis previo es ' + Math.round(contextPacket.confidence * 100) + '%. Verificar datos criticos antes de actuar.';
  }

  if (targetProfile.maxContextLength && output.length > targetProfile.maxContextLength) {
    output = compressTranslation(contextPacket, targetProfile);
  }

  return output;
}

function buildChainOfThoughtInput(packet) {
  var lines = [];

  if (packet.decision) {
    lines.push('DECISION TOMADA: ' + packet.decision);
    lines.push('');
  }

  if (packet.reasoning.length > 0) {
    lines.push('CADENA DE RAZONAMIENTO PREVIA:');
    packet.reasoning.forEach(function(r, i) {
      lines.push((i + 1) + '. ' + r.claim);
    });
    lines.push('');
  }

  if (packet.dataPoints.length > 0) {
    lines.push('DATOS CLAVE TRANSFERIBLES:');
    packet.dataPoints.forEach(function(d) {
      lines.push('- ' + d.value + ' (' + d.context.slice(0, 80) + ')');
    });
    lines.push('');
  }

  if (packet.keyClaims.length > 0) {
    lines.push('AFIRMACIONES PRINCIPALES:');
    packet.keyClaims.forEach(function(c) {
      lines.push('- ' + c.text);
    });
    lines.push('');
  }

  lines.push('Confianza del analisis previo: ' + Math.round(packet.confidence * 100) + '%');
  lines.push('Fuente: ' + packet.sourceModel);

  return lines.join('\n');
}

function buildStructuredInput(packet) {
  var lines = [];

  lines.push('## Contexto del analisis previo');
  lines.push('');

  if (packet.decision) {
    lines.push('### Decision');
    lines.push(packet.decision);
    lines.push('');
  }

  if (packet.reasoning.length > 0) {
    lines.push('### Evidencia');
    packet.reasoning.forEach(function(r) {
      lines.push('- **' + r.type + '**: ' + r.claim);
    });
    lines.push('');
  }

  if (packet.dataPoints.length > 0) {
    lines.push('### Datos');
    packet.dataPoints.forEach(function(d) {
      lines.push('- ' + d.value + ' (' + d.context.slice(0, 60) + ')');
    });
    lines.push('');
  }

  if (packet.keyClaims.length > 0) {
    lines.push('### Puntos clave');
    packet.keyClaims.forEach(function(c) {
      lines.push('- ' + c.text);
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('*Confianza: ' + Math.round(packet.confidence * 100) + '% | Fuente: ' + packet.sourceModel + '*');

  return lines.join('\n');
}

function buildDirectInput(packet) {
  var lines = [];

  if (packet.decision) {
    lines.push('Decision: ' + packet.decision);
  }

  if (packet.dataPoints.length > 0) {
    lines.push('Datos: ' + packet.dataPoints.map(function(d) { return d.value; }).join(', '));
  }

  if (packet.keyClaims.length > 0) {
    lines.push('Puntos clave:');
    packet.keyClaims.slice(0, 3).forEach(function(c) {
      lines.push('- ' + c.text.slice(0, 120));
    });
  }

  lines.push('Confianza: ' + Math.round(packet.confidence * 100) + '% | Fuente: ' + packet.sourceModel);

  return lines.join('\n');
}

function buildAnalyticalInput(packet) {
  var lines = [];

  lines.push('ANALISIS PREVIO (confianza: ' + Math.round(packet.confidence * 100) + '%):');
  lines.push('');

  if (packet.decision) {
    lines.push('Conclusion: ' + packet.decision);
    lines.push('');
  }

  if (packet.reasoning.length > 0) {
    lines.push('Fundamento:');
    packet.reasoning.forEach(function(r) {
      lines.push('  - [' + r.type + '] ' + r.claim);
    });
    lines.push('');
  }

  if (packet.dataPoints.length > 0) {
    lines.push('Metricas:');
    packet.dataPoints.forEach(function(d) {
      lines.push('  - ' + d.value + ': ' + d.context.slice(0, 80));
    });
    lines.push('');
  }

  lines.push('Fuente: ' + packet.sourceModel);
  lines.push('');
  lines.push('Solicitamos: validar, refutar o extender este analisis con evidencia adicional.');

  return lines.join('\n');
}

function buildCreativeInput(packet) {
  var lines = [];

  lines.push('El equipo previo llego a estas conclusiones:');
  lines.push('');

  if (packet.decision) {
    lines.push('>> ' + packet.decision);
    lines.push('');
  }

  if (packet.keyClaims.length > 0) {
    lines.push('Ideas clave:');
    packet.keyClaims.forEach(function(c) {
      lines.push('  * ' + c.text);
    });
    lines.push('');
  }

  if (packet.dataPoints.length > 0) {
    lines.push('Datos relevantes: ' + packet.dataPoints.map(function(d) { return d.value; }).join(', '));
    lines.push('');
  }

  lines.push('Esto abre oportunidades para: ');

  return lines.join('\n');
}

function buildGenericTranslation(packet) {
  var lines = [];

  if (packet.decision) {
    lines.push('Decision: ' + packet.decision);
    lines.push('');
  }

  if (packet.reasoning.length > 0) {
    lines.push('Razonamiento:');
    packet.reasoning.forEach(function(r) {
      lines.push('- ' + r.claim);
    });
    lines.push('');
  }

  if (packet.dataPoints.length > 0) {
    lines.push('Datos: ' + packet.dataPoints.map(function(d) { return d.value; }).join(', '));
    lines.push('');
  }

  if (packet.keyClaims.length > 0) {
    lines.push('Puntos clave:');
    packet.keyClaims.forEach(function(c) {
      lines.push('- ' + c.text);
    });
  }

  lines.push('');
  lines.push('(Confianza: ' + Math.round(packet.confidence * 100) + '% | Fuente: ' + packet.sourceModel + ')');

  return lines.join('\n');
}

function compressTranslation(packet, targetProfile) {
  var maxLen = targetProfile.maxContextLength || 1500;
  var lines = [];

  if (packet.decision) {
    lines.push('Decision: ' + packet.decision.slice(0, 200));
  }

  if (packet.dataPoints.length > 0) {
    lines.push('Datos: ' + packet.dataPoints.slice(0, 3).map(function(d) { return d.value; }).join(', '));
  }

  if (packet.keyClaims.length > 0) {
    lines.push('Clave: ' + packet.keyClaims[0].text.slice(0, 150));
  }

  lines.push('(' + Math.round(packet.confidence * 100) + '% | ' + packet.sourceModel + ')');

  var result = lines.join('\n');
  if (result.length > maxLen) result = result.slice(0, maxLen);
  return result;
}

// ═══════════════════════════════════════════
// SEMANTIC OVERLAP DETECTION
// ═══════════════════════════════════════════

// Bug real, encontrado en vivo (2026-08-10) calibrando un umbral para
// escalado adaptativo del ensemble: esta funcion podia devolver valores
// MAYORES QUE 1 (medido: 1.167 en un caso real de dos respuestas con
// numeros distintos) -- imposible en un indice Jaccard (interseccion/
// union nunca puede superar 1). Causa: `intersection` se incrementaba una
// vez POR CADA OCURRENCIA de una palabra compartida en el array
// concatenado (wordsA.concat(wordsB) conserva repeticiones -- una palabra
// que aparece 3 veces en A y 2 en B sumaba varias veces a `intersection`),
// mientras que `union` (una clave por palabra unica) se quedaba deduplicado
// -- el numerador podia crecer sin el limite que le pone el denominador.
// Usado en ensemble-v2.js para puntuar relevancia (`overlap * 30`, pensado
// como 0-30 puntos) -- una respuesta que repitiera mucho una palabra
// compartida con la query podia colarse con mas puntos de los previstos,
// silenciosamente. Arreglo: interseccion sobre CONJUNTOS unicos (una
// palabra cuenta una vez, sin importar cuantas veces se repita en cada
// texto), no sobre ocurrencias.
function detectSemanticOverlap(textA, textB) {
  if (!textA || !textB) return 0;

  var wordsA = extractSignificantWords(textA);
  var wordsB = extractSignificantWords(textB);

  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  var setA = {};
  var setB = {};
  wordsA.forEach(function(w) { setA[w] = true; });
  wordsB.forEach(function(w) { setB[w] = true; });

  var union = {};
  Object.keys(setA).forEach(function(w) { union[w] = true; });
  Object.keys(setB).forEach(function(w) { union[w] = true; });

  var intersection = 0;
  Object.keys(union).forEach(function(w) {
    if (setA[w] && setB[w]) intersection++;
  });

  var unionSize = Object.keys(union).length;
  return unionSize > 0 ? intersection / unionSize : 0;
}

function extractSignificantWords(text) {
  var STOP_WORDS = {
    el: 1, la: 1, los: 1, las: 1, un: 1, una: 1, de: 1, del: 1, al: 1, en: 1, con: 1,
    por: 1, para: 1, sin: 1, sobre: 1, entre: 1, hasta: 1, desde: 1, hacia: 1,
    es: 1, son: 1, fue: 1, sera: 1, estar: 1, haber: 1, tener: 1, hacer: 1,
    que: 1, como: 1, cuando: 1, donde: 1, porque: 1, pero: 1, y: 1, o: 1,
    the: 1, a: 1, an: 1, is: 1, are: 1, was: 1, were: 1, be: 1, been: 1,
    of: 1, in: 1, to: 1, for: 1, with: 1, on: 1, at: 1, from: 1, by: 1,
    and: 1, or: 1, but: 1, not: 1, this: 1, that: 1, it: 1, its: 1,
    se: 1, no: 1, mas: 1, ya: 1, muy: 1, tan: 1, solo: 1, tambien: 1,
  };

  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 3 && !STOP_WORDS[w]; })
    .slice(0, 100);
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  THINKING_STYLES,
  detectThinkingStyle,
  extractDecisions,
  extractReasoningChain,
  extractDataPoints,
  extractKeyClaims,
  assessConfidence,
  buildContextPacket,
  translateForModel,
  detectSemanticOverlap,
};
