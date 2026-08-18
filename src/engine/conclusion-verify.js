// ── VERIFICACION DETERMINISTA DE LA CONCLUSION CONTRA SU PROPIO DESARROLLO ──
//
// Hueco real, medido (2026-08-18) con scripts/offline-verify-probe.mjs sobre
// el corpus independiente: 10 de los 30 casos (todo `temporal` y todo
// `reasoning`) comparten EXACTAMENTE el mismo mecanismo de fallo, y el ALU
// determinista no detectaba ninguno. El desarrollo es correcto y la ULTIMA
// frase lo contradice:
//
//   "...la fecha cae en April 29. So the deadline is April 30."
//   "...adding 2 days: Saturday, then Sunday. So 100 days from a Friday is a Saturday."
//   "...the day rolls over to Wednesday. So it lands at 5:15 AM Thursday."
//   "...≈ 176.7, so about 143°C"
//   "Yes, that is consistent. [...] that return should not have been accepted."
//
// Es el modo de fallo mas caro de un LLM en produccion: quien lee la respuesta
// se queda con la ultima linea (la que copia y pega), no con la derivacion. Y
// es verificable sin saber nada del mundo -- no hace falta saber cuantos dias
// tiene marzo ni resolver el acertijo: basta con exigir que la conclusion NO
// contradiga lo que la propia respuesta acaba de calcular. Un chip no puede
// saber si el desarrollo es correcto, pero si puede negarse a emitir un
// resultado que se contradice consigo mismo.
//
// Alcance honesto: si la respuesta no tiene frase de conclusion marcada
// ("so", "therefore", "por tanto", "en conclusion", "the answer is"...), este
// canal calla. No adivina cual es la conclusion de un texto sin marcadores.

import { amountParser } from './number-format.js';

var WEEKDAYS = {
  monday: 'lunes', tuesday: 'martes', wednesday: 'miercoles', thursday: 'jueves',
  friday: 'viernes', saturday: 'sabado', sunday: 'domingo',
  lunes: 'lunes', martes: 'martes', miercoles: 'miercoles', 'miércoles': 'miercoles',
  jueves: 'jueves', viernes: 'viernes', sabado: 'sabado', 'sábado': 'sabado', domingo: 'domingo',
};

var MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

var CONCLUSION_MARKERS = /(?:^|[.\n]\s*)((?:so|therefore|thus|hence|in conclusion|the answer is|as[íi] que|por (?:lo )?tanto|en conclusi[óo]n|la respuesta es|entonces)\b[^.\n]*\.?)\s*$/i;

// Localiza la frase de conclusion: la ULTIMA frase del texto que empieza por
// un marcador de conclusion. Se exige que sea la ultima (o penultima si la
// ultima es un comentario suelto) porque una conclusion intermedia no es la
// respuesta final que el lector se lleva.
export function splitConclusion(text) {
  var body = String(text || '').trim();
  if (!body) return null;
  var sentences = body.split(/(?<=[.!?])\s+/);
  for (var i = sentences.length - 1; i >= 0 && i >= sentences.length - 2; i--) {
    if (/^\s*(?:so|therefore|thus|hence|in conclusion|the answer is|as[íi] que|por (?:lo )?tanto|en conclusi[óo]n|la respuesta es|entonces)\b/i.test(sentences[i])) {
      return { derivation: sentences.slice(0, i).join(' '), conclusion: sentences.slice(i).join(' ') };
    }
  }
  return null;
}

function weekdaysIn(text) {
  var found = [];
  var re = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi;
  var m;
  while ((m = re.exec(text)) !== null) found.push({ raw: m[0], key: WEEKDAYS[m[0].toLowerCase()], index: m.index });
  return found;
}

