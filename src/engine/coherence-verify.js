// ── VERIFICACION DE COHERENCIA INTERNA DETERMINISTA ──
// Mismo patron que math-verify.js: no interpreta la pregunta ni genera
// nada, solo escanea el TEXTO YA GENERADO en busca de un tipo de
// contradiccion muy concreto y verificable sin ambiguedad -- no un
// verificador de logica general (eso no es determinista, seria otra IA
// opinando sobre la respuesta, exactamente lo que este chip evita).
//
// Alcance deliberadamente estrecho: relaciones comparativas explicitas
// ("A es mayor que B") que se contradicen con otra relacion comparativa
// explicita sobre el MISMO PAR de terminos en sentido opuesto ("B es
// mayor que A") en algun otro punto del mismo texto. No intenta detectar
// contradicciones implicitas, de significado, o que requieran entender
// el dominio -- eso tendria falsos positivos sin control.

// Bug real, encontrado probando el verificador (no en produccion todavia):
// el termino de la derecha no tenia limite de palabras, solo un
// terminador lejano -- en "PostgreSQL es mejor que SQLite para
// proyectos pequeños." el termino "de la derecha" se comia hasta el
// PROXIMO punto ("SQLite para proyectos pequeños"), no solo "SQLite".
// Se acota cada termino a 1-3 palabras y se exige un terminador real
// justo despues (con lookahead, sin consumirlo) -- si la comparacion
// sigue con una clausula ("...que X para Y"), se prefiere NO extraerla
// antes que extraerla mal. Mejor un falso negativo que un falso positivo
// aqui: el objetivo es cero ruido, no capturar cada frase posible.
// Segundo bug real, encontrado probando el verificador -- este mas sutil
// que el primero: el flag 'i' (case-insensitive) se aplicaba a TODA la
// expresion, incluido "[A-ZÀ-ÿ]" que estaba pensado como "debe empezar
// en mayuscula" (heuristica de nombre propio). Con 'i' activo, esa clase
// tambien acepta minusculas -- asi que en "Pero B es mayor que A.", tras
// excluir "Pero" completo como inicio (ver conectores abajo), el motor
// probaba la SIGUIENTE posicion ("ero B..."), y "e" (minuscula) pasaba
// igualmente la comprobacion de "[A-ZÀ-ÿ]" por culpa del flag global,
// capturando "ero B" como si fuera el termino. Se quita el flag 'i'
// global -- el termino ahora exige mayuscula real -- y las palabras
// clave (es/son/mayor/menor/.../que) se escriben en minuscula porque en
// prosa real casi nunca aparecen capitalizadas a mitad de frase; los
// conectores si pueden ir en mayuscula (inicio de frase, "Pero..."), asi
// que esos se listan en ambas formas explicitamente.
var CONNECTOR_LOOKAHEAD = '(?!(?:[Pp]ero|[Ss]in embargo|[Aa]unque|[Mm]ientras|[Cc]uando|[Pp]orque|[Aa]demás|[Tt]ambién|[Ee]ntonces|[Aa]sí|[Ll]uego|[Pp]or lo tanto)\\s)';
var TERM = '(' + CONNECTOR_LOOKAHEAD + '[A-ZÀ-ÿ][\\wÀ-ÿ\'-]*(?:\\s+[A-Za-zÀ-ÿ][\\wÀ-ÿ\'-]*){0,2})';
// Fallo real encontrado por el banco de pruebas (scripts/benchmark-processor.mjs,
// 2026-08-12): "PostgreSQL es mejor que SQLite para aplicaciones grandes. Pero
// en escenarios reales SQLite es mejor que PostgreSQL." -- contradiccion
// literal evidente, NO detectada. Causa medida (probando el modulo real, no
// suponiendo): la frase 1 no producia NINGUNA coincidencia, porque el
// lookahead exigia el terminador (. , ; :) inmediatamente despues del
// termino, y ahi venia " para aplicaciones grandes.". Con backtracking el
// motor probaba "SQLite para", "SQLite" -- ninguno seguido de terminador --
// asi que descartaba la frase completa. Solo quedaba 1 afirmacion extraida,
// y una sola nunca puede contradecirse.
//
// Se permite una clausula final OPCIONAL antes del terminador, introducida
// por una preposicion conocida, y se DESCARTA (no entra en el grupo de
// captura, asi que el termino sigue siendo limpio: "sqlite", no "sqlite para
// aplicaciones grandes"). Lista cerrada de preposiciones a proposito -- no
// `.*`, que es justo el patron que ya causo tres bugs distintos en los
// detectores de intencion de este mismo proyecto.
var TRAILING_CLAUSE = '(?:\\s+(?:para|en|con|de|por|seg[uú]n|cuando|si|al|desde|hasta|sobre)\\b[^.;:!?\\n]*)?';
var COMPARISON_RE = new RegExp(
  TERM + '\\s+(?:es|son)\\s+(mayor|menor|más\\s+grande|más\\s+pequeñ[oa]|superior|inferior|mejor|peor)\\s+que\\s+' + TERM + TRAILING_CLAUSE + '(?=\\s*[.,;:\\n])',
  'g'
);

