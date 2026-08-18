// ── VERIFICACION DETERMINISTA CONTRA LA FUENTE APORTADA ──
//
// Complementa a source-fidelity-verify.js, que solo compara CIFRAS. Los fallos
// medidos (2026-08-18) en las categorias `contract` y `citation` del corpus
// empresarial casi nunca cambian un numero: cambian a quien se le atribuye una
// obligacion, se saltan una excepcion escrita, o añaden un elemento que la
// fuente no contiene.
//
//   fuente: "El Proveedor sera responsable de los daños... El Cliente sera
//            responsable de proporcionar acceso a los sistemas"
//   respuesta: "El Proveedor ... es responsable de dar acceso a los sistemas"
//                ^ atribucion cruzada entre dos etiquetas de la misma fuente
//
//   fuente: "...EXCEPTO la informacion que ya sea de dominio publico"
//   respuesta: "cubre toda informacion divulgada"
//                ^ universal que ignora la excepcion escrita
//
//   fuente: "status puede ser: pending, shipped, delivered, cancelled"
//   respuesta: "pending, shipped, delivered, cancelled o refunded"
//                ^ elemento inventado en una enumeracion cerrada
//
// Los tres son comprobables sin conocimiento del mundo: la fuente esta EN la
// pregunta. El verificador nunca opina sobre el fondo, solo sobre si lo que
// dice la respuesta tiene respaldo en el texto que se le dio.

import { extractQuotedSources } from './source-fidelity-verify.js';

function deaccent(s) {
  return String(s).toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
}

// Etiquetas que estructuran un documento: partes de un contrato y referencias
// numeradas. Se limita a una lista cerrada de roles porque cualquier nombre
// propio en mayuscula produciria etiquetas falsas.
var ROLE_WORDS = [
  'proveedor', 'cliente', 'contratista', 'comprador', 'vendedor', 'arrendador',
  'arrendatario', 'licenciante', 'licenciatario', 'empresa', 'empleado',
  'provider', 'client', 'contractor', 'customer', 'supplier', 'buyer', 'seller',
  'licensor', 'licensee', 'employer', 'employee',
];
var REFERENCE = '(?:secci[óo]n|section|art[íi]culo|article|cl[áa]usula|clause|anexo|annex|ap[áa]rtado)\\s*\\d+(?:\\.\\d+)*';

function labelPattern() {
  return new RegExp('(' + REFERENCE + '|\\b(?:' + ROLE_WORDS.join('|') + ')\\b)', 'gi');
}

var STOPWORDS = deaccent(
  'el la los las un una unos unas de del al a y o u en con por para que se su sus este esta estos estas ' +
  'sera seran es son debe deben puede pueden todo toda todos todas cada como si no ni lo mas menos ' +
  'the of and or to in for a an is are be will shall any all each other its this that'
).split(/\s+/);

function contentWords(segment) {
  return deaccent(segment)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function (w) { return w.length >= 5 && STOPWORDS.indexOf(w) === -1; });
}

// Divide la fuente en segmentos, uno por etiqueta encontrada, y calcula las
// palabras de contenido EXCLUSIVAS de cada segmento. Solo lo exclusivo sirve
// para detectar una atribucion cruzada: lo compartido no distingue nada.
export function segmentSourceByLabel(source) {
  // La unidad de atribucion es la frase, no la posicion de la etiqueta.
  // Cortar el texto en cada etiqueta produjo un falso positivo inmediato:
  // en "trabajo creado por el Contratista ... sera propiedad del Cliente" el
  // vocabulario de la frase quedaba asignado a la primera etiqueta, asi que un
  // resumen correcto parecia atribuirlo a la otra parte. Solo las frases con
  // UNA etiqueta definen vocabulario exclusivo; las que relacionan a dos
  // partes no atribuyen nada a ninguna.
  var byLabel = {};
  String(source).split(/(?<=[.!?])\s+/).forEach(function (sentence) {
    var re = labelPattern();
    var labels = {};
    var m;
    while ((m = re.exec(sentence)) !== null) labels[deaccent(m[1]).replace(/\s+/g, ' ')] = true;
    var names = Object.keys(labels);
    if (names.length !== 1) return;
    if (!byLabel[names[0]]) byLabel[names[0]] = [];
    byLabel[names[0]].push(sentence);
  });
  var labels = Object.keys(byLabel);
  if (labels.length < 2) return [];
  var wordsByLabel = {};
  labels.forEach(function (label) { wordsByLabel[label] = contentWords(byLabel[label].join(' ')); });
  return labels.map(function (label) {
    var others = {};
    labels.forEach(function (other) {
      if (other === label) return;
      wordsByLabel[other].forEach(function (w) { others[w] = true; });
    });
    return {
      label: label,
      exclusive: wordsByLabel[label].filter(function (w) { return !others[w]; }),
    };
  });
}

