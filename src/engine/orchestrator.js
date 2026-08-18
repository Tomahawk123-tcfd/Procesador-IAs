// LinkCore Orchestrator — Uber-style dispatch for AI work.
// Intent → plan → route each step to the best specialist → one unified result.
// Progress is streamed so the UI can explain every move (Devin transparency).

import { decomposeTask, detectTaskType, isComplexTask } from '../task-decomposer.js';
import { AI_REGISTRY, getCognitiveProfile } from '../ai-registry.js';
import { runCrew, detectDeliverableType } from './crew.js';
import { coordinate, registerIA, memWrite, memRead, memFormat, detectAllContradictions, logConsensusEvent } from './middleware.js';
import { buildContextPacket, translateForModel, detectThinkingStyle } from './semantic-translator.js';
import { buildTaskGraph, getExecutionOrder, getProducerConsumerPairs, summarizeGraph } from './task-graph.js';
import { storeWithIntent, recallByIntent, setScope, formatForPrompt as intentFormat } from './intent-memory.js';
import { checkOverlap, recordCompletedWork } from './work-ledger.js';
import { isDeepWork, deepPlan } from './deep-planner.js';
import { isAppBuildRequest, buildPipelinePlan } from './build-pipeline-planner.js';
import * as S from './settings.js';
import { findGithubContext, detectRepoReference } from './github-search.js';
import { callKimiK3, kimiOrchestrate, isKimiAvailable } from './kimi-k3.js';
import { stripLeakedPreamble } from './translation.js';

async function runGStackWorkflow(workflowId, query, opts) {
  var mod = await import('../gstack.js');
  return mod.runGStackWorkflow(workflowId, query, opts);
}

async function callAI(query, opts) {
  var mod = await import('../backend.js');
  return mod.callAI(query, opts);
}

// callAIEnsemble/callOpenSourceEnsemble/communicateEnsemble (cascada remota
// del Worker: Groq/OpenRouter/NVIDIA/Gemini, y repos HF como servicio) se
// borraron por completo (2026-08-09) junto con el bloque que las llamaba
// mas abajo -- LinkCore es 100% local de verdad, decision explicita del
// usuario. Si se retoman en el futuro, estan en el historial de git.
async function callLocalEnsemble(query, opts) {
  var ensembleMod = await import('./ensemble-v2.js');
  var backendMod = await import('../backend.js');
  return ensembleMod.ensembleRun(query, opts, backendMod.callAI);
}

async function searchExaCode(query, opts) {
  var mod = await import('../backend.js');
  return mod.searchExaCode(query, opts);
}

var CATEGORY_TO_TYPE = {
  text: 'llm-text',
  reasoning: 'llm-reasoning',
  multimodal: 'llm-text',
  code: 'llm-code',
  voice: 'tts',
  audio: 'tts',
  image: 'image-gen',
  vision: 'llm-vision',
  search: 'web-search',
  video: 'llm-text',
  music: 'llm-text',
  data: 'llm-reasoning',
  doc: 'llm-text',
};

// Map orchestrator categories to Worker provider specialties.
// Worker specialties: 'fast', 'general', 'code', 'writing', 'reasoning'
var CATEGORY_TO_WORKER_SPECIALTY = {
  text: 'writing',
  reasoning: 'reasoning',
  code: 'code',
  voice: null,
  audio: null,
  image: null,
  vision: 'general',
  search: 'general',
  video: null,
  music: null,
  data: 'reasoning',
  doc: 'writing',
  multimodal: 'general',
};

var CATEGORY_SYSTEM = {
  text: 'Eres un escritor profesional. Entrega texto listo para usar en espanol, estructurado, sin emojis, sin meta-comentarios como "aquí tienes" o "espero que te sea útil". Directo al contenido.',
  reasoning: 'Eres un analista senior. Analiza en pasos claros con datos concretos, estructura logica, y concluye con una decision accionable. Sin rodeos.',
  code: 'Eres un ingeniero senior con 10+ anios de experiencia. Entrega codigo completo, funcional, con comentarios solo donde aporta valor. Incluye manejo de errores, edge cases, y buenas practicas. Formato: bloques de codigo con syntax highlighting.',
  voice: 'Eres un director de locucion profesional. Entrega el guion final listo para TTS, con pausas marcadas como [...], entonacion indicada, y ritmo optimizado para escucha natural.',
  audio: 'Eres un productor de audio experimentado. Describe el resultado profesional con especificaciones tecnicas (formato, bitrate, sample rate) y entrega el plan de produccion.',
  image: 'Eres un director de arte senior. Entrega prompts de imagen detallados con composicion, estilo, iluminacion, paleta de colores, y descripcion del visual final.',
  search: 'Eres un investigador metódico. Resume hallazgos con bullets, fuentes identificables, datos cuantificables, y conclusiones respaldadas por evidencia.',
  vision: 'Eres un analista visual tecnico. Describe con precision: estructura, dimensiones, colores,tipografia, layout, y elementos visuales relevantes.',
  video: 'Eres un director de video profesional. Entrega guion shot-by-shot con indicaciones de camara, iluminacion, duracion, y brief de produccion tecnico.',
  music: 'Eres un productor musical experimentado. Define mood, estructura, instrumentacion, tempo, key, y prompt detallado para generacion.',
  data: 'Eres un analista de datos senior. Entrega metricas concretas, insights accionables, comparativas, y recomendaciones priorizadas por impacto.',
  doc: 'Eres un editor documental profesional. Entrega documento estructurado con encabezados claros, secciones bien definidas, formato consistente, y lenguaje preciso.',
  multimodal: 'Eres un especialista multimodal. Integra texto e imagen en una respuesta coherente, util, y completa.',
};

function pickDriver(category, preferredAiLabel) {
  var cat = category || 'text';
  var pool = AI_REGISTRY.filter(function (m) {
    return m.category === cat || (m.bestFor || []).some(function (b) {
      return String(b).toLowerCase().indexOf(cat) >= 0;
    });
  });
  if (!pool.length) pool = AI_REGISTRY.filter(function (m) { return m.category === 'text'; });
  if (!pool.length) {
    return { id: 'linkcore-router', name: preferredAiLabel || 'LinkCore Router', provider: 'proxy', category: cat };
  }
  // Prefer open-source when labels hint at it; otherwise highest elo.
  var preferred = preferredAiLabel ? String(preferredAiLabel).toLowerCase() : '';
  var match = pool.find(function (m) {
    return preferred && preferred.indexOf(String(m.name).toLowerCase().split(' ')[0]) >= 0;
  });
  if (match) return match;
  pool.sort(function (a, b) { return (b.elo || 0) - (a.elo || 0); });
  return pool[0];
}