// "menor/inferior/peor/mas pequeño" es la misma relacion que "mayor" pero
// con los terminos invertidos -- se normaliza todo a una sola direccion
// (GT: el primer termino es mayor que el segundo) para poder comparar.
var NEGATIVE_DIRECTION = { 'menor': true, 'inferior': true, 'peor': true, 'más pequeño': true, 'más pequeña': true };

function normalizeTerm(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function extractComparisons(text) {
  var claims = [];
  var match;
  COMPARISON_RE.lastIndex = 0;
  while ((match = COMPARISON_RE.exec(text)) !== null) {
    var left = normalizeTerm(match[1]);
    var direction = match[2].toLowerCase().replace(/\s+/g, ' ');
    var right = normalizeTerm(match[3]);
    if (!left || !right || left === right) continue; // "A es mayor que A" no es una comparacion real, es un error de extraccion
    var isNegative = NEGATIVE_DIRECTION[direction] === true;
    // Canonicaliza a GT(mayor, menor): si la direccion es negativa,
    // el "mayor" real es el termino de la derecha.
    var gt = isNegative ? right : left;
    var lt = isNegative ? left : right;
    claims.push({ gt: gt, lt: lt, raw: match[0].trim(), index: match.index });
  }
  return claims;
}

// Fallo real encontrado por el banco de pruebas (scripts/benchmark-processor.mjs,
// 2026-08-12): "PostgreSQL es mejor que SQLite para aplicaciones grandes. Pero
// en escenarios reales SQLite es mejor que PostgreSQL." es una contradiccion
// literal evidente y NO se detectaba. Causa: TERM captura 1-3 palabras, asi
// que la primera frase daba el termino "sqlite para aplicaciones" y la
// segunda "sqlite" -- comparados con === , no coincidian, y el par nunca se
// cerraba. La comparacion exacta es demasiado estricta cuando un termino
// arrastra su clausula.
//
// Se relaja SOLO por relacion de prefijo (un termino es el otro seguido de
// mas palabras), no por primera palabra suelta: asi "sqlite para
// aplicaciones" coincide con "sqlite", pero "java 8" NO coincide con
// "java 17" (ninguno es prefijo del otro) -- que es justo el falso positivo
// que habria que evitar al comparar versiones distintas de lo mismo.
function termsMatch(a, b) {
  if (a === b) return true;
  return a.indexOf(b + ' ') === 0 || b.indexOf(a + ' ') === 0;
}

// Busca si, para el mismo par de terminos (sin importar el orden en que
// se mencionaron primero), el texto afirma en algun punto A>B y en otro
// punto B>A -- eso es una contradiccion literal, no una interpretacion.
function verifyComparisons(text) {
  if (!text) return [];
  var claims = extractComparisons(text);
  var findings = [];
  var seenPairs = {};
  for (var i = 0; i < claims.length; i++) {
    for (var j = i + 1; j < claims.length; j++) {
      var a = claims[i];
      var b = claims[j];
      if (termsMatch(a.gt, b.lt) && termsMatch(a.lt, b.gt)) {
        var pairKey = [a.gt, a.lt].sort().join('|');
        if (seenPairs[pairKey]) continue;
        seenPairs[pairKey] = true;
        findings.push({
          afirmacionA: a.raw,
          afirmacionB: b.raw,
        });
      }
    }
  }
  return findings;
}

// ── AFIRMACIONES DUPLICADAS ENTRE ENTIDADES COMPARADAS ──
// Patron real, sistematico y medido en vivo (2026-08-12) con `linkcore ask`
// contra modelos pequeños: al comparar dos cosas, el modelo lista la MISMA
// afirmacion como caracteristica distintiva de ambas, cambiando solo el
// nombre. Dos ejemplos reales capturados esta noche:
//   "Interfaz grafica: Python tiene una interfaz grafica facil de usar..."
//   "Interfaz grafica: Rust tiene una interfaz grafica facil de usar..."
// y
//   "Sistema operativo integrado: Java se ejecuta dentro del sistema
//    operativo, lo que significa que las aplicaciones pueden interactuar
//    con los recursos del sistema de manera mas eficiente."
//   "Sistema operativo integrado: Go se ejecuta dentro del sistema
//    operativo, lo que significa que ..." (identico palabra por palabra)
// En la segunda respuesta el patron aparecio 4 veces. verifyComparisons()
// no lo pilla: no hay ninguna comparacion explicita contradictoria, es
// copy-paste entre secciones. Es una alucinacion real (la afirmacion no
// puede ser distintiva de ambas) y es detectable sin ambiguedad ni
// interpretacion: se comparan las viñetas ignorando los nombres propios,
// y si dos quedan identicas pero los originales NO lo eran, el modelo
// copio la afirmacion cambiando solo el sujeto.
//
// Umbral deliberadamente conservador (igual que el resto de este archivo:
// cero ruido antes que capturar todo): solo viñetas, minimo 40 caracteres
// de contenido tras normalizar, y las lineas originales deben diferir.
var BULLET_RE = /^\s*(?:[*\-+•]|\d+[.)])\s+(.{10,})$/;
var MIN_NORMALIZED_LENGTH = 40;

