// ── VERIFICACION DETERMINISTA DE RAZONAMIENTO FINANCIERO ──
//
// Hueco medido (2026-08-18) en la categoria `financial` del corpus
// empresarial: 1 de 5 casos detectado, y solo porque ese tenia una aritmetica
// que se contradecia a si misma. Los otros cuatro son el modo de fallo tipico
// de un LLM con dinero: la aritmetica esta bien hecha, la formula elegida no
// es la que pedia la pregunta.
//
//   margen = beneficio / COSTES        pidiendo "% de los ingresos"
//   precio = coste / (1 - markup)      pidiendo un markup SOBRE COSTE
//   precio_por_accion = acciones / EUR  con numerador y denominador invertidos
//   plazo = importe_sin_IVA / 3        pidiendo incluir el IVA
//
// Los cuatro son verificables sin criterio propio porque la pregunta nombra
// sus magnitudes ("ingresos de 4.200.000 EUR", "costes de 3.100.000 EUR",
// "markup del 60%", "IVA del 21%") y dice cual es la base pedida. El
// verificador cruza la magnitud que la pregunta pone como base con la que la
// respuesta usa realmente. Nada de esto necesita un modelo: necesita leer el
// enunciado, que es justo lo que un LLM apurado se salta.

function toNumber(raw) {
  var s = String(raw).trim();
  // Formato europeo (4.200.000,50) y anglosajon (4,200,000.50) a la vez: el
  // ultimo separador decide quien es el decimal.
  var lastDot = s.lastIndexOf('.');
  var lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    var decimals = s.length - lastComma - 1;
    s = decimals === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot !== -1) {
    var dots = (s.match(/\./g) || []).length;
    var tail = s.length - lastDot - 1;
    if (dots > 1 || tail === 3) s = s.replace(/\./g, '');
  }
  var v = parseFloat(s);
  return isFinite(v) ? v : null;
}

var NUM = '\\d[\\d.,]*';
var DIV = new RegExp('(' + NUM + ')\\s*/\\s*(' + NUM + ')', 'g');
var MULT = new RegExp('(' + NUM + ')\\s*[x×*]\\s*(' + NUM + ')', 'g');

// Magnitudes nombradas en la pregunta: "ingresos de 4.200.000 EUR",
// "2.000.000 de acciones", "costes de 3.100.000".
var LABEL_BEFORE = /([a-zA-ZÁ-ÿ][a-zA-ZÁ-ÿ\s]{2,30}?)\s+de\s+(\d[\d.,]*)/g;
var LABEL_AFTER = /(\d[\d.,]*)\s+(?:de\s+)?([a-zA-ZÁ-ÿ]{4,20})/g;

function deaccent(s) {
  return String(s).toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
}

export function extractNamedQuantities(query) {
  var quantities = [];
  var m;
  LABEL_BEFORE.lastIndex = 0;
  while ((m = LABEL_BEFORE.exec(String(query))) !== null) {
    var value = toNumber(m[2]);
    if (value !== null) quantities.push({ label: deaccent(m[1].trim().split(/\s+/).pop()), value: value, raw: m[2] });
  }
  LABEL_AFTER.lastIndex = 0;
  while ((m = LABEL_AFTER.exec(String(query))) !== null) {
    var v2 = toNumber(m[1]);
    if (v2 !== null) quantities.push({ label: deaccent(m[2]), value: v2, raw: m[1] });
  }
  return quantities;
}

// Base que la pregunta pide para el porcentaje ("como porcentaje de los
// ingresos", "as a percentage of revenue").
var PERCENT_BASE = /(?:como\s+)?(?:porcentaje|%|percentage)\s+(?:de|del|de\s+los|de\s+las|of|of\s+the)\s+([a-zA-ZÁ-ÿ]{4,20})/i;
var ASKS_MARKUP = /\bmark[\s-]?up\b|\brecargo\s+sobre\s+(?:el\s+)?coste\b/i;
var ASKS_TARGET_MARGIN = /\bmargen\s+(?:bruto\s+)?objetivo\b|\btarget\s+margin\b/i;
var PER_UNIT = /\b(?:precio|coste|valor|price|cost)\s+por\s+([a-zA-ZÁ-ÿ]{4,20})|\bper\s+([a-zA-ZÁ-ÿ]{4,20})\b/i;
var TAX_IN_QUERY = /\b(?:IVA|VAT|impuesto|tax)\s+(?:del?\s+)?(\d[\d.,]*)\s*%/i;
var TAX_EXCLUDED = /\b(?:sin\s+(?:IVA|impuestos)|excluding\s+(?:VAT|tax)|IVA\s+aparte)\b/i;

function operandsMatch(body, re, index, target) {
  var m;
  re.lastIndex = 0;
  while ((m = re.exec(body)) !== null) {
    var value = toNumber(m[index]);
    if (value !== null && Math.abs(value - target) < 0.001) return true;
  }
  return false;
}

function dividesBy(body, target) {
  return operandsMatch(body, DIV, 2, target);
}

