// ═══════════════════════════════════════════════════════════════
// LINKCORE DEEP PLANNER
// task-decomposer.js es plano: 14 plantillas fijas de 3-4 pasos,
// pensadas para tareas cortas ("escribe un email", "genera un
// logo"). No sirve para "documento a fondo con analisis exhaustivo
// de las 100 mejores companias de YC" -- eso necesita metodologia,
// lotes de investigacion, consolidacion entre lotes y ensamblado
// final, no una plantilla de 3 pasos.
//
// Este modulo detecta cuando una peticion es de ese tamano y genera
// un plan MULTINIVEL, con la MISMA forma que decomposeTask() espera
// (taskType/sector/label/narrative/originalQuery/subtasks[]), asi
// que orchestrator.js no necesita saber que existe un planificador
// distinto -- solo recibe mas subtareas, mejor pensadas.
// ═══════════════════════════════════════════════════════════════

var DEFAULT_BATCH_SIZE = 10;
// Historia real de este numero: originalmente 8, porque CADA paso
// (incluidos los lotes) heredaba el texto de TODOS los pasos anteriores
// via el fallback generico de buildPrompt() -- el lote #8 arrastraba el
// texto crudo de los 7 anteriores. Arreglado con `contextFrom` explicito
// en cada subtask (ver mas abajo): un lote ahora solo ve la metodologia,
// coste de contexto O(1) en vez de O(numero de lotes). Solo el paso de
// consolidacion sigue viendo todos los lotes (es su trabajo: detectar
// inconsistencias entre ellos), asi que el limite real hoy es cuantos
// lotes caben en UNA llamada de consolidacion, no en cada paso -- mucho
// mas alto que antes. Subido de 8 a 20 con esa base; superarlo de verdad
// (cientos de items) necesitaria resumir cada lote antes de pasarlo a
// consolidacion en vez de concatenar el texto crudo, que sigue sin
// construirse.
var MAX_BATCHES = 20;

// ═══════════════════════════════════════════
// DETECCION DE ESCALA
// ═══════════════════════════════════════════

var EXPLICIT_NUMBER_PATTERN = /\b(\d{2,4})\s+(compan[ií]as?|empresas?|startups?|productos?|art[ií]culos?|p[aá]ginas?|casos?|ejemplos?|opciones?|herramientas?|proyectos?|repositorios?|repos?|items?|elementos?|personas?|candidatos?|competidores?|modelos?|equipos?|paises?|ciudades?|libros?|papers?|estudios?)\b/i;
var TOP_N_PATTERN = /\b(?:las|los|top)\s+(\d{1,4})\s+(?:mejores|principales|top)?\s*(compan[ií]as?|empresas?|startups?|productos?|herramientas?|opciones?|competidores?|modelos?|candidatos?)\b/i;

function extractScale(query) {
  if (!query) return null;
  var m = EXPLICIT_NUMBER_PATTERN.exec(query) || TOP_N_PATTERN.exec(query);
  if (!m) return null;
  var n = parseInt(m[1], 10);
  var subject = (m[2] || 'elementos').toLowerCase();
  if (n > 0 && n < 10000) return { n: n, subject: subject };
  return null;
}

var SCALE_WORD_PATTERN = /\b(exhaustiv\w*|a fondo|en profundidad|completo|completa|detallad\w*|profund\w*|todas las|todos los|cada una de|cada uno de)\b/i;
var DELIVERABLE_PATTERN = /\b(documento|informe|reporte|an[aá]lisis|estudio|investigaci[oó]n)\b/i;

// ¿Esta peticion necesita descomposicion jerarquica en vez de la
// plantilla plana de task-decomposer.js?
function isDeepWork(query) {
  if (!query) return false;
  var scale = extractScale(query);
  if (scale && scale.n >= 15) return true; // un numero explicito grande ya basta
  var hasScaleWord = SCALE_WORD_PATTERN.test(query);
  var hasDeliverable = DELIVERABLE_PATTERN.test(query);
  var isLong = query.trim().length > 140;
  return (hasScaleWord && hasDeliverable) || (!!scale && scale.n >= 8) || (hasScaleWord && isLong);
}

