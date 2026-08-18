// ── VERIFICACION TEMPORAL DETERMINISTA (2026-08-17, hallazgo #7 de la
// segunda investigacion) ──
// Cuarta categoria de verificador sin generacion, mismo perfil que
// math-verify.js/code-verify.js/structural-verify.js: nunca llama a otro
// modelo, solo aritmetica y regex sobre el texto YA escrito. Cubre un
// fallo real y comun que ninguno de los otros tres detecta: un modelo
// afirmando con seguridad que "N años despues de AAAA es BBBB" cuando la
// resta/suma esta mal, o dos afirmaciones sobre "el año actual" que no
// coinciden entre si dentro de la misma respuesta.
//
// Deliberadamente acotado: NO intenta resolver fechas relativas ambiguas
// ("la semana que viene", "hace poco") ni entender el calendario completo
// (meses, dias, husos horarios) -- solo aritmetica de AÑOS, que es donde
// se concentra el error real y facil de verificar sin ambigüedad.

// "1990", "el 2015", "año 2024" -- año suelto de 4 digitos, en un rango
// razonable para evitar falsos positivos con otros numeros de 4 digitos
// (codigos postales, IDs, etc. quedan fuera por el rango).
var YEAR_RE = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/;

// "3 años despues de 2019 es 2021" / "5 años antes de 2020 son 2015"
// Captura: cantidad, direccion (despues/antes), año base, año afirmado.
var YEAR_ARITHMETIC_RE = /(\d{1,3})\s*años?\s*(despu[eé]s|antes)\s*de\s*(1[5-9]\d{2}|20\d{2}|21\d{2})\s*(?:es|son|fue|ser[aá]n?)\s*(?:el\s*|el año\s*)?(1[5-9]\d{2}|20\d{2}|21\d{2})/gi;

// "el año actual es X" / "actualmente estamos en X" / "hoy es X" /
// "a fecha de X" -- variantes de "año de referencia" que el propio texto
// afirma. Si aparecen dos veces con valores distintos, es una
// contradiccion interna real (el texto no puede estar en dos años a la
// vez), no una opinion.
var CURRENT_YEAR_CLAIM_RE = /(?:el año actual es|actualmente estamos en|hoy es(?: el año)?|a fecha de|nos encontramos en(?: el año)?)\s*(1[5-9]\d{2}|20\d{2}|21\d{2})/gi;

function verifyYearArithmetic(text) {
  if (!text) return [];
  var findings = [];
  var m;
  YEAR_ARITHMETIC_RE.lastIndex = 0;
  while ((m = YEAR_ARITHMETIC_RE.exec(text)) !== null) {
    var amount = parseInt(m[1], 10);
    var direction = m[2].toLowerCase();
    var baseYear = parseInt(m[3], 10);
    var claimedYear = parseInt(m[4], 10);
    var expectedYear = direction.indexOf('despu') === 0 ? baseYear + amount : baseYear - amount;
    if (expectedYear !== claimedYear) {
      findings.push({
        texto: m[0].trim(),
        base: baseYear,
        cantidad: amount,
        direccion: direction,
        añoAfirmado: claimedYear,
        añoCorrecto: expectedYear,
      });
    }
  }
  return findings;
}

function verifyCurrentYearConsistency(text) {
  if (!text) return [];
  var seen = {};
  var m;
  CURRENT_YEAR_CLAIM_RE.lastIndex = 0;
  while ((m = CURRENT_YEAR_CLAIM_RE.exec(text)) !== null) {
    var year = m[1];
    if (!seen[year]) seen[year] = [];
    seen[year].push(m[0].trim());
  }
  var distinctYears = Object.keys(seen);
  if (distinctYears.length < 2) return [];
  // Mas de un "año actual" distinto afirmado en el mismo texto -- solo uno
  // puede ser cierto. Se reporta una vez, con todas las variantes vistas.
  return [{
    tipo: 'año_actual_inconsistente',
    afirmaciones: distinctYears.map(function (y) { return { año: y, ejemplos: seen[y] }; }),
  }];
}

// Verificacion combinada -- pensada para llamarse desde el mismo sitio que
// verifyCalculations()/verifyCodeBlocks(), mismo shape de salida (array de
// hallazgos, vacio si no hay nada que avisar).
function verifyTemporalClaims(text) {
  return verifyYearArithmetic(text).map(function (f) {
    return Object.assign({ tipo: 'aritmetica_de_años' }, f);
  }).concat(verifyCurrentYearConsistency(text));
}

export { verifyYearArithmetic, verifyCurrentYearConsistency, verifyTemporalClaims, YEAR_RE };
