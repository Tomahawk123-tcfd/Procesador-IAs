// ═══════════════════════════════════════════════════════════════
// LINKCORE UNIVERSAL TRANSLATION LAYER
// Translates between ANY AI agent's native format and our protocol
// This is the universal serial bus for AI agents
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════
// AGENT REGISTRY
// ═══════════════════════════════════════════

var _agents = {};
var _protocolHandlers = {};

var AGENT_TYPES = {
  chatgpt: { name: 'ChatGPT', protocols: ['api', 'web'], formats: ['json', 'markdown'], capabilities: ['text', 'code', 'reasoning', 'vision'] },
  claude: { name: 'Claude', protocols: ['api', 'web'], formats: ['json', 'markdown'], capabilities: ['text', 'code', 'reasoning', 'vision', 'long_context'] },
  gemini: { name: 'Gemini', protocols: ['api', 'web'], formats: ['json', 'markdown'], capabilities: ['text', 'code', 'reasoning', 'vision', 'multimodal'] },
  groq: { name: 'Groq', protocols: ['api'], formats: ['json'], capabilities: ['text', 'code', 'reasoning'] },
  deepseek: { name: 'DeepSeek', protocols: ['api'], formats: ['json', 'markdown'], capabilities: ['text', 'code', 'reasoning'] },
  copilot: { name: 'GitHub Copilot', protocols: ['api', 'ide'], formats: ['json'], capabilities: ['code', 'reasoning'] },
  cursor: { name: 'Cursor', protocols: ['ide'], formats: ['json'], capabilities: ['code', 'reasoning'] },
  perplexity: { name: 'Perplexity', protocols: ['api', 'web'], formats: ['json', 'markdown'], capabilities: ['text', 'search', 'reasoning'] },
  mistral: { name: 'Mistral', protocols: ['api'], formats: ['json'], capabilities: ['text', 'code', 'reasoning'] },
  llama: { name: 'Llama', protocols: ['api', 'local'], formats: ['json'], capabilities: ['text', 'code'] },
  custom: { name: 'Custom Agent', protocols: ['api', 'webhook'], formats: ['json', 'text', 'markdown'], capabilities: ['text', 'code', 'reasoning', 'custom'] },
};

// ═══════════════════════════════════════════
// FORMAT DETECTION
// ═══════════════════════════════════════════

function detectFormat(input) {
  if (input === null || input === undefined) return 'empty';
  if (typeof input === 'object') {
    if (Array.isArray(input)) return 'array';
    if (input.choices || input.candidates || input.content) return 'openai_compatible';
    if (input.error) return 'error';
    return 'json';
  }
  var s = String(input);
  if (!s.length) return 'empty';
  if (s[0] === '{' || s[0] === '[') {
    try { JSON.parse(s); return 'json_string'; } catch(e) {}
  }
  if (s.indexOf('```') !== -1) return 'markdown_code';
  if (s.indexOf('## ') !== -1 || s.indexOf('**') !== -1 || s.indexOf('- ') !== -1) return 'markdown';
  if (s.indexOf('<html') !== -1 || s.indexOf('<div') !== -1) return 'html';
  if (s.indexOf('def ') !== -1 || s.indexOf('function ') !== -1 || s.indexOf('class ') !== -1) return 'code';
  return 'text';
}

// ═══════════════════════════════════════════
// SCHEMA NORMALIZATION
// ═══════════════════════════════════════════

var STANDARD_SCHEMA = {
  required: ['content', 'agent', 'timestamp'],
  optional: ['confidence', 'sources', 'metadata', 'intent', 'entities', 'actions'],
};

