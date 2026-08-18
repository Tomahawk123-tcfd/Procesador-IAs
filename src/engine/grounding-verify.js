// ── VERIFICACION DE ANCLAJE A FUENTES (GROUNDING / ATTRIBUTION), DETERMINISTA ──
// (2026-08-18) Sexto verificador determinista de LinkCore, junto a
// math-verify.js (aritmetica), code-verify.js (sintaxis real), output-verify.js
// (ejecucion real), coherence-verify.js (comparativas), temporal-verify.js
// (aritmetica de años) y structural-verify.js (coherencia estructural).
//
// Todos los anteriores comparten un limite real y no reconocido hasta ahora:
// comprueban la respuesta CONTRA SI MISMA (¿cuadra su propia cuenta?, ¿compila
// su propio codigo?, ¿se contradice consigo misma?). Ninguno la compara contra
// la FUENTE EXTERNA que la respuesta dice estar citando. Ese es el fallo que
// bloquea el despliegue de RAG/agentes en empresa: la respuesta cita cuatro
// documentos y mete dentro una cifra, una fecha, un nombre, una cita entrecomil-
// lada o un identificador de fuente que NO esta en ninguno de esos documentos.
// Aritmeticamente impecable, sintacticamente valida, internamente coherente --
// y sin respaldo.
//
// Este modulo cierra ese hueco sin generacion: solo analisis de texto, mismo
// perfil de latencia que el resto (milisegundos, nunca un modelo de por medio).
//
// PRINCIPIO DE DISEÑO, heredado de una medicion real de este proyecto: en
// math-verify.js#verifyOperationMatchesQuery se midio sobre 1158 respuestas
// reales que 49 de 49 avisos eran FALSOS POSITIVOS, y la conclusion fue exigir
// contexto real antes de avisar ("un verificador que avisa en prosa normal
// entrena al lector a ignorarlo, que es peor que no tenerlo"). Aqui se aplica
// la misma disciplina en cada canal: ante la duda, NO se avisa. Cada tradeoff
// que produce un falso negativo a proposito esta documentado en el canal que
// lo acepta, nunca escondido.
//
// LIMITE HONESTO DEL MODULO ENTERO: comprueba PRESENCIA en las fuentes que se
// le pasan, no verdad. Si la fuente esta equivocada, o si la fuente correcta no
// se recupero y no llega aqui, este verificador marcara como "sin respaldo" una
// afirmacion que puede ser cierta, y dara por buena una que puede ser falsa
// pero que la fuente repite. Es un detector de ATRIBUCION NO RESPALDADA, no un
// detector de mentiras.

import { safeEval, normalizeExpr, stripCurrencySymbols } from './math-verify.js';
import {
  normalizeEntity,
  extractClaims,
  corePredicateValue,
  predicateTokenOverlap,
} from './structural-verify.js';

var GROUNDING_CHANNELS = {
  QUOTE: 'FABRICATED_QUOTE',
  NUMBER: 'UNSUPPORTED_NUMBER',
  DATE: 'UNSUPPORTED_DATE',
  ENTITY: 'UNSUPPORTED_ENTITY',
  CITATION: 'DANGLING_CITATION',
  CONTRADICTION: 'CONTRADICTED_CLAIM',
  NO_SOURCES: 'NO_SOURCES',
};

var SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

// ═══════════════════════════════════════════
// NORMALIZACION COMPARTIDA
// ═══════════════════════════════════════════

