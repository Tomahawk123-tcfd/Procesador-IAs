// ═══════════════════════════════════════════════════════════════
// NEURAL ARBITRAGE ENGINE: Motor de Arbitraje Neuronal Puro
//
// Zero-Trust para IA: cada respuesta se audita matemáticamente.
// No confía en ningún modelo — verifica todo mediante:
//
// 1. Métricas de Entropía: Shannon entropy para medir incertidumbre
// 2. Distancia Textual: Coseno + Jaccard sobre tokens (la comparacion
//    linea-a-linea real usa estas dos, con emparejamiento por mejor
//    coincidencia, no por indice posicional -- ver detectLineContradictions).
//    levenshteinDistance() se deja exportada como utilidad de caracter-a-
//    caracter para quien la necesite, pero NO participa en el consenso por
//    defecto (2026-08-17: la cabecera afirmaba que si, no era cierto -- ver
//    nota en la funcion).
// 3. Detección de Contradicciones: Por línea, emparejada por mejor
//    coincidencia semantica (no por posicion -- ver nota 2026-08-17)
// 4. Protocolo de Consenso: Score de concordancia entre N modelos
// 5. Reporte Firmado: HMAC-SHA256 con secreto real por instalacion
//    (2026-08-17: antes era una constante hardcodeada en el propio codigo
//    fuente -- ver nota junto a HMAC_SECRET)
//
// El output es un "Consensus Report" que le dice a la IA jefe:
// "Esta línea fue aprobada por consenso por Qwen y Llama con 94%
// de concordancia lógica, pero la línea 12 tiene una contradicción
// estructural del 40% debido a un sesgo del modelo A".
// ═══════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addJournalEntry } from '../memory-bus.js';

// ── CONSTANTS ──
var CONTRADICTION_THRESHOLD = 0.35;
var CONSENSUS_THRESHOLD = 0.7;
var HIGH_CONFIDENCE = 0.85;
var MEDIUM_CONFIDENCE = 0.6;

// Bug real de seguridad, encontrado en auditoria (2026-08-17): HMAC_SECRET
// dependia de process.env.LINKCORE_NODE_ID, que nunca se setea en ningun
// sitio del repo (confirmado por grep) -- asi que en CUALQUIER instalacion
// real, el secreto era siempre la misma constante literal, visible en el
// propio codigo fuente. Un "reporte firmado" con un secreto publico no
// prueba nada: cualquiera que lea este archivo (todo el mundo, no es un
// secreto de red) puede firmar un reporte falso identico. Mismo patron ya
// resuelto en mesh.js (loadOrCreateMeshSecret): generar un secreto
// aleatorio real la primera vez, persistirlo en disco, reutilizarlo en
// arranques futuros -- asi el secreto es real y unico por instalacion, no
// derivable leyendo el codigo.
// Se exporta (2026-08-18) porque audit-ledger.js firma su cadena de hashes
// con el MISMO secreto por instalacion: un segundo secreto (o un segundo
// esquema de firma) para la misma maquina seria otra superficie que
// mantener y otra forma de que las dos firmas dejen de significar lo
// mismo. Un solo secreto, creado en un solo sitio.
var ARBITRAGE_SECRET_FILE = path.join(os.homedir(), '.linkcore', 'arbitrage-secret.txt');
export function loadOrCreateArbitrageSecret() {
  try {
    if (fs.existsSync(ARBITRAGE_SECRET_FILE)) {
      var existing = fs.readFileSync(ARBITRAGE_SECRET_FILE, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch (e) {}
  var fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(ARBITRAGE_SECRET_FILE), { recursive: true });
    fs.writeFileSync(ARBITRAGE_SECRET_FILE, fresh, 'utf-8');
  } catch (e) {
    // Si no se puede persistir, se sigue con el secreto de esta sesion en
    // memoria -- las firmas siguen siendo reales dentro de este proceso,
    // solo no sobreviven a un reinicio del servicio.
  }
  return fresh;
}
var HMAC_SECRET = loadOrCreateArbitrageSecret();

// ── SHANNON ENTROPY ──
// Measures the uncertainty/randomness of a text response
// Higher entropy = more uncertain/hallucinated content

export function shannonEntropy(text) {
  if (!text || text.length === 0) return 0;

  var freq = {};
  var len = text.length;
  for (var i = 0; i < len; i++) {
    var ch = text[i];
    freq[ch] = (freq[ch] || 0) + 1;
  }

  var entropy = 0;
  var keys = Object.keys(freq);
  for (var j = 0; j < keys.length; j++) {
    var p = freq[keys[j]] / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  // Normalize to 0-1 range (max entropy for UTF-8 is ~8 bits)
  return Math.min(1, entropy / 8);
}

// ── TOKENIZE ──
// Split text into meaningful tokens for comparison

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/g, ' ')
    .split(/\s+/)
    .filter(function(t) { return t.length > 1; });
}