// ═══════════════════════════════════════════
// INFERENCIA DE CATEGORIA (misma logica ligera que el resto del repo)
// ═══════════════════════════════════════════

function inferCategory(query) {
  if (/c[oó]digo|code|programa|funci[oó]n|componente|api\b|script/i.test(query)) return 'code';
  if (/datos|m[eé]tricas|estad[ií]stica|excel|csv|dashboard/i.test(query)) return 'data';
  return 'reasoning';
}

// ═══════════════════════════════════════════
// CONSTRUCCION DEL PLAN
// ═══════════════════════════════════════════

// opts: { batchSize, ensembleBatches }
function deepPlan(query, opts) {
  opts = opts || {};
  var scale = extractScale(query);
  var batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;
  var category = inferCategory(query);
  var ensembleBatches = !!opts.ensembleBatches;

  var n = scale ? scale.n : null;
  var subject = scale ? scale.subject : 'elementos relevantes';
  var explicitScale = !!scale;

  var totalBatches;
  var capped = false;
  if (n) {
    totalBatches = Math.ceil(n / batchSize);
    if (totalBatches > MAX_BATCHES) {
      totalBatches = MAX_BATCHES;
      capped = true;
    }
  } else {
    // Alcance exhaustivo SIN numero explicito: no se inventa una cifra
    // falsa. Primero se enumera de verdad (fase 0), y la cobertura
    // trabaja sobre lo que esa fase produzca -- un solo lote, porque sin
    // saber cuantos items hay no se puede calcular cuantos lotes hacen
    // falta de antemano.
    totalBatches = 1;
  }

  var subtasks = [];

  // FASE 0: METODOLOGIA / ENUMERACION -- siempre con ensemble: acertar
  // los criterios aqui evita rehacer todos los lotes despues si estan
  // mal definidos.
  subtasks.push({
    label: n ? 'Definir metodologia y listar ' + n + ' ' + subject : 'Definir metodologia y enumerar ' + subject,
    category: 'reasoning',
    ai: 'Ensemble (metodologia)',
    ensemble: true,
    // Primer paso: no hay nada anterior que ver.
    contextFrom: [],
    desc: n
      ? 'Define los criterios de evaluacion y la estructura del documento final. Despues, produce la lista NUMERADA y completa de los ' + n + ' ' + subject + ' a cubrir, en el orden en que se procesaran por lotes -- sin esta lista los lotes siguientes no tienen sobre que trabajar.'
      : 'Define los criterios de evaluacion y la estructura del documento final. Despues, produce una lista NUMERADA lo mas completa posible de ' + subject + ' relevantes segun la peticion original -- sin esta lista el lote de cobertura no tiene sobre que trabajar.',
  });
  var METHODOLOGY_IDX = 0;

  // FASE 1: LOTES DE INVESTIGACION -- por defecto SIN ensemble (una IA,
  // via callAI) para mantener coste y tiempo razonables en un trabajo ya
  // de por si largo; opts.ensembleBatches lo activa si se prefiere mas
  // calidad a mas coste.
  //
  // contextFrom: [METHODOLOGY_IDX] -- SOLO la metodologia, nunca los
  // lotes hermanos. Cada lote es independiente de los demas por diseno
  // (el lote #5 no necesita el texto crudo del lote #2 para hacer su
  // propio trabajo, solo la lista y los criterios). Sin esto, el
  // fallback generico de buildPrompt() en orchestrator.js concatena
  // TODOS los pasos anteriores sin filtrar -- el lote #8 arrastraria el
  // texto completo de los 7 anteriores, la razon real detras del limite
  // MAX_BATCHES=8 antes de este fix. Con el alcance explicito, el coste
  // de contexto de un lote es O(1), no O(numero de lotes ya hechos).
  var batchIndices = [];
  for (var b = 0; b < totalBatches; b++) {
    var rangeLabel;
    if (n) {
      var start = b * batchSize + 1;
      var end = Math.min((b + 1) * batchSize, n);
      rangeLabel = '#' + start + '-' + end;
    } else {
      rangeLabel = 'la lista completa producida en el paso anterior';
    }
    subtasks.push({
      label: 'Investigar ' + subject + ' ' + rangeLabel,
      category: category,
      ai: 'Lote ' + (b + 1) + '/' + totalBatches,
      ensemble: ensembleBatches,
      contextFrom: [METHODOLOGY_IDX],
      desc: 'Usando la lista y los criterios del paso de metodologia (arriba), elabora una entrada de 120-200 palabras por cada elemento de ' + rangeLabel + ': que es, por que encaja en los criterios definidos, y el dato mas relevante que lo distingue de los demas. Ve directo al contenido, no repitas la metodologia.',
    });
    batchIndices.push(subtasks.length - 1);
  }

  // FASE 2: CONSOLIDACION -- con ensemble: reconciliar inconsistencias
  // entre lotes se beneficia genuinamente de mas de un punto de vista.
  // Este SI necesita ver todos los lotes (es su trabajo: detectar
  // duplicados e inconsistencias entre ellos) -- sigue siendo O(numero
  // de lotes), pero ahora es el UNICO paso con ese coste, no todos.
  var consolidationIdx = null;
  if (totalBatches > 1) {
    subtasks.push({
      label: 'Consolidar y resolver inconsistencias entre lotes',
      category: 'reasoning',
      ai: 'Ensemble (consolidacion)',
      ensemble: true,
      contextFrom: [METHODOLOGY_IDX].concat(batchIndices),
      desc: 'Revisa las entradas producidas por todos los lotes anteriores. Detecta duplicados, criterios aplicados de forma inconsistente entre lotes, y unifica el formato de cada entrada antes del ensamblado final.',
    });
    consolidationIdx = subtasks.length - 1;
  }

  // FASE 3: ENSAMBLADO FINAL -- con ensemble (ya es el comportamiento
  // por defecto de enrichPlan para el ultimo paso; se deja explicito).
  //
  // Si hubo consolidacion, el ensamblado lee SU resultado (ya reconciliado
  // y sin duplicados), no los lotes crudos otra vez -- verlos dos veces
  // (crudos en consolidacion, crudos de nuevo aqui) seria redundancia
  // pura, no contexto util. Con un solo lote (sin consolidacion), lee
  // ese lote directamente.
  subtasks.push({
    label: 'Ensamblar documento final',
    category: 'text',
    ai: 'Ensemble (redaccion final)',
    ensemble: true,
    contextFrom: consolidationIdx !== null
      ? [METHODOLOGY_IDX, consolidationIdx]
      : [METHODOLOGY_IDX].concat(batchIndices),
    desc: 'Con todo lo anterior, redacta el documento final completo segun la estructura definida en la metodologia: introduccion, cuerpo con cada entrada ya consolidada, y conclusiones. Listo para entregar, no un resumen del proceso seguido.',
  });

  var cappedNote = capped
    ? ' (recortado a ' + MAX_BATCHES + ' lotes -- ' + n + ' ' + subject + ' pedidos superan lo que se cubre sin degradar calidad con el limite actual de contexto acumulado)'
    : '';

  var narrative = n
    ? 'Peticion de ' + n + ' ' + subject + ': LinkCore divide el trabajo en metodologia + ' + totalBatches + ' lotes de hasta ' + batchSize + cappedNote + ' + consolidacion + ensamblado -- ' + subtasks.length + ' pasos en total.'
    : 'Peticion de alcance exhaustivo sin numero explicito: LinkCore enumera ' + subject + ' primero, cubre esa lista en un lote de trabajo, y ensambla el resultado -- ' + subtasks.length + ' pasos en total.';

  return {
    taskType: 'deep-work',
    sector: 'Trabajo Profundo',
    label: n ? ('Analisis de ' + n + ' ' + subject) : ('Analisis exhaustivo de ' + subject),
    narrative: narrative,
    originalQuery: query,
    subtasks: subtasks,
    meta: {
      explicitScale: explicitScale,
      n: n,
      subject: subject,
      batchSize: batchSize,
      totalBatches: totalBatches,
      capped: capped,
      ensembleBatches: ensembleBatches,
    },
  };
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  isDeepWork,
  extractScale,
  deepPlan,
  DEFAULT_BATCH_SIZE,
  MAX_BATCHES,
};