function stripAccents(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Forma "laxa" para comparacion literal: minusculas, sin acentos, y TODO lo que
// no sea alfanumerico colapsado a un espacio. Deliberadamente agresiva: iguala
// comillas curvas y rectas, guion normal y raya, coma de mas, punto final,
// salto de linea vs espacio. Consecuencia aceptada a proposito: dos textos que
// solo difieren en puntuacion se consideran el mismo texto -- eso PIERDE algun
// caso raro (una cita alterada solo por puntuacion) a cambio de no marcar como
// "cita inventada" una cita real reformateada, que es el falso positivo que de
// verdad haria inutil el canal.
function looseForm(text) {
  return stripAccents(String(text == null ? '' : text).toLowerCase())
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Forma laxa con un espacio de guarda a cada lado, para poder buscar
// " token " sin que "annex" haga match dentro de "annexed".
function paddedLoose(text) {
  return ' ' + looseForm(text) + ' ';
}

// Sustituye un patron por espacios de la MISMA longitud (respetando saltos de
// linea) en vez de borrarlo: asi los indices del texto original siguen siendo
// validos para extraer la frase de contexto de cada hallazgo.
function blankOut(text, re) {
  return String(text == null ? '' : text).replace(re, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
}

var FENCED_CODE_RE = /```[\s\S]*?```/g;
var INLINE_CODE_RE = /`[^`\n]+`/g;

// El codigo se saca de TODOS los canales antes de empezar. Un bloque de codigo
// esta lleno de literales entrecomillados, numeros magicos, identificadores en
// CamelCase y versiones que no tienen por que estar en la fuente citada --
// dejarlos dentro convierte cualquier respuesta tecnica en una lluvia de
// falsos positivos. code-verify.js ya cubre el codigo por su cuenta.
function stripCodeSpans(text) {
  return blankOut(blankOut(text, FENCED_CODE_RE), INLINE_CODE_RE);
}

function sentenceAround(text, index) {
  if (!text || index == null || index < 0) return String(text || '').trim();
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

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ═══════════════════════════════════════════
// PREPARACION DE FUENTES
// ═══════════════════════════════════════════

// Acepta [{id, text}] o [string] (en cuyo caso el id es la posicion 1-based).
// Una fuente sin texto util se cuenta como PROVISTA pero no USABLE -- esa
// distincion es la diferencia entre "revisado a fondo" y "no habia nada contra
// que revisar", y se expone en el resumen.
function prepareSources(sources) {
  var list = Array.isArray(sources) ? sources : (sources ? [sources] : []);
  return list.map(function (s, i) {
    var obj = (s && typeof s === 'object') ? s : { id: String(i + 1), text: String(s == null ? '' : s) };
    var id = obj.id != null && String(obj.id).trim() ? String(obj.id).trim() : String(i + 1);
    var raw = String(obj.text == null ? '' : obj.text);
    var noCode = stripCodeSpans(raw);
    return {
      id: id,
      index: i + 1,
      text: raw,
      noCode: noCode,
      loose: paddedLoose(noCode),
      usable: noCode.trim().length > 0,
    };
  });
}

// ═══════════════════════════════════════════
// CANAL 1: CITA INVENTADA (FABRICATED_QUOTE)
// ═══════════════════════════════════════════
//
// Señal de mayor confianza y mayor gravedad del modulo: una cita entrecomillada
// es una afirmacion explicita de "esto es literalmente lo que dice la fuente".
// Si no aparece literalmente en ninguna fuente, no es una parafrasis discutible,
// es una atribucion falsa.
//
// Solo comillas DOBLES (rectas, curvas y guillemets). Las comillas simples
// quedan fuera a proposito: en ingles el apostrofo de posesivo/contraccion
// ("the Provider's", "doesn't") las hace inservibles como delimitador, y el
// coste de intentar distinguirlos es mas falso positivo del que evita.
var QUOTE_RE = /"([^"\n]{1,600})"|“([^”\n]{1,600})”|«([^»\n]{1,600})»/g;

// Minimos deliberados: una cita de menos de 4 palabras casi nunca es una cita
// textual de un documento -- es un termino definido ("Agreement"), un valor
// entrecomillado, o comillas de enfasis. Marcarlas dispararia en casi toda
// respuesta juridica o tecnica normal.
var DEFAULT_MIN_QUOTE_WORDS = 4;
var DEFAULT_MIN_QUOTE_CHARS = 15;

function detectFabricatedQuotes(answerNoCode, prepared, opts) {
  var minWords = opts.minQuoteWords || DEFAULT_MIN_QUOTE_WORDS;
  var minChars = opts.minQuoteChars || DEFAULT_MIN_QUOTE_CHARS;
  var findings = [];
  var checked = 0;
  var seen = {};
  var m;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(answerNoCode)) !== null) {
    var inner = m[1] || m[2] || m[3] || '';
    if (QUOTE_RE.lastIndex === m.index) QUOTE_RE.lastIndex++;
    var loose = looseForm(inner);
    if (!loose) continue;
    var words = loose.split(' ').filter(Boolean);
    if (words.length < minWords || loose.length < minChars) continue;
    if (seen[loose]) continue;
    seen[loose] = true;
    checked++;
    var found = null;
    for (var i = 0; i < prepared.length; i++) {
      if (!prepared[i].usable) continue;
      if (prepared[i].loose.indexOf(loose) !== -1) { found = prepared[i]; break; }
    }
    if (found) continue;
    findings.push({
      channel: GROUNDING_CHANNELS.QUOTE,
      severity: 'high',
      claim: '"' + truncate(inner, 200) + '"',
      detail: 'La respuesta presenta este texto como cita literal, pero no aparece de forma literal en ninguna de las ' +
        prepared.length + ' fuente(s) aportada(s) (comparacion tolerante a espacios, puntuacion, acentos y mayusculas).',
      context: truncate(sentenceAround(answerNoCode, m.index), 220),
    });
  }
  return { findings: findings, checked: checked };
}

// ═══════════════════════════════════════════
// CANAL 2: NUMERO SIN RESPALDO (UNSUPPORTED_NUMBER)
// ═══════════════════════════════════════════
//
// QUE NUMEROS SE CONSIDERAN COMPROBABLES, y por que (decision explicita, no
// implicita): un numero solo entra al canal si es una AFIRMACION DE VALOR, no
// un elemento de formato o de navegacion del documento. En concreto entra si
//   (a) lleva simbolo/palabra de moneda, o
//   (b) es un porcentaje, o
//   (c) lleva una unidad reconocible pegada (dias, meses, segundos, MB,
//       peticiones, registros, usuarios...), o
//   (d) es "preciso": tiene decimales/separador de miles, o 4+ digitos.
// Y queda FUERA si
//   (e) esta dentro de un marcador de cita ("[3]"), o
//   (f) lo precede una palabra estructural (seccion, clausula, paso, figura,
//       tabla, pagina, anexo, fuente...) -- esos son referencias, y su canal
//       propio es DANGLING_CITATION, no este, o
//   (g) es un marcador de lista al principio de linea ("1.", "2)"), o
//   (h) es un año suelto de 4 digitos sin moneda/unidad/porcentaje -- ese es
//       territorio de UNSUPPORTED_DATE, y contarlo aqui tambien produciria el
//       mismo hallazgo por duplicado en dos canales.
// Un entero suelto de 1-3 digitos sin moneda, unidad ni porcentaje NO se
// comprueba: es el caso donde el numero suele ser generico ("los 3 casos",
// "las 2 partes") y donde el ruido superaria a la señal.

var NUMBER_RE = /-?\d[\d.,]*\d|-?\d/g;

var SCALE_WORDS = [
  { re: /^\s*(millions?|mill[oó]n|millones)\b/i, factor: 1e6 },
  { re: /^\s*(billions?|bill[oó]n|billones)\b/i, factor: 1e9 },
  { re: /^\s*(thousands?)\b/i, factor: 1e3 },
];

var UNIT_AFTER_RE = /^\s*(ms|milliseconds?|segundos?|seconds?|minutes?|minutos?|hours?|horas?|days?|d[ií]as?|weeks?|semanas?|months?|meses|years?|a[nñ]os?|kb|mb|gb|tb|bytes?|requests?|peticiones|records?|registros|rows?|filas?|users?|usuarios?|employees?|empleados?|tenants?|dollars?|d[oó]lares?|euros?|usd|eur|gbp|points?|puntos?|bps|items?|licen[cs]es?|licencias?|seats?|calls?|llamadas?)\b/i;

var CURRENCY_WORD_AFTER_RE = /^\s*(usd|eur|gbp|dollars?|d[oó]lares?|euros?|libras?)\b/i;

var STRUCTURAL_PREFIX_RE = /(secci[oó]n|section|cl[aá]usula|clause|art[ií]culo|article|p[aá]rrafo|paragraph|subsection|apartado|paso|step|item|figura|figure|tabla|table|p[aá]gina|page|ap[eé]ndice|appendix|anexo|annex|exhibit|schedule|cap[ií]tulo|chapter|parte|part|nota|note|fuente|source|documento|document|doc|referencia|reference|ref|§)\s*#?\s*$/i;

var YEAR_ONLY_RE = /^(1[5-9]\d{2}|20\d{2}|21\d{2})$/;

// Notacion es-ES de miles con punto ("1.234.567"): normalizeExpr() de
// math-verify.js resuelve la coma anglosajona pero no esta, y parseFloat
// leeria 1.234. Se resuelve aqui, antes de delegar, con la misma regla
// estrecha que ya usa normalizeExpr para la coma: grupos de EXACTAMENTE 3
// digitos.
function parseNumericToken(raw) {
  var s = String(raw == null ? '' : raw).replace(/\s/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  var v = parseFloat(normalizeExpr(s));
  return isNaN(v) ? null : v;
}

function bracketRanges(text) {
  var ranges = [];
  var re = /\[[^\]\n]{0,60}\]/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return ranges;
}

function inRanges(ranges, idx) {
  for (var i = 0; i < ranges.length; i++) {
    if (idx >= ranges[i][0] && idx < ranges[i][1]) return true;
  }
  return false;
}

function extractNumbers(text) {
  var out = [];
  var brackets = bracketRanges(text);
  var m;
  var re = new RegExp(NUMBER_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    if (re.lastIndex === m.index) re.lastIndex++;
    var raw = m[0];
    var idx = m.index;
    var value = parseNumericToken(raw);
    if (value === null) continue;

    var before = text.slice(Math.max(0, idx - 30), idx);
    var after = text.slice(idx + raw.length, idx + raw.length + 24);

    var hasCurrency = /[$€£¥]\s*$/.test(before) || CURRENCY_WORD_AFTER_RE.test(after);
    var hasPercent = /^\s*(%|percent\b|por\s+ciento\b)/i.test(after);
    var scale = 0;
    for (var s = 0; s < SCALE_WORDS.length; s++) {
      if (SCALE_WORDS[s].re.test(after)) { scale = SCALE_WORDS[s].factor; break; }
    }
    var unit = UNIT_AFTER_RE.test(after) ? after.trim().split(/\s+/)[0] : null;
    var structural = STRUCTURAL_PREFIX_RE.test(before);
    var listMarker = /(^|\n)[ \t]*$/.test(before) && /^[.)]\s/.test(after);
    var inBracket = inRanges(brackets, idx);
    var digits = raw.replace(/[^\d]/g, '');

    var effectiveValue = scale ? value * scale : value;
    var precise = /[.,]/.test(raw) || digits.length >= 4;
    var yearOnly = YEAR_ONLY_RE.test(raw) && !hasCurrency && !hasPercent && !unit && !scale;

    var checkable = !structural && !listMarker && !inBracket && !yearOnly &&
      (hasCurrency || hasPercent || !!unit || !!scale || precise);

    out.push({
      raw: raw, index: idx, value: value, effectiveValue: effectiveValue,
      hasCurrency: hasCurrency, hasPercent: hasPercent, unit: unit, scale: scale,
      checkable: checkable, structural: structural, yearOnly: yearOnly,
    });
  }
  return out;
}

var DEFAULT_NUMBER_TOLERANCE_PCT = 0.5;

function numberPresentIn(value, sourceNumbers, tolerancePct) {
  for (var i = 0; i < sourceNumbers.length; i++) {
    var v = sourceNumbers[i];
    if (v === value) return true;
    if (v === 0) continue;
    if (Math.abs(v - value) / Math.abs(v) * 100 <= tolerancePct) return true;
  }
  return false;
}

// Derivacion: un numero que NO esta en la fuente pero que SE SIGUE de numeros
// que si estan no es una fabricacion -- es una cuenta. Es el falso positivo mas
// obvio de este canal y se cierra reutilizando el evaluador ya existente
// (safeEval/normalizeExpr de math-verify.js, nunca eval()).
// Dos formas cubiertas, las dos que aparecen de verdad en respuestas de
// empresa:
//   1. expresion aritmetica explicita en la respuesta ("48.300.000 - 41.900.000
//      = 6.400.000"): se evalua y se comprueba que TODOS sus operandos estan en
//      la fuente.
//   2. "N% of M" / "N% de M": porcentaje aplicado a una cifra de la fuente.
// Si el numero candidato es un porcentaje, tambien se acepta el valor de la
// expresion multiplicado por 100 (una razon calculada y luego presentada en
// porcentaje: "6.400.000 / 41.900.000 = 15,3%").
// Lo que NO cubre, a proposito: derivaciones en prosa sin expresion escrita
// ("la suma de ambos trimestres"), cadenas donde un operando es a su vez un
// intermedio derivado, y unidades ("12 meses x 4" no comprueba que las unidades
// cuadren). Preferimos el falso negativo.
var EXPR_RE = /\d[\d.,]*(?:\s*[+\-−*/^×x÷]\s*\(?\d[\d.,]*\)?)+/g;
var PERCENT_OF_RE = /(\d[\d.,]*)\s*%\s*(?:of|de|del|sobre)\s*[$€£¥]?\s*(\d[\d.,]*)\s*(millions?|mill[oó]n|millones|billions?|bill[oó]n|billones|thousands?)?/gi;

// Bug real, encontrado en verificacion adversarial (2026-08-18): una
// derivacion escrita entre parentesis en la propia respuesta ("...per
// year ($2,400,000 / 3).") capturaba "2,400,000 / 3)" -- el `\)?` opcional
// de EXPR_RE, pensado para un operando individual parentizado, se comia el
// parentesis de CIERRE de la expresion completa sin su apertura (que
// queda fuera del match porque este tiene que empezar en un digito). Ese
// parentesis suelto rompe safeEval() (parentesis desequilibrados), asi que
// la derivacion nunca se registraba y un numero correctamente derivado por
// aritmetica escrita en el propio texto se marcaba como "no respaldado" --
// exactamente el falso positivo que este canal existe para evitar. Se
// recorta cualquier parentesis de cierre sobrante al final de la captura
// antes de evaluar, sin tocar el regex (que sigue sirviendo para el caso
// de un operando individual bien parentizado, "(3)").
function stripUnbalancedTrailingParens(expr) {
  var opens = 0, closes = 0;
  for (var i = 0; i < expr.length; i++) {
    if (expr[i] === '(') opens++;
    else if (expr[i] === ')') closes++;
  }
  var extra = closes - opens;
  var out = expr;
  while (extra > 0 && out.length && out[out.length - 1] === ')') {
    out = out.slice(0, -1);
    extra--;
  }
  return out;
}

function buildDerivations(answerNoCode) {
  var text = stripCurrencySymbols(answerNoCode);
  var derivations = [];
  var m;
  EXPR_RE.lastIndex = 0;
  while ((m = EXPR_RE.exec(text)) !== null) {
    if (EXPR_RE.lastIndex === m.index) EXPR_RE.lastIndex++;
    var raw = stripUnbalancedTrailingParens(m[0]);
    var value = safeEval(normalizeExpr(raw));
    if (value === null) continue;
    var operandTokens = raw.match(/\d[\d.,]*/g) || [];
    var operands = operandTokens.map(parseNumericToken).filter(function (v) { return v !== null; });
    if (!operands.length) continue;
    derivations.push({ expr: raw.trim(), value: value, operands: operands });
  }
  PERCENT_OF_RE.lastIndex = 0;
  while ((m = PERCENT_OF_RE.exec(text)) !== null) {
    if (PERCENT_OF_RE.lastIndex === m.index) PERCENT_OF_RE.lastIndex++;
    var pct = parseNumericToken(m[1]);
    var base = parseNumericToken(m[2]);
    if (pct === null || base === null) continue;
    var factor = 1;
    if (m[3]) {
      for (var s = 0; s < SCALE_WORDS.length; s++) {
        if (SCALE_WORDS[s].re.test(' ' + m[3])) { factor = SCALE_WORDS[s].factor; break; }
      }
    }
    derivations.push({ expr: m[0].trim(), value: pct / 100 * base * factor, operands: [pct, base * factor] });
  }
  return derivations;
}

function isDerived(candidate, isPercent, derivations, sourceNumbers, tolerancePct) {
  for (var i = 0; i < derivations.length; i++) {
    var d = derivations[i];
    var matches = closeEnough(d.value, candidate, tolerancePct) ||
      (isPercent && closeEnough(d.value * 100, candidate, tolerancePct));
    if (!matches) continue;
    var allOperandsGrounded = d.operands.every(function (op) {
      return numberPresentIn(op, sourceNumbers, tolerancePct);
    });
    if (allOperandsGrounded) return d;
  }
  return null;
}

function closeEnough(a, b, tolerancePct) {
  if (a === b) return true;
  if (b === 0) return a === 0;
  return Math.abs(a - b) / Math.abs(b) * 100 <= tolerancePct;
}

function detectUnsupportedNumbers(answerNoCode, prepared, knownLoose, opts) {
  var tolerancePct = typeof opts.numberTolerancePct === 'number' ? opts.numberTolerancePct : DEFAULT_NUMBER_TOLERANCE_PCT;
  var sourceNumbers = [];
  prepared.forEach(function (s) {
    if (!s.usable) return;
    extractNumbers(s.noCode).forEach(function (n) {
      sourceNumbers.push(n.effectiveValue);
      if (n.scale) sourceNumbers.push(n.value);
    });
  });
  if (opts.question) {
    extractNumbers(String(opts.question)).forEach(function (n) { sourceNumbers.push(n.effectiveValue); });
  }

  var derivations = buildDerivations(answerNoCode);
  var candidates = extractNumbers(answerNoCode).filter(function (n) { return n.checkable; });
  var findings = [];
  var seen = {};
  candidates.forEach(function (n) {
    if (numberPresentIn(n.effectiveValue, sourceNumbers, tolerancePct)) return;
    // Un numero escrito con separadores puede coincidir con la fuente como
    // CADENA aunque el valor no cuadre (versiones "3.1", identificadores).
    if (knownLoose.indexOf(' ' + looseForm(n.raw) + ' ') !== -1) return;
    var derived = isDerived(n.effectiveValue, n.hasPercent, derivations, sourceNumbers, tolerancePct);
    if (derived) return;
    var key = n.raw + '|' + n.effectiveValue;
    if (seen[key]) return;
    seen[key] = true;
    findings.push({
      channel: GROUNDING_CHANNELS.NUMBER,
      severity: (n.hasCurrency || n.hasPercent) ? 'high' : 'medium',
      claim: n.raw + (n.hasPercent ? '%' : '') + (n.unit ? ' ' + n.unit : ''),
      detail: 'La respuesta afirma este valor pero no aparece en ninguna fuente (tolerancia ' + tolerancePct +
        '%), y no se deriva de ninguna operacion escrita en la propia respuesta sobre cifras de la fuente.',
      context: truncate(sentenceAround(answerNoCode, n.index), 220),
    });
  });
  return { findings: findings, checked: candidates.length };
}

// ═══════════════════════════════════════════
// CANAL 3: FECHA SIN RESPALDO (UNSUPPORTED_DATE)
// ═══════════════════════════════════════════
//
// Fechas completas (ISO, "14 March 2024", "March 14, 2024", "14 de marzo de
// 2024", "14/03/2024") y años sueltos. Una fecha completa se compara por clave
// canonica AAAA-MM-DD; un año suelto, contra el conjunto de años de la fuente
// (incluidos los años de sus fechas completas).
// La forma con barras es ambigua (dd/mm vs mm/dd) y se acepta como respaldada
// si CUALQUIERA de las dos lecturas esta en la fuente -- ante ambigüedad, no se
// avisa.
// TRADEOFF ACEPTADO: un año que la respuesta usa sobre si misma y no sobre el
// tema de la fuente ("a fecha de hoy, 2026") se marcara como no respaldado. No
// se intenta distinguir deterministamente ese uso; el canal devuelve severidad
// media justo para que un caller pueda filtrarlo.

var MONTHS = {
  january: 1, jan: 1, enero: 1, ene: 1,
  february: 2, feb: 2, febrero: 2,
  march: 3, mar: 3, marzo: 3,
  april: 4, apr: 4, abril: 4, abr: 4,
  may: 5, mayo: 5,
  june: 6, jun: 6, junio: 6,
  july: 7, jul: 7, julio: 7,
  august: 8, aug: 8, agosto: 8, ago: 8,
  september: 9, sep: 9, sept: 9, septiembre: 9, setiembre: 9,
  october: 10, oct: 10, octubre: 10,
  november: 11, nov: 11, noviembre: 11,
  december: 12, dec: 12, diciembre: 12, dic: 12,
};

var ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
var MDY_DATE_RE = /\b([A-Za-zÀ-ÿ]{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
var DMY_DATE_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([A-Za-zÀ-ÿ]{3,12})\.?\s+(?:de\s+)?(\d{4})\b/g;
var SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
var YEAR_RE_G = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/g;

function dateKey(y, mo, d) {
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function monthNumber(word) {
  return MONTHS[stripAccents(String(word || '').toLowerCase())] || null;
}

function extractDates(text) {
  var dates = [];
  var consumed = [];
  function push(keys, raw, index) {
    dates.push({ keys: keys, raw: raw, index: index, kind: 'full' });
    consumed.push([index, index + raw.length]);
  }
  var m;
  ISO_DATE_RE.lastIndex = 0;
  while ((m = ISO_DATE_RE.exec(text)) !== null) {
    push([dateKey(m[1], parseInt(m[2], 10), parseInt(m[3], 10))], m[0], m.index);
  }
  MDY_DATE_RE.lastIndex = 0;
  while ((m = MDY_DATE_RE.exec(text)) !== null) {
    var mo1 = monthNumber(m[1]);
    if (!mo1) continue;
    push([dateKey(m[3], mo1, parseInt(m[2], 10))], m[0], m.index);
  }
  DMY_DATE_RE.lastIndex = 0;
  while ((m = DMY_DATE_RE.exec(text)) !== null) {
    var mo2 = monthNumber(m[2]);
    if (!mo2) continue;
    push([dateKey(m[3], mo2, parseInt(m[1], 10))], m[0], m.index);
  }
  SLASH_DATE_RE.lastIndex = 0;
  while ((m = SLASH_DATE_RE.exec(text)) !== null) {
    push([dateKey(m[3], parseInt(m[2], 10), parseInt(m[1], 10)), dateKey(m[3], parseInt(m[1], 10), parseInt(m[2], 10))], m[0], m.index);
  }
  var brackets = bracketRanges(text);
  YEAR_RE_G.lastIndex = 0;
  while ((m = YEAR_RE_G.exec(text)) !== null) {
    if (inRanges(consumed, m.index) || inRanges(brackets, m.index)) continue;
    dates.push({ keys: [], year: m[1], raw: m[0], index: m.index, kind: 'year' });
  }
  return dates;
}

function detectUnsupportedDates(answerNoCode, prepared, opts) {
  var sourceKeys = {};
  var sourceYears = {};
  function indexText(t) {
    extractDates(t).forEach(function (d) {
      d.keys.forEach(function (k) { sourceKeys[k] = true; sourceYears[k.slice(0, 4)] = true; });
      if (d.kind === 'year') sourceYears[d.year] = true;
    });
  }
  prepared.forEach(function (s) { if (s.usable) indexText(s.noCode); });
  if (opts.question) indexText(String(opts.question));

  var candidates = extractDates(answerNoCode);
  var findings = [];
  var seen = {};
  candidates.forEach(function (d) {
    var grounded;
    if (d.kind === 'full') {
      grounded = d.keys.some(function (k) { return !!sourceKeys[k]; });
    } else {
      grounded = !!sourceYears[d.year];
    }
    if (grounded) return;
    var key = d.kind + '|' + d.raw;
    if (seen[key]) return;
    seen[key] = true;
    findings.push({
      channel: GROUNDING_CHANNELS.DATE,
      severity: d.kind === 'full' ? 'high' : 'medium',
      claim: d.raw,
      detail: d.kind === 'full'
        ? 'Fecha concreta afirmada por la respuesta que no aparece en ninguna fuente aportada.'
        : 'Año afirmado por la respuesta que no aparece en ninguna fuente aportada.',
      context: truncate(sentenceAround(answerNoCode, d.index), 220),
    });
  });
  return { findings: findings, checked: candidates.length };
}

// ═══════════════════════════════════════════
// CANAL 4: ENTIDAD SIN RESPALDO (UNSUPPORTED_ENTITY)
// ═══════════════════════════════════════════
//
// Entidad = secuencia de 2+ tokens capitalizados (con conectores en minuscula
// permitidos: of/the/and/for/de/del/y/&). Un solo token queda fuera: en ingles
// y español cualquier palabra a principio de frase va en mayuscula y el ruido
// seria total.
// Se recortan por delante los arranques de frase capitalizados que no son parte
// del nombre ("According", "However", "Section"...). La comparacion usa
// normalizeEntity() de structural-verify.js -- la misma que ya se endurecio
// contra el falso positivo por tilde ("Paris"/"París").
// RELAJACION DELIBERADA: se da por respaldada la entidad si su forma completa
// aparece en la fuente O si aparece cualquiera de sus BIGRAMAS consecutivos.
// Motivo: "Northwind Technologies Inc." frente a "Northwind Technologies" en la
// fuente, o "Master Services Agreement" frente a "the Master Services
// Agreement, dated..." son la misma entidad; exigir la cadena entera produciria
// falsos positivos en casi toda respuesta. Un nombre de verdad inventado no
// comparte ningun bigrama con la fuente. Coste aceptado: dos entidades que
// comparten un bigrama real ("Northwind Technologies GmbH" cuando la fuente
// solo habla de "Northwind Technologies Inc.") no se detectan.

var ENTITY_TOKEN = "[A-ZÀ-ÖØ-Þ][\\wÀ-ÿ&.'’-]*";
var ENTITY_CONNECTOR = "(?:of|the|and|for|de|del|la|el|y|&|von|van)";
var ENTITY_RE = new RegExp(ENTITY_TOKEN + '(?:\\s+(?:' + ENTITY_CONNECTOR + '\\s+)?' + ENTITY_TOKEN + ')+', 'g');

var CAP_STARTERS = {};
('the this that these those it we they i in on at for from to by with and or but if when while however therefore additionally furthermore moreover according based under per as after before during both all each no not note also since although thus hence first second third finally overall importantly specifically notably source sources section clause article appendix exhibit schedule annex document doc figure table step per unlike given however whereas' +
 ' el la los las un una unos unas este esta estos estas ese esa en de del por para con sin sobre segun ademas asi y o pero si cuando mientras aunque primero segundo tercero finalmente ' +
 'seccion clausula articulo apendice anexo documento figura tabla paso fuente nota tambien')
  .split(/\s+/).forEach(function (w) { if (w) CAP_STARTERS[w] = true; });

var CORP_SUFFIX_RE = /\s+(inc|llc|ltd|limited|corp|corporation|company|co|s\s*a|s\s*l|sa|sl|gmbh|bv|nv|plc|ag|srl|spa|holdings?|group)$/;

function entityCore(entityRaw) {
  var tokens = String(entityRaw).trim().split(/\s+/);
  while (tokens.length && CAP_STARTERS[stripAccents(tokens[0].toLowerCase()).replace(/[^a-z]/g, '')]) tokens.shift();
  while (tokens.length && /^(of|the|and|for|de|del|la|el|y|&|von|van)$/i.test(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length < 2) return null;
  var norm = normalizeEntity(tokens.join(' '));
  var loose = looseForm(norm);
  var stripped = loose;
  var prev = null;
  while (stripped !== prev) { prev = stripped; stripped = stripped.replace(CORP_SUFFIX_RE, ''); }
  return { display: tokens.join(' '), loose: loose, core: stripped.trim() || loose };
}

function isEntityGrounded(core, knownLoose) {
  if (!core) return true;
  if (knownLoose.indexOf(' ' + core + ' ') !== -1) return true;
  var toks = core.split(' ').filter(Boolean);
  if (toks.length === 1) return knownLoose.indexOf(' ' + toks[0] + ' ') !== -1;
  for (var i = 0; i + 1 < toks.length; i++) {
    if (knownLoose.indexOf(' ' + toks[i] + ' ' + toks[i + 1] + ' ') !== -1) return true;
  }
  return false;
}

function detectUnsupportedEntities(answerNoCode, prepared, knownLoose, opts) {
  var findings = [];
  var seen = {};
  var checked = 0;
  var m;
  ENTITY_RE.lastIndex = 0;
  while ((m = ENTITY_RE.exec(answerNoCode)) !== null) {
    if (ENTITY_RE.lastIndex === m.index) ENTITY_RE.lastIndex++;
    var core = entityCore(m[0]);
    if (!core || seen[core.core]) continue;
    seen[core.core] = true;
    checked++;
    if (isEntityGrounded(core.core, knownLoose)) continue;
    findings.push({
      channel: GROUNDING_CHANNELS.ENTITY,
      severity: 'medium',
      claim: core.display,
      detail: 'Nombre propio de varias palabras afirmado por la respuesta que no aparece en ninguna fuente aportada ' +
        '(ni completo ni por ninguno de sus pares de palabras consecutivos).',
      context: truncate(sentenceAround(answerNoCode, m.index), 220),
    });
  }
  return { findings: findings, checked: checked };
}

// ═══════════════════════════════════════════
// CANAL 5: CITA COLGANTE (DANGLING_CITATION)
// ═══════════════════════════════════════════
//
// Dos subtipos, con reglas distintas porque son fallos distintos:
//   (a) referencia a una FUENTE que no existe en la lista aportada: "[3]" con
//       solo 2 fuentes, "Source 4", "Doc B". Severidad alta -- la respuesta se
//       apoya en un documento que no le dieron.
//   (b) referencia a una SECCION/anexo dentro de las fuentes ("Section 7.4",
//       "Annex A", "clausula 12.3") cuya etiqueta no aparece en ningun texto de
//       fuente. Severidad media.
// En corchetes solo se evaluan los contenidos con pinta de referencia (numero
// puro, o "doc/source/fuente/s" + etiqueta, o el id literal de una fuente). Un
// "[texto](url)" de Markdown o un corchete cualquiera NO se marca: no hay forma
// determinista de saber que pretendia ser una cita, y marcarlos convertiria
// cualquier respuesta con enlaces en un mar de avisos.

var BRACKET_CITE_RE = /\[([^\]\n]{1,40})\]/g;
var SOURCE_REF_RE = /\b(?:source|fuente|documento|document|doc|reference|referencia|ref)\s+#?([A-Za-z0-9][\w.-]{0,20})/gi;
var SECTION_REF_RE = /\b(secci[oó]n|section|cl[aá]usula|clause|art[ií]culo|article|anexo|annex|exhibit|ap[eé]ndice|appendix|schedule|§)\s*([0-9][\w.]*|[A-Z])\b/g;

function resolveSourceToken(token, prepared) {
  var t = String(token).trim();
  if (!t) return null;
  var lower = looseForm(t);
  for (var i = 0; i < prepared.length; i++) {
    if (looseForm(prepared[i].id) === lower) return prepared[i];
  }
  if (/^\d+$/.test(t)) {
    var n = parseInt(t, 10);
    return (n >= 1 && n <= prepared.length) ? prepared[n - 1] : null;
  }
  if (/^[A-Za-z]$/.test(t)) {
    var li = t.toUpperCase().charCodeAt(0) - 64;
    return (li >= 1 && li <= prepared.length) ? prepared[li - 1] : null;
  }
  return null;
}

function idPrefix(id) {
  var m = /^([A-Za-z]+)[-_]?/.exec(String(id || '').trim());
  return m ? m[1].toLowerCase() : null;
}

function looksLikeReference(content, prepared) {
  var t = String(content).trim();
  if (/^\d+$/.test(t)) return t;
  var m = /^(?:doc|source|fuente|documento|document|ref|s)\s*[:#-]?\s*([A-Za-z0-9][\w.-]{0,20})$/i.exec(t);
  if (m) return m[1];
  for (var i = 0; i < prepared.length; i++) {
    if (looseForm(prepared[i].id) === looseForm(t)) return t;
  }
  // Bug real, encontrado en verificacion adversarial (2026-08-18): un
  // esquema de ids propio del caller ("contract-1", "contract-2") no
  // coincidia con ningun patron reconocido salvo que fuera EXACTAMENTE
  // uno de los ids reales -- asi que "[contract-5]" (fuera de rango, el
  // caso mas comun de referencia colgante) nunca llegaba ni a intentar
  // resolverse, se descartaba en silencio antes de esa comprobacion. Se
  // reconoce tambien un token cuyo PREFIJO alfabetico coincide con el de
  // al menos una fuente real (misma familia de ids, numero distinto) --
  // asi entra en el chequeo real de resolveSourceToken(), que ya sabe
  // decir si el numero concreto existe o no.
  var prefix = idPrefix(t);
  if (prefix) {
    for (var j = 0; j < prepared.length; j++) {
      if (idPrefix(prepared[j].id) === prefix) return t;
    }
  }
  return null;
}

function detectDanglingCitations(answerNoCode, prepared, opts) {
  var findings = [];
  var checked = 0;
  var seen = {};
  var m;

  BRACKET_CITE_RE.lastIndex = 0;
  while ((m = BRACKET_CITE_RE.exec(answerNoCode)) !== null) {
    if (BRACKET_CITE_RE.lastIndex === m.index) BRACKET_CITE_RE.lastIndex++;
    var parts = m[1].split(/[,;]/);
    for (var p = 0; p < parts.length; p++) {
      var token = looksLikeReference(parts[p], prepared);
      if (!token) continue;
      checked++;
      if (resolveSourceToken(token, prepared)) continue;
      var k1 = 'bracket|' + token;
      if (seen[k1]) continue;
      seen[k1] = true;
      findings.push({
        channel: GROUNDING_CHANNELS.CITATION,
        severity: 'high',
        claim: '[' + parts[p].trim() + ']',
        detail: 'La respuesta cita una fuente que no existe: se aportaron ' + prepared.length +
          ' fuente(s) (' + prepared.map(function (s) { return s.id; }).join(', ') + ').',
        context: truncate(sentenceAround(answerNoCode, m.index), 220),
      });
    }
  }

  SOURCE_REF_RE.lastIndex = 0;
  while ((m = SOURCE_REF_RE.exec(answerNoCode)) !== null) {
    if (SOURCE_REF_RE.lastIndex === m.index) SOURCE_REF_RE.lastIndex++;
    checked++;
    if (resolveSourceToken(m[1], prepared)) continue;
    var k2 = 'prose|' + looseForm(m[0]);
    if (seen[k2]) continue;
    seen[k2] = true;
    findings.push({
      channel: GROUNDING_CHANNELS.CITATION,
      severity: 'high',
      claim: m[0].trim(),
      detail: 'La respuesta cita una fuente que no existe: se aportaron ' + prepared.length +
        ' fuente(s) (' + prepared.map(function (s) { return s.id; }).join(', ') + ').',
      context: truncate(sentenceAround(answerNoCode, m.index), 220),
    });
  }

  SECTION_REF_RE.lastIndex = 0;
  while ((m = SECTION_REF_RE.exec(answerNoCode)) !== null) {
    if (SECTION_REF_RE.lastIndex === m.index) SECTION_REF_RE.lastIndex++;
    var label = m[2];
    checked++;
    // Etiqueta de una sola letra ("Annex A"): buscar la letra suelta en el
    // texto de la fuente daria positivo casi siempre ("a company"), asi que se
    // exige la forma completa "palabra + etiqueta". Etiqueta numerica ("7.1"):
    // basta con la etiqueta como token, porque muchos documentos numeran sin
    // repetir la palabra ("7.1 Term.").
    var needleFull = looseForm(m[1] + ' ' + label);
    var needleLabel = looseForm(label);
    var grounded = false;
    for (var i = 0; i < prepared.length && !grounded; i++) {
      if (!prepared[i].usable) continue;
      if (prepared[i].loose.indexOf(' ' + needleFull + ' ') !== -1) grounded = true;
      else if (/^\d/.test(label) && prepared[i].loose.indexOf(' ' + needleLabel + ' ') !== -1) grounded = true;
    }
    if (grounded) continue;
    var k3 = 'section|' + looseForm(m[0]);
    if (seen[k3]) continue;
    seen[k3] = true;
    findings.push({
      channel: GROUNDING_CHANNELS.CITATION,
      severity: 'medium',
      claim: m[0].trim(),
      detail: 'La respuesta remite a una division del documento que no aparece en el texto de ninguna fuente aportada.',
      context: truncate(sentenceAround(answerNoCode, m.index), 220),
    });
  }

  return { findings: findings, checked: checked };
}

// ═══════════════════════════════════════════
// CANAL 6: AFIRMACION CONTRADICHA (CONTRADICTED_CLAIM)
// ═══════════════════════════════════════════
//
// "X es Y" en la respuesta frente a "X es Z" en la fuente. Reutiliza
// extractClaims() y corePredicateValue() de structural-verify.js -- la misma
// extraccion y el mismo "valor nuclear" ya endurecidos alli.
//
// NO se llama a verifyCrossVoiceFacts() directamente, aunque haga casi esto,
// por una razon concreta: esa funcion compara DOS VOCES QUE RESPONDEN A LA
// MISMA PREGUNTA, donde dos predicados distintos sobre el mismo sujeto son por
// construccion un desacuerdo. Aqui se compara una respuesta contra un
// DOCUMENTO, que habla del mismo sujeto en muchos contextos distintos: "The
// Agreement is governed by New York law" frente a "The Agreement is effective
// on 1 January" tienen el mismo sujeto y distinto predicado, y no se
// contradicen en nada. Aplicar aquella funcion tal cual generaria ese falso
// positivo de forma sistematica.
// Dos guardas anadidas sobre la logica reutilizada:
//   1. Solapamiento de tokens entre predicados > 0.3 (mismo umbral que ya usa
//      computeLogicalTensions() en structural-verify.js) -- "hablan del mismo
//      hueco", no solo del mismo sujeto.
//   2. Contencion: si un valor nuclear contiene al otro, no hay conflicto --
//      la respuesta resume la fuente ("responsable del registro de bajas"
//      frente a "responsable del registro de bajas y de verificar la identidad
//      del solicitante"). Es la misma clase de falso positivo que
//      corePredicateValue ya resolvio para "Canberra, una ciudad planificada",
//      un escalon mas arriba.

var CLAIM_OVERLAP_THRESHOLD = 0.3;

function coreValuesConflict(a, b) {
  if (!a || !b) return false;
  if (a === b) return false;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return false;
  return true;
}

function detectContradictedClaims(answerNoCode, prepared, opts) {
  var answerClaims = extractClaims(answerNoCode).filter(function (c) {
    return !c.negated && c.subjectNorm && c.predicateNorm;
  });
  var findings = [];
  var seen = {};
  var comparisons = 0;

  prepared.forEach(function (src) {
    if (!src.usable) return;
    var srcClaims = extractClaims(src.noCode).filter(function (c) {
      return !c.negated && c.subjectNorm && c.predicateNorm;
    });
    answerClaims.forEach(function (a) {
      srcClaims.forEach(function (b) {
        if (a.subjectNorm !== b.subjectNorm) return;
        comparisons++;
        var overlap = predicateTokenOverlap(a.predicateNorm, b.predicateNorm);
        if (overlap <= CLAIM_OVERLAP_THRESHOLD) return;
        var coreA = corePredicateValue(a.predicateNorm);
        var coreB = corePredicateValue(b.predicateNorm);
        if (!coreValuesConflict(coreA, coreB)) return;
        var key = a.subjectNorm + '|' + coreA + '|' + coreB;
        if (seen[key]) return;
        seen[key] = true;
        findings.push({
          channel: GROUNDING_CHANNELS.CONTRADICTION,
          severity: 'high',
          claim: truncate(a.raw, 200),
          detail: 'La fuente ' + src.id + ' afirma otra cosa sobre "' + a.subject + '": "' + truncate(b.raw, 160) + '".',
          context: truncate(sentenceAround(answerNoCode, a.index), 220),
        });
      });
    });
  });

  return { findings: findings, checked: answerClaims.length, comparisons: comparisons };
}

// ═══════════════════════════════════════════
// API PUBLICA
// ═══════════════════════════════════════════
//
// verifyGrounding(answerText, sources, opts)
//   sources: [{id, text}] (o [string]). opts:
//     - channels: lista de canales a ejecutar (por defecto todos)
//     - question: pregunta original; su texto cuenta como contexto conocido
//       para NUMBER/DATE/ENTITY (un dato que puso el usuario en la pregunta no
//       lo invento la respuesta). NO cuenta para QUOTE (una cita es una
//       atribucion a la fuente) ni para CITATION/CONTRADICTION.
//     - numberTolerancePct (0.5 por defecto), minQuoteWords (4), minQuoteChars
//       (15), maxFindingsPerChannel (25)
//
// Devuelve SIEMPRE un objeto con `status`, nunca un array pelado: la diferencia
// entre "revisado a fondo, nada que objetar" y "no habia nada contra que
// revisar" es la informacion mas importante de este verificador, y un array
// vacio las confunde. Si no hay fuentes usables se devuelve status
// 'no_sources' Y un hallazgo explicito de severidad alta -- un caller que solo
// mire findings.length tampoco se queda con una falsa tranquilidad.
function verifyGrounding(answerText, sources, opts) {
  var t0 = Date.now();
  opts = opts || {};
  var answer = String(answerText == null ? '' : answerText);
  var answerNoCode = stripCodeSpans(answer);
  var prepared = prepareSources(sources);
  var usable = prepared.filter(function (s) { return s.usable; });

  var enabled = opts.channels && opts.channels.length
    ? opts.channels.slice()
    : [GROUNDING_CHANNELS.QUOTE, GROUNDING_CHANNELS.NUMBER, GROUNDING_CHANNELS.DATE,
       GROUNDING_CHANNELS.ENTITY, GROUNDING_CHANNELS.CITATION, GROUNDING_CHANNELS.CONTRADICTION];

  var summary = {
    sourcesProvided: prepared.length,
    sourcesUsable: usable.length,
    sourceChars: usable.reduce(function (n, s) { return n + s.noCode.length; }, 0),
    answerChars: answer.length,
    quotesChecked: 0, numbersChecked: 0, datesChecked: 0,
    entitiesChecked: 0, citationsChecked: 0, claimsChecked: 0,
    totalChecked: 0,
  };

  if (!usable.length) {
    return {
      status: 'no_sources',
      findings: [{
        channel: GROUNDING_CHANNELS.NO_SOURCES,
        severity: 'high',
        claim: '(sin fuentes)',
        detail: 'No se aporto ninguna fuente con texto: NO se ha verificado el anclaje de nada. ' +
          'Un resultado vacio aqui no significa "respuesta respaldada", significa "no se pudo comprobar".',
        context: '',
      }],
      summary: summary,
      channelsRun: [],
      latencyMs: Date.now() - t0,
      note: 'Sin fuentes usables -- ningun canal de anclaje se ejecuto.',
    };
  }

  if (!answerNoCode.trim()) {
    return {
      status: 'nothing_checkable',
      findings: [],
      summary: summary,
      channelsRun: [],
      latencyMs: Date.now() - t0,
      note: 'La respuesta esta vacia (o es solo codigo, que este verificador excluye a proposito) -- nada que anclar.',
    };
  }

  // Contexto "conocido" para NUMBER/DATE/ENTITY: fuentes + (opcionalmente) la
  // pregunta del usuario.
  var knownLoose = usable.map(function (s) { return s.loose; }).join(' ');
  if (opts.question) knownLoose += ' ' + paddedLoose(String(opts.question));

  var findings = [];
  var channelsRun = [];

  function run(channel, fn, counterKey) {
    if (enabled.indexOf(channel) === -1) return;
    var res = fn();
    channelsRun.push(channel);
    var cap = typeof opts.maxFindingsPerChannel === 'number' ? opts.maxFindingsPerChannel : 25;
    findings = findings.concat(res.findings.slice(0, cap));
    if (counterKey) summary[counterKey] = res.checked;
  }

  run(GROUNDING_CHANNELS.QUOTE, function () { return detectFabricatedQuotes(answerNoCode, prepared, opts); }, 'quotesChecked');
  run(GROUNDING_CHANNELS.NUMBER, function () { return detectUnsupportedNumbers(answerNoCode, prepared, knownLoose, opts); }, 'numbersChecked');
  run(GROUNDING_CHANNELS.DATE, function () { return detectUnsupportedDates(answerNoCode, prepared, opts); }, 'datesChecked');
  run(GROUNDING_CHANNELS.ENTITY, function () { return detectUnsupportedEntities(answerNoCode, prepared, knownLoose, opts); }, 'entitiesChecked');
  run(GROUNDING_CHANNELS.CITATION, function () { return detectDanglingCitations(answerNoCode, prepared, opts); }, 'citationsChecked');
  run(GROUNDING_CHANNELS.CONTRADICTION, function () { return detectContradictedClaims(answerNoCode, prepared, opts); }, 'claimsChecked');

  summary.totalChecked = summary.quotesChecked + summary.numbersChecked + summary.datesChecked +
    summary.entitiesChecked + summary.citationsChecked + summary.claimsChecked;

  findings.sort(function (a, b) {
    var d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    return d !== 0 ? d : String(a.channel).localeCompare(String(b.channel));
  });

  var status = summary.totalChecked === 0 ? 'nothing_checkable' : 'checked';
  return {
    status: status,
    findings: findings,
    summary: summary,
    channelsRun: channelsRun,
    latencyMs: Date.now() - t0,
    note: status === 'nothing_checkable'
      ? 'Habia fuentes, pero la respuesta no contiene ninguna afirmacion anclable (ni cita, ni cifra comprobable, ni fecha, ni nombre propio, ni referencia).'
      : undefined,
  };
}

export { verifyGrounding, GROUNDING_CHANNELS };
