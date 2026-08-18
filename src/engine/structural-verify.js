// ── VERIFICACION DE COHERENCIA ESTRUCTURAL, DETERMINISTA ──
// (2026-08-17) Tercer verificador determinista de LinkCore, junto a
// math-verify.js (aritmetica) y code-verify.js (sintaxis/API). Ninguno de
// los dos cubre esto: una respuesta puede no tener ni una cuenta ni una
// linea de codigo y aun asi contradecirse a si misma con dos afirmaciones
// tipo "X es Y" que no pueden ser ambas ciertas a la vez dentro del propio
// texto. coherence-verify.js ya cubre un caso relacionado pero distinto
// (comparativas explicitas "A es mayor que B" vs "B es mayor que A" sobre
// el MISMO par) -- esto cubre afirmaciones de identidad/pertenencia ("X es
// Y") y su cierre transitivo, que es una clase de contradiccion diferente
// (no lexicamente opuesta, sino ESTRUCTURALMENTE inconsistente: "A es B",
// "B es C", pero tambien "A no es C" en algun otro punto del texto).
//
// Inspirado en el paper+repo real "Eidoku" (arXiv:2512.20664,
// github.com/ShinobuMiya/Eidoku, verificado leyendo ambos directamente).
// El paper describe una version completa con embeddings de frase (MiniLM)
// + un modelo NLI cross-encoder para el canal geometrico/logico. El propio
// repo, en su encabezado, ofrece ademas "a lightweight version... to
// minimize dependencies" basada en TF-IDF + regex, sin ningun modelo de
// ML de por medio. Esto implementa ESA version ligera, en JavaScript con
// solo built-ins de Node -- nunca la version con embeddings -- porque
// CLAUDE.md prohibe explicitamente dependencias npm ("Cero dependencias
// npm -- todo built-in de Node.js") y anadir una libreria de embeddings/
// transformers la violaria.
//
// LIMITACION HONESTA, tal cual la reconoce el propio paper (verificado
// esta noche): esto impone COHERENCIA CONTEXTUAL, no verdad objetiva. Si
// el texto de partida (o el contexto contra el que se compara) ya contiene
// un error, este verificador hace CUMPLIR ese error de forma consistente
// en vez de detectarlo -- no sabe que PostgreSQL es en realidad SQL y no
// NoSQL salvo que el propio texto lo afirme y luego se contradiga solo.
// Es una tecnica de prueba de concepto para detectar INCONSISTENCIA
// INTERNA verificable, no un detector de alucinaciones contra el mundo
// real. Ademas, al igual que math-verify.js/code-verify.js, la extraccion
// de afirmaciones es por regex sobre un patron sintactico concreto
// ("Sujeto es/son Predicado" al inicio de frase) -- no un parser
// linguistico real, asi que solo cubre ese patron explicito, con la misma
// filosofia que el resto del proyecto: mejor un falso negativo que
// inventar cobertura que no existe.

import { extractFinalNumericClaimWithIndex, compareNumericClaims } from './math-verify.js';

// ═══════════════════════════════════════════
// NORMALIZACION Y TOKENIZACION
// ═══════════════════════════════════════════