// Bug real reportado en vivo (2026-07-30): la confianza salia SIEMPRE en
// 60% ("Claude Fable 5 -- confianza: 60%", "Qwen 3.5 Max -- confianza:
// 60%"...) sin importar la respuesta. Causa: normalizeToStandard()
// asignaba un numero FIJO por FORMATO (markdown->0.6, openai_compatible
// ->0.6), y casi cualquier respuesta de un LLM se clasifica como
// 'markdown' (basta un "**negrita**" o una lista con "- "). El numero no
// media nada del contenido real, solo de que forma tenia el texto.
//
// Reemplazado por una heuristica sobre el CONTENIDO: longitud sustancial,
// frases de rechazo/incertidumbre ("no puedo", "no estoy seguro"),
// estructura real (encabezados, listas, bloques de codigo). Sigue sin ser
// una medida de verdad objetiva -- eso requeriria verificacion externa,
// fuera de alcance aqui -- pero ya no es una constante disfrazada de
// metrica.
var HEDGE_PATTERNS = /\b(no puedo|no tengo acceso|no estoy seguro|no se sabe con certeza|posiblemente|podria ser|quiza|tal vez|as an ai|i cannot|i'm not sure|i don't have access|it's possible that|might be)\b/i;
var REFUSAL_PATTERNS = /\b(no puedo ayudarte|no puedo responder|no dispongo de|lo siento,? no|i can't help|i'm unable to)\b/i;
var STRUCTURE_PATTERNS = /(^|\n)#{1,3}\s|\n[-*]\s|\n\d+\.\s|```/;

function computeContentConfidence(content) {
  var text = String(content || '');
  var len = text.trim().length;
  if (!len) return 0.1;

  var score = 0.5;
  if (len > 400) score += 0.15;
  else if (len > 120) score += 0.08;
  else if (len < 20) score -= 0.15;

  if (STRUCTURE_PATTERNS.test(text)) score += 0.1;
  if (REFUSAL_PATTERNS.test(text)) score -= 0.35;
  else if (HEDGE_PATTERNS.test(text)) score -= 0.15;

  return Math.min(Math.max(score, 0.1), 0.95);
}

// ── DETECCION DE FUGA DE CONTEXTO ──
// Bug real, critico, confirmado en vivo (2026-08-03, dos veces): buildContextBlock()
// en backend.js inyecta bloques de contexto ("Estado del proyecto (Memory
// Bus): ...", "Hechos que el usuario te ha pedido recordar: ...",
// "Conversacion reciente...") dentro del SYSTEM PROMPT de cada llamada.
// Modelos pequeños a veces no responden la pregunta -- devuelven ese
// bloque de contexto, o el propio prompt de instruccion, como si fuera la
// respuesta. Vivia solo dentro de ensemble-v2.js; el camino de ultimo
// recurso de callAI() (backend.js, cuando el ensemble entero falla) no lo
// tenia, y reprodujo la misma fuga en vivo. Se centraliza aqui -- utilidad
// generica de calidad de respuesta, mismo sitio que computeContentConfidence
// -- para que cualquier camino que acepte una respuesta de un modelo pueda
// usarla, no solo el ensemble.
var CONTEXT_LEAK_MARKERS = [
  'Estado del proyecto (Memory Bus)',
  'Hechos que el usuario te ha pedido recordar',
  'Conversacion reciente',
  'Conversación reciente',
  'Revisa tu respuesta considerando las perspectivas',
];

function looksLikeContextLeak(text) {
  if (!text) return false;
  var head = text.trim().slice(0, 80);
  for (var i = 0; i < CONTEXT_LEAK_MARKERS.length; i++) {
    if (head.indexOf(CONTEXT_LEAK_MARKERS[i]) !== -1) return true;
  }
  return false;
}

// ── DETECCION GENERAL DE ECO ──
// Bug real, confirmado en vivo TRES veces (2026-08-03), cada vez con un
// texto inyectado distinto: primero "Estado del proyecto (Memory Bus)",
// luego el propio prompt de revision de ensemble-v2.js, luego "Memoria
// con intencion (STITCH)" + la plantilla de instruccion de
// orchestrator.js#buildPrompt(). looksLikeContextLeak() de arriba exige
// conocer de antemano la frase exacta que se fugo -- cada vez que un
// prompt nuevo (orquestador, crew, ensemble, lo que sea futuro) inyecta
// SU PROPIO bloque de contexto, hace falta añadir SU frase a la lista a
// mano, DESPUES de que ya se haya colado en produccion. Esto es
// estructural, no una lista que se pueda mantener completa: cualquier
// modelo pequeño, con cualquier prompt de sistema suficientemente largo,
// puede ecoar cualquier parte de el en vez de responder.
//
// Chequeo general en su lugar: si el INICIO de la respuesta aparece
// literal dentro de lo que se le mando al modelo (system prompt + query
// combinados), es un eco -- no importa que parte concreta sea. Una
// respuesta real practicamente nunca empieza con 60+ caracteres
// identicos a su propio prompt de entrada; es una coincidencia
// estadisticamente imposible salvo que sea, de hecho, un eco.
function looksLikeEcho(responseText, sentContent) {
  if (!responseText || !sentContent) return false;
  var sentLower = sentContent.toLowerCase();

  var head = responseText.trim().slice(0, 60).toLowerCase();
  if (head.length >= 40 && sentLower.indexOf(head) !== -1) return true;

  // Cuarto fallo real, confirmado en vivo (2026-08-03): la fuga no siempre
  // esta al PRINCIPIO de la respuesta -- un modelo pequeño (smollm2:135m)
  // alucino un contenido nuevo (fuera de tema) y solo al FINAL colo una
  // linea literal de la plantilla de instrucciones del orquestador
  // ("Entrega SOLO el resultado de esta subtarea...",
  // orchestrator.js#buildPrompt). El chequeo de solo el inicio no lo
  // detecta. En su lugar: si CUALQUIER linea de la respuesta (no solo la
  // primera) aparece literal dentro de lo que se le mando al modelo, es
  // una fuga -- sin importar en que posicion de la respuesta este.
  var lines = responseText.split(/\n+/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim().toLowerCase();
    if (line.length >= 35 && sentLower.indexOf(line) !== -1) return true;
  }

  // Quinto fallo real, confirmado en vivo (2026-08-03): un modelo pequeño
  // (smollm2:360m) devolvio "Haz un analisis del mercado actual de coches
  // autonomos. Entrega el resultado de este analisis en formato listo
  // para usar en espanol, estructurado sin emojis y meta-comentarios
  // directamente." -- NO es una copia literal de ninguna linea del
  // prompt (parafraseo la instruccion del system prompt: "sin emojis NI
  // meta-comentarios" -> "sin emojis Y meta-comentarios"), asi que ni el
  // chequeo de inicio ni el de linea-por-linea lo detectan. Es la misma
  // familia de fallo con una mutacion de una palabra, no un texto nuevo.
  // Chequeo estructural en su lugar: una respuesta CORTA cuyas palabras
  // significativas (>3 letras) coinciden en gran mayoria con las del
  // prompt enviado no esta aportando informacion nueva -- esta
  // reformulando la pregunta/instruccion, no contestandola. Una
  // respuesta real, aunque reutilice vocabulario de la pregunta, añade
  // contenido propio y baja la proporcion de solapamiento.
  if (responseText.trim().length < 500) {
    // Quita acentos antes de comparar -- "análisis" (respuesta real, con
    // tilde) y "analisis" (como suele venir en el prompt, sin tilde) son
    // la misma palabra; sin normalizar, el solapamiento se subestimaba.
    var stripAccents = function (s) {
      return s.replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u');
    };
    var respWords = stripAccents(responseText.toLowerCase()).replace(/[^\w\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 3; });
    if (respWords.length >= 6) {
      var sentWords = {};
      stripAccents(sentLower).replace(/[^\w\s]/g, ' ').split(/\s+/).forEach(function (w) { if (w.length > 3) sentWords[w] = true; });
      var matched = respWords.filter(function (w) { return sentWords[w]; }).length;
      if ((matched / respWords.length) > 0.7) return true;
    }
  }

  return false;
}

// ── LIMPIEZA DE PREAMBULO FILTRADO ──
// Bug real, encontrado en vivo (2026-08-07): un modelo abrio su respuesta
// con "Entendido. Aqui esta el resultado de la subtarea en el pipeline de
// LinkCore:" -- parafraseo de la plantilla real del orquestador ("Tu
// subtarea en el pipeline de LinkCore:", orchestrator.js#buildPrompt), no
// una copia literal (por eso looksLikeEcho no lo pilla: ni coincide linea
// por linea ni la respuesta es corta). El resto de la respuesta (varias
// secciones, analisis real y en tema) era bueno -- rechazar TODO por una
// frase de apertura desperdicia un analisis real en una maquina donde cada
// intento cuesta minutos. Se recorta solo la primera linea si menciona
// terminologia interna que un usuario nunca deberia ver, en vez de tirar
// la respuesta entera.
var PREAMBLE_LEAK_MARKERS = ['pipeline de linkcore', 'subtarea', 'siguiente agente'];
function stripLeakedPreamble(text) {
  if (!text) return text;
  var firstBreak = text.indexOf('\n');
  var firstLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).trim();
  if (firstLine.length === 0 || firstLine.length > 200) return text;
  var lower = firstLine.toLowerCase();
  var hasMarker = PREAMBLE_LEAK_MARKERS.some(function (marker) { return lower.indexOf(marker) !== -1; });
  if (!hasMarker) return text;
  var rest = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  return rest.replace(/^\n+/, '').trim();
}