function buildPrompt(step, query, previousResults, graphContext, intentContext, githubContext, exaContext) {
  var prior = '';

  if (graphContext && graphContext.consumerMode && graphContext.producerResult) {
    // Bug real, severo (2026-08-12): graphContext.producerResult es el
    // TEXTO PLANO del paso anterior (results[id], un string) -- este
    // codigo lo trataba como un objeto con .text/.model/.elo. producer.text
    // es siempre undefined, asi que buildContextPacket(undefined, ...)
    // devolvia null SIEMPRE (su primera linea es `if (!rawOutput) return
    // null`), lo que forzaba el camino de respaldo -- que a su vez hacia
    // producer.text.slice(...) sobre ese mismo undefined y reventaba con
    // TypeError. Esto se disparaba en CADA paso que dependiera del
    // anterior (modo 'consumer' del grafo de tareas), no en un caso raro.
    var producer = graphContext.producerResult;
    var targetProfile = getCognitiveProfile(step.driver || {});
    var packet = buildContextPacket(producer, { name: graphContext.producerModel || 'modelo anterior', id: null }, step.role || step.category);
    if (packet) {
      prior = '\n\n' + translateForModel(packet, targetProfile) + '\n';
    } else {
      prior = '\n\nContexto del paso anterior:\n' + producer.slice(0, 1500) + '\n';
    }
  } else {
    // Si el paso declara `contextFrom` (indices de que pasos anteriores
    // necesita de verdad -- deep-planner.js lo hace), se usa SOLO eso en
    // vez de todo el historial. Sin esto, un plan de muchos pasos
    // acumulaba el texto de TODOS los anteriores en cada uno, sin
    // filtrar -- el motivo real detras del limite MAX_BATCHES de
    // deep-planner.js (ver su cabecera). Cuando `contextFrom` no esta
    // definido (las plantillas planas de task-decomposer.js nunca lo
    // ponen), el comportamiento es EXACTAMENTE el de siempre: todo el
    // historial, sin cambios -- cero riesgo de regresion para el camino
    // que ya funcionaba.
    var allKeys = Object.keys(previousResults || {});
    var keys = Array.isArray(step.contextFrom)
      ? step.contextFrom.map(function (idx) { return 'step-' + idx; }).filter(function (k) { return allKeys.indexOf(k) !== -1; })
      : allKeys;
    if (keys.length) {
      prior = '\n\nContexto de pasos anteriores:\n' + keys.map(function (k) {
        var t = previousResults[k] || '';
        return '- Paso ' + k + ': ' + t.slice(0, 1200);
      }).join('\n');
    }
  }

  var intentPart = intentContext ? '\n\nMemoria de contexto:\n' + intentContext + '\n' : '';
  var githubPart = (githubContext && githubContext.ok)
    ? '\n\nCodigo real de referencia (' + githubContext.repo + ', ' + githubContext.results.length + ' fragmentos relevantes de ' + githubContext.filesIndexed + ' archivos indexados):\n' + githubContext.contextText + '\n'
    : '';
  var exaPart = (exaContext && exaContext.ok && exaContext.results.length)
    ? '\n\nCodigo real encontrado en GitHub (busqueda semantica via Exa, ' + exaContext.results.length + ' fuentes):\n' + exaContext.results.map(function (r) {
        return '=== ' + r.url + ' ===\n' + (r.highlights || []).join('\n');
      }).join('\n\n') + '\n'
    : '';

  return (
    'Solicitud original del usuario:\n' + query + '\n\n' +
    'Tu subtarea en el pipeline de LinkCore:\n' +
    step.label + '\n' +
    (step.desc ? ('Detalle: ' + step.desc + '\n') : '') +
    'Entrega SOLO el resultado de esta subtarea, listo para el siguiente agente.' +
    intentPart +
    githubPart +
    exaPart +
    prior
  );
}

function enrichPlan(rawPlan) {
  if (!rawPlan) return null;
  return {
    taskType: rawPlan.taskType,
    sector: rawPlan.sector,
    label: rawPlan.label,
    narrative: rawPlan.narrative,
    originalQuery: rawPlan.originalQuery,
    subtasks: (rawPlan.subtasks || []).map(function (st, i, arr) {
      var type = CATEGORY_TO_TYPE[st.category] || 'llm-text';
      var driver = pickDriver(st.category, st.ai);
      // El ultimo paso (la síntesis que el usuario va a leer) es el que
      // mas se beneficia de ensemble learning real: varios proveedores
      // responden a la misma pregunta y se reconcilian, en vez de confiar
      // en la salida de uno solo para el resultado final. Un plan puede
      // marcar explicitamente que pasos quiere en ensemble (deep-planner.js
      // lo hace: metodologia, consolidacion y ensamblado si, lotes de
      // investigación no por defecto -- coste); si no lo marca, se
      // mantiene el comportamiento de siempre (solo el ultimo paso).
      // Bug real, confirmado en vivo (2026-08-03): con `&& arr.length > 1`,
      // un plan de UN SOLO paso (el caso mas comun para queries como "haz
      // un analisis...") nunca marcaba su propio paso como final, asi que
      // nunca entraba en la rama de ensemble de mas abajo -- pese a que es
      // precisamente el caso donde mas falta hace (es el UNICO paso, y por
      // tanto la unica oportunidad de que varias IAs se crucen y comparen
      // antes de que el usuario vea la respuesta). Verificado con --json:
      // contributors=[1 solo modelo], ensemble=null en ese caso.
      var isFinalStep = i === arr.length - 1;
      return {
        id: 'step-' + i,
        index: i,
        label: st.label,
        desc: st.desc,
        ai: st.ai,
        category: st.category,
        type: type,
        driver: driver,
        status: 'pending',
        result: null,
        log: null,
        latencyMs: 0,
        ensemble: typeof st.ensemble === 'boolean' ? st.ensemble : isFinalStep,
        // Se copia tal cual si el plan lo trae (deep-planner.js); si no,
        // queda undefined y buildPrompt() usa el historial completo de
        // siempre -- ver la nota larga ahi.
        contextFrom: st.contextFrom,
      };
    }),
  };
}

function emit(onProgress, event) {
  if (typeof onProgress === 'function') {
    try { onProgress(event); } catch (e) {}
  }
}

async function runWebSearch(query) {
  try {
    var url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_redirect=1&no_html=1';
    var res = await fetch(url);
    if (!res.ok) return null;
    var data = await res.json();
    var bits = [];
    if (data.AbstractText) bits.push(data.AbstractText);
    (data.RelatedTopics || []).slice(0, 5).forEach(function (t) {
      if (t.Text) bits.push(t.Text);
    });
    if (!bits.length) return null;
    return {
      text: bits.join('\n\n'),
      model: 'DuckDuckGo Instant Answer',
      provider: 'duckduckgo',
      latencyMs: 0,
    };
  } catch (e) {
    return null;
  }
}