// Normaliza una entidad/predicado para poder compararlos como nodos del
// mismo grafo: minusculas, articulo inicial fuera, puntuacion final fuera,
// espacios colapsados. Deliberadamente SIN stemming ni normalizacion de
// plural/singular (2026-08-17) -- "base de datos relacional" y "bases de
// datos relacionales" NO se reconocen como el mismo nodo. Anadir stemming
// real (Porter/Snowball) para español es una libreria mas o una cantidad
// de reglas ad-hoc no trivial; se documenta como limitacion conocida en
// vez de fingir una cobertura que no existe. En la practica, esto significa
// que el cierre transitivo solo conecta afirmaciones que reusan el MISMO
// termino textual (normalizado) de una frase a otra.
function normalizeEntity(text) {
  var t = (text || '').toLowerCase().trim();
  t = t.replace(/^(el|la|los|las|un|una|unos|unas|the|a|an)\s+/i, '');
  t = t.replace(/[.,;:!?]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Bug real, encontrado en vivo (2026-08-17, linkcore vnpu CROSSCHECK):
  // "La capital de Francia es Paris" (voz A) vs "...es París" (voz B) se
  // marcaba como desacuerdo factual -- normalizeEntity() nunca quitaba
  // tildes, a diferencia de tokenize() (mas abajo en este mismo archivo),
  // que si lo hace por la misma razon ("reducir dispersion entre
  // variantes con/sin tilde"). Se aplica la misma normalizacion aqui, para
  // que corePredicateValue()/verifyCrossVoiceFacts() dejen de tratar la
  // misma ciudad como dos hechos distintos solo por el acento.
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t;
}

// Tokenizador para TF-IDF: minusculas, sin acentos (para reducir dispersión
// entre variantes con/sin tilde -- perdida de precision aceptada a
// proposito, el vector es una señal de similitud aproximada, no un
// analisis morfologico), solo alfanumerico.
function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

var STOPWORDS = {
  de: 1, la: 1, el: 1, los: 1, las: 1, un: 1, una: 1, unos: 1, unas: 1,
  es: 1, son: 1, que: 1, y: 1, en: 1, no: 1, para: 1, con: 1, del: 1, al: 1,
  the: 1, is: 1, are: 1, a: 1, an: 1, of: 1, and: 1, not: 1, to: 1, in: 1,
};

// ═══════════════════════════════════════════
// EXTRACCION DE AFIRMACIONES "X ES Y" / "X IS Y"
// ═══════════════════════════════════════════

// Mismo espiritu que FACTUAL_SIGNALS en consensus.js (patrones regex
// explicitos, sin intentar entender la frase) pero para un objetivo
// distinto: no comparar dos textos completos, sino extraer una afirmacion
// estructurada (sujeto, predicado, negacion) de CADA frase copulativa
// "Sujeto es/son Predicado" que empiece al inicio de una frase. Acotado a
// inicio de frase a proposito -- capturar "es/son" en medio de una
// subordinada ("...que dice que X es Y...") dispara con demasiada
// frecuencia sobre afirmaciones ajenas al sujeto real; el mismo tipo de
// sobre-generacion que coherence-verify.js ya documento y evito.
// Bug real, encontrado probando este mismo modulo (2026-08-17): la
// continuacion del sujeto ("hasta 4 palabras mas") es codiciosa y "no" es
// una palabra valida de esa clase, asi que en "PostgreSQL no es X" el
// motor prefiere tragarse "no" como PARTE del sujeto ("PostgreSQL no") en
// vez de dejarlo para el grupo de negacion opcional -- el backtracking
// solo entra si "es/son" no aparece justo despues, y aqui SI aparece. La
// negacion se perdia por completo (negated quedaba false). Se añade un
// lookahead negativo en cada paso de la continuacion: no consumas la
// siguiente palabra si lo que viene desde ahi es (opcionalmente "no"
// seguido de) "es/son" -- fuerza a la continuacion a parar justo antes de
// la copula, dejando "no" disponible para su propio grupo.
// Bug real, encontrado en verificacion adversarial (2026-08-17): la copula
// exigia un espacio inmediatamente despues ("es\s+"), asi que "es, segun
// mis calculos, 42" o "es: Madrid" (puntuacion pegada a la copula, sin
// espacio antes) nunca hacian match -- ninguna claim se extraia, y el
// desacuerdo real ni siquiera llegaba a compararse. Se añade puntuacion
// opcional entre la copula y el espacio obligatorio.
var CLAIM_PATTERNS = [
  {
    lang: 'es',
    re: /(?:^|[.!?\n]\s*)([A-ZÀ-ÿ][\wÀ-ÿ'-]*(?:\s+(?!(?:no\s+)?(?:es|son)\b)[\wÀ-ÿ'-]+){0,4})\s+(no\s+)?(?:es|son)[,:]?\s+([^.!?\n]{2,100}?)\s*(?=[.!?\n]|$)/g,
  },
  {
    lang: 'en',
    re: /(?:^|[.!?\n]\s*)([A-Z][\w'-]*(?:\s+(?!(?:is\s+not\b|isn't\b|is\b))[\w'-]+){0,4})\s+(is\s+not\s+|isn't\s+|is[,:]?\s+)([^.!?\n]{2,100}?)\s*(?=[.!?\n]|$)/g,
  },
];

function extractClaims(text) {
  if (!text) return [];
  var claims = [];
  CLAIM_PATTERNS.forEach(function (p) {
    p.re.lastIndex = 0;
    var m;
    while ((m = p.re.exec(text)) !== null) {
      var subjectRaw = (m[1] || '').trim();
      var negMarker = m[2] || '';
      var predicateRaw = (m[3] || '').trim();
      if (subjectRaw && predicateRaw) {
        claims.push({
          raw: m[0].replace(/^[.!?\n]\s*/, '').trim(),
          subject: subjectRaw,
          subjectNorm: normalizeEntity(subjectRaw),
          predicate: predicateRaw,
          predicateNorm: normalizeEntity(predicateRaw),
          negated: /no|not|n't/i.test(negMarker),
          lang: p.lang,
          index: m.index,
        });
      }
      if (p.re.lastIndex === m.index) p.re.lastIndex++; // evita bucle infinito ante un match de longitud cero
    }
  });
  claims.sort(function (a, b) { return a.index - b.index; });
  return claims;
}

// ═══════════════════════════════════════════
// CANAL 1: TENSION TOPOLOGICA (grafo de afirmaciones + cierre transitivo)
// ═══════════════════════════════════════════

// Construye el grafo dirigido SOLO con aristas positivas (afirmaciones sin
// negar): sujeto_normalizado -> predicado_normalizado. Las negadas no
// entran como arista -- son la afirmacion que se comprueba CONTRA el
// grafo, no un hecho que aporte al cierre.
function buildPositiveEdges(claims) {
  var edges = {};
  claims.forEach(function (c, idx) {
    if (c.negated) return;
    if (!edges[c.subjectNorm]) edges[c.subjectNorm] = [];
    edges[c.subjectNorm].push({ to: c.predicateNorm, claimIndex: idx });
  });
  return edges;
}

// BFS acotado (maxHops) buscando un camino de aristas POSITIVAS desde
// `from` hasta `to`. Devuelve la lista de indices de afirmacion que forman
// ese camino (el "testigo" de la ruta), o null si no hay camino. maxHops=6
// es un limite arbitrario mas de seguridad (evitar recorrer grafos enormes
// en textos largos) que un valor calibrado -- ninguna prueba real de este
// modulo ha necesitado mas de 2-3 saltos.
function findPositivePath(edges, from, to, maxHops) {
  maxHops = maxHops || 6;
  if (from === to) return null; // reflexivo, no es una cadena que verificar
  var visited = {};
  visited[from] = true;
  var queue = [{ node: from, path: [] }];
  while (queue.length) {
    var cur = queue.shift();
    if (cur.path.length >= maxHops) continue;
    var out = edges[cur.node] || [];
    for (var i = 0; i < out.length; i++) {
      var e = out[i];
      var newPath = cur.path.concat([e.claimIndex]);
      if (e.to === to) return newPath;
      if (!visited[e.to]) {
        visited[e.to] = true;
        queue.push({ node: e.to, path: newPath });
      }
    }
  }
  return null;
}

