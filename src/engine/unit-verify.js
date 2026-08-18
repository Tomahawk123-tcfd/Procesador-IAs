// ── VERIFICACION DETERMINISTA DE ARITMETICA CON UNIDADES ──
//
// Hueco real, medido (2026-08-18) con scripts/offline-verify-probe.mjs sobre
// el corpus independiente (scripts/benchmark-corpus-independent.mjs, escrito
// sin leer los verificadores): de los 5 casos de la categoria `units`, el ALU
// determinista detectaba 0. Recall global del corpus: 3/30 (10%).
//
// La causa no es que la aritmetica sea difIcil -- es que math-verify.js solo
// reconoce expresiones PURAS (digitos, operadores, parentesis). En cuanto la
// respuesta escribe la unidad entre los terminos, que es como escribe un
// humano y como escribe un LLM, el patron se rompe en seco:
//
//   "55 liters / 3.785 ≈ 20.8 US gallons"   <- error real de 43%, 0 hallazgos
//   "2 cups × 120 g/cup = 340 grams"        <- error real de 42%, 0 hallazgos
//
// Reproducido en vivo antes de escribir este modulo:
//   verifyCalculations('55 liters / 3.785 = 20.8 US gallons') -> []
//
// Este modulo NO entiende de unidades ni convierte entre ellas (eso exigiria
// una tabla de factores que se quedaria corta y mentiria por omision). Solo
// hace tres cosas comprobables:
//   1. recalcular una operacion de dos terminos aunque lleve unidades pegadas;
//   2. comprobar la descomposicion decimal->sexagesimal (2,4 h = 2 h 24 min);
//   3. comprobar que el resto de una descomposicion no exceda su propia base
//      (18 oz dentro de una libra de 16 oz es imposible, no opinable).

import { amountParser } from './number-format.js';

// Palabra de unidad: letras, grados, %, barra ("g/cup", "km/h"). Nunca
// incluye digitos -- un "3" pegado a la unidad seria parte del numero.
var UNIT_WORD = '[A-Za-z°ºµ%][A-Za-z°ºµ%/.]{0,14}';

// Numero con separadores de miles/decimales en cualquiera de las dos
// notaciones. Que separador es cual lo decide number-format.js.
var NUMBER = '\\d[\\d.,]*';

var OPERATORS = '[+\\-−*/×x÷]';

// La lectura de miles y decimales la decide number-format.js una vez por
// texto. Decidirla numero a numero hacia que los dos operandos de una misma
// expresion se interpretaran con reglas distintas ("1.100.000 / 2 = 550.000"
// daba un error del 99900% sobre un texto correcto).

// Tolerancia doble, para no llamar error a un redondeo legItimo. Un texto que
// escribe "≈ 14.5" tras dividir 55/3.785 (14.5310...) no se equivoca: redondea
// a un decimal. Se acepta si la diferencia cabe en MEDIA unidad del ultimo
// digito significativo del valor afirmado, o si es menor que el margen
// relativo. Se exige superar AMBOS umbrales para reportar.
function isWithinRounding(computed, claimed, relativeTolerancePct) {
  var claimedStr = String(claimed);
  var dot = claimedStr.indexOf('.');
  var decimals = dot === -1 ? 0 : claimedStr.length - dot - 1;
  var halfLastDigit = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(computed - claimed) <= halfLastDigit) return true;
  var relative = claimed === 0 ? (computed === 0 ? 0 : 100) : Math.abs((computed - claimed) / claimed) * 100;
  return relative <= relativeTolerancePct;
}

function applyOperator(a, op, b) {
  if (op === '+') return a + b;
  if (op === '-' || op === '−') return a - b;
  if (op === '*' || op === '×' || op === 'x' || op === 'X') return a * b;
  if (op === '/' || op === '÷') return b === 0 ? null : a / b;
  return null;
}

// Un numero afirmado seguido de otro operador NO es el resultado de la
// operacion anterior: es el primer termino de otra expresion reescrita
// ("1/3 = 1/6 + 2/6"). math-verify.js aprendio esto a base de falsos
// positivos reales (ver isStartOfFurtherExpression alli); el mismo guardia es
// obligatorio aqui, y sin el este modulo marcaba como error toda suma de
// fracciones reducida paso a paso (reproducido al escribirlo).
function continuesAsExpression(text, afterIndex) {
  var i = afterIndex;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return false;
  return OPERATORS.indexOf(text[i]) !== -1 || '+-−*/×x÷'.indexOf(text[i]) !== -1;
}

var UNIT_ARITH = new RegExp(
  '(' + NUMBER + ')\\s*(' + UNIT_WORD + ')?\\s*(' + OPERATORS + ')\\s*' +
  '(' + NUMBER + ')\\s*(' + UNIT_WORD + ')?\\s*[=≈]\\s*(' + NUMBER + ')',
  'gd'
);