async function executeStep(step, query, previousResults, graphContext, intentContext, preferredModelIds, deadlineTs) {
  var started = Date.now();
  if (deadlineTs && Date.now() > deadlineTs) {
    throw new Error('Presupuesto global de tiempo de la orquestacion agotado antes de poder intentar este paso');
  }
  // Solo busca en GitHub si el usuario menciono un repo real
  // (owner/repo) en su peticion -- nunca dispara una busqueda a ciegas.
  // El indexado queda en cache, asi que solo el primer paso paga el
  // coste real de indexar; los siguientes reusan el mismo indice.
  var githubContext = detectRepoReference(query) ? await findGithubContext(query).catch(function () { return null; }) : null;
  // Busqueda semantica de codigo real via Exa -- solo en los pasos
  // "potentes" (ensemble), no en cada subtarea trivial, para no gastar
  // cuota de la API en peticiones simples que no la necesitan.
  var exaContext = step.ensemble ? await searchExaCode(query, { githubOnly: true }).catch(function () { return null; }) : null;
  var prompt = buildPrompt(step, query, previousResults, graphContext, intentContext, githubContext, exaContext);
  var system = CATEGORY_SYSTEM[step.category] || CATEGORY_SYSTEM.text;

  if (step.type === 'web-search') {
    var search = await runWebSearch(query);
    if (search && search.text) {
      search.latencyMs = Date.now() - started;
      return search;
    }
  }

  var workerCategory = CATEGORY_TO_WORKER_SPECIALTY[step.category] || null;
  var systemPrompt = 'Eres un especialista de LinkCore en ' + (step.category || 'texto') + '. ' +
    system + ' Responde EN ESPAÑOL de forma profesional y directa, sin emojis ni meta-comentarios.';

  // 100% local de verdad (2026-08-09), decision explicita del usuario tras
  // encontrar en vivo que este paso caia a Groq (via callAIEnsemble, la
  // cascada del Worker) para cualquier tarea larga/compleja pese a que TODA
  // la documentacion de hoy decia "cero claves remotas configuradas" --
  // habia una clave (LINKCORE_PROXY_SECRET) en el entorno y este camino
  // nunca se limpio cuando se quito Groq de ensemble-v2.js. Se borra por
  // completo (no se deja tras un flag): callOpenSourceEnsemble (repos HF
  // como servicio remoto) y callAIEnsemble (Groq/OpenRouter/NVIDIA/Gemini
  // via Worker) ya no se llaman desde aqui. Si se retoma en el futuro, el
  // bloque completo esta en el historial de git de este archivo.
  if (step.ensemble) {
    // size:2 en serie 100% local media 897s (15 min) en vivo (2026-08-03)
    // -- de ahi este limite. LinkCore es 100% local: size:2 es el maximo
    // sostenible en serie sin degradar el tiempo total a mas de eso.
    var localEnsemble = await callLocalEnsemble(prompt, {
      systemPrompt: systemPrompt,
      size: 2,
      category: workerCategory,
      gstackReview: false,
      preferredModelIds: preferredModelIds || [],
      deadlineTs: deadlineTs,
    });
    if (localEnsemble && localEnsemble.ok && localEnsemble.text) {
      var localMembers = localEnsemble.ensemble ? localEnsemble.ensemble.models : [localEnsemble.model];
      return {
        text: localEnsemble.text,
        model: localMembers.join(' + '),
        provider: 'ensemble-v2-local',
        latencyMs: localEnsemble.latencyMs,
        openSource: true,
        trace: [],
        requestedCategory: workerCategory,
        ensemble: {
          requestedSize: localEnsemble.ensemble ? localEnsemble.ensemble.size : 1,
          realSize: localMembers.length,
          // Nombre de campo `round2` a proposito: bin/linkcore-cli.js lee
          // d.ensemble.round2 para el desglose por modelo -- ese nombre
          // viene de ensembleRun() (ensemble-v2.js).
          round2: (localEnsemble.ensemble && localEnsemble.ensemble.round2) ? localEnsemble.ensemble.round2.map(function (r) {
            return { model: r.model, provider: 'ollama-local', revised: !!r.revised, text: r.text, round1Text: r.round1Text };
          }) : [],
          scores: localEnsemble.ensemble ? localEnsemble.ensemble.scores : null,
          families: null,
          independent: null,
          contradictions: 0,
          failures: [],
          consideredRepos: null,
          selectionExplanation: null,
          // false: ya no es un "degradado" cayendo de un camino remoto que
          // fallo -- es el UNICO camino, el intencional. local:true se deja
          // para que cualquier lector del payload siga viendo de donde vino.
          degraded: false,
          local: true,
        },
      };
    }
    // Si ni el ensemble local consigue respuesta (todos los modelos small
    // fallaron/circuito abierto), cae al callAI() de un solo modelo de
    // abajo -- degradacion explicita a un solo modelo, nunca a un
    // proveedor remoto no pedido.
  }

  // Bug real, encontrado en vivo (2026-08-09): timeoutMs:35000 se calibro
  // para proveedores remotos rapidos (Groq, cientos de tokens/seg) -- tras
  // quitar Groq de este archivo, este es el ultimo recurso 100% local, y
  // 35s no alcanza ni para el propio techo de tokens del sistema
  // (OLLAMA_MAX_TOKENS_CEILING=700 en backend.js): a la velocidad real
  // medida hoy (~10 tokens/seg en esta CPU), 700 tokens solos ya piden
  // ~70s, sin contar la evaluacion del prompt de entrada (mas lenta cuanto
  // mas largo). Confirmado en vivo: una pregunta larga real fallaba con
  // "Sin respuesta del proveedor" tras agotar este margen. Subido a un
  // valor que de verdad cubre el techo de tokens en esta CPU.
  var result = await callAI(prompt, {
    systemPrompt: systemPrompt,
    maxTokens: step.type === 'llm-code' ? 3500 : 2200,
    temperature: step.type === 'llm-reasoning' ? 0.15 : 0.35,
    timeoutMs: 90000,
    category: workerCategory,
    // Mismo patron que crew.js (agent.role === 'coder'): sin esto, una
    // subtarea de codigo podia caer en un modelo 'tiny'/'small' del
    // catalogo -- capaz para texto general, malo para codigo. minTier ya
    // esta soportado de punta a punta (backend.js#pickBestOpenSourceModel
    // -> ollama-catalog.js), solo faltaba conectarlo aqui.
    minTier: step.type === 'llm-code' ? 'medium' : undefined,
    deadlineTs: deadlineTs,
  });

  if (result && result.text) {
    return {
      text: result.text,
      model: result.model || step.ai,
      provider: result.provider || 'proxy',
      latencyMs: result.latencyMs || (Date.now() - started),
      openSource: !!(step.driver && step.driver.openSource),
      trace: result.trace || [],
      requestedCategory: workerCategory,
    };
  }

  throw new Error('Sin respuesta del proveedor para: ' + step.label);
}

