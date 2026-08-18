// ── VERIFICACION MATEMATICA DETERMINISTA ──
// Bug real, encontrado en vivo (2026-08-08): se le pidio a LinkCore
// calcular 1000 * 1.07^10 (interes compuesto). El ensemble local escribio
// la formula correcta, pero sustituyo mal: dijo "1000 x 2,158275" cuando
// 1.07^10 es en realidad 1.967151 -- el resultado final (2158,28 euros)
// era ~9.7% mas alto que el correcto (1967,15 euros), presentado con
// total confianza y una formula limpia. Ningun LLM, ni el ensemble ni uno
// grande, es fiable haciendo aritmetica mental. Un ordenador si lo es.
//
// Esto NO intenta entender la pregunta ni generar la respuesta -- solo
// escanea el TEXTO YA GENERADO por el modelo en busca de expresiones
// aritmeticas puras seguidas de un resultado afirmado, las recalcula de
// verdad, y avisa si no coinciden. Es una red de seguridad determinista
// sobre una respuesta probabilistica, no un modelo mas.

// Parser recursivo-descendente sobre un whitelist estricto de caracteres
// -- nunca eval()/Function() sobre texto generado por un modelo, aunque
// parezca inofensivo. Un evaluador propio, sin acceso a nada del sistema,
// es la unica forma segura de "calcular lo que dice el texto".
function tokenize(expr) {
  var tokens = [];
  var i = 0;
  while (i < expr.length) {
    var c = expr[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9]/.test(c)) {
      var num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: 'num', value: parseFloat(num) });
      continue;
    }
    if ('+-*/^()'.indexOf(c) !== -1) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    // Caracter fuera del whitelist aritmetico -- no es una expresion pura,
    // se aborta en vez de intentar adivinar que quiso decir.
    return null;
  }
  return tokens;
}

function parseExpr(tokens, pos) {
  var result = parseTerm(tokens, pos);
  if (!result) return null;
  var left = result.value; pos = result.pos;
  while (pos < tokens.length && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
    var op = tokens[pos].value; pos++;
    var right = parseTerm(tokens, pos);
    if (!right) return null;
    left = op === '+' ? left + right.value : left - right.value;
    pos = right.pos;
  }
  return { value: left, pos: pos };
}

function parseTerm(tokens, pos) {
  var result = parsePower(tokens, pos);
  if (!result) return null;
  var left = result.value; pos = result.pos;
  while (pos < tokens.length && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
    var op = tokens[pos].value; pos++;
    var right = parsePower(tokens, pos);
    if (!right) return null;
    if (op === '/' && right.value === 0) return null; // division por cero: no es una expresion valida, no se inventa un resultado
    left = op === '*' ? left * right.value : left / right.value;
    pos = right.pos;
  }
  return { value: left, pos: pos };
}

function parsePower(tokens, pos) {
  var result = parseUnary(tokens, pos);
  if (!result) return null;
  var left = result.value; pos = result.pos;
  if (pos < tokens.length && tokens[pos].value === '^') {
    pos++;
    var right = parsePower(tokens, pos); // asociativo a la derecha
    if (!right) return null;
    return { value: Math.pow(left, right.value), pos: right.pos };
  }
  return { value: left, pos: pos };
}

function parseUnary(tokens, pos) {
  if (pos < tokens.length && tokens[pos].value === '-') {
    var inner = parseUnary(tokens, pos + 1);
    if (!inner) return null;
    return { value: -inner.value, pos: inner.pos };
  }
  return parsePrimary(tokens, pos);
}

function parsePrimary(tokens, pos) {
  if (pos >= tokens.length) return null;
  var t = tokens[pos];
  if (t.type === 'num') return { value: t.value, pos: pos + 1 };
  if (t.value === '(') {
    var inner = parseExpr(tokens, pos + 1);
    if (!inner) return null;
    if (tokens[inner.pos] && tokens[inner.pos].value === ')') {
      return { value: inner.value, pos: inner.pos + 1 };
    }
    return null;
  }
  return null;
}

// Evalua una expresion aritmetica en texto de forma segura. Devuelve
// `null` si contiene cualquier cosa fuera del whitelist numerico/operador
// (nunca intenta "adivinar" ni ejecutar codigo) o si la expresion esta mal
// formada.
function safeEval(expr) {
  var tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  var result = parseExpr(tokens, 0);
  if (!result || result.pos !== tokens.length) return null;
  if (!isFinite(result.value)) return null;
  return result.value;
}