// ── DETECCION DE RECHAZO ──
// Bug real, encontrado en vivo (2026-08-05): qwen2.5:0.5b respondio "Lo
// siento, pero no puedo ayudarte con eso." a una peticion totalmente
// benigna ("haz un analisis del mercado de sensores industriales") -- una
// llamada directa a Ollama, sin pasar por LinkCore, respondio bien a la
// misma pregunta, asi que no es que el modelo no pueda: fue un fallo
// puntual (stocastico, un modelo de 0.5B). El problema real es que ese
// rechazo se ACEPTO como respuesta valida y se cacheo -- ninguno de los
// detectores existentes (fuga/eco/repeticion) lo pilla, porque es corto,
// coherente y no repite nada. Se sirvio en cache 3 veces despues, como si
// fuera una respuesta real. No es una lista exhaustiva (nunca lo es,
// misma leccion que looksLikeContextLeak) pero cubre los patrones de
// rechazo mas comunes en español e ingles de modelos pequeños.
var REFUSAL_MARKERS = [
  'lo siento, pero no puedo', 'lo siento, no puedo ayudarte',
  'no puedo ayudarte con eso', 'no puedo ayudar con eso',
  'no puedo asistir con esa', 'no estoy en condiciones de ayudar',
  "i'm sorry, but i can't", "i cannot assist with", "i'm not able to help",
  'as an ai language model, i cannot',
];
function looksLikeRefusal(text) {
  if (!text) return false;
  // Bug real, encontrado en vivo (2026-08-07): el gate original exigia que
  // TODA la respuesta fuera corta (<120 chars) para contar como rechazo --
  // pero un modelo pequeño puede abrir con un rechazo real ("Lo siento,
  // pero no puedo realizar una solicitud original directamente...") y
  // seguir divagando despues con texto confuso sobre "la subtarea en el
  // pipeline", superando el limite y colandose sin detectar. Lo que
  // importa es si la respuesta EMPIEZA rechazando, no cuanto mida en
  // total -- se mira solo el arranque (primeros ~80 caracteres).
  var head = text.trim().toLowerCase().slice(0, 80);
  for (var i = 0; i < REFUSAL_MARKERS.length; i++) {
    if (head.indexOf(REFUSAL_MARKERS[i]) !== -1) return true;
  }
  return false;
}