function stripEntityNames(line) {
  // Quita palabras que empiezan por mayuscula (nombres propios: Python,
  // Rust, Java, Go...) y el formato markdown, para quedarse con la
  // afirmacion en si. Se conserva la primera palabra de la frase solo si
  // no es la unica diferencia -- en la practica basta con quitar todas las
  // capitalizadas: si dos viñetas quedan identicas tras esto, la unica
  // diferencia real entre ellas eran esos nombres.
  //
  // Bug real, encontrado endureciendo el demo de VERIFY (2026-08-17): el
  // regex original solo se comia UNA palabra que empezara por mayuscula --
  // "Llama 3.1 8B" perdia solo "Llama" (3.1 y 8B empiezan por digito, no
  // por mayuscula, asi que sobrevivian) y "Mistral 7B" perdia solo
  // "Mistral", dejando "3 1 8b ..." vs "7b ..." -- normalizados DISTINTOS,
  // asi que una afirmacion identica copiada entre dos modelos de IA (el
  // caso mas probable en un producto que compara modelos) nunca se
  // detectaba como duplicado. Nombres de una sola palabra (Python, Rust)
  // nunca tuvieron este problema -- confirmado en vivo antes del fix. Ahora
  // el nombre propio se traga tambien los tokens pegados que empiezan por
  // digito (version/tamaño: "3.1", "8B", "7b") mientras vengan justo
  // despues, sin romper frases normales como "Rust tiene 15 años" (ahi
  // "tiene" no empieza por digito, asi que el 15 nunca se pega a "Rust").
  return line
    .replace(/\*\*/g, ' ')
    .replace(/[`*_]/g, ' ')
    .replace(/\b[A-ZÀ-Ý][\wÀ-ÿ+#.-]*(?:\s+\d[\wÀ-ÿ.:+#-]*)*/g, ' ')
    .replace(/[^\wÀ-ÿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function verifyDuplicateClaims(text) {
  if (!text) return [];
  var lines = String(text).split('\n');
  var byNormalized = {};
  var findings = [];

  for (var i = 0; i < lines.length; i++) {
    var m = BULLET_RE.exec(lines[i]);
    if (!m) continue;
    var original = m[1].trim();
    var normalized = stripEntityNames(original);
    if (normalized.length < MIN_NORMALIZED_LENGTH) continue;

    if (!byNormalized[normalized]) {
      byNormalized[normalized] = original;
      continue;
    }
    // Ya visto: solo es hallazgo si los originales DIFERIAN (si son
    // identicos es una repeticion literal, otro problema -- y menos
    // interesante que la afirmacion copiada cambiando el sujeto).
    var previous = byNormalized[normalized];
    if (previous === original) continue;
    findings.push({ afirmacionA: previous, afirmacionB: original });
    // Una sola vez por afirmacion normalizada, para no repetir el mismo
    // aviso si el modelo la copio tres o mas veces.
    byNormalized[normalized] = original;
  }

  return findings;
}

export { verifyComparisons, verifyDuplicateClaims };