// ── COSINE SIMILARITY ──
// Measures semantic similarity between two texts via token vectors

export function cosineSimilarity(textA, textB) {
  var tokensA = tokenize(textA);
  var tokensB = tokenize(textB);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Build frequency vectors
  var freqA = {};
  var freqB = {};
  var allTokens = {};

  for (var i = 0; i < tokensA.length; i++) {
    freqA[tokensA[i]] = (freqA[tokensA[i]] || 0) + 1;
    allTokens[tokensA[i]] = true;
  }
  for (var j = 0; j < tokensB.length; j++) {
    freqB[tokensB[j]] = (freqB[tokensB[j]] || 0) + 1;
    allTokens[tokensB[j]] = true;
  }

  // Calculate cosine similarity
  var dotProduct = 0;
  var normA = 0;
  var normB = 0;
  var keys = Object.keys(allTokens);

  for (var k = 0; k < keys.length; k++) {
    var token = keys[k];
    var a = freqA[token] || 0;
    var b = freqB[token] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── JACCARD SIMILARITY ──
// Measures overlap between token sets (structural similarity)

export function jaccardSimilarity(textA, textB) {
  var setA = new Set(tokenize(textA));
  var setB = new Set(tokenize(textB));

  if (setA.size === 0 && setB.size === 0) return 1;

  var intersection = 0;
  setA.forEach(function(token) {
    if (setB.has(token)) intersection++;
  });

  var union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── LEVENSHTEIN NORMALIZED ──
// Normalized edit distance (0 = identical, 1 = completely different)
//
// Nota de honestidad (2026-08-17): la cabecera del archivo afirmaba que
// esta metrica participaba en la deteccion de contradicciones junto a
// coseno/Jaccard -- no era cierto, nunca tuvo un caller real en este
// archivo (confirmado por grep). Se queda exportada como utilidad valida
// (funciona, esta bien probada) pero NO se fuerza su uso en el consenso:
// edit-distance a nivel de CARACTER es una señal mas apropiada para
// detectar "casi el mismo texto con una errata" que para el problema real
// que resuelve este archivo (desacuerdo SEMANTICO entre respuestas de
// modelos distintos, tipicamente de longitud y fraseo muy diferentes,
// donde coseno/Jaccard a nivel de token ya son la señal correcta). Forzarla
// aqui solo por completar la lista de la cabecera habria sido añadir una
// señal sin validar que mejora algo -- se corrige la cabecera en vez de
// forzar el uso.
export function levenshteinDistance(textA, textB) {
  var lenA = textA.length;
  var lenB = textB.length;

  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  var matrix = [];
  for (var i = 0; i <= lenA; i++) {
    matrix[i] = [i];
  }
  for (var j = 0; j <= lenB; j++) {
    matrix[0][j] = j;
  }

  for (var i = 1; i <= lenA; i++) {
    for (var j = 1; j <= lenB; j++) {
      var cost = textA[i - 1] === textB[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  var maxLen = Math.max(lenA, lenB);
  return maxLen > 0 ? matrix[lenA][lenB] / maxLen : 0;
}

// ── EMPAREJAMIENTO POR MEJOR COINCIDENCIA TEMATICA (2026-08-17) ──
// Bug real, encontrado en auditoria (mismo hallazgo #9 de la revision tipo
// CodeRabbit de esta sesion): detectLineContradictions()/lineLevelConsensus()
// comparaban linesA[i] contra linesB[i] por INDICE de array -- asumiendo que
// dos respuestas generadas independientemente estructuran su respuesta
// identica linea por linea. Cualquier diferencia estructural (una frase de
// introduccion de mas, una lista reordenada) desalinea todo lo que sigue,
// produciendo contradicciones fantasma o contradicciones reales sin
// detectar. ensemble-v2.js ya resuelve un problema parecido con un enfoque
// de mejor-coincidencia (collectConsensusAnchors/lineSupportMetrics) -- esta
// es la misma idea, autocontenida en este archivo: para cada linea de A, se
// busca la linea de B que comparte MAS palabras (mejor candidata a hablar
// del mismo tema), no la que esta en la misma posicion.
//
// Bug real #2, encontrado en auditoria adversarial (2026-08-17, verificado
// con llamada real -- no razonamiento): el overlap de arriba se calculaba
// sobre TODOS los tokens de tokenize(), incluidas palabras funcionales
// (el/la/de/en/que/y...) que aparecen en casi cualquier frase en español.
// Con prueba real: "El precio del cafe subio... en el mercado... este mes"
// vs "La luna llena de este mes se vera... en el cielo" -- CERO relacion
// tematica -- se emparejaban igualmente por compartir "el/en/este/mes", y
// detectLineContradictions() reportaba un "semantic_contradiction" al 71%
// de confianza entre dos frases que nunca hablaban de lo mismo. Eso es
// exactamente el fallo que la nota de arriba decia resolver ("comparte MAS
// palabras... hablar del mismo tema"), roto por no filtrar las palabras que
// cualquier frase comparte por gramatica, no por tema. Se filtran antes de
// contar el solape -- tokenize() en si se deja intacta (coseno/Jaccard del
// resto del archivo se benefician de ver el texto completo).
var TOPICAL_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al',
  'en', 'y', 'o', 'a', 'que', 'es', 'son', 'fue', 'fueron', 'ser', 'esta',
  'estan', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'lo', 'le', 'les', 'se', 'su', 'sus', 'con', 'por', 'para', 'como', 'mas',
  'pero', 'muy', 'no', 'si', 'ya', 'tambien', 'todo', 'todos', 'toda', 'todas',
  'the', 'of', 'in', 'on', 'and', 'to', 'is', 'are', 'was', 'were', 'it',
  'this', 'that', 'these', 'those', 'be', 'been', 'with', 'for', 'as', 'at',
  'by', 'or', 'an',
]);

function topicalTokens(text) {
  var out = [];
  var tokens = tokenize(text);
  for (var i = 0; i < tokens.length; i++) {
    if (!TOPICAL_STOPWORDS.has(tokens[i])) out.push(tokens[i]);
  }
  return out;
}

// Bug real #3, misma auditoria (2026-08-17, verificado con llamada real):
// una vez emparejadas dos lineas por tema real (fix de arriba), el veredicto
// de "hay contradiccion" seguia calculandose con coseno/Jaccard sobre el
// TEXTO COMPLETO -- palabras funcionales incluidas. Prueba real: "La capital
// de Australia es Canberra..." vs "...es Sidney..." (contradiccion factual
// real e inequivoca) puntuaba combined=0.549, POR ENCIMA del umbral de
// contradiccion (0.35) -- la coincidencia de "la/capital/de/australia/es/
// ciudad/del" ahogaba la unica palabra que de verdad importaba. Se
// recalcula la similitud sobre el texto sin palabras funcionales para el
// veredicto (misma formula de cada caller, solo cambia el texto de entrada).
function stripStopwordsText(text) {
  return topicalTokens(text).join(' ');
}

// Limitacion real, encontrada en verificacion adversarial (2026-08-17,
// task #107): el umbral de contradiccion opera sobre similitud AGREGADA
// (coseno+Jaccard de toda la linea), asi que "Newton nacio en 1643" vs
// "Newton nacio en 1642" -- una sola cifra distinta, el resto identico --
// puntua 0.398, POR ENCIMA del umbral (0.35), y nunca se marca como
// contradiccion pese a ser un desacuerdo factual real e inequivoco. La
// similitud agregada esta pensada para fraseo distinto sobre el mismo
// hecho, no para el caso opuesto: fraseo IDENTICO salvo un valor. Se anade
// un chequeo independiente y deliberadamente estrecho: si, tras quitar
// palabras funcionales, las dos lineas tienen EXACTAMENTE el mismo numero
// de palabras y difieren en UNA sola posicion de contenido, y esa palabra
// que difiere parece un valor (contiene un digito), es una sustitucion de
// valor -- señal mucho mas fuerte que la similitud agregada para este caso
// concreto. Acotado a "un digito de por medio" a proposito: una sola
// palabra de vocabulario distinta ("grande" vs "enorme") es demasiado
// ambigua para decidir sin mirar el resto de la frase.
function singleValueSubstitution(strippedA, strippedB) {
  var tokensA = tokenize(strippedA);
  var tokensB = tokenize(strippedB);
  if (tokensA.length === 0 || tokensA.length !== tokensB.length) return null;
  var diffIdx = -1;
  for (var i = 0; i < tokensA.length; i++) {
    if (tokensA[i] !== tokensB[i]) {
      if (diffIdx !== -1) return null; // mas de una posicion distinta, no es este caso
      diffIdx = i;
    }
  }
  if (diffIdx === -1) return null; // identicas, nada que señalar
  var diffA = tokensA[diffIdx], diffB = tokensB[diffIdx];
  if (!/\d/.test(diffA) && !/\d/.test(diffB)) return null;
  return { diffA: diffA, diffB: diffB };
}

// Falso positivo real, encontrado por el propio benchmark de verificacion
// (caso reason-02, borrador CORRECTO marcado con 3 "contradicciones",
// 2026-08-17): una linea de preambulo sin contenido factual ("¡Claro! Aqui
// te explico brevemente...") se emparejaba tematicamente contra la
// primera frase de contenido REAL de la otra voz ("PostgreSQL es una base
// de datos relacional...") -- comparten vocabulario de tema (postgresql,
// base, datos, relacional) pero la linea A no afirma nada que la linea B
// pueda contradecir, son frases de naturaleza distinta. El emparejamiento
// tematico no distingue "frase de relleno" de "frase con un hecho" -- se
// filtran las primeras antes de que puedan ser ni referencia ni candidata.
var META_LINE_RE = /^[¡!]?(claro|por supuesto|aqu[ií]\s+(te\s+explico|tienes|hay|va)|a\s+continuaci[oó]n|sure|here('s|\s+is)|let\s+me\s+explain)\b/i;
function looksLikeMetaLine(line) {
  return META_LINE_RE.test((line || '').trim());
}

function bestTopicalMatch(lineText, candidateLines, usedIndices) {
  var tokensRef = new Set(topicalTokens(lineText));
  var bestLine = null, bestIndex = -1, bestOverlap = 0;
  for (var i = 0; i < candidateLines.length; i++) {
    if (usedIndices && usedIndices[i]) continue;
    var candidate = (candidateLines[i] || '').trim();
    if (candidate.length < 10 || looksLikeMetaLine(candidate)) continue;
    var tokensCandidate = new Set(topicalTokens(candidate));
    var overlap = 0;
    tokensRef.forEach(function (t) { if (tokensCandidate.has(t)) overlap++; });
    if (overlap > bestOverlap) { bestOverlap = overlap; bestLine = candidate; bestIndex = i; }
  }
  return { line: bestLine, index: bestIndex, overlap: bestOverlap };
}

// ── LINE-BY-LINE CONTRADICTION DETECTION ──
// Compares responses line by line to find specific contradictions

export function detectLineContradictions(linesA, linesB, modelA, modelB) {
  var contradictions = [];
  var usedB = {};

  for (var i = 0; i < linesA.length; i++) {
    var lineA = (linesA[i] || '').trim();
    if (!lineA || lineA.length < 10 || looksLikeMetaLine(lineA)) continue;

    // Emparejamiento por tema real (>=2 palabras compartidas), no por
    // posicion -- ver nota de arriba. Umbral bajado de >2 a >=2 el
    // 2026-08-17 (verificacion adversarial del fix de topicalTokens): el
    // propio filtrado de palabras funcionales reduce el solape de lineas
    // factuales cortas ("Newton nacio en 1643" pierde "en" como stopword,
    // dejando solape=2 con la version contradictoria), asi que el umbral
    // >2 heredado de antes del filtrado dejaba de emparejar exactamente el
    // tipo de linea corta que este verificador existe para comparar.
    var match = bestTopicalMatch(lineA, linesB, usedB);
    if (!match.line || match.overlap < 2) continue;
    var lineB = match.line;

    var strippedA = stripStopwordsText(lineA);
    var strippedB = stripStopwordsText(lineB);
    var cosine = cosineSimilarity(strippedA, strippedB);
    var jaccard = jaccardSimilarity(strippedA, strippedB);
    var combined = (cosine * 0.6 + jaccard * 0.4);

    // Comparten tema (ya filtrado arriba) pero el fraseo global diverge --
    // eso es lo que hace sospechosa la coincidencia de contradiccion.
    if (combined < CONTRADICTION_THRESHOLD) {
      usedB[match.index] = true;
      contradictions.push({
        line: i + 1,
        matchedLineB: match.index + 1,
        textA: lineA.slice(0, 200),
        textB: lineB.slice(0, 200),
        modelA: modelA,
        modelB: modelB,
        similarity: combined,
        confidence: 1 - combined,
        type: 'semantic_contradiction',
      });
    } else {
      // La similitud agregada dice "de acuerdo", pero eso es ciego a una
      // unica cifra distinta en frases por lo demas identicas -- ver nota
      // de singleValueSubstitution (task #107, 2026-08-17).
      var valueSub = singleValueSubstitution(strippedA, strippedB);
      if (valueSub) {
        usedB[match.index] = true;
        contradictions.push({
          line: i + 1,
          matchedLineB: match.index + 1,
          textA: lineA.slice(0, 200),
          textB: lineB.slice(0, 200),
          modelA: modelA,
          modelB: modelB,
          similarity: combined,
          confidence: 0.9,
          type: 'value_substitution',
          valueA: valueSub.diffA,
          valueB: valueSub.diffB,
        });
      }
    }
  }

  return contradictions;
}

// ── CONSENSUS SCORING ──
// Calculates overall agreement between N models

// Hallazgo #3, segunda investigacion (2026-08-17, ref. arXiv 2607.08065
// "When LLMs Agree, Are They Right?"): el acuerdo entre modelos es una
// señal de confianza mas debil de lo que parece (Spearman 0.20-0.59 con la
// correccion real), y es PEOR justo donde mas se confia en ella -- cuando
// dos modelos de la MISMA familia (dos Qwen, dos Llama) coinciden, es mas
// probable que compartan el mismo sesgo/error de entrenamiento que que
// esten confirmando algo de forma independiente. calculateConsensus() no
// distinguia esto: dos voces de la misma familia de acuerdo contaban IGUAL
// que dos de familias distintas. Un par de la misma familia pesa la mitad
// hacia el score de consenso -- no se descarta (siguen siendo una señal
// real), pero no se le da el mismo credito que a confirmacion genuinamente
// independiente.
var SAME_FAMILY_WEIGHT = 0.5;

export function calculateConsensus(responses) {
  if (!responses || responses.length < 2) {
    return { score: 1.0, confidence: 'single_model', agreements: [], contradictions: [] };
  }

  var allContradictions = [];
  var totalPairs = 0;
  var totalWeight = 0;
  var totalSimilarity = 0;
  var sameFamilyPairs = 0;

  // Compare all pairs
  for (var i = 0; i < responses.length; i++) {
    for (var j = i + 1; j < responses.length; j++) {
      var respA = responses[i];
      var respB = responses[j];

      // Overall similarity
      var cosine = cosineSimilarity(respA.text, respB.text);
      var jaccard = jaccardSimilarity(respA.text, respB.text);
      var combined = (cosine * 0.6 + jaccard * 0.4);

      var sameFamily = !!(respA.family && respB.family && respA.family === respB.family);
      var weight = sameFamily ? SAME_FAMILY_WEIGHT : 1;
      if (sameFamily) sameFamilyPairs++;

      totalSimilarity += combined * weight;
      totalWeight += weight;
      totalPairs++;

      // Line-by-line contradictions
      var linesA = respA.text.split('\n');
      var linesB = respB.text.split('\n');
      var contradictions = detectLineContradictions(linesA, linesB, respA.model, respB.model);
      allContradictions = allContradictions.concat(contradictions);
    }
  }

  var avgSimilarity = totalWeight > 0 ? totalSimilarity / totalWeight : 0;
  var contradictionPenalty = allContradictions.length * 0.05;
  var consensusScore = Math.max(0, Math.min(1, avgSimilarity - contradictionPenalty));

  // Determine confidence level
  var confidence = 'low';
  if (consensusScore >= HIGH_CONFIDENCE) confidence = 'high';
  else if (consensusScore >= CONSENSUS_THRESHOLD) confidence = 'medium';
  else if (consensusScore >= MEDIUM_CONFIDENCE) confidence = 'moderate';

  return {
    score: consensusScore,
    confidence: confidence,
    avgSimilarity: avgSimilarity,
    contradictions: allContradictions,
    contradictionCount: allContradictions.length,
    modelCount: responses.length,
    models: responses.map(function(r) { return r.model; }),
    // Transparencia real (no un numero fabricado): cuantos de los pares
    // comparados eran de la misma familia y por tanto pesaron menos.
    sameFamilyPairs: sameFamilyPairs,
    totalPairs: totalPairs,
  };
}

// ── LINE-LEVEL CONSENSUS ──
// For each line, calculate which models agree

// Nota sobre el enfoque (2026-08-17, mismo fix que detectLineContradictions
// de arriba): usa la primera respuesta como referencia y busca, para cada
// una de sus lineas, la linea que mejor coincide tematicamente (mas
// palabras compartidas) en cada una de las demas respuestas -- no la misma
// posicion. Es asimetrico a proposito (una respuesta ancla el orden) en vez
// de un emparejamiento N-a-N optimo (que exigiria un algoritmo de
// asignacion tipo Hungarian, desproporcionado para este uso) -- una mejora
// real y honesta sobre el indice posicional puro, no una solucion perfecta.
export function lineLevelConsensus(responses) {
  if (!responses || responses.length < 2) return [];

  var linesPerResponse = responses.map(function (r) { return r.text.split('\n'); });
  var referenceLines = linesPerResponse[0];
  var lineGroups = [];

  for (var lineIdx = 0; lineIdx < referenceLines.length; lineIdx++) {
    var refLine = (referenceLines[lineIdx] || '').trim();
    if (refLine.length < 10 || looksLikeMetaLine(refLine)) continue;

    var lineResponses = [{ model: responses[0].model, text: refLine }];
    for (var r = 1; r < responses.length; r++) {
      var match = bestTopicalMatch(refLine, linesPerResponse[r], null);
      if (match.line && match.overlap > 1) {
        lineResponses.push({ model: responses[r].model, text: match.line });
      }
    }

    if (lineResponses.length < 2) continue;

    // Calculate pairwise similarities for this line
    var agreements = [];
    var lineContradictions = [];

    for (var a = 0; a < lineResponses.length; a++) {
      for (var b = a + 1; b < lineResponses.length; b++) {
        // Mismo fix que detectLineContradictions (ver nota junto a
        // stripStopwordsText): sobre texto completo, dos lineas cortas que
        // comparten solo andamiaje gramatical ("la/de/es/del...") puntuaban
        // como acuerdo o quedaban en zona muerta aunque el hecho concreto
        // fuera opuesto (Canberra vs Sidney -> 0.623 de coseno crudo, ni
        // acuerdo ni contradiccion). Se juzga sobre el contenido real.
        var strippedLineA = stripStopwordsText(lineResponses[a].text);
        var strippedLineB = stripStopwordsText(lineResponses[b].text);
        var sim = cosineSimilarity(strippedLineA, strippedLineB);
        // Mismo hallazgo que detectLineContradictions (task #107,
        // 2026-08-17): una sola cifra distinta en frases por lo demas
        // identicas puede puntuar por ENCIMA del umbral de consenso (frases
        // casi identicas), asi que se comprueba ANTES de aceptar un
        // acuerdo, no solo como alternativa a una contradiccion.
        var valueSub = singleValueSubstitution(strippedLineA, strippedLineB);
        if (valueSub) {
          lineContradictions.push({
            models: [lineResponses[a].model, lineResponses[b].model],
            textA: lineResponses[a].text.slice(0, 150),
            textB: lineResponses[b].text.slice(0, 150),
            similarity: sim,
            type: 'value_substitution',
            valueA: valueSub.diffA,
            valueB: valueSub.diffB,
          });
        } else if (sim >= CONSENSUS_THRESHOLD) {
          agreements.push({
            models: [lineResponses[a].model, lineResponses[b].model],
            similarity: sim,
          });
        } else if (sim < CONTRADICTION_THRESHOLD) {
          var commonTokens = 0;
          var tokensA = new Set(topicalTokens(lineResponses[a].text));
          var tokensB = new Set(topicalTokens(lineResponses[b].text));
          tokensA.forEach(function(t) { if (tokensB.has(t)) commonTokens++; });
          if (commonTokens > 2) {
            lineContradictions.push({
              models: [lineResponses[a].model, lineResponses[b].model],
              textA: lineResponses[a].text.slice(0, 150),
              textB: lineResponses[b].text.slice(0, 150),
              similarity: sim,
            });
          }
        }
      }
    }

    lineGroups.push({
      line: lineIdx + 1,
      responseCount: lineResponses.length,
      agreements: agreements.length,
      contradictions: lineContradictions,
      consensusRatio: lineResponses.length > 0 ? agreements.length / (lineResponses.length * (lineResponses.length - 1) / 2) : 0,
    });
  }

  return lineGroups;
}

// ── FULL ARBITRATION ──
// Complete arbitration process: metrics + consensus + report

export function arbitrateResponses(query, responses, opts) {
  opts = opts || {};
  var startTime = Date.now();

  // 1. Calculate individual model metrics
  var modelMetrics = responses.map(function(resp) {
    return {
      model: resp.model,
      family: resp.family || 'unknown',
      entropy: shannonEntropy(resp.text),
      tokenCount: tokenize(resp.text).length,
      charCount: resp.text.length,
      latencyMs: resp.latencyMs || 0,
    };
  });

  // 2. Calculate consensus
  var consensus = calculateConsensus(responses);

  // 3. Line-level analysis
  var lineAnalysis = lineLevelConsensus(responses);

  // 4. Find the best response (highest consensus + lowest entropy)
  var scoredResponses = responses.map(function(resp, idx) {
    var metrics = modelMetrics[idx];
    var consensusBonus = consensus.score * 20;
    var entropyPenalty = metrics.entropy * 10;
    var lineAgreements = lineAnalysis.filter(function(l) {
      return l.consensusRatio > 0.5;
    }).length;

    return {
      model: resp.model,
      text: resp.text,
      score: 50 + consensusBonus - entropyPenalty + lineAgreements,
      entropy: metrics.entropy,
      consensusContrib: consensus.score,
    };
  });

  scoredResponses.sort(function(a, b) { return b.score - a.score; });

  // 5. Generate signed report
  var report = {
    query: query.slice(0, 200),
    timestamp: Date.now(),
    durationMs: Date.now() - startTime,
    modelCount: responses.length,
    models: modelMetrics,
    consensus: {
      score: consensus.score,
      confidence: consensus.confidence,
      avgSimilarity: consensus.avgSimilarity,
      contradictionCount: consensus.contradictionCount,
    },
    lineAnalysis: {
      totalLines: lineAnalysis.length,
      highConsensusLines: lineAnalysis.filter(function(l) { return l.consensusRatio > 0.7; }).length,
      contradictedLines: lineAnalysis.filter(function(l) { return l.contradictions.length > 0; }).length,
      details: lineAnalysis.slice(0, 20),
    },
    contradictions: consensus.contradictions.slice(0, 10),
    bestResponse: scoredResponses[0] ? {
      model: scoredResponses[0].model,
      score: scoredResponses[0].score,
    } : null,
    rankings: scoredResponses.map(function(r) {
      return { model: r.model, score: Math.round(r.score), entropy: r.entropy.toFixed(3) };
    }),
    // Bug real, confirmado en vivo (2026-08-13): ensemble-v2.js lee
    // `arbitrageReport.recommendedText` para decidir si usar la respuesta
    // recomendada por el arbitraje cuando hay consenso alto (score>0.7) --
    // pero este objeto nunca traia ese campo. Solo lo ponia
    // ensembleWithArbitrage(), una funcion envoltorio de mas abajo que
    // NINGUN caller real invoca en todo el repo (confirmado por grep) --
    // y que ademas tenia sus dos ramas if/else haciendo exactamente lo
    // mismo, asi que ni siquiera su propia condicion de consenso tenia
    // efecto. La ruta "alto consenso -> usar el texto recomendado por el
    // arbitraje neuronal" nunca se activaba, en silencio. Se pone aqui,
    // en la funcion que si se llama de verdad.
    recommendedText: scoredResponses[0] ? scoredResponses[0].text : null,
  };

  // 6. Sign the report
  report.signature = signReport(report);

  // 7. Record in Memory Bus journal
  try {
    addJournalEntry({
      type: 'arbitration',
      content: 'Consensus: ' + (consensus.score * 100).toFixed(1) + '% | Contradictions: ' + consensus.contradictionCount + ' | Best: ' + (report.bestResponse ? report.bestResponse.model : 'none'),
      model: report.bestResponse ? report.bestResponse.model : null,
      category: 'neural-arbitrage',
      latencyMs: report.durationMs,
      tokens: responses.reduce(function(sum, r) { return sum + r.text.length; }, 0),
      metadata: {
        consensusScore: consensus.score,
        confidence: consensus.confidence,
        contradictionCount: consensus.contradictionCount,
        models: responses.map(function(r) { return r.model; }),
      },
    });
  } catch (e) {}

  return report;
}

// ── HMAC SIGNING ──
// Signs the report for integrity verification

function signReport(report) {
  var payload = JSON.stringify({
    query: report.query,
    timestamp: report.timestamp,
    consensus: report.consensus,
    bestModel: report.bestResponse ? report.bestResponse.model : null,
  });

  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

// ── VERIFY SIGNATURE ──
// Verifies that a report hasn't been tampered with

export function verifyReportSignature(report) {
  if (!report || typeof report.signature !== 'string') return false;
  var expected = signReport(report);
  var a = Buffer.from(report.signature, 'hex');
  var b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// ── CONTRADICTION REPORT (Human-readable) ──

export function formatContradictionReport(report) {
  var lines = [];
  lines.push('=== NEURAL ARBITRAGE REPORT ===');
  lines.push('Query: ' + report.query);
  lines.push('Models: ' + report.modelCount);
  lines.push('Consensus: ' + (report.consensus.score * 100).toFixed(1) + '% (' + report.consensus.confidence + ')');
  lines.push('Contradictions: ' + report.consensus.contradictionCount);
  lines.push('');

  if (report.contradictions.length > 0) {
    lines.push('--- CONTRADICTIONS DETECTED ---');
    for (var i = 0; i < report.contradictions.length; i++) {
      var c = report.contradictions[i];
      lines.push('Line ' + c.line + ': ' + c.modelA + ' vs ' + c.modelB + ' (similarity: ' + (c.similarity * 100).toFixed(1) + '%)');
      lines.push('  A: ' + c.textA);
      lines.push('  B: ' + c.textB);
      lines.push('');
    }
  }

  if (report.bestResponse) {
    lines.push('Best: ' + report.bestResponse.model + ' (score: ' + report.bestResponse.score + ')');
  }

  lines.push('Signature: ' + report.signature.slice(0, 16) + '...');
  return lines.join('\n');
}

// ensembleWithArbitrage() -- envoltorio muerto, eliminado (2026-08-13):
// ningun caller real en todo el repo lo invocaba (confirmado por grep,
// ensemble-v2.js llama a arbitrateResponses() directamente), y sus dos
// ramas if/else duplicaban exactamente la misma asignacion sin que la
// condicion de consenso tuviera ningun efecto real. La unica pieza de
// valor real que tenia -- poner `report.recommendedText` -- ya vive
// directamente en arbitrateResponses(), la funcion que si se llama.