// Bug real, encontrado en verificacion adversarial con un corpus
// independiente en ingles/notacion estadounidense (2026-08-18): "$753,840
// − $340,000" no generaba NINGUN hallazgo pese a tener un error real --
// el signo "−" que usa es MENOS MATEMATICO (U+2212), no el guion ASCII
// "-" (U+002D) que reconocen los patrones de abajo. Un LLM tipografiando
// matematicas en ingles usa U+2212 con normalidad; se mapea a "-" igual
// que "×"/"x"/"÷" ya se mapean a sus equivalentes ASCII.
function normalizeExpr(raw) {
  // Segundo hallazgo real de la misma verificacion adversarial (2026-08-18):
  // al quitar el "$" con stripCurrencySymbols(), "9,268" (miles con coma,
  // notacion anglosajona) llegaba aqui y el reemplazo ciego de "," por "."
  // lo convertia en 9.268 -- un error de 1000x, peor que no detectar nada.
  // No se puede distinguir con certeza "coma = miles" de "coma = decimal"
  // sin saber el idioma/locale de origen, asi que se resuelve con una
  // regla deliberadamente estrecha: una coma seguida de EXACTAMENTE 3
  // digitos y nada mas de digitos despues ("9,268", "1,234,567") se trata
  // como separador de miles y se BORRA, no se convierte en punto. El caso
  // principal de este proyecto (coma decimal en español: "86,40 euros",
  // "0,15") casi nunca tiene exactamente 3 digitos tras la coma -- sigue
  // intacto. Un caso genuinamente ambiguo como "3,141" (¿tres coma ciento
  // cuarenta y uno, o 3141?) se resuelve a favor de miles -- riesgo
  // aceptado y documentado, no oculto.
  var s = raw.replace(/\d(?:,\d{3})+(?!\d)/g, function (m) { return m.replace(/,/g, ''); });
  return s
    .replace(/,/g, '.')
    .replace(/[×x]/gi, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .trim();
}

// Mismo hallazgo (2026-08-18): un simbolo de moneda pegado a un numero
// dentro de una expresion ("$753,840 − $340,000 ≈ $313,840") corta la
// expresion en seco -- ni EXPR_AFTER_EQUALS ni DIRECT_EXPR_EQUALS pueden
// atravesar un caracter fuera de su clase, y "$" nunca estuvo en ella. Se
// quita ANTES de aplicar cualquier patron (no cambia el valor numerico,
// solo estorba a la deteccion), nunca dentro de safeEval -- el criterio de
// "nunca eval() ni adivinar" sigue intacto, esto es limpieza de texto de
// entrada, no interpretacion aritmetica.
function stripCurrencySymbols(text) {
  return (text || '').replace(/[$€£¥]\s*(?=\d)/g, '');
}

// Extrae toda expresion aritmetica PURA (solo digitos/operadores/parentesis,
// sin variables) que aparezca justo despues de un "=" o "≈" en el texto --
// tanto si el otro lado es un numero suelto ("= 2158,28") como si es otra
// expresion pura ("= 1000 x 2,158275"). Cada linea de una derivacion paso a
// paso ("A = ...", "A = ...", "A ≈ ...") deja una de estas.
var EXPR_AFTER_EQUALS = /[=≈]\s*(\(?-?[0-9][0-9.,\s+\-−*/^×x÷()]*[0-9)])/g;

// La ETIQUETA de un paso es lo que hay a la izquierda de su "=" en esa
// linea ("A", "Descuento", "Precio Final"...). Bug real, encontrado por el
// propio benchmark (test/verification-benchmark.js, 2026-08-08) sobre una
// respuesta REAL y CORRECTA:
//
//     Descuento = 340 x 0,22 = 74,80 euros
//     Precio Final = 340 - 74,80 = 265,20 euros
//
// Los dos calculos son correctos, pero la comparacion de "pasos
// consecutivos" comparaba 74,80 contra 265,20 -- dos cantidades DISTINTAS
// (el descuento y el precio final) -- y gritaba un error del 254% en una
// respuesta impecable. La premisa "pasos consecutivos deben ser iguales"
// solo vale DENTRO de la derivacion de UNA MISMA cantidad. Agrupar por
// etiqueta lo arregla sin perder el caso que motivo el verificador (el de
// interes compuesto: todas sus lineas son "A = ...", misma etiqueta).
//
// Limitacion real, encontrada probando en vivo (2026-08-18), NO arreglada:
// labelFor() agrupa por el prefijo de linea completo hasta el match, asi que
// una cadena de igualdades escrita TODA EN UNA SOLA LINEA nunca se agrupa
// como "misma cantidad restated" -- cada "=" sucesivo hace crecer el
// prefijo y genera una etiqueta distinta. Reproducido en vivo:
//   verifyCalculations('1000 x 1,07^10 = 1000 x 2,158275 ≈ 2158,28 euros')
// devuelve [] (deberia poder detectar una sustitucion incorrecta ahi si la
// hubiera). Si la misma cadena se escribe en lineas separadas con la misma
// etiqueta, o el paso intermedio se afirma como su propia ecuacion aislada,
// SI se detecta -- el mecanismo existente funciona, solo falla en el caso
// de una sola linea. El fix obvio (agrupar por linea fisica en vez de por
// prefijo) rompe el caso de arriba (340 x 0,22 = 74,80 / 340 - 74,80 =
// 265,20 en variantes de una sola linea con cantidades distintas separadas
// por coma) -- un fix seguro necesita distinguir "cadena numerica pura" de
// "nueva etiqueta" caracter a caracter, que no se ha hecho todavia.
function labelFor(text, matchIndex) {
  var lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  var before = text.slice(lineStart, matchIndex).trim();
  return before.toLowerCase().replace(/\s+/g, ' ');
}

function extractEvaluableSteps(text) {
  var steps = [];
  var match;
  EXPR_AFTER_EQUALS.lastIndex = 0;
  while ((match = EXPR_AFTER_EQUALS.exec(text)) !== null) {
    var raw = match[1].trim();
    var norm = normalizeExpr(raw);
    var value = safeEval(norm);
    if (value !== null) {
      steps.push({ raw: raw, norm: norm, value: value, index: match.index, label: labelFor(text, match.index) });
    }
  }
  return steps;
}

// Segundo bug real, encontrado en vivo (2026-08-08) probando el propio
// verificador con casos nuevos ("200 * 0.15 = 25 euros", un IVA mal
// calculado, etc.): el rediseño para pillar el caso de "curva de
// derivacion paso a paso" (arriba) rompio sin querer el caso mas simple y
// mas comun -- una sola linea "expresion = resultado". EXPR_AFTER_EQUALS
// solo captura lo que va DESPUES de cada "=", nunca la expresion pura
// ANTES de el, asi que "200 * 0.15 = 25" solo extraia "25" (sin operador,
// filtrado, cero pasos que comparar). Se añade este segundo patron,
// independiente del primero: expresion pura ANTES del "=" comparada
// directamente contra el numero DESPUES.
// Flag 'd' (indices de cada grupo capturado): necesaria para poder REBOBINAR
// el escaneo al inicio exacto del grupo 2 cuando se descarta una
// coincidencia (ver isStartOfFurtherExpression mas abajo) -- sin indices
// exactos, saltar la coincidencia entera se come los caracteres que la
// SIGUIENTE expresion real de la cadena necesitaba como su propio inicio.
var DIRECT_EXPR_EQUALS = /([0-9][0-9.,]*(?:\s*[+\-−*/^×x÷]\s*\(?-?[0-9][0-9.,]*\)?)+)\s*[=≈]\s*\(?(-?[0-9][0-9.,]*)/gd;

// El "numero reclamado" capturado por la regex de arriba es solo digitos --
// si justo despues (tras espacios) viene un operador, ese numero NO es el
// resultado final de la expresion anterior, es el PRIMER TERMINO de otra
// expresion reescrita ("A = B x C = D", muy comun en cadenas de reduccion
// paso a paso en una sola linea). Sin este chequeo se compara la expresion
// completa de la izquierda contra un fragmento truncado de la de la
// derecha -- dos cantidades sin relacion real.
function isStartOfFurtherExpression(text, afterIndex) {
  var i = afterIndex;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i < text.length && '+-−*/^×x÷'.indexOf(text[i]) !== -1;
}

// Bug real, encontrado en el propio corpus empresarial (2026-08-18):
// "Margen = 1.100.000 / 4.200.000 = 26,2%" es correcto (1100000/4200000 =
// 0,2619, redondeado a 26,2% = 0,262) pero se marcaba como error de
// 99%: la division da una FRACCION (0,2619), el numero reclamado esta
// expresado como PORCENTAJE (26,2), y nadie multiplicaba por 100 antes de
// comparar. Patron extremadamente comun en texto financiero ("X / Y =
// Z%"). Se comprueba si justo despues del numero reclamado (tras
// espacios) viene un "%" -- si es asi, se compara el computado ESCALADO
// x100 contra el reclamado, no el computado crudo.
function isFollowedByPercent(text, afterIndex) {
  var i = afterIndex;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i < text.length && text[i] === '%';
}

function verifyDirectStatements(text, tolerancePct) {
  var findings = [];
  var match;
  DIRECT_EXPR_EQUALS.lastIndex = 0;
  while ((match = DIRECT_EXPR_EQUALS.exec(text)) !== null) {
    // Bug real, encontrado en verificacion adversarial con un corpus
    // independiente (2026-08-18): "Future value = 8200 x (1+0,003417)^36
    // ≈ 8200 x 1,1303 ≈ $9.268" (correcto) se marcaba como error porque el
    // "8200" que arranca la SEGUNDA expresion se leia como si fuera el
    // resultado reclamado de la PRIMERA. Mismo patron reprodujo 3 falsos
    // positivos distintos en el mismo corpus (fracciones reducidas paso a
    // paso en una linea, conversion de temperatura con dos "=" seguidos).
    // Si lo que sigue al numero capturado es otro operador, no es un
    // resultado final -- se descarta esta coincidencia. Rebobinar (no solo
    // "continue") es imprescindible: sin rebobinar, el intento siguiente
    // arranca DESPUES de todo lo ya consumido, perdiendo el termino inicial
    // ("318" en "318 x 5/9 ≈ 176.7") que la proxima expresion real
    // necesitaba como su propio comienzo -- confirmado en vivo, produjo un
    // segundo falso positivo mientras se probaba este mismo arreglo.
    if (isStartOfFurtherExpression(text, match.index + match[0].length)) {
      DIRECT_EXPR_EQUALS.lastIndex = match.indices[2][0];
      continue;
    }

    var exprRaw = match[1].trim();
    var claimedRaw = normalizeExpr(match[2]);
    var computed = safeEval(normalizeExpr(exprRaw));
    var claimed = parseFloat(claimedRaw);
    if (computed === null || isNaN(claimed)) continue;
    var claimedIsPercent = isFollowedByPercent(text, match.indices[2][1]);
    var comparable = claimedIsPercent ? computed * 100 : computed;
    var diffPct = claimed === 0 ? (comparable === 0 ? 0 : 100) : Math.abs((comparable - claimed) / claimed) * 100;
    if (diffPct > tolerancePct) {
      findings.push({
        pasoAnterior: exprRaw + (claimedIsPercent ? ' (como %)' : ''),
        valorAnterior: Math.round(comparable * 1e6) / 1e6,
        pasoSiguiente: match[2].trim() + (claimedIsPercent ? '%' : ''),
        valorSiguiente: claimed,
        diffPct: Math.round(diffPct * 10) / 10,
      });
    }
  }
  return findings;
}

// Bug real, encontrado en vivo (2026-08-08): el error de calculo real
// (1.07^10 sustituido como 2,158275 en vez de 1,967151) no estaba en que
// una expresion no cuadrase con SU PROPIO resultado final -- la ultima
// linea ("1000 x 2,158275 ≈ 2158,28") es internamente consistente. El
// fallo esta en el PASO anterior: la sustitucion de "(1+0,07)^10" por
// "2,158275" ya era incorrecta. Una derivacion paso a paso escribe varias
// lineas que deberian ser TODAS iguales entre si (son la misma cantidad,
// reescrita) -- se comparan los pasos consecutivos entre si, no solo el
// ultimo contra un resultado externo.
//
// Se combinan DOS chequeos independientes, porque cubren casos distintos
// (probado en vivo: cada uno pillaba lo que el otro no):
// 1. verifyDirectStatements(): "expr = resultado" en una sola linea.
// 2. El bucle de abajo: pasos consecutivos de una derivacion, cuando
//    ninguna linea individual tiene la expresion completa a un lado.
function verifyCalculations(text, tolerancePct) {
  if (!text) return [];
  tolerancePct = typeof tolerancePct === 'number' ? tolerancePct : 0.5; // 0.5% de margen por redondeo intermedio
  text = stripCurrencySymbols(text);
  var directFindings = verifyDirectStatements(text, tolerancePct);
  var steps = extractEvaluableSteps(text);
  // Solo expresiones con operador real cuentan como "paso de calculo" --
  // un "= 10" suelto (ej. "n = 10 años") no es una cuenta que verificar.
  // Bug real, encontrado en vivo (2026-08-08): este filtro comprobaba
  // `s.raw` (el texto tal cual, con "x"/"×" como simbolo de multiplicar)
  // contra un patron que solo reconoce "*" -- un paso como "1000 x
  // 2,158275" no tiene NINGUN caracter de [+\-*/^] en crudo, asi que se
  // descartaba antes de poder compararlo, justo el paso donde estaba el
  // error real. Se comprueba `s.norm` (ya normalizado, "x"->"*"), no el
  // texto original.
  steps = steps.filter(function (s) { return /[+\-*/^]/.test(s.norm.replace(/^\(|\)$/g, '')); });
  var findings = [];
  // Bug real, encontrado por el propio benchmark de verificacion
  // (scripts/benchmark-verification.mjs, caso math-06, 2026-08-17): pese a
  // que labelFor() ya calculaba una etiqueta por paso (ver comentario mas
  // arriba, "agrupar por etiqueta lo arregla"), este bucle nunca la
  // consultaba -- comparaba steps[i-1] contra steps[i] por INDICE de array,
  // sin mirar la etiqueta. Confirmado en vivo: "Descuento = 480 x 0,18 =
  // 86,40 euros" seguido de "Precio final = 480 - 86,40 = 393,60 euros"
  // (calculo CORRECTO) disparaba un falso "355% de diferencia" porque
  // comparaba el descuento contra el precio final -- dos cantidades
  // distintas que solo son vecinas en el texto, no en la derivacion. Se
  // compara cada paso contra el ULTIMO paso visto con la MISMA etiqueta
  // (no necesariamente el anterior en el array), que es justo lo que el
  // comentario original decia hacer.
  var lastStepByLabel = {};
  for (var i = 0; i < steps.length; i++) {
    var curr = steps[i];
    var prev = lastStepByLabel[curr.label];
    if (prev) {
      var diffPct = prev.value === 0 ? (curr.value === 0 ? 0 : 100) : Math.abs((curr.value - prev.value) / prev.value) * 100;
      if (diffPct > tolerancePct) {
        findings.push({
          pasoAnterior: prev.raw,
          valorAnterior: Math.round(prev.value * 1e6) / 1e6,
          pasoSiguiente: curr.raw,
          valorSiguiente: Math.round(curr.value * 1e6) / 1e6,
          diffPct: Math.round(diffPct * 10) / 10,
        });
      }
    }
    lastStepByLabel[curr.label] = curr;
  }
  // Fusion de los tres chequeos, sin duplicar el mismo hallazgo si por
  // casualidad los patrones capturaron la misma pareja de pasos. El tercero
  // (prosa sin "="/"≈", ver verifyNaturalLanguageArithmetic mas abajo) se
  // llama aqui mismo para que cualquier caller existente de
  // verifyCalculations() (incluido verification-pipeline.js) reciba la
  // cobertura sin tener que cambiar nada mas.
  var naturalLangFindings = verifyNaturalLanguageArithmetic(text, tolerancePct);
  var seen = {};
  var merged = [];
  directFindings.concat(findings).concat(naturalLangFindings).forEach(function (f) {
    var key = f.pasoAnterior + '|' + f.pasoSiguiente;
    if (seen[key]) return;
    seen[key] = true;
    merged.push(f);
  });
  return merged;
}

// ── COMPARACION DE CIFRA FINAL ENTRE DOS RESPUESTAS ──
// verifyCalculations() comprueba los pasos INTERNOS de UNA respuesta
// (que cada paso de su propia derivacion cuadre con el anterior). Esto es
// otra cosa: comparar la cifra final que afirman DOS respuestas
// INDEPENDIENTES del ensemble, para decidir si hace falta un tercer
// modelo de desempate antes de sintetizar. Construido 2026-08-10 porque
// detectSemanticOverlap() (semantic-translator.js) demostro en calibracion
// que dos respuestas pueden compartir casi todo el vocabulario y aun asi
// discrepar en la cifra exacta -- justo el caso donde una tercera opinion
// mas falta hace, y donde una señal de solapamiento de palabras no sirve.

// Reutiliza extractEvaluableSteps() para las derivaciones "X = numero"/
// "X ≈ numero"; si el texto no tiene ninguna (respuesta en prosa sin
// formato de calculo), cae a buscar el ultimo numero con pinta de cifra
// real (no un ano, no un "paso 3") en el texto -- mejor candidato
// disponible, no una certeza.
var STANDALONE_NUMBER_RE = /-?\d[\d.,]*\d|-?\d/g;

// Igual que extractFinalNumericClaim() (abajo, ahora un wrapper de esta),
// pero devuelve tambien la posicion en el texto donde se encontro la cifra
// final -- necesario para structural-verify.js#verifyCrossVoiceNumbers
// (2026-08-17), que agrupa voces por "misma pregunta aparente" mirando el
// contexto (frase) alrededor de la cifra, no solo la cifra en si. Una
// funcion nueva en vez de anadir un segundo parametro opcional a
// extractFinalNumericClaim() para no cambiar la forma de su valor de
// retorno (numero | null) en ningun caller existente.
function extractFinalNumericClaimWithIndex(text) {
  if (!text) return null;
  var steps = extractEvaluableSteps(text);
  if (steps.length > 0) {
    var lastStep = steps[steps.length - 1];
    return { value: lastStep.value, index: lastStep.index };
  }
  // Regex propia (no la compartida STANDALONE_NUMBER_RE) para no arrastrar
  // estado de lastIndex entre llamadas -- exec() con /g necesita recorrer
  // todo el texto para quedarse con el ULTIMO match, y usar el regex
  // module-level compartido aqui lo dejaria con lastIndex distinto de 0
  // para cualquier otro caller que lo reutilice despues.
  var re = new RegExp(STANDALONE_NUMBER_RE.source, 'g');
  var m, last = null;
  while ((m = re.exec(text)) !== null) {
    last = m;
    if (re.lastIndex === m.index) re.lastIndex++; // evita bucle infinito ante un match de longitud cero
  }
  if (!last) return null;
  var value = parseFloat(normalizeExpr(last[0]));
  if (isNaN(value)) return null;
  return { value: value, index: last.index };
}

function extractFinalNumericClaim(text) {
  var r = extractFinalNumericClaimWithIndex(text);
  return r ? r.value : null;
}

// Compara la cifra final afirmada por dos respuestas. Devuelve `null` si
// alguna de las dos no afirma ningun numero (nada que comparar por esta
// via -- no es lo mismo que "estan de acuerdo"). Tolerancia mas laxa que
// verifyCalculations() (2% en vez de 0.5%): aqui se comparan dos
// respuestas INDEPENDIENTES, no pasos de una misma derivacion -- una
// diferencia de redondeo intermedio legitima entre dos modelos distintos
// es mas probable que dentro de la derivacion de un solo modelo.
function compareNumericClaims(textA, textB, tolerancePct) {
  tolerancePct = typeof tolerancePct === 'number' ? tolerancePct : 2;
  var a = extractFinalNumericClaim(textA);
  var b = extractFinalNumericClaim(textB);
  if (a === null || b === null) return null;
  var diffPct = a === 0 ? (b === 0 ? 0 : 100) : Math.abs((b - a) / a) * 100;
  return { disagree: diffPct > tolerancePct, valueA: a, valueB: b, diffPct: Math.round(diffPct * 10) / 10 };
}

// ── ¿RESOLVIO LA OPERACION QUE SE LE PIDIO? ──
// Hueco real encontrado en vivo (2026-08-12) con una llamada MCP: a la
// pregunta "Cuanto es 15 por 4?" (multiplicacion, = 60) el modelo
// respondio con una DIVISION: "15 ÷ 4 = 3.75". verifyCalculations() dio
// "sin hallazgos" -- y hacia bien su trabajo: 15÷4=3.75 es aritmeticamente
// correcto. Nadie comprobaba que la operacion RESUELTA fuera la PEDIDA.
//
// Se cierra de forma determinista, sin interpretar nada: se extrae el
// operador de la pregunta por palabra clave, se miran los operadores que
// aparecen en la respuesta, y si el pedido no esta entre ellos es un
// hallazgo. Conservador a proposito: si la pregunta no menciona ninguna
// operacion reconocible, o la respuesta no contiene ninguna, no se dice
// nada (cero ruido antes que un falso positivo).
// Bug real, GRAVE, medido sobre 1158 respuestas reales de Claude
// (scripts/measure-on-claude-output.mjs, 2026-08-12): esta funcion marcaba
// 49 respuestas como "la operacion resuelta no es la que se pidio" y las 49
// eran FALSOS POSITIVOS. Causa: en español "por", "entre", "mas" y "menos"
// son de las preposiciones/adverbios mas comunes del idioma ("gracias POR",
// "POR eso", "ENTRE otras cosas", "MAS bien", "MENOS de lo que deberia") --
// buscarlas como palabra suelta dispara en prosa normal, no en aritmetica.
// Tasa real de hallazgos legitimos: 2 de 1158 (0.17%), no 4.4%.
//
// Se exige CONTEXTO ARITMETICO REAL: la palabra de operacion tiene que
// estar entre dos numeros ("15 por 4", "20 entre 5"), no suelta en una
// frase. Las formas verbales explicitas (multiplicar, dividir, sumar,
// restar) si pueden ir sueltas -- nadie escribe "multiplicad" en prosa
// casual. Mejor un falso negativo que 49 falsos positivos: un verificador
// que avisa en prosa normal entrena al lector a ignorarlo, que es peor que
// no tenerlo.
var QUERY_OPERATORS = [
  {
    op: '*', nombre: 'multiplicación',
    aritmetica: /\d+(?:[.,]\d+)?\s*(?:por|veces|x|×|\*)\s*\d+/i,
    verbal: /\bmultiplicad[oa]s?\b|\bmultiplicar\b/i,
  },
  {
    op: '/', nombre: 'división',
    aritmetica: /\d+(?:[.,]\d+)?\s*(?:entre|dividido\s+entre|dividido\s+por|\/|÷)\s*\d+/i,
    verbal: /\bdividid[oa]s?\b|\bdividir\b/i,
  },
  {
    op: '+', nombre: 'suma',
    aritmetica: /\d+(?:[.,]\d+)?\s*(?:m[aá]s|\+)\s*\d+/i,
    verbal: /\bsumad[oa]s?\b|\bsumar\b/i,
  },
  {
    op: '-', nombre: 'resta',
    aritmetica: /\d+(?:[.,]\d+)?\s*(?:menos|-)\s*\d+/i,
    verbal: /\brestad[oa]s?\b|\brestar\b/i,
  },
];

// Segunda medicion sobre las mismas 1158 respuestas reales (2026-08-12):
// exigir contexto aritmetico NO basto -- la tasa subio de 4.4% a 17.2%.
// Causa medida depurando (no suponiendo): el falso positivo entra por el
// lado de la PREGUNTA, no de la respuesta. Cualquier mensaje del usuario con
// numeros unidos por guion ("tarda 15-20 segundos", "el 2026-08-12",
// "backend.js:640-660") encaja en el patron de resta, y como la respuesta no
// lleva ninguna resta, salta el aviso.
//
// Tras fallar dos veces, la conclusion honesta: este verificador solo tiene
// sentido cuando la pregunta es CLARAMENTE una operacion aritmetica pedida,
// no prosa que contiene numeros. Se exige las tres cosas a la vez: (1) la
// pregunta es corta (una operacion no necesita 200 caracteres), (2) tiene una
// marca explicita de que se pide calcular, y (3) hay patron aritmetico o
// verbo de operacion. Con eso el caso real que lo motivo ("Cuanto es 15 por
// 4?") sigue cubierto y la prosa normal queda fuera.
var ASKS_TO_COMPUTE = /\b(cu[aá]nt[oa]s?|calcula|calcular|resultado|cu[aá]l\s+es\s+el\s+resultado|how\s+much|compute)\b|=\s*\?/i;
var MAX_ARITHMETIC_QUERY_LEN = 120;

function detectRequestedOperator(query) {
  if (!query) return null;
  if (query.length > MAX_ARITHMETIC_QUERY_LEN) return null;
  if (!ASKS_TO_COMPUTE.test(query)) return null;
  var found = [];
  QUERY_OPERATORS.forEach(function (o) {
    if (o.aritmetica.test(query) || o.verbal.test(query)) found.push(o);
  });
  // Si la pregunta menciona mas de una operacion, no se puede decidir cual
  // era "la pedida" sin interpretar -- se deja pasar.
  return found.length === 1 ? found[0] : null;
}

function operatorsPresentIn(text) {
  var present = {};
  if (!text) return present;
  if (/[x×*]|\bpor\b|multiplicad/i.test(text)) present['*'] = true;
  if (/[÷/]|\bentre\b|dividid/i.test(text)) present['/'] = true;
  if (/\+|\bm[aá]s\b|sumad/i.test(text)) present['+'] = true;
  if (/(?:\d\s*-\s*\d)|\bmenos\b|restad/i.test(text)) present['-'] = true;
  return present;
}

function verifyOperationMatchesQuery(query, text) {
  var requested = detectRequestedOperator(query);
  if (!requested) return [];
  var present = operatorsPresentIn(text);
  var anyPresent = Object.keys(present).length > 0;
  if (!anyPresent) return [];
  if (present[requested.op]) return [];
  var usados = Object.keys(present).map(function (k) {
    var m = QUERY_OPERATORS.find(function (o) { return o.op === k; });
    return m ? m.nombre : k;
  });
  return [{ pedida: requested.nombre, usadas: usados }];
}

// Bug real, encontrado en verificacion adversarial (2026-08-17): tanto
// EXPR_AFTER_EQUALS como DIRECT_EXPR_EQUALS exigen un simbolo literal "="
// o "≈" entre la expresion y el resultado. Una frase en prosa como "La
// suma de 17 y 25 es 41" (17+25=42, error real, probado en vivo con
// `linkcore vnpu VERIFY`) no tiene ningun simbolo de esos -- solo la
// palabra "es" -- y pasaba con "sin hallazgos". Se anaden dos patrones mas,
// deliberadamente acotados para no reintroducir la trampa ya documentada
// arriba (QUERY_OPERATORS) de "por"/"menos" como preposicion/adverbio
// suelto: (a) infijo "A por/mas/menos/entre B es/son/da C", (b) nominal
// "la suma/resta/multiplicacion/division de A y/entre B es/son/da C".
// Ambos exigen los DOS numeros y la palabra operadora explicita PEGADOS
// entre si (misma exigencia de "contexto aritmetico real" que ya usa
// operatorsPresentIn), asi que una preposicion suelta en prosa normal
// nunca tiene un numero a cada lado y no puede hacer match.
var NATURAL_LANG_INFIX = /(-?\d+(?:[.,]\d+)?)\s*(m[aá]s|menos|por|veces|entre|dividido\s+(?:entre|por))\s*(-?\d+(?:[.,]\d+)?)\s+(?:es|son|da|resulta\s+en)\s+\(?(-?\d+(?:[.,]\d+)?)/gi;
var NATURAL_LANG_NOMINAL = /\b(suma|resta|multiplicaci[oó]n|producto|divisi[oó]n|cociente)\s+de\s+(-?\d+(?:[.,]\d+)?)\s*(?:y|entre|por|con)\s*(-?\d+(?:[.,]\d+)?)\s+(?:es|son|da|resulta\s+en)\s+\(?(-?\d+(?:[.,]\d+)?)/gi;

function infixOp(word) {
  var w = word.toLowerCase();
  if (/^m[aá]s$/.test(w)) return '+';
  if (/^menos$/.test(w)) return '-';
  if (/^(por|veces)$/.test(w)) return '*';
  return '/'; // entre / dividido entre / dividido por
}

function nominalOp(word) {
  var w = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (w === 'suma') return '+';
  if (w === 'resta') return '-';
  if (w === 'multiplicacion' || w === 'producto') return '*';
  return '/'; // division / cociente
}

function applyOp(op, a, b) {
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  return b !== 0 ? a / b : null;
}

function verifyNaturalLanguageArithmetic(text, tolerancePct) {
  var findings = [];
  if (!text) return findings;
  tolerancePct = typeof tolerancePct === 'number' ? tolerancePct : 0.5;
  var patterns = [
    { re: NATURAL_LANG_INFIX, opOf: function (m) { return infixOp(m[2]); }, a: 1, b: 3, claimed: 4, label: function (m) { return m[1] + ' ' + m[2] + ' ' + m[3]; } },
    { re: NATURAL_LANG_NOMINAL, opOf: function (m) { return nominalOp(m[1]); }, a: 2, b: 3, claimed: 4, label: function (m) { return m[1] + ' de ' + m[2] + ' y ' + m[3]; } },
  ];
  patterns.forEach(function (p) {
    p.re.lastIndex = 0;
    var m;
    while ((m = p.re.exec(text)) !== null) {
      var a = parseFloat(normalizeExpr(m[p.a]));
      var b = parseFloat(normalizeExpr(m[p.b]));
      var claimed = parseFloat(normalizeExpr(m[p.claimed]));
      if (isNaN(a) || isNaN(b) || isNaN(claimed)) continue;
      var computed = applyOp(p.opOf(m), a, b);
      if (computed === null || !isFinite(computed)) continue;
      var diffPct = claimed === 0 ? (computed === 0 ? 0 : 100) : Math.abs((computed - claimed) / claimed) * 100;
      if (diffPct > tolerancePct) {
        findings.push({
          pasoAnterior: p.label(m),
          valorAnterior: Math.round(computed * 1e6) / 1e6,
          pasoSiguiente: String(claimed),
          valorSiguiente: claimed,
          diffPct: Math.round(diffPct * 10) / 10,
        });
      }
      if (p.re.lastIndex === m.index) p.re.lastIndex++;
    }
  });
  return findings;
}

// normalizeExpr y stripCurrencySymbols pasan a ser publicas (2026-08-18) para
// grounding-verify.js: la comprobacion de "este numero se DERIVA de numeros de
// la fuente" necesita exactamente la misma normalizacion de miles/decimales/
// simbolos de moneda que ya se calibro aqui (ver los dos comentarios de
// 2026-08-18 sobre "9,268" y "$753,840 − $340,000"). Reimplementarla alli
// habria creado una segunda regla de miles/decimales divergente -- justo el
// tipo de duplicacion que produjo el error de 1000x documentado arriba.
export { verifyCalculations, safeEval, normalizeExpr, stripCurrencySymbols, extractFinalNumericClaim, extractFinalNumericClaimWithIndex, compareNumericClaims, verifyOperationMatchesQuery, verifyNaturalLanguageArithmetic };
