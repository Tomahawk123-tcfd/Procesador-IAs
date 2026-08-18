// ── UNIDAD DE PUNTUACION DE CONFIANZA (2026-08-18) ──
// Hasta ahora, VERIFY y CROSSCHECK se disparaban porque la IA jefe decidia
// hacerlo, no porque el sistema calculara si el caso lo merecia. Esta
// funcion cierra ese hueco: tras correr VERIFY (rapido, determinista,
// gratis en RAM), decide si el silencio de VERIFY es una señal real de
// "esta bien" o solo significa "VERIFY no tiene ningun chequeo que
// aplique aqui" -- y si merece la pena escalar a CROSSCHECK (lento, con
// coste real de RAM/latencia) para tener una segunda voz independiente.
//
// Las probabilidades no son un modelo entrenado ni una opinion de otra
// IA -- son la MEDICION REAL de este mismo proyecto (scripts/benchmark-
// verification.mjs, corpus autoescrito de 30 casos, 2026-08-17): VERIFY
// sola acierta 100% en matematicas y aritmetica de años, pero solo 16.7%
// en afirmaciones factuales sin numeros -- exactamente donde CROSSCHECK
// (fact-checking cruzado entre voces) acierta 100%. La puntuacion de
// confianza usa esa asimetria medida, no una intuicion.
//
// Requisito explicito del usuario (2026-08-18): "no debes depender de mi
// RAM porque cada usuario tiene una diferente" -- un producto que se vende
// a empresas no puede asumir que siempre habra RAM libre para consultar
// modelos locales. Por eso esta unidad SIEMPRE comprueba disponibilidad
// real de RAM (ollama-catalog.js#hasSufficientRamFor) antes de recomendar
// escalar, y degrada limpiamente a "quedate en VERIFY" cuando no hay
// margen -- el sistema sigue siendo util (VERIFY no depende de RAM) en
// vez de fallar o colgarse en una maquina mas modesta.

import { extractClaims } from './structural-verify.js';

// Modelo de referencia para el chequeo de RAM: el mas pequeño y capaz del
// catalogo que CROSSCHECK usaria en la practica (ver ollama-catalog.js).
// No es EL modelo exacto que se acabaria eligiendo (eso lo decide
// intermediateOllama() con la categoria real) -- es un proxy deliberadamente
// barato para saber si "hay margen para intentar algo local ahora mismo",
// sin forzar la carga de un modelo solo para medir.
var RAM_PROBE_MODEL = 'qwen2.5:0.5b';

