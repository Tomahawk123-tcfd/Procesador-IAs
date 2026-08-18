// ═══════════════════════════════════════════════════════════════
// LINKCORE TASK GRAPH
// Detects overlap between tasks, resolves dependencies,
// prevents duplicate work. The scheduling brain.
// ═══════════════════════════════════════════════════════════════

import { detectSemanticOverlap } from './semantic-translator.js';

// ═══════════════════════════════════════════
// KEYWORD SIGNATURES PER CATEGORY
// ═══════════════════════════════════════════

var CATEGORY_SIGNATURES = {
  reasoning: ['analizar', 'evaluar', 'comparar', 'razonar', 'concluir', 'decidir', 'planificar', 'estrategia', 'analyze', 'evaluate', 'compare', 'reason', 'conclude', 'decide', 'plan', 'strategy'],
  code: ['codigo', 'programar', 'implementar', 'funcion', 'componente', 'api', 'html', 'css', 'javascript', 'code', 'program', 'implement', 'function', 'component', 'api', 'html', 'css'],
  text: ['escribir', 'redactar', 'documento', 'contenido', 'informe', 'articulo', 'guion', 'write', 'draft', 'document', 'content', 'report', 'article', 'script'],
  design: ['diseno', 'visual', 'layout', 'color', 'tipografia', 'mockup', 'wireframe', 'design', 'visual', 'layout', 'color', 'typography', 'mockup', 'wireframe'],
  search: ['buscar', 'investigar', 'fuentes', 'datos', 'estadisticas', 'search', 'research', 'sources', 'data', 'statistics'],
  data: ['datos', 'metricas', 'estadisticas', 'grafico', 'dashboard', 'data', 'metrics', 'statistics', 'chart', 'dashboard'],
};

// ═══════════════════════════════════════════
// DEPENDENCY DETECTION
// ═══════════════════════════════════════════

var DEPENDENCY_PATTERNS = {
  requires: [
    /\b(requiere|necesita|depends on|needs|basado en|based on|a partir de| partir de)\b/i,
    /\b(utilizando|using|con|with|employing|empleando)\b/i,
  ],
  produces: [
    /\b(genera|produce|entrega|returns|output|resultado|deliverable)\b/i,
    /\b(crea|builds|construye|forma|shapes|molda)\b/i,
  ],
  consumes: [
    /\b(lee|reads|toma|takes|input|entrada|recibe|receives|procesa|processes)\b/i,
  ],
};

// [prerequisito, dependiente]: el segundo depende logicamente del primero,
// sin importar en que orden aparezcan en el array del plan.
var CATEGORY_DEPENDENCY_RULES = [
  ['reasoning', 'code'],
  ['reasoning', 'text'],
  ['search', 'text'],
  ['search', 'reasoning'],
  ['search', 'data'],
  ['design', 'code'],
];

function detectDependencies(taskA, taskB) {
  var deps = [];

  var textA = (taskA.label + ' ' + (taskA.desc || '')).toLowerCase();
  var textB = (taskB.label + ' ' + (taskB.desc || '')).toLowerCase();

  DEPENDENCY_PATTERNS.requires.forEach(function(p) {
    if (p.test(textA) && textB.indexOf(taskA.label.split(' ')[0].toLowerCase()) !== -1) {
      deps.push({ from: taskA.id, to: taskB.id, type: 'requires' });
    }
    if (p.test(textB) && textA.indexOf(taskB.label.split(' ')[0].toLowerCase()) !== -1) {
      deps.push({ from: taskB.id, to: taskA.id, type: 'requires' });
    }
  });

  var catA = taskA.category || 'text';
  var catB = taskB.category || 'text';

  // Bug real, confirmado en vivo (2026-08-13): estas reglas solo
  // comprobaban una direccion fija (catA=prerequisito, catB=dependiente),
  // y el bucle que llama a detectDependencies() en buildTaskGraph() SIEMPRE
  // pasa taskA=el de indice mas bajo del array. Resultado: la regla solo
  // puede CONFIRMAR una dependencia que el array YA tiene en el orden
  // correcto -- es ciega precisamente al caso en que un paso 'code'
  // aparece en el array ANTES que el 'reasoning' del que depende, que es
  // el UNICO caso en el que detectar la dependencia serviria para algo (ver
  // getExecutionOrder(), ahora conectado de verdad en orchestrator.js).
  // Reproducido en vivo: plan [code, reasoning, text] con el 'code'
  // dependiendo logicamente del 'reasoning' -> dependsOn salia vacio. Se
  // comprueban las dos direcciones sin importar el orden del array.
  CATEGORY_DEPENDENCY_RULES.forEach(function (rule) {
    if (catA === rule[0] && catB === rule[1]) {
      deps.push({ from: taskA.id, to: taskB.id, type: 'logical' });
    }
    if (catB === rule[0] && catA === rule[1]) {
      deps.push({ from: taskB.id, to: taskA.id, type: 'logical' });
    }
  });

  return deps;
}