// Fechas "April 29" / "29 de abril". Se EXCLUYEN los rangos ("March 16-31",
// "June 2-30"): en un desarrollo paso a paso son el inventario de dias que
// queda por consumir, no una fecha resultado, y tomarlos por resultado
// generaba falsos positivos (comprobado sobre los casos correctos del corpus).
function datesIn(text) {
  var found = [];
  var re = /\b([A-Za-zÁ-ÿ]+)\s+(\d{1,2})(?!\s*[-–—]\s*\d)(?![\d:])|\b(\d{1,2})(?!\s*[-–—]\s*\d)\s+de\s+([A-Za-zÁ-ÿ]+)/gi;
  var m;
  while ((m = re.exec(text)) !== null) {
    var monthWord = (m[1] || m[4] || '').toLowerCase();
    var day = parseInt(m[2] || m[3], 10);
    var month = MONTHS[monthWord];
    if (!month || !day || day > 31) continue;
    found.push({ raw: m[0].trim(), key: month + '-' + day, month: month, day: day, index: m.index });
  }
  return found;
}

// Regla comun a los dos chequeos de abajo: el ULTIMO valor del desarrollo es
// el resultado que el desarrollo defiende; la conclusion tiene que repetirlo.
function lastOf(list) {
  return list.length ? list[list.length - 1] : null;
}

export function verifyConclusionWeekday(text) {
  var parts = splitConclusion(text);
  if (!parts) return [];
  var derived = lastOf(weekdaysIn(parts.derivation));
  var concluded = lastOf(weekdaysIn(parts.conclusion));
  if (!derived || !concluded || derived.key === concluded.key) return [];
  return [{
    tipo: 'conclusion_contradice_desarrollo',
    dimension: 'dia_de_la_semana',
    enElDesarrollo: derived.raw,
    enLaConclusion: concluded.raw,
  }];
}

export function verifyConclusionDate(text) {
  var parts = splitConclusion(text);
  if (!parts) return [];
  var derived = lastOf(datesIn(parts.derivation));
  var concluded = lastOf(datesIn(parts.conclusion));
  if (!derived || !concluded || derived.key === concluded.key) return [];
  // Solo se reporta si hablan del MISMO mes: dos meses distintos suelen ser
  // dos hitos distintos del enunciado (inicio y fin), no una contradiccion.
  if (derived.month !== concluded.month) return [];
  return [{
    tipo: 'conclusion_contradice_desarrollo',
    dimension: 'fecha',
    enElDesarrollo: derived.raw,
    enLaConclusion: concluded.raw,
  }];
}

// "≈ 176.7, so about 143°C": el redondeo declarado tiene que estar cerca del
// numero que se acaba de calcular. Margen del 5% -- generoso a proposito, para
// que un "unos 180°C" sobre 176,7 (redondeo a la decena, legItimo) no salte.
// El marcador de aproximacion es OBLIGATORIO justo delante del segundo
// numero. Antes bastaba un conector ("so", "así que") y entonces cualquier
// cifra que continuara la frase se comparaba contra el ultimo calculo: "Total
// cost = 100 dollars, so 20 boxes are needed" se reportaba como un redondeo
// incoherente del 80% sobre un texto correcto. El conector sigue permitido,
// pero solo como relleno previo al marcador.
// El marcador NO puede ser "≈" ni "~": tras un "=" esos signos introducen el
// RESULTADO del calculo, no un redondeo del paso anterior ("(350-32) × 5/9 ≈
// 176.7"), y aceptarlos generaba avisos sobre respuestas correctas.
var ROUNDING_CLAIM = /[=≈]\s*(\d[\d.,]*)\s*[^.\n=≈]{0,40}?\b(?:about|approximately|approx|roughly|around|nearly|unos|unas|aproximadamente|cerca\s+de|casi|redondeando\s+a)\s+(\d[\d.,]*)/gi;

// La notacion de miles/decimales la decide number-format.js una vez por texto.

// Falso positivo real, encontrado al probar este modulo contra los casos
// CORRECTOS del corpus independiente (units-03, units-04): "= 2.4 hours,
// which is about 2 hours 24 minutes" y "≈ 7.9 ounces, so approximately 7 lbs
// 8 oz" no redondean nada -- DESCOMPONEN la cantidad en unidad mayor + resto,
// asi que el "2" y el "7" no son el valor redondeado sino la parte entera. Se
// detecta por la forma (unidad seguida de otro numero) y se deja pasar; la
// coherencia de esa descomposicion la comprueba unit-verify.js, que es su
// sitio.
var COMPOSITE_TAIL = /^\s*(?:hours?|horas?|h|lbs?|pounds?|libras?|ft|feet|foot|pies?|minutes?|minutos?|min|kg|kilos?)\b\s*\d/i;

