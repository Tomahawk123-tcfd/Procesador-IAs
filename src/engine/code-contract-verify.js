// ── VERIFICACION DETERMINISTA DE CONTRATO EN CODIGO ──
//
// Hueco medido, no supuesto: en el corpus empresarial
// (scripts/benchmark-corpus-enterprise.mjs) cuatro de los cinco casos
// `code-review` estan marcados expectedGap:true, y el motivo es siempre el
// mismo -- code-verify.js solo comprueba que el codigo COMPILE (vm.Script para
// JS, ast.parse para Python) y estos cuatro compilan perfectamente:
//
//   items[:n+1]                        pedido "los primeros n elementos"
//   f = open(path) sin close ni with   fuga de descriptor
//   if (config.timeoutMs)              pedido "comprobar si existe" (0 y "" fallan)
//   await readFile(...) + JSON.parse   pedido sin manejo de errores
//
// Ese es el fallo de IA que mas dinero cuesta en empresa: codigo que pasa el
// linter, pasa la review humana por lo corto que es, y se rompe con el primer
// dato real. Ninguno de los cuatro necesita un modelo para detectarse: son
// propiedades sintacticas del codigo cruzadas con lo que el usuario PIDIO en su
// pregunta.
//
// Precision antes que cobertura. Cada regla lleva su condicion de silencio y
// solo dispara si la pregunta pide explicitamente la propiedad que falta: un
// aviso falso hace que el operador deje de leer los avisos, y entonces el
// canal vale menos que cero. Por eso aqui NO hay reglas de estilo: nada de
// "usa const", nada de "faltan tipos", nada de opiniones.

// Bloques de codigo con su lenguaje declarado. Sin lenguaje declarado no se
// analiza: adivinarlo produciria avisos de Python sobre JavaScript.
export function extractCodeBlocks(text) {
  var body = String(text || '');
  var blocks = [];
  var fenced = /```([a-zA-Z0-9_+-]*)\s*([\s\S]*?)```/g;
  var m;
  while ((m = fenced.exec(body)) !== null) {
    var lang = m[1].toLowerCase();
    if (lang === 'py' || lang === 'python') blocks.push({ lang: 'python', code: m[2] });
    else if (lang === 'js' || lang === 'javascript' || lang === 'ts' || lang === 'typescript') blocks.push({ lang: 'javascript', code: m[2] });
  }
  return blocks;
}

// Intencion leida de la pregunta del usuario, nunca de la respuesta.
var ASKS_FIRST_N = /\b(?:primeros?|first|primeras)\s+(n|\d+)\b/i;
var ASKS_CLOSE = /\b(?:cierre|cierra|close[sd]?|closing|libere|liberar|release)\b/i;
var ASKS_EXISTENCE_CHECK = /\b(?:existe|exista|existence|est[áa]\s+definid|undefined|indefinid|null|nul[oa]|presente|present|defined)\b/i;
var ASKS_ERROR_HANDLING = /\b(?:manej(?:e|ar|o)\s+(?:de\s+)?errores?|error\s+handling|maneje\s+excepciones|captur(?:e|ar)\s+(?:el\s+)?error|try\s*\/?\s*catch|gestione\s+errores?|robust[ao]|fall(?:e|ar)\s+de\s+forma\s+controlada)\b/i;

// Un slice de Python sobre el que se puede razonar: end = expresion simple.
var PY_SLICE = /\[\s*(?::|0\s*:)?\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*([+-])\s*(\d+)\s*\]/g;
var JS_SLICE = /\.slice\(\s*0\s*,\s*([A-Za-z_$][\w$]*|\d+)\s*([+-])\s*(\d+)\s*\)/g;

function sliceOffByOne(block, askedCount) {
  var findings = [];
  var re = block.lang === 'python' ? PY_SLICE : JS_SLICE;
  re.lastIndex = 0;
  var m;
  while ((m = re.exec(block.code)) !== null) {
    // Solo se compara cuando el limite usa el MISMO nombre/valor que pidio la
    // pregunta ("los primeros n" -> [:n+1]). Un slice sobre otra variable
    // puede ser deliberado y no se toca.
    if (String(m[1]) !== String(askedCount)) continue;
    findings.push({
      tipo: 'limite_desplazado',
      expresion: m[0].trim(),
      detalle: 'se pidieron ' + askedCount + ' elementos pero el limite es ' + m[1] + ' ' + m[2] + ' ' + m[3] + ': devuelve ' + (m[2] === '+' ? 'uno de mas' : 'uno de menos'),
    });
  }
  return findings;
}