// Regresion real, encontrada verificando el fix anterior (2026-08-18): al
// quitar la guarda `!arithmeticHeavy` de la rama factual (correcto para el
// caso MIXTO), una frase puramente aritmetica redactada con copula ("El
// area ES 12 x 5 = 60") pasaba a contar como afirmacion factual y bajaba a
// 0.4 -- candidata a escalar a CROSSCHECK (60-150s) por algo que VERIFY ya
// resuelve al 100% de forma determinista. La señal que de verdad distingue
// los dos casos no es el texto entero, es el PREDICADO: "es Canberra" o
// "es Paris, que tiene 2100000 habitantes" tienen una entidad real que
// VERIFY no puede auditar; "es 12 x 5 = 60 metros cuadrados" es una cuenta
// que math-verify.js ya comprueba. Se cuenta como prosa factual solo si
// hay AL MENOS UNA afirmacion cuyo predicado nuclear no sea aritmetica.
function corePredicate(predicate) {
  return (predicate || '').split(/[,;:(]/)[0].trim();
}

function isArithmeticPredicate(predicate) {
  var core = corePredicate(predicate);
  var digits = (core.match(/\d/g) || []).length;
  if (digits === 0) return false;
  var hasOperator = /[+\-−*/^=≈×÷]|\d\s*x\s*\d/i.test(core);
  return hasOperator && digits / Math.max(core.length, 1) > 0.08;
}

function looksLikeFactualProse(text) {
  var claims = extractClaims(text || '');
  return claims.some(function (c) { return !isArithmeticPredicate(c.predicate); });
}

// Bug real, encontrado en prueba adversarial de esta misma unidad
// (2026-08-18): "La capital de Francia, fundada hace más de 2000 años
// según la tradición, es París" se marcaba como 'arithmeticHeavy' (85% de
// confianza, sin escalar) solo por la densidad de digitos del año
// incidental -- exactamente al reves de lo que deberia pasar: es una
// afirmacion factual sin ningun calculo, justo el terreno donde CROSSCHECK
// aporta y VERIFY no. La densidad de digitos sola no distingue "una fecha
// mencionada de paso" de "una cuenta real" -- se exige ademas un operador
// aritmetico de verdad (+,-,*,/,=,≈,x,×,÷) cerca de los digitos, no solo
// que haya digitos.
function looksLikeArithmeticHeavy(text) {
  var t = typeof text === 'string' ? text : '';
  var digitCount = (t.match(/\d/g) || []).length;
  var hasOperator = /[+\-−*/^=≈×÷]|(?<=\d)\s*x\s*(?=\d)/i.test(t);
  return digitCount >= 3 && digitCount / Math.max(t.length, 1) > 0.03 && hasOperator;
}

// assessConfidence(text, opts) -> { score, recommendEscalation, reason, ramAvailable }
// `opts.hasFindings`: si VERIFY ya encontro un problema real.
// `opts.checkRam`: funcion inyectable (para tests) que devuelve
// {ok, freeMB, needMB} -- por defecto usa la comprobacion real de RAM.
async function assessConfidence(text, opts) {
  opts = opts || {};
  var hasFindings = !!opts.hasFindings;

  if (hasFindings) {
    return {
      score: 0.15,
      recommendEscalation: false,
      ramAvailable: null,
      reason: 'VERIFY ya encontró un problema real -- no hace falta gastar CROSSCHECK para confirmar algo que ya se sabe que está mal. Mostrar el hallazgo de VERIFY directamente.',
    };
  }

  // Bug real, encontrado en hunt adversarial (2026-08-18): `text` viene de
  // payload.draft, JSON arbitrario mandado por quien invoque vNPU.VERIFY/
  // AUTOVERIFY -- un payload perfectamente valido como {"draft":12345} o
  // {"draft":[1,2,3]} llega aqui como numero/array/objeto, no string.
  // looksLikeArithmeticHeavy() hacia `t.match(...)` sobre ese valor tal
  // cual -- TypeError ("t.match is not a function") sin capturar en
  // ningun sitio de esta unidad, tumbando el opcode entero con un mensaje
  // interno crudo en vez de degradar limpio como el resto del proyecto
  // (ver la guarda de CROSSCHECK en vnpu-core.js). Se normaliza a string
  // una sola vez, aqui, para que ambos detectores reciban siempre texto.
  var safeText = typeof text === 'string' ? text : (text == null ? '' : String(text));

  var factualProse = looksLikeFactualProse(safeText);
  var arithmeticHeavy = looksLikeArithmeticHeavy(safeText);

  var ramCheck = { ok: true, freeMB: null, needMB: 0 };
  try {
    var catalogMod = await import('./ollama-catalog.js');
    ramCheck = catalogMod.hasSufficientRamFor(RAM_PROBE_MODEL);
  } catch (e) {
    // Sin poder comprobar RAM real, no se asume que hay margen -- se
    // recomienda quedarse en VERIFY (la opcion que nunca depende de RAM)
    // en vez de arriesgar una recomendacion que no se puede sostener.
    ramCheck = { ok: false, freeMB: null, needMB: 0 };
  }

  // Bug real, encontrado en hunt adversarial (2026-08-18): antes esta rama
  // exigia `factualProse && !arithmeticHeavy` -- un texto con AMBAS cosas a
  // la vez (p.ej. "La capital de Francia es París, que tiene 2100000
  // habitantes y creció 15% + 3%") caia directo al generico "confianza
  // moderada" de mas abajo, perdiendo la señal de que hay una afirmacion
  // "X es Y" que VERIFY mide solo 16.7% de aciertos en detectar. La
  // presencia de aritmetica en la MISMA respuesta no hace que esa
  // afirmacion factual sea mas facil de auditar -- VERIFY sigue ciego a
  // ella igual. Se comprueba factualProse primero, sin condicionar a la
  // ausencia de aritmetica: si hay una afirmacion factual, se evalua para
  // escalar, haya o no numeros alrededor.
  if (factualProse) {
    if (!ramCheck.ok) {
      return {
        score: 0.4,
        recommendEscalation: false,
        ramAvailable: false,
        reason: 'Hay afirmaciones factuales tipo "X es Y" que VERIFY no puede contrastar por sí sola (mide 16.7% de aciertos en esa categoría, frente al 100% de CROSSCHECK)' + (arithmeticHeavy ? ', aunque el texto también contenga aritmética' : '') + ' -- CROSSCHECK sería lo ideal, pero no hay RAM libre suficiente ahora mismo (' + ramCheck.freeMB + 'MB libres). Se mantiene la confianza baja pero no se recomienda escalar: forzarlo fallaría o degradaría, no ayudaría.',
      };
    }
    return {
      score: 0.4,
      recommendEscalation: true,
      ramAvailable: true,
      reason: 'Afirmaciones factuales tipo "X es Y"' + (arithmeticHeavy ? ' (aunque el texto también tenga aritmética, eso no cubre la afirmación factual)' : ' sin respaldo numérico') + ' -- terreno donde VERIFY mide solo 16.7% de aciertos. Hay RAM suficiente (' + ramCheck.freeMB + 'MB libres) para que CROSSCHECK (100% de aciertos medido en esta categoría) las contraste contra otra voz.',
    };
  }

  if (arithmeticHeavy) {
    return {
      score: 0.85,
      recommendEscalation: false,
      ramAvailable: ramCheck.ok,
      reason: 'Contenido dominado por aritmética/fechas, donde VERIFY mide 100% de aciertos de forma determinista y sin coste. Su silencio aquí es una señal fuerte -- no hace falta gastar CROSSCHECK.',
    };
  }

  return {
    score: 0.6,
    recommendEscalation: false,
    ramAvailable: ramCheck.ok,
    reason: 'Sin hallazgos y sin una señal clara de contenido factual no verificable. Confianza moderada -- no se recomienda escalar por defecto, pero tampoco hay la misma certeza que en el caso puramente aritmético.',
  };
}

export { assessConfidence };