function multipliesBy(body, target) {
  return operandsMatch(body, MULT, 2, target) || operandsMatch(body, MULT, 1, target);
}

function pluralAware(label) {
  var base = deaccent(label);
  return base.replace(/(es|s)$/, '');
}

function matchesLabel(a, b) {
  var x = pluralAware(a);
  var y = pluralAware(b);
  return x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0;
}

export function verifyFinancialFormulas(text, query) {
  var q = String(query || '');
  var body = String(text || '');
  if (!q || !body) return [];
  var findings = [];
  var quantities = extractNamedQuantities(q);

  // 1) Porcentaje calculado sobre una base distinta de la pedida.
  var baseAsked = PERCENT_BASE.exec(q);
  if (baseAsked && quantities.length >= 2) {
    var wanted = quantities.filter(function (x) { return matchesLabel(x.label, baseAsked[1]); });
    if (wanted.length > 0) {
      var wantedValues = wanted.map(function (x) { return x.value; });
      var others = quantities.filter(function (x) { return wantedValues.indexOf(x.value) === -1; });
      var m;
      DIV.lastIndex = 0;
      while ((m = DIV.exec(body)) !== null) {
        var denominator = toNumber(m[2]);
        if (denominator === null) continue;
        if (wantedValues.indexOf(denominator) !== -1) continue;
        var wrong = others.filter(function (x) { return x.value === denominator; })[0];
        if (!wrong) continue;
        findings.push({
          tipo: 'base_del_porcentaje_incorrecta',
          baseDeclarada: baseAsked[1],
          baseUsada: wrong.label + ' (' + wrong.raw + ')',
          expresion: m[0],
        });
      }
    }
  }

  // 2) Markup sobre coste resuelto con la formula del margen objetivo
  //    (dividir entre 1 - tasa) o al reves.
  var rate = /(\d[\d.,]*)\s*%/.exec(q);
  if (rate) {
    var pct = toNumber(rate[1]);
    if (pct !== null && pct > 0 && pct < 100) {
      var complement = Math.round((1 - pct / 100) * 1000) / 1000;
      var increment = Math.round((1 + pct / 100) * 1000) / 1000;
      // "usa el complemento" = divide entre (1 - tasa), escrito de forma
      // simbolica o ya evaluado (0,40). "usa el incremento" = multiplica por
      // (1 + tasa), igual en las dos formas.
      var usesComplement = dividesBy(body, complement) || /\/\s*\(?\s*1\s*[-–]\s*/.test(body);
      var usesIncrement = multipliesBy(body, increment) || /[x×*]\s*\(?\s*1\s*\+\s*/.test(body);
      if (ASKS_MARKUP.test(q) && !ASKS_TARGET_MARGIN.test(q) && usesComplement && !usesIncrement) {
        findings.push({
          tipo: 'formula_de_markup_confundida',
          pedido: 'markup sobre coste: coste × (1 + ' + pct + '%)',
          usado: 'division entre (1 - ' + pct + '%), que es la formula del margen objetivo',
        });
      }
      if (ASKS_TARGET_MARGIN.test(q) && !ASKS_MARKUP.test(q) && usesIncrement && !usesComplement) {
        findings.push({
          tipo: 'formula_de_margen_confundida',
          pedido: 'margen objetivo: coste / (1 - ' + pct + '%)',
          usado: 'multiplicacion por (1 + ' + pct + '%), que es la formula del markup',
        });
      }
    }
  }

  // 3) Magnitud "por unidad" con la division invertida: el recuento de
  //    unidades tiene que ir en el denominador.
  var perUnit = PER_UNIT.exec(q);
  if (perUnit) {
    var unitLabel = perUnit[1] || perUnit[2];
    var unitQuantity = quantities.filter(function (x) { return matchesLabel(x.label, unitLabel); })[0];
    if (unitQuantity) {
      var m2;
      DIV.lastIndex = 0;
      while ((m2 = DIV.exec(body)) !== null) {
        var numerator = toNumber(m2[1]);
        if (numerator === unitQuantity.value) {
          findings.push({
            tipo: 'division_invertida',
            expresion: m2[0],
            detalle: 'para obtener un valor por ' + unitLabel + ', el numero de ' + unitLabel + ' va en el denominador',
          });
        }
      }
    }
  }

  // 4) Impuesto exigido por la pregunta y ausente del calculo.
  var tax = TAX_IN_QUERY.exec(q);
  if (tax && !TAX_EXCLUDED.test(q)) {
    var taxPct = toNumber(tax[1]);
    if (taxPct !== null && taxPct > 0) {
      var factor = 1 + taxPct / 100;
      var mentionsRate = new RegExp('\\b' + String(taxPct).replace('.', '[.,]') + '\\s*%').test(body);
      if (!mentionsRate && !multipliesBy(body, factor)) {
        findings.push({
          tipo: 'impuesto_omitido',
          pedido: tax[0],
          detalle: 'la respuesta no aplica ni menciona el impuesto que la pregunta exige incluir',
        });
      }
    }
  }

  return findings;
}
