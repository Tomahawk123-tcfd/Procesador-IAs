// ── AUDITORIA POR LOTES: LA PUERTA DE CALIDAD DEL PROCESADOR ──
//
// Los opcodes existentes verifican UNA respuesta. Una empresa que pone un
// modelo en produccion no tiene una respuesta: tiene un conjunto de
// evaluacion, un despliegue a la semana y una pregunta que hoy nadie le
// contesta con numeros -- "¿el cambio de prompt/modelo de ayer empeoro algo?".
// Ese es el hueco de PRODUCTO, no de recall: sin lote no hay puerta de
// calidad, y sin puerta el procesador se queda en una utilidad manual.
//
// AUDIT pasa un conjunto entero por los mismos canales deterministas (mismo
// codigo que VERIFY, no una variante paralela que podria divergir) y devuelve:
//
//   - el detalle por elemento (que canal disparo y cuantos hallazgos),
//   - la tasa agregada y el desglose por canal,
//   - si el conjunto viene ETIQUETADO (`expectFindings`), la matriz de
//     confusion real: recall, precision y falsos positivos,
//   - un veredicto contra el `gate` que la empresa declare.
//
// Todo es determinista y sin generacion: el coste es de milisegundos por
// elemento, asi que esto entra en un CI y corre en cada despliegue. Sin
// etiquetas tampoco se inventa una calidad "absoluta": se informa de la tasa
// de hallazgos, que es un hecho, y se deja claro que no hay verdad de
// referencia con la que calcular recall.

import { applyDeterministicVerification } from './verification-pipeline.js';

var DEFAULT_GATE = {
  maxFindingRate: null,     // fraccion maxima de elementos con hallazgo
  minRecall: null,          // solo evaluable con etiquetas
  maxFalsePositiveRate: null,
  maxChannelErrors: 0,      // un canal que revienta es un fallo de la puerta
};

function ratio(part, total) {
  if (!total) return null;
  return parseFloat((part / total).toFixed(4));
}

// Un elemento del conjunto: la pregunta original, la respuesta a auditar y,
// opcionalmente, la etiqueta de si esa respuesta ES defectuosa. La etiqueta es
// lo unico que permite hablar de recall sin mentir.
function normalizeItem(raw, index) {
  var item = raw || {};
  return {
    id: item.id != null ? String(item.id) : 'item-' + (index + 1),
    query: typeof item.query === 'string' ? item.query : '',
    draft: typeof item.draft === 'string' ? item.draft : (typeof item.answer === 'string' ? item.answer : ''),
    expectFindings: typeof item.expectFindings === 'boolean' ? item.expectFindings : null,
  };
}