// ═══════════════════════════════════════════
// OVERLAP DETECTION
// ═══════════════════════════════════════════

function computeTaskSignature(task) {
  var text = ((task.label || '') + ' ' + (task.desc || '') + ' ' + (task.category || '')).toLowerCase();
  var words = text.split(/\s+/).filter(function(w) { return w.length > 3; });

  var sig = {};
  words.forEach(function(w) { sig[w] = (sig[w] || 0) + 1; });

  var cat = task.category || 'text';
  var catSig = CATEGORY_SIGNATURES[cat] || [];
  catSig.forEach(function(kw) { sig[kw] = (sig[kw] || 0) + 2; });

  return sig;
}

function signatureOverlap(sigA, sigB) {
  var keysA = Object.keys(sigA);
  var keysB = Object.keys(sigB);
  var allKeys = {};
  keysA.forEach(function(k) { allKeys[k] = true; });
  keysB.forEach(function(k) { allKeys[k] = true; });

  var intersection = 0;
  keysA.forEach(function(k) {
    if (sigB[k]) intersection += Math.min(sigA[k], sigB[k]);
  });

  var totalWeight = 0;
  Object.keys(allKeys).forEach(function(k) {
    totalWeight += Math.max(sigA[k] || 0, sigB[k] || 0);
  });

  return totalWeight > 0 ? intersection / totalWeight : 0;
}

function detectTaskOverlap(taskA, taskB) {
  var textA = (taskA.label + ' ' + (taskA.desc || '')).toLowerCase();
  var textB = (taskB.label + ' ' + (taskB.desc || '')).toLowerCase();
  var textOverlap = detectSemanticOverlap(textA, textB);

  var sigA = computeTaskSignature(taskA);
  var sigB = computeTaskSignature(taskB);
  var sigOverlap = signatureOverlap(sigA, sigB);

  var catA = taskA.category || 'text';
  var catB = taskB.category || 'text';
  var catBonus = catA === catB ? 0.15 : 0;

  var total = textOverlap * 0.5 + sigOverlap * 0.35 + catBonus;
  return Math.min(total, 1);
}

// ═══════════════════════════════════════════
// TASK GRAPH BUILDER
// ═══════════════════════════════════════════