// Para cada afirmacion NEGADA ("A no es B"), busca si el resto del texto
// afirma -- de forma directa o encadenada -- que A SI es B (cierre
// transitivo). Si existe ese camino, la tension se reparte entre la
// afirmacion negada y cada eslabon del camino que la contradice (dividido
// por la longitud del camino: un camino largo de 4 saltos es una inferencia
// mas debil que una contradiccion directa de 1 salto, y el peso lo refleja).
function computeTopologicalTensions(claims) {
  var edges = buildPositiveEdges(claims);
  var tensionMap = {};
  claims.forEach(function (c, negIdx) {
    if (!c.negated) return;
    var path = findPositivePath(edges, c.subjectNorm, c.predicateNorm);
    if (!path || !path.length) return;
    var contribution = 1 / path.length;
    path.forEach(function (claimIdx) {
      if (claimIdx === negIdx) return;
      var a = Math.min(negIdx, claimIdx);
      var b = Math.max(negIdx, claimIdx);
      var key = a + '|' + b;
      tensionMap[key] = (tensionMap[key] || 0) + contribution;
    });
  });
  return tensionMap;
}

// ═══════════════════════════════════════════
// CANAL 2: TENSION GEOMETRICA (TF-IDF, sin PCA real)
// ═══════════════════════════════════════════

// DECISION DE DISEÑO (2026-08-17): el repo real de Eidoku usa vectores
// TF-IDF + error de reconstruccion de PCA (proyectar cada vector sobre su
// primer componente principal y medir cuanto se pierde al reconstruirlo)
// como señal de "cuanto se desvia esta afirmacion del resto del lote". PCA
// completo es viable via iteracion de potencias (power iteration) para el
// componente principal, pero anade una superficie de bugs numericos real
// (convergencia, vectores dispersos con vocabularios distintos por
// documento, normalizacion) para una ganancia marginal frente a una
// alternativa mas simple y igual de honesta sobre lo que mide. Se opta por
// un SUSTITUTO MAS SIMPLE, documentado como tal: NO es PCA, no captura el
// eje de mayor varianza del lote.
//
// Segunda vuelta de diseño, tras probar el primer sustituto en vivo
// (2026-08-17): la primera version media la distancia coseno de CADA
// afirmacion al CENTROIDE del lote (el sustituto que sugiere el propio
// encargo de esta tarea) y promediaba esa desviacion entre las dos
// afirmaciones de cada par. Probado con lotes reales de 4-8 afirmaciones
// cortas, DEGENERA: con tan pocos documentos y vocabulario mayormente
// distinto entre frases, casi todos los terminos aparecen en 1-2
// documentos de N, asi que el IDF es alto para casi todo el vocabulario y
// CADA afirmacion queda dominada por sus propios terminos raros -- el
// centroide (promedio disperso de vectores casi sin solape entre si) no
// se parece a NINGUNA afirmacion individual, y la "distancia al
// centroide" sale artificialmente alta y casi uniforme para todo el lote,
// diluyendo la señal real (tension topologica) en vez de complementarla.
// Medido en vivo: en un lote de 8 afirmaciones, esta version daba
// distancia-al-centroide entre 0.37 y 0.45 para TODOS los pares por igual,
// sin relacion con si el par tenia contradiccion real o no.
//
// Se sustituye por algo aun mas simple y mejor comportado para lotes
// pequeños: distancia coseno DIRECTA entre los vectores TF-IDF de las DOS
// afirmaciones del par (sin centroide de por medio). Sigue sin ser PCA,
// pero es una señal geometrica per-PAR con semantica clara ("que tan
// distintas son estas dos afirmaciones en vocabulario") y sin el efecto
// de dilucion del centroide en corpora pequeños. Si en el futuro se
// procesan lotes grandes (decenas de afirmaciones), el centroide vuelve a
// ser una opcion razonable -- power iteration sobre la matriz de
// covarianza (X^T X, sin libreria externa) sigue siendo el camino directo
// hacia PCA real si se justifica el coste.
function buildTfIdfVectors(docs) {
  var tokenSets = docs.map(function (d) {
    return tokenize(d).filter(function (t) { return !STOPWORDS[t]; });
  });
  var df = {};
  tokenSets.forEach(function (tokens) {
    var seen = {};
    tokens.forEach(function (t) {
      if (!seen[t]) { seen[t] = true; df[t] = (df[t] || 0) + 1; }
    });
  });
  var N = docs.length;
  var vocab = Object.keys(df);
  return tokenSets.map(function (tokens) {
    var tf = {};
    tokens.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    var vec = {};
    var len = tokens.length || 1;
    vocab.forEach(function (term) {
      if (!tf[term]) return;
      // +1 en el idf (smoothing habitual) evita idf=0 cuando un termino
      // aparece en todos los documentos del lote -- sin el, ese termino
      // desaparecería del vector aunque sea relevante.
      var idf = Math.log(N / df[term]) + 1;
      vec[term] = (tf[term] / len) * idf;
    });
    return vec;
  });
}