// Recurso abierto y nunca cerrado dentro de la misma funcion. Silencio si se
// usa `with` (Python) o si hay un close/finally/using en el bloque.
function leakedHandle(block) {
  var code = block.code;
  if (block.lang === 'python') {
    if (/\bwith\s+open\s*\(/.test(code)) return [];
    var opened = /(\b[A-Za-z_][A-Za-z0-9_]*)\s*=\s*open\s*\(/.exec(code);
    if (!opened) return [];
    var handle = opened[1];
    if (new RegExp('\\b' + handle + '\\.close\\s*\\(').test(code)) return [];
    if (/\breturn\s+[A-Za-z_]/.test(code) && !/\bfor\b|\bread/.test(code)) return [];
    return [{
      tipo: 'recurso_no_liberado',
      expresion: handle + ' = open(...)',
      detalle: 'el descriptor nunca se cierra: usar "with open(...) as ' + handle + '" o cerrarlo en finally',
    }];
  }
  var jsOpened = /\bfs\.(?:openSync|open)\s*\(/.test(code);
  if (!jsOpened) return [];
  if (/\.close\s*\(|closeSync\s*\(/.test(code)) return [];
  return [{
    tipo: 'recurso_no_liberado',
    expresion: 'fs.open(...)',
    detalle: 'el descriptor nunca se cierra: cerrarlo en un finally',
  }];
}

// Comprobacion de existencia hecha con veracidad (truthiness): 0, "" y false
// son valores legitimos que se descartan como si no existieran. Solo se
// reporta si la pregunta pidio comprobar EXISTENCIA, y solo sobre un acceso a
// propiedad (una variable suelta no tiene el problema de "clave ausente").
function truthinessInsteadOfExistence(block) {
  var findings = [];
  var re = /\bif\s*\(?\s*(!?)\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\)?\s*[:{]/g;
  var m;
  while ((m = re.exec(block.code)) !== null) {
    var expr = m[2] + '.' + m[3];
    var guarded = new RegExp('(?:' + m[3] + '\\s*(?:in|!==\\s*undefined|!=\\s*null|is\\s+not\\s+None)|hasOwnProperty\\s*\\(\\s*[\'"`]' + m[3] + '|' + m[2] + '\\?\\.' + m[3] + '|\\bget\\s*\\(\\s*[\'"`]' + m[3] + ')');
    if (guarded.test(block.code)) continue;
    findings.push({
      tipo: 'existencia_por_veracidad',
      expresion: 'if (' + m[1] + expr + ')',
      detalle: 'se pidio comprobar si el valor existe, pero esto comprueba si es verdadero: 0, "" y false son valores validos que caen en la rama equivocada',
    });
  }
  return findings;
}

// Operacion que falla en tiempo de ejecucion (I/O, parseo, red) sin ninguna
// captura, cuando la pregunta pidio manejo de errores.
var FALLIBLE = [
  { re: /\bJSON\.parse\s*\(/, nombre: 'JSON.parse' },
  { re: /\bjson\.loads?\s*\(/, nombre: 'json.load' },
  { re: /\breadFile(?:Sync)?\s*\(/, nombre: 'readFile' },
  { re: /\bfetch\s*\(/, nombre: 'fetch' },
  { re: /\bopen\s*\(/, nombre: 'open' },
];

function unhandledFailure(block) {
  var code = block.code;
  if (/\btry\b/.test(code) || /\.catch\s*\(/.test(code)) return [];
  for (var i = 0; i < FALLIBLE.length; i += 1) {
    if (FALLIBLE[i].re.test(code)) {
      return [{
        tipo: 'error_no_gestionado',
        expresion: FALLIBLE[i].nombre + '(...)',
        detalle: 'se pidio manejo de errores pero esta llamada puede lanzar y no hay try/catch: el fallo sube sin control',
      }];
    }
  }
  return [];
}

export function verifyCodeContract(text, query) {
  var blocks = extractCodeBlocks(text);
  if (blocks.length === 0) return [];
  var q = String(query || '');
  var askedFirstN = ASKS_FIRST_N.exec(q);
  var findings = [];

  blocks.forEach(function (block) {
    if (askedFirstN) findings = findings.concat(sliceOffByOne(block, askedFirstN[1]));
    if (ASKS_CLOSE.test(q)) findings = findings.concat(leakedHandle(block));
    if (ASKS_EXISTENCE_CHECK.test(q)) findings = findings.concat(truthinessInsteadOfExistence(block));
    if (ASKS_ERROR_HANDLING.test(q)) findings = findings.concat(unhandledFailure(block));
  });

  return findings;
}