function buildTaskGraph(steps) {
  if (!steps || steps.length === 0) return [];

  var graph = steps.map(function(step, i) {
    return {
      id: step.id || 'step-' + i,
      index: i,
      label: step.label,
      desc: step.desc || '',
      category: step.category || 'text',
      ai: step.ai,
      driver: step.driver,
      dependsOn: [],
      consumedBy: null,
      overlapsWith: [],
      mode: 'producer',
      status: step.status || 'pending',
      result: step.result || null,
    };
  });

  for (var i = 0; i < graph.length; i++) {
    for (var j = i + 1; j < graph.length; j++) {
      var deps = detectDependencies(graph[i], graph[j]);
      deps.forEach(function(d) {
        var fromIdx = graph.findIndex(function(t) { return t.id === d.from; });
        var toIdx = graph.findIndex(function(t) { return t.id === d.to; });
        if (fromIdx !== -1 && toIdx !== -1) {
          graph[toIdx].dependsOn.push(graph[fromIdx].id);
        }
      });

      var overlap = detectTaskOverlap(graph[i], graph[j]);
      if (overlap > 0.55) {
        graph[j].overlapsWith.push({ taskId: graph[i].id, overlap: overlap });
      }
    }
  }

  graph.forEach(function(task) {
    if (task.overlapsWith.length > 0) {
      var highestOverlap = task.overlapsWith.sort(function(a, b) { return b.overlap - a.overlap; })[0];
      var producerTask = graph.find(function(t) { return t.id === highestOverlap.taskId; });
      if (producerTask) {
        task.consumedBy = producerTask.id;
        task.mode = 'consumer';
      }
    }
  });

  graph = resolveCircularDeps(graph);

  return graph;
}

function resolveCircularDeps(graph) {
  var changed = true;
  while (changed) {
    changed = false;
    graph.forEach(function(task) {
      if (task.dependsOn.indexOf(task.id) !== -1) {
        task.dependsOn = task.dependsOn.filter(function(d) { return d !== task.id; });
        changed = true;
      }
    });

    graph.forEach(function(task) {
      task.dependsOn.forEach(function(depId) {
        var dep = graph.find(function(t) { return t.id === depId; });
        if (dep && dep.dependsOn.indexOf(task.id) !== -1) {
          if (task.index < dep.index) {
            dep.dependsOn = dep.dependsOn.filter(function(d) { return d !== task.id; });
          } else {
            task.dependsOn = task.dependsOn.filter(function(d) { return d !== depId; });
          }
          changed = true;
        }
      });
    });
  }

  return graph;
}

// ═══════════════════════════════════════════
// EXECUTION ORDER
// ═══════════════════════════════════════════

function getExecutionOrder(graph) {
  var completed = {};
  var order = [];
  var remaining = graph.filter(function(t) { return t.mode !== 'consumer' || !t.consumedBy; });

  while (order.length < graph.length) {
    var ready = remaining.filter(function(task) {
      if (completed[task.id]) return false;
      return task.dependsOn.every(function(depId) { return completed[depId]; });
    });

    if (ready.length === 0) {
      var notDone = graph.filter(function(t) { return !completed[t.id]; });
      if (notDone.length === 0) break;
      ready = [notDone[0]];
    }

    ready.forEach(function(task) {
      order.push(task);
      completed[task.id] = true;
    });
  }

  return order;
}

// ═══════════════════════════════════════════
// PRODUCER-CONSUMER PAIRS
// ═══════════════════════════════════════════

function getProducerConsumerPairs(graph) {
  var pairs = [];

  graph.forEach(function(task) {
    if (task.mode === 'consumer' && task.consumedBy) {
      var producer = graph.find(function(t) { return t.id === task.consumedBy; });
      if (producer) {
        pairs.push({ producer: producer, consumer: task });
      }
    }
  });

  return pairs;
}

// ═══════════════════════════════════════════
// GRAPH SUMMARY
// ═══════════════════════════════════════════

function summarizeGraph(graph) {
  var producers = graph.filter(function(t) { return t.mode === 'producer'; });
  var consumers = graph.filter(function(t) { return t.mode === 'consumer'; });
  var deps = graph.reduce(function(sum, t) { return sum + t.dependsOn.length; }, 0);
  var overlaps = graph.reduce(function(sum, t) { return sum + t.overlapsWith.length; }, 0);

  return {
    totalTasks: graph.length,
    producers: producers.length,
    consumers: consumers.length,
    dependencyCount: deps,
    overlapCount: overlaps,
    categories: graph.reduce(function(acc, t) { acc[t.category] = (acc[t.category] || 0) + 1; return acc; }, {}),
  };
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  buildTaskGraph,
  getExecutionOrder,
  getProducerConsumerPairs,
  detectTaskOverlap,
  detectDependencies,
  summarizeGraph,
};