export async function runBatchAudit(payload) {
  var input = payload || {};
  var items = Array.isArray(input.items) ? input.items.map(normalizeItem) : [];
  if (items.length === 0) return { ok: false, error: 'items_vacio' };
  var gate = Object.assign({}, DEFAULT_GATE, input.gate || {});
  var startedAt = Date.now();

  var results = [];
  var channelHits = {};
  var channelErrorCounts = {};
  var withFindings = 0;
  var truePositives = 0;
  var falseNegatives = 0;
  var falsePositives = 0;
  var trueNegatives = 0;
  var labelled = 0;

  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    var itemStart = Date.now();
    var verified;
    try {
      verified = await applyDeterministicVerification(item.draft, item.query);
    } catch (e) {
      // Un elemento que revienta no puede tumbar la auditoria entera: se
      // registra como error del elemento y el lote continua.
      results.push({ id: item.id, error: e && e.message ? e.message : String(e), latencyMs: Date.now() - itemStart });
      continue;
    }
    var findings = 0;
    Object.keys(verified.findingCounts || {}).forEach(function (channel) {
      findings += verified.findingCounts[channel];
      channelHits[channel] = (channelHits[channel] || 0) + verified.findingCounts[channel];
    });
    (verified.channelErrors || []).forEach(function (channel) {
      channelErrorCounts[channel] = (channelErrorCounts[channel] || 0) + 1;
    });
    if (verified.hasFindings) withFindings += 1;
    if (item.expectFindings !== null) {
      labelled += 1;
      if (item.expectFindings && verified.hasFindings) truePositives += 1;
      else if (item.expectFindings && !verified.hasFindings) falseNegatives += 1;
      else if (!item.expectFindings && verified.hasFindings) falsePositives += 1;
      else trueNegatives += 1;
    }
    results.push({
      id: item.id,
      hasFindings: verified.hasFindings,
      channels: verified.channels || [],
      findingCounts: verified.findingCounts || {},
      channelErrors: verified.channelErrors || [],
      findings: findings,
      expectFindings: item.expectFindings,
      // El texto anotado solo se devuelve si se pide: en un lote de miles de
      // elementos, arrastrarlo multiplica el tamaño de la respuesta por nada.
      text: input.includeText ? verified.text : undefined,
      latencyMs: Date.now() - itemStart,
    });
  }

  var audited = results.filter(function (r) { return !r.error; }).length;
  var totalChannelErrors = Object.keys(channelErrorCounts).reduce(function (sum, k) { return sum + channelErrorCounts[k]; }, 0);
  var recall = labelled ? ratio(truePositives, truePositives + falseNegatives) : null;
  var precision = (truePositives + falsePositives) > 0 ? ratio(truePositives, truePositives + falsePositives) : null;
  var falsePositiveRate = labelled ? ratio(falsePositives, falsePositives + trueNegatives) : null;

  var summary = {
    items: items.length,
    audited: audited,
    failedItems: items.length - audited,
    withFindings: withFindings,
    findingRate: ratio(withFindings, audited),
    channelHits: channelHits,
    channelErrors: channelErrorCounts,
    totalChannelErrors: totalChannelErrors,
    labelled: labelled,
    // Sin etiquetas estos cuatro son null a proposito: dar un recall
    // inventado sobre un conjunto sin verdad de referencia seria exactamente
    // la clase de metrica que este proyecto no puede permitirse.
    recall: recall,
    precision: precision,
    falsePositiveRate: falsePositiveRate,
    confusion: labelled ? { truePositives: truePositives, falseNegatives: falseNegatives, falsePositives: falsePositives, trueNegatives: trueNegatives } : null,
    latencyMs: Date.now() - startedAt,
  };

  var violations = [];
  if (gate.maxFindingRate !== null && summary.findingRate !== null && summary.findingRate > gate.maxFindingRate) {
    violations.push({ regla: 'maxFindingRate', limite: gate.maxFindingRate, medido: summary.findingRate });
  }
  if (gate.minRecall !== null) {
    if (recall === null) violations.push({ regla: 'minRecall', limite: gate.minRecall, medido: null, detalle: 'el conjunto no trae etiquetas expectFindings: el recall no es calculable' });
    else if (recall < gate.minRecall) violations.push({ regla: 'minRecall', limite: gate.minRecall, medido: recall });
  }
  if (gate.maxFalsePositiveRate !== null) {
    if (falsePositiveRate === null) violations.push({ regla: 'maxFalsePositiveRate', limite: gate.maxFalsePositiveRate, medido: null, detalle: 'el conjunto no trae etiquetas expectFindings' });
    else if (falsePositiveRate > gate.maxFalsePositiveRate) violations.push({ regla: 'maxFalsePositiveRate', limite: gate.maxFalsePositiveRate, medido: falsePositiveRate });
  }
  if (gate.maxChannelErrors !== null && totalChannelErrors > gate.maxChannelErrors) {
    violations.push({ regla: 'maxChannelErrors', limite: gate.maxChannelErrors, medido: totalChannelErrors });
  }

  return {
    ok: true,
    passed: violations.length === 0,
    gate: gate,
    violations: violations,
    summary: summary,
    results: results,
  };
}

// Compara dos auditorias del MISMO conjunto para responder a la unica pregunta
// que importa en un despliegue: que empeoro respecto a la referencia. Se
// compara por id, no por posicion -- un conjunto reordenado no es un cambio.
export function compareAudits(baseline, candidate) {
  var base = {};
  (baseline && baseline.results || []).forEach(function (r) { base[r.id] = r; });
  var regressions = [];
  var fixes = [];
  (candidate && candidate.results || []).forEach(function (r) {
    var prev = base[r.id];
    if (!prev || prev.error || r.error) return;
    if (!prev.hasFindings && r.hasFindings) regressions.push({ id: r.id, canales: r.channels });
    if (prev.hasFindings && !r.hasFindings) fixes.push({ id: r.id, canales: prev.channels });
  });
  return {
    compared: Object.keys(base).length,
    regressions: regressions,
    fixes: fixes,
    worse: regressions.length > 0,
  };
}