// Atribucion cruzada: una frase de la respuesta menciona UNA etiqueta y arrastra
// vocabulario que en la fuente pertenece en exclusiva a otra. Si menciona dos o
// mas etiquetas no se juzga: la frase puede estar relacionandolas legitimamente.
export function verifyLabelAttribution(text, query) {
  var sources = extractQuotedSources(query);
  if (sources.length === 0) return [];
  var segments = segmentSourceByLabel(sources.join('\n'));
  if (segments.length < 2) return [];
  var findings = [];
  String(text || '').split(/(?<=[.!?])\s+/).forEach(function (sentence) {
    var mentioned = segments.filter(function (segment) {
      return new RegExp('\\b' + segment.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(deaccent(sentence));
    });
    if (mentioned.length !== 1) return;
    var words = contentWords(sentence);
    segments.forEach(function (segment) {
      if (segment.label === mentioned[0].label) return;
      var borrowed = segment.exclusive.filter(function (w) { return words.indexOf(w) !== -1; });
      var own = mentioned[0].exclusive.filter(function (w) { return words.indexOf(w) !== -1; });
      if (borrowed.length >= 2 && borrowed.length > own.length) {
        findings.push({
          tipo: 'atribucion_cruzada',
          atribuidoA: mentioned[0].label,
          perteneceA: segment.label,
          terminos: borrowed.slice(0, 4),
        });
      }
    });
  });
  return findings;
}

var EXCEPTION_MARKER = /\b(excepto|salvo|exclu\w+|no\s+incluye|siempre\s+que|[úu]nicamente\s+si|solo\s+si|s[óo]lo\s+si|condicionad\w+|except|unless|provided\s+that|excluding|only\s+if)\b/i;
var UNIVERSAL_CLAIM = /\b(tod[oa]s?\b|siempre\b|autom[áa]tica\w*|sin\s+necesidad\b|sin\s+ninguna?\b|cualquier\b|en\s+todos\s+los\s+casos\b|always\b|automatic\w*|without\s+any\b|no\s+need\b)/i;
var ANSWER_EXCEPTION = /\b(excepto|salvo|exclu\w+|excepci[óo]n|queda\s+fuera|no\s+(?:est[áa]|estan|aplica|cubre|protege|incluye)|pero\s+solo|pero\s+s[óo]lo|solo\s+si|s[óo]lo\s+si|siempre\s+que|dentro\s+de|condicion\w+|unless|except|only\s+if|provided\s+that)\b/i;

// La fuente condiciona o excluye algo y la respuesta afirma lo contrario en
// terminos absolutos sin recoger esa condicion. Calla en cuanto la respuesta
// menciona la excepcion de cualquier forma: la redaccion es libre, lo que no
// puede faltar es la restriccion.
export function verifyOmittedException(text, query) {
  var sources = extractQuotedSources(query);
  if (sources.length === 0) return [];
  var source = sources.join('\n');
  var marker = EXCEPTION_MARKER.exec(source);
  if (!marker) return [];
  var body = String(text || '');
  var claim = UNIVERSAL_CLAIM.exec(body);
  if (!claim) return [];
  if (ANSWER_EXCEPTION.test(body)) return [];
  return [{
    tipo: 'excepcion_de_la_fuente_omitida',
    marcadorEnLaFuente: marker[0],
    afirmacionAbsoluta: claim[0],
    detalle: 'la fuente condiciona o excluye un caso y la respuesta lo presenta sin ninguna restriccion',
  }];
}

var ENUM_INTRO = /(?:puede\s+(?:ser|tomar\s+los\s+valores)|valores\s+(?:posibles|permitidos)|can\s+be|one\s+of|allowed\s+values|possible\s+values)\s*:?\s*([^.\n]{10,200})/i;

function enumItems(fragment) {
  return String(fragment)
    .split(/\s*(?:,|;|\bo\b|\by\b|\bor\b|\band\b)\s*/i)
    .map(function (item) { return deaccent(item).replace(/[^a-z0-9_\-]/g, '').trim(); })
    .filter(function (item) { return item.length >= 3; });
}

// Enumeracion cerrada de la fuente ampliada por la respuesta: cualquier
// elemento del listado de la respuesta que no aparezca en NINGUNA parte de la
// fuente es un valor inventado.
export function verifyEnumerationSupport(text, query) {
  var sources = extractQuotedSources(query);
  if (sources.length === 0) return [];
  var source = sources.join('\n');
  var sourceEnum = ENUM_INTRO.exec(source);
  if (!sourceEnum) return [];
  var allowed = enumItems(sourceEnum[1]);
  if (allowed.length < 2) return [];
  var answerEnum = ENUM_INTRO.exec(String(text || ''));
  if (!answerEnum) return [];
  var sourceFlat = deaccent(source);
  var invented = enumItems(answerEnum[1]).filter(function (item) {
    return allowed.indexOf(item) === -1 && sourceFlat.indexOf(item) === -1;
  });
  if (invented.length === 0) return [];
  return [{
    tipo: 'valor_no_respaldado',
    inventados: invented,
    permitidosPorLaFuente: allowed,
  }];
}

export function verifyGrounding(text, query) {
  return verifyLabelAttribution(text, query)
    .concat(verifyOmittedException(text, query))
    .concat(verifyEnumerationSupport(text, query));
}