export function verifyRoundingClaim(text) {
  if (!text) return [];
  var body = String(text);
  var toNumber = amountParser(body);
  var findings = [];
  var m;
  ROUNDING_CLAIM.lastIndex = 0;
  while ((m = ROUNDING_CLAIM.exec(body)) !== null) {
    var computed = toNumber(m[1]);
    var rounded = toNumber(m[2]);
    if (computed === null || rounded === null || computed === 0) continue;
    if (COMPOSITE_TAIL.test(body.slice(m.index + m[0].length))) continue;
    var relative = Math.abs((rounded - computed) / computed) * 100;
    if (relative <= 5) continue;
    findings.push({
      tipo: 'redondeo_incoherente',
      calculado: computed,
      redondeado: rounded,
      diffPct: Math.round(relative * 10) / 10,
    });
  }
  return findings;
}

// Asignaciones de posicion contradictorias dentro del mismo texto: "Cara
// first, Ana middle, Ben last" seguido de "Ana first, Cara middle, Ben last".
// Se ignoran las clausulas hipoteticas o negadas ("if Ben were last", "Ana is
// not first", "Cara can't be last") -- ahi la posicion se menciona para
// descartarla, no para afirmarla, y contarlas producia contradicciones
// inventadas sobre respuestas correctas (comprobado en vivo).
var POSITION_WORDS = /\b([A-ZÁ-Ÿ][a-zá-ÿ]{1,20})\b(?:\s+(?:is|es|va|queda|would be|se queda))?\s+(?:in\s+the\s+|en\s+(?:el\s+)?)?(first|second|third|middle|last|primero|segundo|tercero|[uú]ltimo|medio)\b/g;
// Falso positivo real, encontrado al probar este modulo contra el caso
// CORRECTO reasoning-01: "Ben is not in the middle, so Ben is first or last"
// no asigna a Ben dos posiciones -- enumera las dos que le quedan. Una
// disyuncion no es una asignacion, y contarla como tal inventaba una
// contradiccion en una respuesta impecable.
var HYPOTHETICAL = /\b(?:if|were|could|might|unless|or|either|no|not|n't|cannot|puede que|si\b|salvo|[óo]\s)\b/i;

export function verifyPositionAssignments(text) {
  if (!text) return [];
  var clauses = String(text).split(/[,;:.()\n]|\s—\s|\s-\s/);
  var byName = {};
  clauses.forEach(function (clause) {
    if (HYPOTHETICAL.test(clause)) return;
    var m;
    POSITION_WORDS.lastIndex = 0;
    while ((m = POSITION_WORDS.exec(clause)) !== null) {
      var name = m[1].toLowerCase();
      var position = m[2].toLowerCase().replace('ú', 'u');
      if (!byName[name]) byName[name] = {};
      byName[name][position] = (byName[name][position] || 0) + 1;
    }
  });
  var findings = [];
  Object.keys(byName).forEach(function (name) {
    var positions = Object.keys(byName[name]);
    if (positions.length < 2) return;
    findings.push({
      tipo: 'asignacion_contradictoria',
      sujeto: name,
      posiciones: positions,
    });
  });
  return findings;
}

// Veredicto inicial contra la explicacion que le sigue. La respuesta abre con
// "Yes"/"No" y a continuacion describe lo contrario. Se necesita la PREGUNTA
// para saber que significa "si": si se pregunta "¿es consistente?", un "si"
// afirma cumplimiento; si se pregunta "¿es una contradiccion?", un "si" afirma
// incumplimiento. Sin esa señal en la pregunta, este chequeo calla.
var COMPLIANCE_QUESTION = /\b(consistent|consistente|valid|v[áa]lido|allowed|permitido|compliant|conforme|correct[oa]?|acceptable|aceptable|protegid[oa])\b/i;
var VIOLATION_QUESTION = /\b(contradiction|contradicci[óo]n|violation|violaci[óo]n|inconsistent|inconsistente|breach|incumplimiento|problem|problema|wrong|err[oó]neo)\b/i;
var VIOLATION_LANGUAGE = /\b(violates?|viola|infringe|breaches|contradicts|contradice|is a (?:direct )?contradiction|should not|shouldn't|must not|no deber[íi]a|no puede|cannot|can't|fails?|falla|no se (?:habr[íi]a|deber[íi]a)|not be accepted|no se cumple|incumple)\b/i;

export function verifyVerdictPolarity(text, query) {
  if (!text || !query) return [];
  var body = String(text).trim();
  var opening = /^\s*(yes|no|s[íi])\b/i.exec(body);
  if (!opening) return [];
  var affirmative = /^(yes|s[íi])$/i.test(opening[1]);
  var q = String(query);
  var complianceQuestion = COMPLIANCE_QUESTION.test(q);
  var violationQuestion = VIOLATION_QUESTION.test(q);
  if (complianceQuestion === violationQuestion) return []; // ambigua o ninguna: no se opina
  var verdictClaimsViolation = violationQuestion ? affirmative : !affirmative;
  if (verdictClaimsViolation) return []; // el veredicto ya avisa del problema: nada que contradecir
  var explanation = body.replace(/^[^.!?]*[.!?]\s*/, '');
  if (!VIOLATION_LANGUAGE.test(explanation)) return [];
  var offending = (explanation.split(/(?<=[.!?])\s+/).filter(function (s) { return VIOLATION_LANGUAGE.test(s); })[0] || '').trim();
  return [{
    tipo: 'veredicto_contradice_explicacion',
    veredicto: opening[1],
    explicacion: offending.slice(0, 220),
  }];
}

// Aritmetica de husos/relojes dentro del propio texto: si la respuesta declara
// un desplazamiento ("5 hours behind") y da dos horas de reloj, la diferencia
// entre ellas tiene un unico valor posible. Caso real no detectado por ningun
// canal previo (temporal-03 del corpus independiente): "New York es 5 horas
// menos que Londres... si en New York son 2:00 PM, en Londres son 9:00 PM"
// (serian 7:00 PM). Se exige EXACTAMENTE un desplazamiento declarado y dos
// horas de reloj -- con mas de dos horas en juego no se puede saber cual se
// compara con cual sin interpretar la frase, y este canal no interpreta.
var CLOCK_TIME = /\b(\d{1,2}):(\d{2})\s*(AM|PM|a\.m\.|p\.m\.)?/gi;
var DECLARED_OFFSET = /\b(\d{1,2})\s*(?:hours?|horas?)\s*(?:behind|ahead|de\s+(?:diferencia|adelanto|retraso)|m[áa]s|menos)\b/i;

function clockToMinutes(hour, minute, meridiem) {
  var h = hour % 12;
  if (meridiem && /p/i.test(meridiem)) h += 12;
  if (!meridiem) h = hour;
  return h * 60 + minute;
}

export function verifyClockOffset(text) {
  if (!text) return [];
  var body = String(text);
  var offset = DECLARED_OFFSET.exec(body);
  if (!offset) return [];
  var times = [];
  var m;
  CLOCK_TIME.lastIndex = 0;
  while ((m = CLOCK_TIME.exec(body)) !== null) {
    times.push({ raw: m[0].trim(), minutes: clockToMinutes(parseInt(m[1], 10), parseInt(m[2], 10), m[3]) });
  }
  if (times.length !== 2) return [];
  var declaredMinutes = parseInt(offset[1], 10) * 60;
  var actual = Math.abs(times[1].minutes - times[0].minutes);
  if (actual > 12 * 60) actual = 24 * 60 - actual;
  if (actual === declaredMinutes) return [];
  return [{
    tipo: 'desplazamiento_horario_incoherente',
    desplazamientoDeclarado: offset[1] + ' h',
    desplazamientoAplicado: (Math.round((actual / 60) * 100) / 100) + ' h',
    horas: [times[0].raw, times[1].raw],
  }];
}

export function verifyConclusionConsistency(text, query) {
  return verifyConclusionWeekday(text)
    .concat(verifyClockOffset(text))
    .concat(verifyConclusionDate(text))
    .concat(verifyRoundingClaim(text))
    .concat(verifyPositionAssignments(text))
    .concat(verifyVerdictPolarity(text, query));
}
