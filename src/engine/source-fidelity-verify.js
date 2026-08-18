// ── VERIFICACION DETERMINISTA DE FIDELIDAD A LA FUENTE CITADA ──
//
// Hueco real, medido (2026-08-18) sobre el corpus empresarial: en la categoria
// `contract` la pregunta INCLUYE el texto de la clausula entre comillas y la
// respuesta lo resume. El error inyectado mas comun es cambiar una cifra del
// documento:
//
//   pregunta: "...puede terminar este Acuerdo con un preaviso de 90 dias..."
//   respuesta: "el preaviso requerido es de 30 dias"
//
// Este es el caso de uso empresarial numero uno de un LLM (resumir un documento
// que se le entrega) y tambien el mas facil de auditar sin conocimiento del
// mundo: si el usuario aporta la fuente, toda cifra de la respuesta que hable
// de la MISMA magnitud que la fuente tiene que coincidir con ella. No hace
// falta entender el contrato -- basta con no aceptar un numero que la fuente
// contradice.
//
// Reglas de silencio (imprescindibles para no gritar sobre resumenes buenos):
//   - solo actua si la pregunta trae una cita larga y literal (>= 80 caracteres
//     entre comillas): sin fuente no hay nada contra lo que comparar;
//   - solo compara cifras acompañadas de la MISMA palabra-magnitud ("dias",
//     "EUR", "%"): un numero suelto puede venir de un calculo legItimo;
//   - solo reporta si el numero de la respuesta NO aparece en ninguna parte de
//     la fuente Y la fuente da otro valor para esa misma magnitud.

import { detectNotation, parseAmount } from './number-format.js';

var QUOTE_BLOCK = /["“”«»']([^"“”«»']{80,})["“”«»']/g;

// Magnitud = la palabra que sigue al numero (o el simbolo pegado a el). Se
// normaliza a singular basto para que "dia"/"dias" y "day"/"days" casen.
function normalizeMagnitude(word) {
  var w = String(word).toLowerCase().replace(/[.,;:)]+$/, '');
  w = w.replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
  if (w.length > 3 && /(es|s)$/.test(w)) w = w.replace(/(es|s)$/, '');
  return w;
}

// La notacion de miles/decimales se decide una vez por texto (number-format.js):
// leerla numero a numero comparaba "1.100.000" contra "550.000" con reglas
// distintas y reportaba un desvio de x1000 sobre cifras correctas.

// El parentesis opcional cubre la forma que usa el lenguaje contractual real,
// "ninety (90) days": sin el, la cifra de la fuente quedaba sin magnitud y la
// clausula no se podia contrastar con nada.
var NUMBER_WITH_MAGNITUDE = /(\d[\d.,]*)\s*\)?\s*(%|€|\$|£|[A-Za-zÁ-ÿ]{2,20})/g;

// La notacion se pasa desde fuera: la fuente y la respuesta se comparan cifra
// a cifra, asi que las dos tienen que leerse con la MISMA regla de miles.
function magnitudesIn(text, notation) {
  var toNumber = function (raw) { return parseAmount(raw, notation); };
  var map = {};
  var m;
  NUMBER_WITH_MAGNITUDE.lastIndex = 0;
  while ((m = NUMBER_WITH_MAGNITUDE.exec(String(text))) !== null) {
    var value = toNumber(m[1]);
    if (value === null) continue;
    var magnitude = normalizeMagnitude(m[2]);
    if (!magnitude) continue;
    if (!map[magnitude]) map[magnitude] = [];
    map[magnitude].push({ value: value, raw: m[0].trim() });
  }
  return map;
}

// Palabras demasiado genericas para identificar una magnitud: casan con
// cualquier cosa y producirian avisos sobre numeros sin relacion.
var GENERIC_WORDS = ['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'o', 'a', 'que', 'con', 'por', 'para', 'of', 'the', 'and', 'or', 'to', 'in', 'is', 'are', 'be'];

export function extractQuotedSources(query) {
  var sources = [];
  var m;
  QUOTE_BLOCK.lastIndex = 0;
  while ((m = QUOTE_BLOCK.exec(String(query || ''))) !== null) sources.push(m[1]);
  return sources;
}

export function verifySourceFidelity(text, query) {
  var sources = extractQuotedSources(query);
  if (sources.length === 0) return [];
  var source = sources.join('\n');
  var notation = detectNotation(source + '\n' + String(text || ''));
  var sourceMagnitudes = magnitudesIn(source, notation);
  var answerMagnitudes = magnitudesIn(text, notation);
  var sourceNumbers = {};
  Object.keys(sourceMagnitudes).forEach(function (magnitude) {
    sourceMagnitudes[magnitude].forEach(function (entry) { sourceNumbers[entry.value] = true; });
  });
  var findings = [];
  var reported = {};
  Object.keys(answerMagnitudes).forEach(function (magnitude) {
    if (GENERIC_WORDS.indexOf(magnitude) !== -1) return;
    var inSource = sourceMagnitudes[magnitude];
    if (!inSource || inSource.length === 0) return;
    answerMagnitudes[magnitude].forEach(function (claim) {
      if (sourceNumbers[claim.value]) return; // la cifra existe en la fuente: nada que objetar
      var expected = inSource.map(function (e) { return e.raw; }).join(' / ');
      var key = magnitude + '|' + claim.value;
      if (reported[key]) return;
      reported[key] = true;
      findings.push({
        tipo: 'cifra_no_respaldada_por_la_fuente',
        magnitud: magnitude,
        enLaRespuesta: claim.raw,
        enLaFuente: expected,
      });
    });
  });
  return findings;
}