function uniqueLines(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (s) {
    if (seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

function synthesize(plan, modelsUsed, totalMs) {
  var lines = [];
  var done = plan.subtasks.filter(function (s) { return s.status === 'completed'; }).length;
  var total = plan.subtasks.length;

  lines.push('**Ejecutado:** `' + (plan.label || 'Plan de ejecución') + '`');
  lines.push('');
  lines.push('**Tiempo total:** ' + (totalMs > 1000 ? (totalMs / 1000).toFixed(1) + 's' : totalMs + 'ms') + ' | ' + done + '/' + total + ' pasos completados');
  lines.push('');

  lines.push('LinkCore descompuso tu peticion en **' + total + ' subtareas** y despacho cada una segun su especialidad:');
  lines.push('');

  plan.subtasks.forEach(function (st, i) {
    var driverName = st.model || 'sin respuesta';
    var provider = st.provider || 'proxy';
    var latency = st.latencyMs ? (st.latencyMs > 1000 ? (st.latencyMs / 1000).toFixed(1) + 's' : st.latencyMs + 'ms') : '';
    var statusIcon = st.status === 'completed' ? '[OK]' : st.status === 'error' ? '[ERR]' : st.status === 'running' ? '[...]' : '[--]';

    lines.push(statusIcon + ' **Paso ' + (i + 1) + ':** ' + st.label);
    lines.push('   - **Agente:** `' + driverName + '` (' + provider + ')' + (latency ? ' · ' + latency : ''));
    if (st.desc) {
      lines.push('   - **Tarea:** ' + st.desc);
    }
    if (st.status === 'completed' && st.result) {
      var preview = String(st.result).slice(0, 400);
      if (String(st.result).length > 400) preview += '...';
      lines.push('   - **Resultado:** ' + preview);
    }
    if (st.status === 'error' && st.log) {
      lines.push('   - **Error:** ' + st.log);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('**IAs que respondieron realmente:**');
  modelsUsed.forEach(function (m) {
    lines.push('- `' + m.model + '` via ' + m.provider + (m.requestedCategory ? ' · especialidad: ' + m.requestedCategory : ''));
  });

  var skipped = [];
  modelsUsed.forEach(function (m) {
    (m.trace || []).forEach(function (t) {
      if (t.status === 'ok') return;
      skipped.push('- `' + t.tier + '` — ' + t.detail);
    });
  });
  if (skipped.length) {
    lines.push('');
    lines.push('**Niveles descartados en la cascada:**');
    uniqueLines(skipped).forEach(function (s) { lines.push(s); });
  }

  return lines.join('\n');
}

/**
 * Run a full LinkCore dispatch cycle.
 * @param {string} query
 * @param {{ onProgress?: Function }} opts
 */
// Presupuesto global de tiempo, portable a CUALQUIER maquina (2026-08-14):
// antes de esto, cada etapa (Kimi K3, ensemble round1, callAI paso 1, la
// cascada de respaldo de callAI) vigilaba solo SU PROPIO timeout, sin que
// ninguna supiera cuanto tiempo ya habian gastado las anteriores. En una
// maquina bajo presion momentanea (poca RAM libre, otros procesos, modo
// ahorro de energia -- no exclusivo de esta maquina de desarrollo), la
// SUMA de las 4 etapas puede crecer sin techo real. Reproducido en vivo:
// una consulta real tardo 367s sumando las 4 etapas por separado, cada una
// "a tiempo" segun su propio limite. Un reloj unico, compartido por todo
// el ciclo, hace que el peor caso sea predecible en cualquier hardware, no
// solo en el mejor de los casos.
var ORCHESTRATION_GLOBAL_BUDGET_MS = 240000;

export async function runOrchestration(query, opts) {
  opts = opts || {};
  var onProgress = opts.onProgress;
  var startedAt = Date.now();
  var deadlineTs = startedAt + ORCHESTRATION_GLOBAL_BUDGET_MS;
  // Identifica esta ejecución en el ledger de trabajo -- para que el
  // chequeo de solapamiento no se dispare contra los propios pasos que
  // esta misma peticion ya planeo (eso ya lo cubre task-graph.js dentro
  // del plan actual). El ledger mira hacia ATRAS, a sesiones anteriores.
  var runSessionId = 'orch_' + startedAt;

  var settings = S.load();

  // ═══════════════════════════════════════════════════════════════
  // KIMI K3 MASTER ORCHESTRATOR: El cerebro que decide todo
  // ═══════════════════════════════════════════════════════════════
  if (isKimiAvailable()) {
    emit(onProgress, { type: 'kimi_start', message: 'Kimi K3 analizando tu peticion como orquestador maestro...', plan: null, logs: [] });

    var kimiDecision = await kimiOrchestrate(query, {
      systemPrompt: 'Eres Kimi K3, el cerebro orquestador de LinkCore. Analiza y decide.',
      maxTokens: 2000,
      temperature: 0.2,
    });

    if (kimiDecision && kimiDecision.ok) {
      emit(onProgress, { type: 'kimi_decision', strategy: kimiDecision.strategy, reason: kimiDecision.reason, models: kimiDecision.models, message: 'Kimi K3 decide: ' + kimiDecision.strategy + ' - ' + kimiDecision.reason });

      // Si Kimi decide responder directamente
      if (kimiDecision.strategy === 'direct' && kimiDecision.response) {
        emit(onProgress, { type: 'done', plan: null, message: 'Kimi K3 respondio directamente', logs: [] });
        return {
          response: kimiDecision.response,
          decomposed: false,
          model: 'kimi-k3',
          provider: 'kimi-api',
          latencyMs: Date.now() - startedAt,
          orchestrator: 'kimi-k3',
          kimiDecision: kimiDecision,
        };
      }

      // Si Kimi decide ensemble, continuar con el pipeline normal
      // pero usando los modelos que Kimi sugirio.
      //
      // Bug real, confirmado en vivo (2026-08-13): esto se guardaba en
      // `settings` (variable local de runOrchestration) pero executeStep()
      // es una funcion de nivel superior, sin closure sobre `settings` --
      // ningun paso del plan llegaba a ver jamas lo que Kimi decidio. La
      // decision del "cerebro orquestador maestro" se calculaba y se
      // tiraba: el pipeline elegia modelos exactamente igual que si Kimi
      // nunca hubiera opinado. Se corrige pasando `settings.preferredModels`
      // explicitamente a cada executeStep() (ver la llamada mas abajo), que
      // a su vez lo reenvia a callLocalEnsemble() -> ensembleRun()
      // (opts.preferredModelIds, nuevo hoy tambien en ensemble-v2.js).
      if (kimiDecision.models && kimiDecision.models.length) {
        settings.preferredModels = kimiDecision.models;
      }
    }
  }

  // Intent Memory: store this task's intent and set scope (if enabled)
  var intentContext = '';
  if (settings.intentMemory) {
    var taskIntent = storeWithIntent(query, 'orchestrator', { eventType: 'orchestration' });
    setScope(taskIntent.intent.scope);
    intentContext = intentFormat({ query: query, limit: 4 });
  }

  var raw = null;
  if (settings.ensemble) {
    // Orden de deteccion, mas especifico primero: "crea una app" tiene
    // su propio pipeline (requisitos -> diseño -> datos -> codigo ->
    // control de versiones -> testing -> publicacion, revisado por
    // G-STACK CEO+Eng Manager el 2026-07-28 -- ver la cabecera de
    // build-pipeline-planner.js). Si no es eso, peticiones de trabajo
    // grande ("documento a fondo con análisis exhaustivo de las 100
    // mejores companias de YC") no encajan en las plantillas planas de
    // 3-4 pasos de decomposeTask() -- necesitan metodologia, lotes de
    // investigacion, consolidacion y ensamblado. Solo si ninguna de las
    // dos aplica, cae a la plantilla plana de siempre.
    raw = isAppBuildRequest(query) ? buildPipelinePlan(query)
      : isDeepWork(query) ? deepPlan(query)
      : decomposeTask(query);
  }

  // When ensemble is OFF, skip decomposition — single best AI handles everything
  if (!raw) {
    raw = {
      taskType: 'general',
      sector: 'General',
      label: settings.ensemble ? 'Tarea general' : 'Tarea directa',
      narrative: settings.ensemble
        ? 'LinkCore analiza tu petición, elige las mejores IAs del catálogo y sintetiza una única respuesta.'
        : 'Ensemble desactivado. Una sola IA responde directamente.',
      originalQuery: query,
      subtasks: [
        { label: query.slice(0, 120), ai: 'Best available', category: 'text', desc: query },
      ],
    };
  }

  // Bug real encontrado en vivo (2026-07-28): un plan de deep-planner.js
  // SIEMPRE tiene mas de 2 subtareas por diseno, asi que sin esta
  // exclusion `useCrew` era true en TODO plan de trabajo profundo -- y si
  // runCrew() "tenia exito" (ver crewHasRealAnswer abajo), su resultado
  // SUSTITUIA por completo la metodologia + lotes + consolidacion que el
  // deep-planner acababa de construir, sin que nadie lo supiera. El plan
  // jerarquico deliberado no debe competir con la planificación ad-hoc de
  // runCrew() -- se excluye explicitamente.
  var PLANNED_TASK_TYPES = { 'deep-work': true, 'build-pipeline': true };
  // Bug real, grave, confirmado en vivo (2026-08-03): esta condicion
  // escalaba a Crew (6 pasos SECUENCIALES, cada uno una llamada real a un
  // modelo, mas una ronda final de coordinate() que trata esos 6 pasos
  // como si fueran votos paralelos -- el mismo fallo ya arreglado en este
  // archivo para el flujo normal, generando 45 "contradicciones" falsas y
  // colgandose esperando a un mediador) para CUALQUIER query que pasara
  // isComplexTask() -- una barra muy baja (cualquier frase con un verbo
  // de accion, o >200 caracteres). Reproducido en vivo: "haz un analisis
  // del mercado actual..." escalo a Crew y tardo mas de 30 minutos sin
  // devolver nada visible, en una maquina sin GPU. isComplexTask() es la
  // barra correcta para decidir "esto necesita descomposicion en pasos"
  // (shouldOrchestrate), NO para decidir "esto necesita un equipo de 6
  // roles secuenciales con mediacion". Se usa detectDeliverableType()
  // -- la misma señal que ya usa smartQuery() para su propio gate de
  // Crew, mas estricta -- para mantener consistencia entre los dos
  // sitios que deciden si vale la pena pagar el coste real de Crew.
  var useCrew = settings.ensemble && !PLANNED_TASK_TYPES[raw.taskType] && detectDeliverableType(query) !== 'text';
  if (useCrew) {
    try {
      var crewResult = await runCrew(query, { onProgress: onProgress });
      // runCrew() puede "tener exito" tecnicamente (no lanza excepcion) pero
      // sin que ningun agente haya respondido de verdad -- eso NO es un
      // resultado valido, es un fallo silencioso disfrazado de respuesta.
      // Si pasa, cae al camino real (enrichPlan/executeStep) en vez de
      // devolver "No se obtuvieron respuestas de los agentes." como si
      // fuera la respuesta final.
      var crewHasRealAnswer = crewResult && crewResult.modelsUsed && crewResult.modelsUsed.length > 0;
      if (crewHasRealAnswer) {
        emit(onProgress, { type: 'response', response: crewResult.response, decomposed: crewResult.decomposed, decompositionLabel: crewResult.decompositionLabel });
        return crewResult;
      }
      console.error('[LinkCore] Crew sin respuestas reales, cayendo al camino clasico.');
    } catch (crewErr) {
      console.error('[LinkCore] Crew fallback:', crewErr);
    }
  }

  var plan = enrichPlan(raw);
  var taskGraph = buildTaskGraph(plan.subtasks);
  var graphSummary = summarizeGraph(taskGraph);
  var pairs = getProducerConsumerPairs(taskGraph);

  emit(onProgress, {
    type: 'plan',
    plan: plan,
    narrative: plan.narrative,
    message: 'Plan listo: ' + plan.subtasks.length + ' pasos · sector ' + plan.sector + (pairs.length ? ' · ' + pairs.length + ' pares productor-consumidor detectados' : ''),
    graphSummary: graphSummary,
  });

  var results = {};
  var modelsUsed = [];
  var logs = [];

  // Bug real, confirmado en vivo (2026-08-13): taskGraph.dependsOn se
  // calculaba de verdad (detectDependencies: patrones "requiere/produce/
  // consume" + reglas logicas por categoria como reasoning-antes-que-code)
  // y getExecutionOrder() ya existia para devolver el orden topologico que
  // respeta esas dependencias -- pero este bucle iteraba plan.subtasks en
  // su orden de ARRAY plano, sin llamar a getExecutionOrder() ni una vez
  // (confirmado por grep en todo el repo: el unico uso de la funcion era
  // este import, nunca invocada). Con las plantillas actuales de
  // task-decomposer.js, ya pre-ordenadas a mano, no se notaba -- pero para
  // cualquier plan futuro que dependa del grafo real (deep-planner con
  // pasos generados dinamicamente, por ejemplo) una dependencia detectada
  // no impedia ejecutar un paso antes que el que de verdad necesitaba. Se
  // ejecuta en el orden que el propio grafo calculo, resolviendo el nodo
  // real de plan.subtasks por id (el nodo del grafo es una copia estatica
  // sin los campos que se mutan en vivo durante la ejecucion, como model/
  // result -- ver el comentario de graphContext mas abajo sobre ese mismo
  // patron).
  var executionOrder = getExecutionOrder(taskGraph);

  for (var i = 0; i < executionOrder.length; i++) {
    var step = plan.subtasks.find(function (s) { return s.id === executionOrder[i].id; });
    if (!step) continue;
    step.status = 'running';

    var graphNode = taskGraph.find(function(n) { return n.id === step.id; });
    var graphContext = null;
    if (graphNode && graphNode.mode === 'consumer' && graphNode.consumedBy) {
      var producerResult = results[graphNode.consumedBy];
      if (producerResult) {
        // Bug real (2026-08-12), mismo patron que agentOutputs mas abajo:
        // taskGraph se construye UNA VEZ al empezar, con step.driver (la
        // preseleccion del catalogo ELO inventado) -- nunca se actualiza
        // con el modelo real tras ejecutar. plan.subtasks si se muta con
        // el modelo real (step.model = out.model, ver executeStep), asi
        // que se busca ahi, no en el nodo estatico del grafo.
        var producerStep = plan.subtasks.find(function(s) { return s.id === graphNode.consumedBy; });
        graphContext = {
          consumerMode: true,
          producerResult: producerResult,
          producerModel: producerStep ? (producerStep.model || null) : null,
          overlap: graphNode.overlapsWith.find(function(o) { return o.taskId === graphNode.consumedBy; }),
        };
      }
    }

    var workerSpecialty = CATEGORY_TO_WORKER_SPECIALTY[step.category] || 'general';
    var selectionMsg = 'Despachando "' + step.label + '" · especialidad solicitada: ' + workerSpecialty;
    selectionMsg += (graphContext ? ' · consumiendo resultado del paso anterior' : '');

    // Chequeo contra el ledger de trabajo: ¿ya se hizo algo muy parecido
    // en una sesion anterior de LinkCore? No decide por el usuario --
    // informa, con dato concreto (que tarea, cuando, con que resultado),
    // para que la decision de reusar o repetir se tome sabiendolo, no a
    // ciegas. Esto es lo verificable de "no os solapeis": un registro
    // real, no una promesa de que las IAs "se coordinan".
    var overlapMatches = checkOverlap(
      { label: step.label, desc: step.desc, category: step.category },
      { excludeSessionId: runSessionId, limit: 2 }
    );
    if (overlapMatches.length) {
      var top = overlapMatches[0];
      var ageMin = Math.round(top.ageMs / 60000);
      var overlapMsg = 'Posible trabajo repetido: "' + top.label + '" ya se ejecuto hace ' +
        (ageMin < 1 ? 'menos de un minuto' : ageMin + ' min') +
        ' (' + Math.round(top.score * 100) + '% similar, fuente: ' + top.source + ').';
      logs.push({ t: Date.now(), level: 'warn', text: overlapMsg });
      emit(onProgress, {
        type: 'step_overlap_warning',
        step: step,
        matches: overlapMatches,
        message: overlapMsg,
        plan: plan,
        logs: logs.slice(),
      });
    }

    emit(onProgress, {
      type: 'step_start',
      step: step,
      message: selectionMsg,
      plan: plan,
      logs: logs.slice(),
    });

    try {
      var out = await executeStep(step, query, results, graphContext, intentContext, settings.preferredModels || [], deadlineTs);
      step.status = 'completed';
      // Bug real, encontrado en vivo (2026-08-07): un modelo abrio su
      // respuesta parafraseando la plantilla de buildPrompt() ("...la
      // subtarea en el pipeline de LinkCore:") -- ni looksLikeEcho ni
      // looksLikeRefusal lo detectan (no es copia literal, la respuesta
      // no es corta), y el resto del contenido era un analisis real y
      // bueno. Se recorta solo la linea de apertura filtrada en vez de
      // rechazar un analisis completo que costo minutos generar.
      step.result = stripLeakedPreamble(out.text);
      step.model = out.model;
      step.provider = out.provider;
      step.latencyMs = out.latencyMs;
      step.log = 'OK · ' + out.model + ' · ' + out.latencyMs + 'ms';
      results[step.id] = out.text;
      step.trace = out.trace || [];
      // Bug real, confirmado en vivo (2026-08-03): executeStep() ya
      // construye out.ensemble con el desglose completo (round1 vs
      // round2, revisado o no, modelos que votaron) cuando el paso
      // ensambla de verdad -- pero nunca se copiaba a `step`, asi que se
      // perdia aqui mismo y la respuesta final de runOrchestration() no
      // tenia forma de saber que un ensemble habia ocurrido. Se usa
      // `ensembleInfo` (no `ensemble`, que ya es el flag booleano de si
      // este paso DEBE intentar ensemble) para no pisarlo.
      step.ensembleInfo = out.ensemble || null;
      recordCompletedWork(
        { label: step.label, desc: step.desc, category: step.category },
        { query: query, resultPreview: out.text, source: 'orchestrator', sessionId: runSessionId }
      );
      modelsUsed.push({
        subtask: step.label,
        model: out.model,
        provider: out.provider,
        openSource: out.openSource,
        requestedCategory: out.requestedCategory,
        trace: out.trace || [],
      });
      logs.push({
        t: Date.now(),
        level: 'ok',
        text: step.label + ' → ' + out.model + ' (' + out.provider + ') · ' + out.latencyMs + 'ms',
      });
      (out.trace || []).forEach(function (t) {
        if (t.status === 'ok') return;
        logs.push({ t: t.at, level: 'info', text: '   ' + t.tier + ': ' + t.status + ' — ' + t.detail });
      });

      // Rastro de razonamiento: si este paso fue ensemble, narrar EN VIVO
      // por que se eligieron esas familias y cuanto trabajo hizo el
      // traductor -- datos que ya se calculaban pero se quedaban enterrados
      // en el objeto de retorno, sin que nadie los viera hasta el final.
      if (out.ensemble) {
        var reasoningLines = [];
        if (out.ensemble.selectionExplanation) reasoningLines.push(out.ensemble.selectionExplanation);
        reasoningLines.push(
          out.ensemble.realSize + '/' + out.ensemble.requestedSize + ' modelos respondieron' +
          (out.ensemble.independent ? ' (independientes: cada voto de una familia distinta)' : ' (aviso: no todos los votos son independientes)') +
          '.'
        );
        if (out.ensemble.crossStyleTranslations > 0) {
          reasoningLines.push(out.ensemble.crossStyleTranslations + ' respuestas se reexpresaron a un estilo de pensamiento distinto al del receptor antes de la ronda de revisión -- sin eso se habrian leido mal o perdido.');
        }
        if (out.ensemble.contradictions > 0) {
          reasoningLines.push(out.ensemble.contradictions + ' contradicciones detectadas entre respuestas, resueltas por confianza calibrada.');
        }
        if (out.ensemble.degraded) {
          reasoningLines.push('AVISO: el pipeline open source no pudo ejecutarse; esta respuesta viene de la cascada de proveedores de reserva, no del ensemble real.');
        }
        emit(onProgress, {
          type: 'step_reasoning',
          step: step,
          reasoning: reasoningLines,
          message: reasoningLines.join(' '),
          plan: plan,
          logs: logs.slice(),
        });
        logs.push({ t: Date.now(), level: 'info', text: '   Razonamiento: ' + reasoningLines.join(' ') });
      }

      emit(onProgress, {
        type: 'step_done',
        step: step,
        message: 'Completado: ' + step.label + ' → ' + out.model + ' (' + out.provider + ')',
        plan: plan,
        trace: out.trace || [],
        logs: logs.slice(),
      });
    } catch (err) {
      step.status = 'error';
      step.result = '';
      step.log = String((err && err.message) || err);
      logs.push({ t: Date.now(), level: 'error', text: step.label + ' falló: ' + step.log });
      emit(onProgress, {
        type: 'step_error',
        step: step,
        message: 'Error en ' + step.label + ': ' + step.log,
        plan: plan,
        logs: logs.slice(),
      });
    }
  }

  var totalMs = Date.now() - startedAt;

  // Bug real, severo (2026-08-12): esto usaba (s.driver && s.driver.name)
  // primero -- s.driver viene de pickDriver(), que elige una entrada del
  // catalogo ELO INVENTADO de ai-registry.js (numeros fabricados, ningun
  // benchmark real detras). El modelo que de verdad respondio ya esta en
  // s.model (out.model real, asignado tras la ejecucion, linea ~671) --
  // pero se ignoraba a favor de una marca ficticia ("GPT 5.6 Sol", "Claude
  // Fable 5"...) que nunca toco la query. Esa atribucion falsa no solo se
  // mostraba al usuario: se pasaba a coordinate() y logConsensusEvent()
  // como si fueran IAs reales participando en la deteccion de
  // contradicciones. Se usa el modelo real ejecutado, nunca el del catalogo.
  var agentOutputs = plan.subtasks.filter(function (s) { return s.status === 'completed' && s.result; }).map(function (s, i) {
    return { agent: s.model || s.ai || 'agent-' + i, content: s.result };
  });

  var coordResult = null;
  if (agentOutputs.length > 1) {
    emit(onProgress, { type: 'middleware_start', message: 'LinkCore coordina ' + agentOutputs.length + ' agentes: detectando contradicciones y compartiendo memoria...', plan: plan, logs: logs.slice() });
    try {
      coordResult = await coordinate(agentOutputs, {
        onProgress: function(evt) { emit(onProgress, { type: 'middleware_' + evt.type, message: evt.message, plan: plan, logs: logs.slice() }); },
      });
      logConsensusEvent({ type: 'orchestrator_coordinate', agents: agentOutputs.map(function(o) { return o.agent; }), contradictionCount: coordResult.contradictions.length, resolution: coordResult.mediation && coordResult.mediation.resolved ? 'mediated' : 'clean' });
    } catch(coordErr) {
      console.error('[LinkCore] Middleware coordination error:', coordErr);
    }
  }

  // Bug real, severo, confirmado en una corrida E2E en vivo (2026-08-02):
  // plan.subtasks es SIEMPRE una tuberia SECUENCIAL (metodologia -> lote ->
  // ensamblado en deep-planner.js; planificar -> redactar -> pulir en las
  // plantillas planas de task-decomposer.js) -- nunca votos PARALELOS
  // independientes respondiendo la MISMA pregunta. coordinate() esta
  // diseñado para lo segundo: comparar N respuestas a una misma pregunta y
  // detectar si se contradicen entre si. Aplicado aqui, comparaba el
  // esquema de metodologia contra el documento final ensamblado -- textos
  // DISTINTOS por diseño, sobre la MISMA tarea pero en etapas distintas del
  // pipeline, no dos opiniones en desacuerdo -- y disparaba contradicciones
  // falsas en masa (verificado en vivo: 38 "contradicciones" entre solo 3
  // pasos de una tuberia). Peor aun: si coordinate() decidia que el
  // esquema de metodologia tenia mas confianza calibrada que el documento
  // final, SUSTITUIA la respuesta real (el documento que el usuario pidio)
  // por el esquema intermedio, sin aviso -- y la alternativa (synthesize()
  // de este archivo) tampoco servia: trunca el resultado de cada paso a
  // 400 caracteres en un reporte de proceso, perdiendo el documento
  // completo que deep-planner.js explicitamente dice que el ultimo paso
  // debe entregar ("Listo para entregar, no un resumen del proceso
  // seguido"; las plantillas planas de task-decomposer.js igual: siempre
  // terminan en un paso de pulido/entrega). La respuesta real es el
  // resultado COMPLETO, sin truncar, del ultimo paso completado -- ni una
  // sustitucion por "consenso" entre etapas que no son comparables, ni un
  // resumen truncado del proceso. coordinate() se conserva arriba por su
  // valor real de infraestructura (memoria compartida entre pasos,
  // auditoria via logConsensusEvent, deteccion de drift) pero ya no decide
  // cual es la respuesta final.
  var lastCompletedStep = null;
  for (var lsi = plan.subtasks.length - 1; lsi >= 0; lsi--) {
    if (plan.subtasks[lsi].status === 'completed' && plan.subtasks[lsi].result) {
      lastCompletedStep = plan.subtasks[lsi];
      break;
    }
  }
  var response = lastCompletedStep ? lastCompletedStep.result : synthesize(plan, modelsUsed, totalMs);

  // Validación G-STACK: solo para planes de trabajo profundo (deep-planner.js).
  // gstack.js existia completo y fiel al repo real desde antes, pero NINGUN
  // camino de ejecución lo llamaba -- un subsistema entero construido y
  // desconectado. 'quickReview' (Reviewer -> QA Lead) es el workflow pensado
  // para "cambios que ya existen" en vez de planificacion, que es justo lo
  // que hay aqui: un documento ya ensamblado que hay que auditar antes de
  // entregarlo. No se ejecuta en el resto de planes (coste/tiempo -- una
  // tarea corta no necesita dos rondas de revisión extra de gstack).
  var gstackVerdict = null;
  if (plan.taskType === 'deep-work' && response) {
    emit(onProgress, { type: 'gstack_start', message: 'Validando el documento ensamblado con G-STACK (Reviewer → QA Lead)...', plan: plan, logs: logs.slice() });
    try {
      var gResult = await runGStackWorkflow('quickReview', response.slice(0, 4000), { maxTokens: 1200 });
      if (gResult && !gResult.error) {
        gstackVerdict = {
          workflow: gResult.workflow,
          steps: gResult.steps.map(function (s) { return { role: s.roleName, output: s.output, model: s.model, family: s.family }; }),
          finalOutput: gResult.finalOutput,
          reviewedPreviewOnly: response.length > 4000,
        };
        logs.push({ t: Date.now(), level: 'ok', text: 'G-STACK (' + gResult.workflow + '): ' + gResult.steps.map(function(s){return s.roleName;}).join(' → ') + ' completado' + (gstackVerdict.reviewedPreviewOnly ? ' (revisado sobre los primeros 4000 caracteres, el documento completo es mas largo)' : '') });
      }
    } catch (gErr) {
      logs.push({ t: Date.now(), level: 'error', text: 'G-STACK fallo: ' + ((gErr && gErr.message) || gErr) });
    }
    emit(onProgress, {
      type: 'gstack_done',
      gstackVerdict: gstackVerdict,
      message: gstackVerdict ? 'G-STACK completado: ' + gstackVerdict.steps.map(function(s){return s.role;}).join(' → ') : 'G-STACK no disponible para este plan.',
      plan: plan,
      logs: logs.slice(),
    });
  }

  emit(onProgress, {
    type: 'done',
    plan: plan,
    message: 'LinkCore coordinó ' + modelsUsed.length + ' IAs' + (coordResult && coordResult.contradictions.length ? ' · ' + coordResult.contradictions.length + ' conflictos detectados' : ' · sin conflictos') + ' · ' + totalMs + 'ms' + (gstackVerdict ? ' · validado por G-STACK' : ''),
    middleware: coordResult ? { contradictions: coordResult.contradictions.length, resolutions: coordResult.resolutions.length, drift: coordResult.drift } : null,
    logs: logs.slice(),
  });

  return {
    response: response,
    decomposed: true,
    decompositionLabel: plan.label,
    decompositionSector: plan.sector,
    narrative: plan.narrative,
    middleware: coordResult,
    // El ensemble del paso que de verdad produjo `response` (mismo
    // criterio "ultimo paso completado" que arriba) -- sin esto el CLI
    // (bin/linkcore-cli.js, que lee d.ensemble.round2 para mostrar "IAs
    // consultadas" y el desglose por modelo) no tenia forma de saber que
    // un ensemble real habia ocurrido dentro del orquestador.
    ensemble: lastCompletedStep ? lastCompletedStep.ensembleInfo : null,
    gstackVerdict: gstackVerdict,
    steps: plan.subtasks.map(function (st) {
      return {
        id: st.id,
        label: st.label,
        desc: st.desc,
        ai: st.model || st.ai,
        category: st.category,
        status: st.status,
        driver: st.driver,
        provider: st.provider,
        latencyMs: st.latencyMs,
        result: st.result,
      };
    }),
    modelsUsed: modelsUsed,
    plan: plan,
    logs: logs,
    totalLatencyMs: totalMs,
    driver: modelsUsed[0] ? { model: modelsUsed[0].model, local: false } : null,
    sector: plan.sector,
  };
}

// Señales de que el usuario pide algo BREVE. Son un veto, no un peso: si
// alguien escribe "explica en 3 frases que es X", ha dicho explicitamente
// el tamaño de la respuesta que quiere, y montar un pipeline de 4 pasos
// (busqueda + multimodal + razonamiento + reporte) con varios modelos y
// minutos de espera es ignorar la peticion, no cumplirla.
//
// Bug real reportado en vivo (2026-07-29): "Explica en 3 frases que es el
// ensemble learning" disparaba 6 pasos, porque `\bexplica\b` esta en el
// trigger de investigación-profunda y ademas runCrew() se sumaba al tener
// mas de 2 subtareas. El keyword decidia solo, sin mirar que la misma
// frase acotaba el alcance dos palabras despues.
var BREVITY_VETO = /\ben\s+\d+\s+(frases?|palabras?|lineas?|l[ií]neas?|puntos?|bullets?)\b|\bbrevemente\b|\ben\s+resumen\b|\bresumido\b|\bcorto\b|\ben\s+una\s+(frase|linea|l[ií]nea)\b|\bsin\s+rollo\b|\bal\s+grano\b|\bin\s+\d+\s+(sentences?|words?|lines?|bullets?)\b|\bbriefly\b|\bshort\s+answer\b|\bone\s+(sentence|line)\b|\btl;?dr\b/i;

export function shouldOrchestrate(query) {
  if (!query || query.trim().length < 2) return false;
  if (/^(hola|hey|hi|hello|buenas|qué tal|que tal)\b/i.test(query.trim())) return false;
  if (BREVITY_VETO.test(query)) return false;
  // Bug real reportado en vivo (2026-07-28): el umbral de longitud aqui
  // (40) era MAS bajo que el que ya tiene isComplexTask() (80, ahora 200
  // -- ver su cabecera), asi que este por si solo bastaba para mandar
  // CUALQUIER mensaje de mas de 40 caracteres al pipeline completo de
  // orquestacion (varios pasos, varios modelos, minutos de duracion) en
  // vez de una respuesta directa. Practicamente ninguna frase normal se
  // libraba. Subido al mismo umbral que isComplexTask() para que ambos
  // digan lo mismo, en vez de que el mas permisivo de los dos decida.
  return isComplexTask(query) || !!detectTaskType(query) || query.trim().length > 200;
}

export { enrichPlan, pickDriver, buildPrompt };