// Recalcula "A <unidad> op B <unidad> = C" cuando al menos uno de los dos
// terminos lleva unidad escrita. Si NINGUNO la lleva, la expresion es pura y
// ya la cubre math-verify.js -- se deja pasar para no duplicar el mismo
// hallazgo en dos canales distintos.
export function verifyUnitAwareArithmetic(text, tolerancePct) {
  if (!text) return [];
  tolerancePct = typeof tolerancePct === 'number' ? tolerancePct : 1;
  var clean = String(text).replace(/[$€£¥]\s*(?=\d)/g, '');
  var parseNumber = amountParser(clean);
  var findings = [];
  var match;
  UNIT_ARITH.lastIndex = 0;
  while ((match = UNIT_ARITH.exec(clean)) !== null) {
    var leftUnit = match[2] || '';
    var rightUnit = match[5] || '';
    if (!leftUnit && !rightUnit) continue;
    if (continuesAsExpression(clean, match.index + match[0].length)) {
      // Rebobinar al inicio del numero afirmado (no seguir tras el match
      // entero): el termino que arranca la siguiente expresion real esta
      // dentro de lo ya consumido.
      UNIT_ARITH.lastIndex = match.indices[6][0];
      continue;
    }
    var a = parseNumber(match[1]);
    var b = parseNumber(match[4]);
    var claimed = parseNumber(match[6]);
    if (a === null || b === null || claimed === null) continue;
    var computed = applyOperator(a, match[3], b);
    if (computed === null || !isFinite(computed)) continue;
    if (isWithinRounding(computed, claimed, tolerancePct)) continue;
    findings.push({
      tipo: 'aritmetica_con_unidades',
      expresion: match[1] + (leftUnit ? ' ' + leftUnit : '') + ' ' + match[3] + ' ' + match[4] + (rightUnit ? ' ' + rightUnit : ''),
      valorCorrecto: Math.round(computed * 1e6) / 1e6,
      valorAfirmado: claimed,
      diffPct: claimed === 0 ? 100 : Math.round(Math.abs((computed - claimed) / claimed) * 1000) / 10,
    });
  }
  return findings;
}

// ── DESCOMPOSICION DECIMAL -> SEXAGESIMAL ──
// "12 / 5 = 2.4 hours, which is about 2 hours 40 minutes": la division es
// correcta, la traduccion a minutos no (0,4 h son 24 min). Es un error de
// conversion dentro de la MISMA respuesta, verificable sin saber nada del
// mundo: la parte fraccionaria por 60 tiene un unico valor posible.
var DECIMAL_TO_HM = /(\d+[.,]\d+)\s*(?:hours?|horas?|h)\b[^.\n]{0,60}?(\d+)\s*(?:hours?|horas?|h)\b\s*(?:y\s*|and\s*)?(\d+)\s*(?:minutes?|minutos?|min)\b/gi;

export function verifyTimeDecomposition(text) {
  if (!text) return [];
  var body = String(text);
  var parseNumber = amountParser(body);
  var findings = [];
  var match;
  DECIMAL_TO_HM.lastIndex = 0;
  while ((match = DECIMAL_TO_HM.exec(body)) !== null) {
    var decimal = parseNumber(match[1]);
    var hours = parseInt(match[2], 10);
    var minutes = parseInt(match[3], 10);
    if (decimal === null) continue;
    if (Math.floor(decimal) !== hours) continue; // habla de otra cantidad, no de la misma
    var expected = Math.round((decimal - hours) * 60);
    if (Math.abs(expected - minutes) <= 1) continue; // 1 min de margen por redondeo
    findings.push({
      tipo: 'descomposicion_temporal',
      expresion: match[1] + ' h',
      valorCorrecto: hours + ' h ' + expected + ' min',
      valorAfirmado: hours + ' h ' + minutes + ' min',
    });
  }
  return findings;
}

// ── RESTO IMPOSIBLE EN UNA DESCOMPOSICION ──
// "7 lbs 18 oz": una libra tiene 16 onzas, asi que 18 oz nunca es el resto de
// una descomposicion -- es un valor imposible, no una estimacion discutible.
// Igual con minutos/segundos (>=60) y pulgadas dentro de un pie (>=12). Solo
// se aplica al patron "N <unidad mayor> M <unidad menor>", donde M ES por
// construccion el resto.
var COMPOSITE_UNITS = [
  { major: '(?:lbs?|pounds?|libras?)', minor: '(?:oz|ounces?|onzas?)', base: 16 },
  { major: '(?:ft|feet|foot|pies?)', minor: '(?:in|inch|inches|pulgadas?)', base: 12 },
  { major: '(?:hours?|horas?|h)', minor: '(?:minutes?|minutos?|min)', base: 60 },
  { major: '(?:minutes?|minutos?|min)', minor: '(?:seconds?|segundos?|s|sec)', base: 60 },
];

export function verifyCompositeUnitBounds(text) {
  if (!text) return [];
  var findings = [];
  COMPOSITE_UNITS.forEach(function (spec) {
    var re = new RegExp('(\\d+)\\s*' + spec.major + '\\b\\s*(?:y\\s*|and\\s*)?(\\d+)\\s*' + spec.minor + '\\b', 'gi');
    var match;
    while ((match = re.exec(String(text))) !== null) {
      var minor = parseInt(match[2], 10);
      if (minor < spec.base) continue;
      findings.push({
        tipo: 'resto_imposible',
        expresion: match[0].trim(),
        limite: spec.base,
        valorAfirmado: minor,
      });
    }
  });
  return findings;
}

// Entrada unica del canal, para que el pipeline solo tenga que llamar a una
// funcion y los tres chequeos compartan formato de hallazgo.
export function verifyUnits(text) {
  return verifyUnitAwareArithmetic(text)
    .concat(verifyTimeDecomposition(text))
    .concat(verifyCompositeUnitBounds(text));
}
