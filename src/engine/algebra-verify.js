// ── VERIFICACION DETERMINISTA DE SUSTITUCION ALGEBRAICA ──
//
// Hueco real, medido (2026-08-18) con scripts/offline-verify-probe.mjs: dos
// casos del corpus independiente (math-02, math-05) tienen un error grave y
// NINGUN verificador los detecta, por una razon incomoda -- su aritmetica es
// impecable. El error esta un paso antes, en el algebra:
//
//   "selling price = C × 1.65. So C = 18.50 × 1.65 ≈ $30.53"
//        18,50 × 1,65 = 30,525: la cuenta esta bien. Lo que esta mal es
//        despejar C multiplicando cuando la ecuacion declarada exige dividir
//        (el resultado sale mas caro que el precio de venta, un absurdo).
//
//   "sugar = flour × (2/3) ... sugar = 750 × 3/2 = 1125g"
//        750 × 3/2 = 1125: la cuenta esta bien. La formula declarada en la
//        misma frase decia 2/3, no 3/2 -- la sustitucion invirtio la razon.
//
// Este es el patron de error mas peligroso de un LLM en tareas cuantitativas:
// la respuesta ENSEÑA la formula correcta (la ha visto mil veces en el
// entrenamiento) y luego la usa mal, con lo que el lector que "comprueba la
// cuenta" confirma el numero equivocado. Recalcular la aritmetica no lo pilla
// nunca. Comparar la formula declarada contra la sustitucion numerica si.
//
// Alcance honesto: NO se resuelve algebra simbolica ni se entiende la
// pregunta. Solo se comparan dos afirmaciones del propio texto que deben ser
// la misma cosa. Si la respuesta no declara la formula, no hay nada contra lo
// que comparar y este canal calla (0 hallazgos, no un aviso vacio).

import { amountParser } from './number-format.js';

var NUM = '\\d[\\d.,]*';
var MULT = '[*×xX·]';
var VARIABLE = '[A-Za-zÁ-ÿ][A-Za-zÁ-ÿ_0-9]{0,20}';

// La notacion de miles/decimales se decide una vez por texto en
// number-format.js: hacerlo numero a numero leia "1.100.000" como un millon y
// "550.000" como quinientos cincuenta en la misma expresion.

// Primer intento de este modulo (descartado tras probarlo en vivo): capturar
// la etiqueta con una regex de "palabras antes del =". Fallaba en el caso
// real que motivo el modulo -- en "so sugar = flour × (2/3)" la etiqueta
// capturada era "so sugar", que nunca coincide con el "sugar = 750 × 3/2" de
// la sustitucion, asi que el verificador devolvia 0 hallazgos sobre un error
// evidente. Se trocea el texto en ecuaciones y se usa como clave la ULTIMA
// palabra antes del "=" ("sugar", "price", "c"), que es la que nombra la
// cantidad; los adverbios y conectores de delante son ruido.
// El punto solo separa frases cuando NO esta entre digitos: cortar por
// cualquier "." partia "18.50 × 1.65" en un "18" suelto y el verificador se
// quedaba sin la sustitucion que tenia que comparar (reproducido en vivo
// mientras se escribia este modulo: 0 hallazgos sobre el caso math-02).
var SENTENCE_BREAK = /[\n;:,=]|\.(?!\d)/;

function isSentenceBreakAt(body, i) {
  var c = body[i];
  if ('\n;:,=('.indexOf(c) !== -1) return true;
  return c === '.' && !/\d/.test(body[i + 1] || '');
}

function extractEquations(text) {
  var equations = [];
  var body = String(text);
  var re = /=/g;
  var match;
  while ((match = re.exec(body)) !== null) {
    var startOfLeft = 0;
    for (var i = match.index - 1; i >= 0; i--) {
      if (isSentenceBreakAt(body, i)) { startOfLeft = i + 1; break; }
    }
    var left = body.slice(startOfLeft, match.index).trim();
    var words = left.split(/\s+/).filter(Boolean);
    var key = words.length ? words[words.length - 1].toLowerCase().replace(/[^a-zá-ÿ_0-9]/gi, '') : '';
    var rest = body.slice(match.index + 1);
    var endMatch = SENTENCE_BREAK.exec(rest);
    var rhs = (endMatch ? rest.slice(0, endMatch.index) : rest).trim();
    if (!key || !rhs) continue;
    equations.push({ key: key, rhs: rhs, index: match.index });
  }
  return equations;
}