// ── DETECCION DE BASURA REPETITIVA ──
// Fallo real, confirmado en vivo (2026-08-03) con smollm2:135m: no ecoa el
// prompt de entrada (looksLikeEcho no lo pilla), sino que se queda en bucle
// repitiendo sus propias frases/lineas (fragmentos de la memoria inyectada,
// parafraseados) varias veces dentro de la misma respuesta. Es un fallo
// estructural del modelo (demasiado pequeño para prompts largos), no de un
// texto concreto -- por eso el chequeo no busca ninguna frase conocida,
// solo si la propia respuesta se repite a si misma.
function looksLikeRepetitiveGarbage(text) {
  if (!text) return false;

  // Bug real, encontrado construyendo vNPU.CROSSCHECK (2026-08-17):
  // "No@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@" (33 caracteres, llama3.2:3b real,
  // en vivo) volvia con ok:true de callOllamaModel -- esta funcion exigia
  // texto >= 80 caracteres antes de comprobar NADA, asi que cualquier
  // basura corta se colaba sin control. Justo el caso mas probable cuando
  // se pide una respuesta de una frase (como hace CROSSCHECK), no una
  // rareza. Chequeo nuevo, sin gate de longitud: una misma letra/simbolo
  // repetido 8+ veces SEGUIDAS no es texto real en ningun idioma humano,
  // se detecta a cualquier longitud.
  //
  // Falso positivo real, encontrado en caza de bugs adversarial (2026-08-17):
  // el chequeo de arriba, sin excepciones, tambien marcaba como basura
  // separadores decorativos legitimos que un modelo puede generar de
  // verdad -- probado en vivo: "--------" (regla horizontal Markdown),
  // "========" (subrayado de titulo estilo RST/docstring de Python), un
  // separador de tabla ("|--------|--------|"), o una cabecera de bloque de
  // codigo con "========================". Cualquiera de estos, dentro de
  // una respuesta larga por lo demas correcta, la tiraba ENTERA (fallo real
  // en el camino de generacion fresca: `repetitive_garbage_detected` en
  // backend.js#callOllamaModel, CON fallo de circuit breaker registrado
  // contra un modelo inocente) o la marcaba como cache invalida sin motivo
  // real. El caso real que motivo el chequeo ("@" repetido) nunca usa estos
  // caracteres de trazado ASCII -- se excluyen especificamente de ESTE
  // chequeo (las comprobaciones de repeticion de lineas/fragmentos de mas
  // abajo siguen intactas para basura real que use estos mismos simbolos de
  // forma no decorativa).
  var REPEAT_RE = /(.)\1{7,}/g;
  var SEPARATOR_CHARS = '-=_*~#.·•';
  // Hueco real, encontrado en verificacion adversarial (2026-08-17, task
  // #108): la exclusion de arriba es incondicional, asi que una respuesta
  // que sea POR ENTERO un separador repetido ("========" como el texto
  // COMPLETO, no decorando una respuesta real) ahora pasaba sin marcar --
  // el caso contrario al que motivo la exclusion. Ninguna respuesta
  // legitima es unicamente puntuacion decorativa sin una sola palabra real,
  // asi que se comprueba antes de aplicar la exclusion: si, quitando
  // espacios, el texto entero son solo caracteres separadores, es basura
  // sin importar cual de ellos sea.
  var ONLY_SEPARATORS_RE = new RegExp('^[' + SEPARATOR_CHARS.replace(/[-\]\\^]/g, '\\$&') + '\\s]+$');
  if (ONLY_SEPARATORS_RE.test(text)) return true;
  var repeatMatch;
  while ((repeatMatch = REPEAT_RE.exec(text))) {
    if (SEPARATOR_CHARS.indexOf(repeatMatch[1]) === -1) return true;
  }

  if (text.length < 80) return false;

  var lines = text
    .split(/\n+/)
    .map(function (l) { return l.trim().toLowerCase(); })
    .filter(function (l) { return l.length >= 25; });
  var seenLines = {};
  for (var i = 0; i < lines.length; i++) {
    seenLines[lines[i]] = (seenLines[lines[i]] || 0) + 1;
    if (seenLines[lines[i]] >= 2) return true;
  }

  var normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  var chunkLen = 35;
  var step = 17;
  var seenChunks = {};
  for (var pos = 0; pos + chunkLen <= normalized.length; pos += step) {
    var chunk = normalized.slice(pos, pos + chunkLen);
    if (/^[\s.,;:!?-]*$/.test(chunk)) continue;
    seenChunks[chunk] = (seenChunks[chunk] || 0) + 1;
    if (seenChunks[chunk] >= 2) return true;
  }

  return false;
}