function cosineSim(vecA, vecB) {
  var dot = 0, normA = 0, normB = 0;
  var keysA = Object.keys(vecA);
  var keysB = Object.keys(vecB);
  keysA.forEach(function (k) {
    normA += vecA[k] * vecA[k];
    if (vecB[k]) dot += vecA[k] * vecB[k];
  });
  keysB.forEach(function (k) { normB += vecB[k] * vecB[k]; });
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Tension geometrica por PAR = distancia coseno directa entre los vectores
// TF-IDF de las dos afirmaciones (1 - similitud coseno). 0 = vocabulario
// identico, 1 = sin ningun termino en comun tras quitar stopwords.
function computeGeometricTensions(claims) {
  var docs = claims.map(function (c) { return c.raw; });
  var vectors = buildTfIdfVectors(docs);
  var tensionMap = {};
  for (var i = 0; i < claims.length; i++) {
    for (var j = i + 1; j < claims.length; j++) {
      tensionMap[i + '|' + j] = 1 - cosineSim(vectors[i], vectors[j]);
    }
  }
  return tensionMap;
}

// ═══════════════════════════════════════════
// CANAL 3: TENSION LOGICA (negacion / hueco de entailment entre pares)
// ═══════════════════════════════════════════

// Mismo patron que FACTUAL_SIGNALS en consensus.js (pares positivo/
// negativo por regex), reutilizado aqui sobre PREDICADOS de afirmaciones
// del mismo sujeto en vez de sobre dos textos completos de agentes
// distintos. Lista deliberadamente corta y literal -- extenderla es
// sencillo (mismo formato) pero cada entrada nueva es una fuente potencial
// de falso positivo si no se prueba con casos reales primero.
var STRUCTURAL_ANTONYM_SIGNALS = [
  { positive: /\bsql\b|relacional/i, negative: /nosql|no\s+relacional/i },
  { positive: /seguro|safe|risk-free/i, negative: /inseguro|peligroso|unsafe|risky/i },
  { positive: /disponible|available|en\s+stock/i, negative: /no\s+disponible|unavailable|agotado/i },
  { positive: /correcto|cierto|verdadero|true|correct/i, negative: /incorrecto|falso|false|incorrect/i },
  { positive: /gratis|gratuito|free/i, negative: /de\s+pago|paid|no\s+gratis/i },
];

function predicateTokenOverlap(aNorm, bNorm) {
  var aTokens = tokenize(aNorm).filter(function (t) { return !STOPWORDS[t]; });
  var bTokens = tokenize(bNorm).filter(function (t) { return !STOPWORDS[t]; });
  if (!aTokens.length || !bTokens.length) return 0;
  var setA = {};
  aTokens.forEach(function (t) { setA[t] = true; });
  var setB = {};
  var inter = 0;
  bTokens.forEach(function (t) {
    setB[t] = true;
    if (setA[t]) inter++;
  });
  var union = Object.keys(setA).length + Object.keys(setB).length - inter;
  return union === 0 ? 0 : inter / union;
}

// Tension logica entre dos afirmaciones: (a) mismo sujeto normalizado,
// predicados con solapamiento de tokens real (>0.3, umbral conservador: no
// es "hablan del mismo tema", es "es esencialmente el mismo predicado"), y
// una la niega y la otra no -- restatement directo contradictorio; o
// (b) mismo sujeto y un par positivo/negativo de STRUCTURAL_ANTONYM_SIGNALS
// aparece uno en cada predicado.
// Bug real, encontrado en auditoria adversarial (2026-08-18): esta funcion
// mezclaba en el MISMO numero dos señales de naturaleza distinta -- (a) la
// continua (overlap de tokens entre predicado negado/no negado, un valor
// difuso 0-1) y (b) la discreta de STRUCTURAL_ANTONYM_SIGNALS (o hay match
// de un par de antonimos conocido, o no lo hay: 0 o 1, sin gradacion). El
// caso normal mas simple posible -- "El servicio es seguro para produccion.
// El servicio es inseguro para uso en produccion." (2 frases, 1 solo par) --
// no se detectaba: computeAllPairTensions() normaliza cada canal dividiendo
// por su propia desviacion estandar DENTRO DEL LOTE, y con un solo par en
// el lote la varianza es 0, asi que la contribucion normalizada de CUALQUIER
// canal en un lote de 1 par se fuerza a 0 por diseño (ver el comentario de
// esa funcion, "un canal sin varianza en este lote no aporta señal
// discriminativa") -- diseño correcto para una señal difusa como el coseno
// geometrico, pero equivocado para un match de antonimo explicito, que es
// tan discreto y fiable como una arista topologica. Confirmado en vivo que
// el problema persiste incluso con mas frases en el lote (varianza != 0):
// con "...servicio es seguro... inseguro... Python es interpretado." el
// antonimo SI genera tension bruta pero termina EMPATADO en el total
// normalizado con los otros dos pares (que no tienen ninguna relacion real,
// solo ruido geometrico de fondo) porque la formula de normalizacion no
// distingue "señal real" de "ruido de fondo" cuando dan la misma magnitud
// tras dividir por sigma -- y un empate nunca supera tauC (percentil 95 * 1.1
// del propio lote). Mismo diagnostico, misma solucion que ya se aplico al
// canal topologico (ver el comentario de mas abajo en verifyStructuralCoherence,
// "el canal topologico es discreto ... Se incluye sin pasar por tauC"): un
// match de antonimo explicito se expone COMO SEÑAL DISCRETA APARTE
// (antonymMap), y el filtro de hallazgos la trata igual que rawTopological --
// bypassea el umbral relativo del lote en vez de competir por destacar sobre
// el ruido de fondo del propio lote.
function computeLogicalTensions(claims) {
  var tensionMap = {};
  var antonymMap = {};
  for (var i = 0; i < claims.length; i++) {
    for (var j = i + 1; j < claims.length; j++) {
      var a = claims[i], b = claims[j];
      if (a.subjectNorm !== b.subjectNorm || !a.subjectNorm) continue;
      var tension = 0;
      var overlap = predicateTokenOverlap(a.predicateNorm, b.predicateNorm);
      if (a.negated !== b.negated && overlap > 0.3) {
        tension = Math.max(tension, overlap);
      }
      for (var k = 0; k < STRUCTURAL_ANTONYM_SIGNALS.length; k++) {
        var sig = STRUCTURAL_ANTONYM_SIGNALS[k];
        var aPos = sig.positive.test(a.predicate), aNeg = sig.negative.test(a.predicate);
        var bPos = sig.positive.test(b.predicate), bNeg = sig.negative.test(b.predicate);
        if ((aPos && bNeg) || (aNeg && bPos)) {
          tension = Math.max(tension, 1);
          antonymMap[i + '|' + j] = true;
        }
      }
      if (tension > 0) tensionMap[i + '|' + j] = tension;
    }
  }
  return { tensionMap: tensionMap, antonymMap: antonymMap };
}

// ═══════════════════════════════════════════
// COMBINACION Y UMBRAL CALIBRADO (formula verificada del repo real)
// ═══════════════════════════════════════════

function stddev(values) {
  if (!values.length) return 0;
  var mean = values.reduce(function (s, v) { return s + v; }, 0) / values.length;
  var variance = values.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / values.length;
  return Math.sqrt(variance);
}

// Percentil por interpolacion lineal, mismo comportamiento que el default
// de np.percentile (el repo real usa np.percentile(..., 95)).
function percentile(values, p) {
  if (!values.length) return 0;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var idx = (p / 100) * (sorted.length - 1);
  var lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

// tau_c = max(2.0, percentil95(todas_las_tensiones_del_lote) * 1.1)
// -- formula literal del repo real (tau_c = max(2.0, np.percentile(
// total_tensions, 95) * safety_margin), safety_margin=1.1), confirmada
// leyendo el codigo fuente esta noche. Consecuencia honesta de esta
// formula, no un bug: con lotes muy pequeños (pocos pares), el percentil
// 95 se acerca mucho al valor maximo del propio lote, y multiplicarlo por
// 1.1 empuja el umbral por ENCIMA de ese maximo -- nada se marca salvo que
// haya una tension claramente atipica frente al resto del lote. El umbral
// esta pensado para separar un par realmente anomalo de un fondo de pares
// normales, no para disparar con dos afirmaciones sueltas sin contexto
// alrededor.
function computeAllPairTensions(claims) {
  var pairs = [];
  for (var i = 0; i < claims.length; i++) {
    for (var j = i + 1; j < claims.length; j++) pairs.push(i + '|' + j);
  }
  var topo = computeTopologicalTensions(claims);
  var geo = computeGeometricTensions(claims);
  var logi = computeLogicalTensions(claims);

  var rawI = pairs.map(function (k) { return topo[k] || 0; });
  var rawG = pairs.map(function (k) { return geo[k] || 0; });
  var rawL = pairs.map(function (k) { return logi.tensionMap[k] || 0; });

  var sigmaI = stddev(rawI);
  var sigmaG = stddev(rawG);
  var sigmaL = stddev(rawL);

  return pairs.map(function (key, idx) {
    var parts = key.split('|');
    // Normalizacion por desviacion estandar del propio canal en este lote
    // (1/sigma_L, 1/sigma_G, 1/sigma_I). Si sigma es 0 o indefinida (lote
    // de tamaño 1, o el canal entero en cero para este lote), la
    // contribucion normalizada de ese canal es 0 en vez de dividir por
    // cero -- instruccion explicita del encargo, y ademas coherente: un
    // canal sin varianza en este lote no aporta señal discriminativa.
    var iNorm = sigmaI > 0 ? rawI[idx] / sigmaI : 0;
    var gNorm = sigmaG > 0 ? rawG[idx] / sigmaG : 0;
    var lNorm = sigmaL > 0 ? rawL[idx] / sigmaL : 0;
    return {
      i: parseInt(parts[0], 10),
      j: parseInt(parts[1], 10),
      rawTopological: rawI[idx],
      rawGeometric: rawG[idx],
      rawLogical: rawL[idx],
      // Señal discreta aparte (2026-08-18, ver el comentario de
      // computeLogicalTensions arriba): un match explicito de
      // STRUCTURAL_ANTONYM_SIGNALS, no la magnitud normalizada -- se
      // consulta directamente en el filtro de hallazgos, igual que
      // rawTopological, en vez de competir por destacar sobre el ruido del
      // lote via logicalNorm.
      rawLogicalAntonym: logi.antonymMap[key] ? 1 : 0,
      topologicalNorm: iNorm,
      geometricNorm: gNorm,
      logicalNorm: lNorm,
      total: iNorm + gNorm + lNorm,
    };
  });
}

// ═══════════════════════════════════════════
// API PUBLICA
// ═══════════════════════════════════════════

// Extrae afirmaciones "X es/son Y" de `text`, construye las tres señales
// de tension entre cada par de afirmaciones, calibra el umbral con el
// propio lote, y devuelve los pares que lo superan con detalle suficiente
// para explicar POR QUE (que afirmaciones, que canal(es) lo causaron).
//
// Con menos de 2 afirmaciones extraidas no hay ningun par que comparar --
// se devuelve sin hallazgos y sin fingir un umbral calculado sobre nada.
function verifyStructuralCoherence(text) {
  var claims = extractClaims(text);
  if (claims.length < 2) {
    return {
      findings: [],
      claimsFound: claims.length,
      pairsAnalyzed: 0,
      threshold: null,
      note: 'Menos de 2 afirmaciones "X es/son Y" extraidas del texto -- nada que comparar.',
    };
  }

  var pairResults = computeAllPairTensions(claims);
  var totals = pairResults.map(function (r) { return r.total; });
  var tauC = Math.max(2.0, percentile(totals, 95) * 1.1);

  // Hueco real, encontrado en verificacion adversarial (2026-08-17,
  // benchmark caso reason-02): el umbral de arriba es un percentil DENTRO
  // del propio lote de pares -- calibrado para que una contradiccion
  // destaque como minoria anomala sobre una mayoria coherente. Con pocas
  // afirmaciones (el caso normal de una sola respuesta corta: 3 claims, 3
  // pares), una cadena transitiva contradictoria ("A es B", "B es C", "A
  // no es C") ocupa 2 de los 3 pares -- es la MAYORIA del lote, no un
  // valor atipico, y el umbral relativo nunca dispara pase lo que pase por
  // diseño, no por error de calculo (mismo motivo, documentado mas abajo,
  // por el que verifyCrossVoiceFacts se construyo sin umbral relativo para
  // el caso de 2 voces). A diferencia de los canales geometrico/logico
  // (señal continua, tiene sentido calibrarla contra el resto del lote),
  // el canal topologico es discreto: un valor > 0 significa que existe un
  // camino de aristas POSITIVAS que la negacion contradice directamente --
  // prueba de grafo, no una señal difusa que necesite destacar sobre una
  // linea base. Se incluye sin pasar por tauC.
  var findings = pairResults
    .filter(function (r) { return r.total > tauC || r.rawTopological > 0 || r.rawLogicalAntonym > 0; })
    .sort(function (a, b) { return b.total - a.total; })
    .map(function (r) {
      var claimA = claims[r.i];
      var claimB = claims[r.j];
      var drivenBy = [];
      if (r.topologicalNorm > 0) drivenBy.push('topological');
      // rawLogicalAntonym bypasea tauC igual que rawTopological (ver
      // comentario 2026-08-18 mas arriba) -- se marca como "driven by
      // logical" aunque logicalNorm haya salido a 0 por falta de varianza
      // en el lote, que es justo el caso que este bypass existe para cubrir.
      if (r.logicalNorm > 0 || r.rawLogicalAntonym > 0) drivenBy.push('logical');
      // El canal geometrico casi nunca vale exactamente 0 (es una distancia
      // coseno continua) -- solo se lista como canal "responsable" si su
      // contribucion normalizada es una fraccion no trivial del total,
      // para no acusar al canal geometrico de cada hallazgo por defecto.
      if (r.total > 0 && r.geometricNorm / r.total > 0.15) drivenBy.push('geometric');

      return {
        claimA: { text: claimA.raw, subject: claimA.subject, predicate: claimA.predicate, negated: claimA.negated },
        claimB: { text: claimB.raw, subject: claimB.subject, predicate: claimB.predicate, negated: claimB.negated },
        totalTension: Math.round(r.total * 1000) / 1000,
        threshold: Math.round(tauC * 1000) / 1000,
        drivenBy: drivenBy,
        channels: {
          topological: Math.round(r.topologicalNorm * 1000) / 1000,
          geometric: Math.round(r.geometricNorm * 1000) / 1000,
          logical: Math.round(r.logicalNorm * 1000) / 1000,
        },
        reason: drivenBy.indexOf('topological') !== -1
          ? 'El texto afirma en cadena que "' + claimA.subject + '" es "' + claimA.predicate + '" (directa o transitivamente), pero en otro punto niega esa misma relacion.'
          : 'Afirmaciones sobre "' + claimA.subject + '" con predicados en tension logica o geometrica marcada dentro de este lote.',
      };
    });

  return {
    findings: findings,
    claimsFound: claims.length,
    pairsAnalyzed: pairResults.length,
    threshold: Math.round(tauC * 1000) / 1000,
  };
}

// ═══════════════════════════════════════════
// COMPARACION DIRECTA ENTRE VOCES (2026-08-17, hallazgo real construyendo
// vNPU.CROSSCHECK)
// ═══════════════════════════════════════════
//
// Bug/hueco real, encontrado en vivo: "La capital de Australia es Sidney"
// vs "La capital de Australia es Canberra" (dos voces independientes, el
// caso mas comun y mas importante de desacuerdo factual) no lo detectaba
// NINGUNO de los verificadores deterministas existentes. detectLineContra-
// dictions (neural-arbitrage.js) lo descarta porque el solapamiento lexico
// COMPARTIDO ("la capital de australia es") es tan alto que la similitud
// GLOBAL de la frase sale por encima del umbral de contradiccion, aunque
// la unica palabra que de verdad importa (Sidney/Canberra) sea distinta.
// El canal logico de verifyStructuralCoherence (de arriba) solo dispara
// con negacion directa o una lista corta de antonimos -- "Sidney" y
// "Canberra" no son ni lo uno ni lo otro, son dos valores DISTINTOS para
// el mismo hueco. Y el umbral por lote de verifyStructuralCoherence nunca
// dispara con solo 2 afirmaciones (1 par) -- necesita un lote mayor para
// tener una linea base "normal" contra la que destacar.
//
// Esta funcion es deliberadamente mas simple y directa que las de arriba:
// no calibra un umbral relativo al lote, no exige negacion ni antonimos --
// agrupa afirmaciones "X es/son Y" de VARIAS VOCES por sujeto normalizado,
// y si dos voces distintas dan un predicado normalizado DIFERENTE para el
// MISMO sujeto, eso ES el hallazgo, sin mas condicion. Reutiliza
// extractClaims() (misma extraccion ya probada arriba), solo cambia como
// se comparan los resultados.
// Falso positivo real, encontrado probando esta misma funcion (2026-08-17):
// "Canberra" vs "Canberra, una ciudad planificada" se marcaba como
// desacuerdo -- ambas voces coinciden en el HECHO (Canberra), una solo
// elabora mas. Comparar el predicado ENTERO como string es demasiado
// estricto. El valor real de una afirmacion "X es Y" suele ser lo PRIMERO
// del predicado, antes de la primera coma (el resto es aclaracion
// añadida) -- se compara solo esa parte nuclear, no el predicado completo.
// Limitacion honesta: si la elaboracion viene sin ningun separador de los
// de abajo ("un lenguaje interpretado y dinamico" vs "un lenguaje
// interpretado"), esto no la separa -- cubre los patrones con separador
// explicito, los mas comunes en respuestas factuales de una frase, no
// todos los patrones posibles.
// Bug real, misma clase que el ya corregido para coma (encontrado en vivo,
// 2026-08-17, hunt adversarial explicito sobre este mismo punto): el split
// original solo cortaba en ",", asi que "Canberra; una ciudad planificada",
// "Canberra: la capital administrativa" y "Canberra (una ciudad
// planificada)" sobrevivian ENTEROS como "valor nuclear" -- ninguno de los
// tres coincidia con el "Canberra" simple de la otra voz por comparacion de
// string exacta, y los tres se marcaban como falso desacuerdo factual pese
// a coincidir en el hecho. Se corta en el primero que aparezca de coma,
// punto y coma, dos puntos o parentesis de apertura -- misma logica que ya
// existia, extendida a los separadores de elaboracion equivalentes.
function corePredicateValue(predicateNorm) {
  var s = predicateNorm || '';
  var parts = s.split(/[,;:(]/);
  var head = (parts[0] || '').trim();
  if (head) return head;
  // El primer segmento esta vacio: el separador aparece al principio del
  // predicado (p.ej. ", segun mis calculos, 42" o ": Madrid" -- la
  // elaboracion precede al valor en vez de seguirlo). Cortar por la cabeza
  // en ese caso colapsaba el valor a '' en ambas voces y dos respuestas que
  // de verdad discrepan (42 vs 45, Madrid vs Barcelona) pasaban como "de
  // acuerdo" -- hallazgo de verificacion adversarial 2026-08-17. El ultimo
  // segmento es la mejor aproximacion al valor real en esa forma invertida
  // (la elaboracion tipicamente termina justo antes del valor, no despues).
  for (var i = parts.length - 1; i > 0; i--) {
    var tail = (parts[i] || '').trim();
    if (tail) return tail;
  }
  return s.trim();
}

function verifyCrossVoiceFacts(voices) {
  if (!voices || voices.length < 2) return [];
  var bySubject = {};
  voices.forEach(function (voice) {
    var claims = extractClaims(voice.text || '');
    claims.forEach(function (c) {
      // Solo afirmaciones positivas por ahora -- cruzar negacion entre
      // voces distintas ("A dice que X es Y" vs "B dice que X no es Y")
      // es un caso real pero mas complejo (¿negacion de que, exactamente,
      // si los predicados no coinciden palabra por palabra?); mejor no
      // cubrirlo a medias que fingir una cobertura que no se probo.
      if (c.negated || !c.subjectNorm || !c.predicateNorm) return;
      if (!bySubject[c.subjectNorm]) bySubject[c.subjectNorm] = [];
      bySubject[c.subjectNorm].push({ model: voice.model, claim: c });
    });
  });

  var findings = [];
  Object.keys(bySubject).forEach(function (subj) {
    var entries = bySubject[subj];
    if (entries.length < 2) return;
    var seenPredicates = {};
    for (var i = 0; i < entries.length; i++) {
      for (var j = i + 1; j < entries.length; j++) {
        var a = entries[i], b = entries[j];
        if (a.model === b.model) continue; // misma voz repitiendose, no es un desacuerdo entre voces
        if (corePredicateValue(a.claim.predicateNorm) === corePredicateValue(b.claim.predicateNorm)) continue; // mismo valor nuclear, sin desacuerdo
        var pairKey = a.model + '|' + b.model + '|' + subj;
        if (seenPredicates[pairKey]) continue;
        seenPredicates[pairKey] = true;
        findings.push({
          subject: a.claim.subject,
          modelA: a.model,
          predicateA: a.claim.predicate,
          modelB: b.model,
          predicateB: b.claim.predicate,
        });
      }
    }
  });
  return findings;
}

// ═══════════════════════════════════════════
// COMPARACION NUMERICA DIRECTA ENTRE VOCES (2026-08-17)
// ═══════════════════════════════════════════
//
// Mismo hueco que motivo verifyCrossVoiceFacts() (arriba) pero para
// numeros, no prosa: "El total es 42" vs "El total es 45" (o "La poblacion
// es de 3 millones" vs "...5 millones") es al menos tan comun como el caso
// "Sidney vs Canberra", y ninguno de los verificadores deterministas
// existentes lo cubre para VARIAS voces. math-verify.js ya tiene
// compareNumericClaims(), pero esta pensado para comparar exactamente DOS
// respuestas del ensemble (ronda de desempate 1-contra-1) -- aqui hace
// falta recorrer N voces de vNPU.CROSSCHECK, decidir CON QUE otra voz
// comparar cada una, y solo entonces aplicar esa misma comparacion.
//
// Reutiliza tal cual, sin reinventar nada de eso:
//   - extractFinalNumericClaimWithIndex() (math-verify.js) para sacar la
//     cifra final de cada voz (misma logica ya calibrada alli: prioriza la
//     ultima linea de una derivacion "X = numero", cae a la ultima cifra
//     suelta del texto si no hay derivacion).
//   - compareNumericClaims() (math-verify.js) para decidir si dos cifras
//     difieren mas alla de la tolerancia (2% por defecto, ya calibrada
//     alli para comparar dos respuestas INDEPENDIENTES, no pasos de una
//     misma derivacion).
//   - predicateTokenOverlap() (definida arriba en este mismo archivo para
//     verifyStructuralCoherence) para decidir si dos voces estan
//     respondiendo a la MISMA pregunta antes de comparar sus cifras --
//     sin esto, cualquier par de voces con una cifra final distinta se
//     marcaria como "desacuerdo" aunque hablasen de cosas sin relacion.
//
// Lo unico nuevo aqui es la nocion de "contexto" de una cifra: la frase
// que la rodea en el texto (sentenceAround(), abajo), tokenizada y
// comparada por solapamiento igual que ya se hace con los predicados de
// "X es Y" -- mismo principio que agrupar por sujeto en
// verifyCrossVoiceFacts(), adaptado a que aqui no hay un sujeto gramatical
// explicito que extraer, solo la frase entera alrededor del numero.
function sentenceAround(text, index) {
  if (!text || index == null || index < 0) return text || '';
  var startDot = text.lastIndexOf('.', index - 1);
  var startNL = text.lastIndexOf('\n', index - 1);
  var start = Math.max(startDot, startNL);
  var endDot = text.indexOf('.', index);
  var endNL = text.indexOf('\n', index);
  var end;
  if (endDot === -1) end = endNL;
  else if (endNL === -1) end = endDot;
  else end = Math.min(endDot, endNL);
  if (end === -1) end = text.length;
  return text.slice(start + 1, end).trim();
}

// Umbral de solapamiento para decidir "misma pregunta aparente". Mas bajo
// que el 0.3 que usa computeLogicalTensions() para predicados cortos de
// "X es Y" (arriba) porque aqui se compara la FRASE ENTERA alrededor del
// numero -- mas palabras de por medio (conectores, unidades, verbos) diluyen
// el solapamiento aunque el tema sea el mismo. Calibrado contra los tres
// casos de prueba de esta funcion (ver test manual mas abajo en el
// historial de esta tarea): 0.2 separa limpiamente dos preguntas sin
// relacion (solapamiento 0) sin perder variantes razonables de la misma
// pregunta ("cual es el total de la compra" vs "el total final de la
// compra").
var SAME_QUESTION_OVERLAP_THRESHOLD = 0.2;

// Para cada voz, extrae su cifra final (con la frase que la rodea de
// contexto) y compara cada par de voces DISTINTAS cuyo contexto solapa lo
// bastante como para asumir que responden a la misma pregunta. Si sus
// cifras finales difieren mas alla de la tolerancia de
// compareNumericClaims(), es un hallazgo.
//
// Con menos de 2 voces, o si ninguna voz tiene una cifra numerica
// extraible, no hay nada que comparar -- se devuelve vacio sin fingir una
// comparacion sobre datos que no existen.
function verifyCrossVoiceNumbers(voices, tolerancePct) {
  if (!voices || voices.length < 2) return [];

  var claims = voices.map(function (voice) {
    var r = extractFinalNumericClaimWithIndex(voice.text || '');
    if (!r) return null;
    return {
      model: voice.model,
      text: voice.text || '',
      value: r.value,
      context: sentenceAround(voice.text || '', r.index),
    };
  });

  var findings = [];
  for (var i = 0; i < claims.length; i++) {
    if (!claims[i]) continue;
    for (var j = i + 1; j < claims.length; j++) {
      if (!claims[j]) continue;
      var a = claims[i], b = claims[j];
      if (a.model === b.model) continue; // misma voz repitiendose, no es un desacuerdo entre voces
      var overlap = predicateTokenOverlap(a.context, b.context);
      if (overlap < SAME_QUESTION_OVERLAP_THRESHOLD) continue; // contextos sin relacion -- no se puede asumir que responden a la misma pregunta
      var cmp = compareNumericClaims(a.text, b.text, tolerancePct);
      if (!cmp || !cmp.disagree) continue;
      findings.push({
        modelA: a.model,
        valueA: cmp.valueA,
        contextA: a.context,
        modelB: b.model,
        valueB: cmp.valueB,
        contextB: b.context,
        diffPct: cmp.diffPct,
        questionOverlap: Math.round(overlap * 1000) / 1000,
      });
    }
  }
  return findings;
}

// corePredicateValue y predicateTokenOverlap pasan a ser publicas
// (2026-08-18) para grounding-verify.js#CONTRADICTED_CLAIM. Ese canal compara
// una respuesta contra una FUENTE, no dos voces contra la misma pregunta, asi
// que no puede llamar a verifyCrossVoiceFacts() tal cual (ver el comentario de
// ese canal en grounding-verify.js) -- pero SI debe reutilizar exactamente
// estas dos piezas: el valor nuclear ya endurecido contra el falso positivo
// "Canberra" vs "Canberra, una ciudad planificada", y el solapamiento de
// tokens que ya decide "¿hablan del mismo hueco?" en computeLogicalTensions().
export {
  verifyStructuralCoherence,
  verifyCrossVoiceFacts,
  verifyCrossVoiceNumbers,
  extractClaims,
  computeAllPairTensions,
  normalizeEntity,
  corePredicateValue,
  predicateTokenOverlap,
};