var RATIO_DECLARED = new RegExp('^(' + VARIABLE + ')\\s*(?:' + MULT + '|/)\\s*\\(?\\s*(' + NUM + ')\\s*/\\s*(' + NUM + ')\\s*\\)?');
var RATIO_USED = new RegExp('^(' + NUM + ')\\s*(?:' + MULT + ')\\s*\\(?\\s*(' + NUM + ')\\s*/\\s*(' + NUM + ')\\s*\\)?');

// Compara la razon de la formula declarada contra la razon realmente
// sustituida para la MISMA cantidad.
export function verifyRatioSubstitution(text) {
  if (!text) return [];
  var toNumber = amountParser(text);
  var equations = extractEquations(text);
  var findings = [];
  var reported = {};
  equations.forEach(function (declaredEq) {
    var declared = RATIO_DECLARED.exec(declaredEq.rhs);
    if (!declared) return;
    var a = toNumber(declared[2]);
    var b = toNumber(declared[3]);
    if (a === null || b === null || b === 0) return;
    var declaredValue = a / b;
    equations.forEach(function (usedEq) {
      if (usedEq.index === declaredEq.index || usedEq.key !== declaredEq.key) return;
      var used = RATIO_USED.exec(usedEq.rhs);
      if (!used) return;
      var c = toNumber(used[2]);
      var d = toNumber(used[3]);
      if (c === null || d === null || d === 0) return;
      var usedValue = c / d;
      var relative = Math.abs((usedValue - declaredValue) / declaredValue) * 100;
      if (relative <= 0.5) return;
      var key = declaredEq.key + '|' + declared[2] + '/' + declared[3] + '|' + used[2] + '/' + used[3];
      if (reported[key]) return;
      reported[key] = true;
      findings.push({
        tipo: 'razon_sustituida_distinta',
        cantidad: declaredEq.key,
        razonDeclarada: declared[2] + '/' + declared[3],
        razonUsada: used[2] + '/' + used[3],
      });
    });
  });
  return findings;
}

// Despeje invertido: la ecuacion declarada dice "precio = C × k" (C es la
// incognita, k un factor numerico) y despues el texto calcula "C = <numero> ×
// k". Despejar C de un producto exige DIVIDIR entre k; si se vuelve a
// multiplicar, el resultado sale mal por un factor de k². Se exige el MISMO
// factor literal en las dos afirmaciones -- sin eso no hay forma de saber si
// el segundo producto es otro calculo legItimo del texto.
var PRODUCT_DECLARED = new RegExp('^(' + VARIABLE + ')\\s*(?:' + MULT + ')\\s*(' + NUM + ')(?!\\s*[/\\d])');

export function verifyInvertedIsolation(text) {
  if (!text) return [];
  var toNumber = amountParser(text);
  var equations = extractEquations(text);
  var findings = [];
  var reported = {};
  equations.forEach(function (declaredEq) {
    var declared = PRODUCT_DECLARED.exec(declaredEq.rhs);
    if (!declared) return;
    var target = declared[1].toLowerCase();
    var factorRaw = declared[2];
    var factor = toNumber(factorRaw);
    if (factor === null || factor === 0 || factor === 1) return;
    if (target === declaredEq.key) return;
    var isolation = new RegExp('^(' + NUM + ')\\s*(?:' + MULT + ')\\s*' + factorRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\d])');
    equations.forEach(function (isoEq) {
      if (isoEq.index === declaredEq.index || isoEq.key !== target) return;
      var iso = isolation.exec(isoEq.rhs);
      if (!iso) return;
      var known = toNumber(iso[1]);
      if (known === null) return;
      var key = target + '|' + factorRaw + '|' + iso[1];
      if (reported[key]) return;
      reported[key] = true;
      findings.push({
        tipo: 'despeje_invertido',
        ecuacionDeclarada: declaredEq.key + ' = ' + declared[1] + ' × ' + factorRaw,
        despejeEscrito: declared[1] + ' = ' + iso[1] + ' × ' + factorRaw,
        despejeCorrecto: declared[1] + ' = ' + iso[1] + ' / ' + factorRaw + ' ≈ ' + (Math.round((known / factor) * 100) / 100),
      });
    });
  });
  return findings;
}

export function verifyAlgebraicSubstitution(text) {
  return verifyRatioSubstitution(text).concat(verifyInvertedIsolation(text));
}
