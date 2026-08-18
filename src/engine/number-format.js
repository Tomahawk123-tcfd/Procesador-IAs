// ── NOTACION NUMERICA COMPARTIDA POR LOS VERIFICADORES ──
//
// "1.100.000" es un millon en España y uno-punto-uno en Estados Unidos, y
// "550.000" puede ser cualquiera de las dos cosas. Decidirlo numero a numero
// rompe la comparacion en cuanto los dos operandos de la MISMA expresion caen
// en ramas distintas de la heuristica: "1.100.000 / 2 = 550.000" se leia como
// 1100000 / 2 = 550, o sea un error del 99900% sobre un texto correcto.
//
// La notacion se decide UNA vez por texto y se aplica a todos sus numeros. Si
// no hay ninguna señal que la desambigue, el numero se declara ambiguo
// (`null`) y el verificador que lo pidio se calla: preferimos perder una
// deteccion antes que gritar sobre una respuesta correcta.

// Señales INEQUIVOCAS de agrupacion: dos grupos de tres digitos seguidos
// ("1.100.000") o un grupo mas un decimal con el otro separador ("1.100,50").
// Un solo grupo NO vale como señal: "3.785" es el factor litros->galones en
// notacion inglesa y un numero de cuatro cifras en española, y tomarlo por
// agrupacion convertia "55 liters / 3.785 = 20.8 gallons" en 55/3785.
var DOT_GROUPED = /\b\d{1,3}(?:\.\d{3}){2,}\b|\b\d{1,3}(?:\.\d{3})+,\d+\b/;
var COMMA_GROUPED = /\b\d{1,3}(?:,\d{3}){2,}\b|\b\d{1,3}(?:,\d{3})+\.\d+\b/;
// Señales de separador decimal: 1-2 decimales o mas de 3 (con 3 exactos no se
// distingue de un grupo de miles).
var DOT_DECIMAL = /\d+\.\d{1,2}(?!\d)|\d+\.\d{4,}/;
var COMMA_DECIMAL = /\d+,\d{1,2}(?!\d)|\d+,\d{4,}/;

// 'dot-grouping'  -> el punto agrupa miles, la coma es decimal (español)
// 'comma-grouping'-> la coma agrupa miles, el punto es decimal (ingles)
// 'unknown'       -> sin señales, o señales contradictorias en el mismo texto;
//                    los literales ambiguos se descartan en vez de adivinarse
export function detectNotation(contextText) {
  var body = String(contextText || '');
  var dotGroups = DOT_GROUPED.test(body) || COMMA_DECIMAL.test(body);
  var commaGroups = COMMA_GROUPED.test(body) || DOT_DECIMAL.test(body);
  if (dotGroups && commaGroups) return 'unknown';
  if (dotGroups) return 'dot-grouping';
  if (commaGroups) return 'comma-grouping';
  return 'unknown';
}

var AMBIGUOUS_DOT = /^\d{1,3}\.\d{3}$/;
var AMBIGUOUS_COMMA = /^\d{1,3},\d{3}$/;

// Devuelve el valor del numero segun la notacion dada, o null si en esa
// notacion el literal no tiene una lectura unica.
export function parseAmount(raw, notation) {
  // Un separador final no forma parte del numero: viene de la puntuacion de la
  // frase ("≈ 176.7, so about 177"). Dejarlo dentro convertia 176.7 en 1767 al
  // tomar esa coma final por el separador decimal.
  var s = String(raw == null ? '' : raw).trim().replace(/\s/g, '').replace(/^[.,]+|[.,]+$/g, '');
  if (!s) return null;
  if (notation === 'unknown' && (AMBIGUOUS_DOT.test(s) || AMBIGUOUS_COMMA.test(s))) return null;
  var hasDot = s.indexOf('.') !== -1;
  var hasComma = s.indexOf(',') !== -1;
  if (hasDot && hasComma) {
    // Con los dos separadores presentes el ultimo es siempre el decimal,
    // independientemente de la notacion del resto del texto.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (notation === 'dot-grouping') {
    if (hasDot) s = s.replace(/\./g, '');
    if (hasComma) s = s.replace(',', '.');
  } else if (notation === 'comma-grouping') {
    if (hasComma) s = s.replace(/,/g, '');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, ''); // "1.100.000" se agrupa por si solo
  } else if ((s.match(/,/g) || []).length > 1) {
    s = s.replace(/,/g, '');
  } else {
    // Notacion desconocida y un solo separador que no forma grupo de 3:
    // solo puede ser decimal.
    if (hasComma) s = s.replace(',', '.');
  }
  var value = parseFloat(s);
  return isFinite(value) ? value : null;
}

// Atajo para el caso normal: varios literales del mismo texto.
export function amountParser(contextText) {
  var notation = detectNotation(contextText);
  return function (raw) { return parseAmount(raw, notation); };
}