// ── DETECCION DE RESPUESTA FUERA DE TEMA ──
// Fallo real, confirmado en vivo (2026-08-10): llama3.2:1b, preguntado por
// el area de una parcela agricola (maiz/trigo/descanso), respondio con una
// tabla comparando TypeScript vs Python -- coherente, bien formateada, sin
// eco ni repeticion (looksLikeEcho/looksLikeRepetitiveGarbage no lo pillan,
// porque no es NINGUNO de esos dos fallos), simplemente sobre OTRO TEMA por
// completo. Ninguna verificacion existente hasta hoy comprobaba que la
// respuesta tuviera relacion real con la pregunta -- todas son
// estructurales (¿se repite?, ¿copia el prompt?), ninguna es de contenido.
//
// Enfoque deliberadamente simple y determinista (nada de embeddings, cero
// dependencias nuevas, mismo principio que math-verify.js): solapamiento de
// palabras significativas entre pregunta y respuesta. Si la respuesta es
// razonablemente larga y casi ninguna palabra de contenido de la pregunta
// aparece en ella, es la señal mas fuerte y barata de que se contesto a otra
// cosa. Lista de exclusion (STOPWORDS) deliberadamente generosa: incluye
// verbos instructivos habituales en la PREGUNTA ("calcula", "explica",
// "muestra", "desarrollo") que una respuesta legitima no tiene por que
// repetir literalmente -- si se contaran, inflarian el solapamiento y
// esconderian precisamente el caso que esto debe pillar.
var TOPIC_STOPWORDS = {
  'para': 1, 'como': 1, 'este': 1, 'esta': 1, 'estos': 1, 'estas': 1,
  'sobre': 1, 'cada': 1, 'entre': 1, 'desde': 1, 'hasta': 1, 'donde': 1,
  'cuando': 1, 'porque': 1, 'tiene': 1, 'tienen': 1, 'puede': 1, 'pueden': 1,
  'hacer': 1, 'hace': 1, 'debe': 1, 'deben': 1, 'quiero': 1, 'necesito': 1,
  'dame': 1, 'calcula': 1, 'calculo': 1, 'explica': 1, 'muestra': 1,
  'desarrollo': 1, 'resultado': 1, 'sera': 1, 'seran': 1, 'otro': 1,
  'otra': 1, 'otros': 1, 'otras': 1, 'todo': 1, 'toda': 1, 'todos': 1,
  'todas': 1, 'solo': 1, 'tambien': 1, 'mas': 1, 'menos': 1, 'asi': 1,
  'muy': 1, 'bien': 1, 'puedes': 1, 'responde': 1, 'frases': 1, 'pasos': 1,
  'paso': 1, 'siguiente': 1, 'final': 1, 'total': 1, 'forma': 1, 'manera': 1,
};

function stripAccentsLocal(s) {
  return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
}

function significantWords(text) {
  var words = stripAccentsLocal(text.toLowerCase()).match(/[a-z0-9]{5,}/g) || [];
  var out = {};
  words.forEach(function (w) { if (!TOPIC_STOPWORDS[w]) out[w] = true; });
  return out;
}

function looksLikeTopicMismatch(query, responseText) {
  if (!query || !responseText || responseText.length < 100) return false;
  var queryWords = significantWords(query);
  var queryKeys = Object.keys(queryWords);
  // Bug real, encontrado en vivo (2026-08-10) probando este mismo
  // detector con casos mas variados: "¿Como funciona la recoleccion de
  // basura en JavaScript?" respondida correctamente con terminologia
  // experta distinta ("motor V8", "heap", "generacional") tenia CERO
  // solapamiento lexico con la pregunta (ninguna prueba dice "V8" ni
  // "heap") y se marcaba como fuera de tema pese a ser correcta. Con
  // pocas palabras de contenido en la pregunta, UNA sola sustitucion de
  // vocabulario legitima (un termino tecnico mas preciso) puede vaciar
  // el solapamiento entero. El caso real que motivo este detector
  // (parcela agricola respondida con TypeScript vs Python) tenia mas de
  // una decena de palabras de contenido -- ahi un solapamiento cercano a
  // cero SI es una señal fiable, porque no es una sola sustitucion, es
  // ausencia total. El umbral sube de 3 a 6 para exigir esa misma
  // riqueza antes de fiarse de la métrica.
  if (queryKeys.length < 6) return false;
  var responseWords = significantWords(responseText);
  var matched = queryKeys.filter(function (w) { return responseWords[w]; }).length;
  var overlap = matched / queryKeys.length;
  return overlap < 0.15;
}

function normalizeToStandard(raw, agentId) {
  var format = detectFormat(raw);
  var result = {
    content: '',
    agent: agentId,
    timestamp: Date.now(),
    confidence: 0.5,
    sources: [],
    metadata: {},
    intent: null,
    entities: [],
    actions: [],
    format: format,
  };

  if (raw === null || raw === undefined) return result;

  if (format === 'openai_compatible') {
    result.content = extractContentFromOpenAI(raw);
    result.metadata.model = raw.model;
    result.metadata.usage = raw.usage;
    result.confidence = computeContentConfidence(result.content);
  } else if (format === 'json' || format === 'json_string') {
    var parsed = typeof raw === 'string' ? tryParseJSON(raw) : raw;
    if (parsed) {
      result.content = parsed.content || parsed.text || parsed.message || parsed.response || JSON.stringify(parsed);
      // Solo confiar en confidence explicito si de verdad viene del propio
      // agente (parsed.confidence); si no, medir el contenido en vez de
      // asumir 0.5 fijo.
      result.confidence = typeof parsed.confidence === 'number' ? parsed.confidence : computeContentConfidence(result.content);
      result.sources = parsed.sources || [];
      result.metadata = parsed.metadata || {};
      result.intent = parsed.intent || null;
      result.entities = parsed.entities || [];
      result.actions = parsed.actions || [];
    } else {
      result.content = String(raw);
      result.confidence = computeContentConfidence(result.content);
    }
  } else if (format === 'markdown' || format === 'markdown_code') {
    result.content = String(raw);
    result.confidence = computeContentConfidence(result.content);
    result.metadata.hasStructure = true;
  } else if (format === 'code') {
    result.content = String(raw);
    result.confidence = Math.min(computeContentConfidence(result.content) + 0.1, 0.95);
    result.metadata.isCode = true;
    result.metadata.language = detectLanguage(String(raw));
  } else if (format === 'html') {
    result.content = String(raw);
    result.confidence = computeContentConfidence(result.content);
    result.metadata.isHTML = true;
  } else {
    result.content = String(raw);
    result.confidence = computeContentConfidence(result.content);
  }

  if (!result.content) result.content = String(raw);
  result.confidence = Math.min(Math.max(result.confidence, 0), 1);

  return result;
}

// ═══════════════════════════════════════════
// INTENT EXTRACTION
// ═══════════════════════════════════════════

var INTENT_PATTERNS = [
  { intent: 'answer', patterns: /responde|answer|la respuesta|the answer|es que|result/i },
  { intent: 'question', patterns: /pregunta|question|que es|what is|como|how|por que|why/i },
  { intent: 'action', patterns: /ejecuta|execute|haz|do|crea|create|genera|generate|envia|send/i },
  { intent: 'analysis', patterns: /analiza|analyze|evalua|evaluate|compara|compare|estudia|study/i },
  { intent: 'summary', patterns: /resumen|summary|resume|summarize|sintetiza|synthesize/i },
  { intent: 'code', patterns: /codigo|code|programa|program|funcion|function|implementa|implement/i },
  { intent: 'search', patterns: /busca|search|encuentra|find|investiga|research/i },
  { intent: 'error', patterns: /error|fallo|fail|problema|problem|no puedo|cannot|unable/i },
  { intent: 'confirmation', patterns: /confirmo|confirm|acepto|accept|de acuerdo|agreed|si$/i },
  { intent: 'rejection', patterns: /rechazo|reject|no acepto|decline|en desacuerdo|disagree|no$/i },
];

function extractIntent(text) {
  if (!text) return { intent: 'unknown', confidence: 0 };
  var s = String(text).toLowerCase();
  var best = { intent: 'general', confidence: 0.3 };
  INTENT_PATTERNS.forEach(function(p) {
    if (p.patterns.test(s)) {
      var confidence = 0.7;
      if (s.length > 200) confidence += 0.1;
      if (s.indexOf('!') !== -1) confidence += 0.1;
      confidence = Math.min(confidence, 0.95);
      if (confidence > best.confidence) {
        best = { intent: p.intent, confidence: confidence };
      }
    }
  });
  return best;
}

// ═══════════════════════════════════════════
// ENTITY EXTRACTION
// ═══════════════════════════════════════════

var ENTITY_PATTERNS = [
  { type: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: 'url', pattern: /https?:\/\/[^\s]+/g },
  { type: 'phone', pattern: /[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/g },
  { type: 'date', pattern: /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g },
  { type: 'money', pattern: /[\$\€\£]\s*[\d,]+\.?\d*/g },
  { type: 'percentage', pattern: /\d+\.?\d*\s*%/g },
  { type: 'number', pattern: /\b\d{1,3}(,\d{3})*(\.\d+)?\b/g },
];

function extractEntities(text) {
  if (!text) return [];
  var entities = [];
  var s = String(text);
  ENTITY_PATTERNS.forEach(function(ep) {
    var matches = s.match(ep.pattern);
    if (matches) {
      matches.forEach(function(m) {
        entities.push({ type: ep.type, value: m, start: s.indexOf(m), length: m.length });
      });
    }
  });
  return entities;
}

// ═══════════════════════════════════════════
// ACTION DETECTION
// ═══════════════════════════════════════════

var ACTION_PATTERNS = [
  { action: 'deploy', pattern: /deploy|despliega|publica|publish|push/i },
  { action: 'send_email', pattern: /envia[^.:;!?\n]{0,40}email|send[^.:;!?\n]{0,40}email|manda[^.:;!?\n]{0,40}correo/i },
  { action: 'create_file', pattern: /crea[^.:;!?\n]{0,40}arch|create[^.:;!?\n]{0,40}file|nuevo[^.:;!?\n]{0,40}arch/i },
  { action: 'update_record', pattern: /actualiza|update|modifica|modify|cambia|change/i },
  { action: 'delete', pattern: /elimina|delete|borra|remove|destruye|destroy/i },
  { action: 'search', pattern: /busca|search|encuentra|find|google|查询/i },
  { action: 'execute_code', pattern: /ejecuta[^.:;!?\n]{0,40}cod|run[^.:;!?\n]{0,40}code|exec|compila|compile/i },
  { action: 'approve', pattern: /aprueba|approve|autoriza|authorize|valida|validate/i },
  { action: 'reject', pattern: /rechaza|reject|niega|deny|cancela|cancel/i },
  { action: 'notify', pattern: /notifica|notify|avisa|alert|informa|inform/i },
];

function detectActions(text) {
  if (!text) return [];
  var actions = [];
  var s = String(text);
  ACTION_PATTERNS.forEach(function(ap) {
    if (ap.pattern.test(s)) {
      actions.push({ action: ap.action, confidence: 0.7, source: 'pattern_match' });
    }
  });
  return actions;
}

// ═══════════════════════════════════════════
// CONFIDENCE CALIBRATION
// ═══════════════════════════════════════════

var _agentAccuracy = {};

function calibrateConfidence(agentId, historicalAccuracy) {
  _agentAccuracy[agentId] = {
    accuracy: historicalAccuracy,
    // Bug real: precedencia de operadores -- `x || 0 + 1` se evalua como
    // `x || (0 + 1)`, no `(x || 0) + 1`. Con un valor previo truthy (>=1),
    // el `+1` nunca se ejecutaba y samples se quedaba congelado en 1 para
    // siempre en vez de contar cuantas veces se calibro. Sin caller real
    // hoy (getCalibratedConfidence cae siempre al fallback sin calibrar),
    // pero corregido para cuando se active.
    samples: ((_agentAccuracy[agentId] || {}).samples || 0) + 1,
    updatedAt: Date.now(),
  };
}

function getCalibratedConfidence(agentId, rawConfidence) {
  var calibration = _agentAccuracy[agentId];
  if (!calibration) return rawConfidence;
  var adjustment = (calibration.accuracy - 0.5) * 0.3;
  return Math.min(Math.max(rawConfidence + adjustment, 0), 1);
}

// ═══════════════════════════════════════════
// PROTOCOL BRIDGING
// ═══════════════════════════════════════════

function registerAgent(agentId, config) {
  _agents[agentId] = {
    id: agentId,
    type: config.type || 'custom',
    name: config.name || agentId,
    protocols: config.protocols || ['api'],
    formats: config.formats || ['json'],
    capabilities: config.capabilities || ['text'],
    endpoint: config.endpoint || null,
    auth: config.auth || null,
    metadata: config.metadata || {},
    registeredAt: Date.now(),
    lastSeen: null,
    status: 'registered',
  };
  return { ok: true, agentId: agentId };
}

function getAgent(agentId) {
  return _agents[agentId] || null;
}

function listAgents() {
  return Object.keys(_agents).map(function(id) {
    return {
      id: _agents[id].id,
      type: _agents[id].type,
      name: _agents[id].name,
      capabilities: _agents[id].capabilities,
      status: _agents[id].status,
      lastSeen: _agents[id].lastSeen,
    };
  });
}

function updateAgentStatus(agentId, status) {
  if (!_agents[agentId]) return { ok: false, error: 'agent_not_found' };
  _agents[agentId].status = status;
  _agents[agentId].lastSeen = Date.now();
  return { ok: true };
}

// ═══════════════════════════════════════════
// TRANSLATE OUTPUT (for agent consumption)
// ═══════════════════════════════════════════

function translateForAgent(normalized, targetAgentId) {
  var targetAgent = _agents[targetAgentId];
  if (!targetAgent) return { format: 'json', data: normalized };

  var preferredFormat = targetAgent.formats[0] || 'json';
  if (preferredFormat === 'json') {
    return {
      format: 'json',
      data: {
        task: normalized.intent,
        content: normalized.content,
        context: normalized.metadata,
        confidence: normalized.confidence,
        entities: normalized.entities,
        actions: normalized.actions,
      },
    };
  }
  if (preferredFormat === 'markdown') {
    var md = '';
    if (normalized.intent) md += '**Tarea:** ' + normalized.intent + '\n\n';
    md += normalized.content;
    if (normalized.sources.length) {
      md += '\n\n**Fuentes:**\n' + normalized.sources.map(function(s) { return '- ' + s; }).join('\n');
    }
    return { format: 'markdown', data: md };
  }
  return { format: 'text', data: normalized.content };
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function extractContentFromOpenAI(response) {
  if (response.choices && response.choices[0]) {
    var choice = response.choices[0];
    if (choice.message) return choice.message.content || '';
    if (choice.text) return choice.text;
  }
  if (response.candidates && response.candidates[0]) {
    return response.candidates[0].content || '';
  }
  if (response.content) return response.content;
  return JSON.stringify(response);
}

function tryParseJSON(s) {
  try { return JSON.parse(s); } catch(e) { return null; }
}

function detectLanguage(code) {
  if (code.indexOf('def ') !== -1 && code.indexOf('import ') !== -1) return 'python';
  if (code.indexOf('function ') !== -1 && code.indexOf('const ') !== -1) return 'javascript';
  if (code.indexOf('func ') !== -1 && code.indexOf('package ') !== -1) return 'go';
  if (code.indexOf('fn ') !== -1 && code.indexOf('let mut ') !== -1) return 'rust';
  if (code.indexOf('public class ') !== -1) return 'java';
  if (code.indexOf('#include') !== -1) return 'cpp';
  if (code.indexOf('<html') !== -1) return 'html';
  if (code.indexOf('SELECT ') !== -1) return 'sql';
  return 'unknown';
}

function formatForPrompt(entries) {
  if (!entries || !entries.length) return '';
  return entries.map(function(e) {
    return '[' + e.agent + '] ' + (e.intent || 'general') + ': ' + (e.content || '').slice(0, 200);
  }).join('\n');
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  AGENT_TYPES,
  detectFormat,
  normalizeToStandard,
  computeContentConfidence,
  looksLikeContextLeak,
  looksLikeEcho,
  looksLikeRepetitiveGarbage,
  looksLikeTopicMismatch,
  looksLikeRefusal,
  stripLeakedPreamble,
  extractIntent,
  extractEntities,
  detectActions,
  calibrateConfidence,
  getCalibratedConfidence,
  registerAgent,
  getAgent,
  listAgents,
  updateAgentStatus,
  translateForAgent,
  formatForPrompt,
  STANDARD_SCHEMA,
};
