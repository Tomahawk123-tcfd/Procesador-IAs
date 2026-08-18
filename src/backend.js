import os from 'node:os';
import * as T from './tools.js';
import { isComplexTask } from './task-decomposer.js';
import { runOrchestration, shouldOrchestrate } from './engine/orchestrator.js';
import { buildContextPacket, translateForModel, detectThinkingStyle } from './engine/semantic-translator.js';
import { looksLikeContextLeak, looksLikeEcho, looksLikeRepetitiveGarbage, looksLikeRefusal, looksLikeTopicMismatch } from './engine/translation.js';
import { chipPreFlight, circuitRecordSuccess, circuitRecordFailure, circuitIsOpen, cacheGet, cacheSet, finalCacheGet, finalCacheSet, chipEventRecord } from './engine/chip-core.js';
import { routeQuery, recordOutcome } from './engine/smart-router.js';
import { ensembleRun } from './engine/ensemble-v2.js';
import { recordDecision, mctsUpdate } from './engine/neural-decision-engine.js';
import { verifyCalculations } from './engine/math-verify.js';
import { SemanticCache } from './engine/semantic-cache.js';

// Caché semántico (2026-08-11): complementa a finalCacheGet/finalCacheSet
// (exacta). Solo se consulta en el camino de ensemble normal -- nunca
// antes de Crew/orquestador/MCP, donde una "pregunta parecida" no implica
// la misma entrega (una app parecida no es la misma app). Umbral y
// guardas deterministas calibrados en vivo, ver semantic-cache.js.
var semanticCache = new SemanticCache({ threshold: 0.90, maxSize: 500 });
import { verifyCodeBlocks } from './engine/code-verify.js';
import { verifyComparisons } from './engine/coherence-verify.js';
import { computeContentConfidence } from './engine/translation.js';
import { recordQuery as learningRecord, recordCollaboration } from './engine/learning-loop.js';
import { getContextSummary, addJournalEntry, extractEntities, graphReport } from './memory-bus.js';
import { callKimiK3, kimiOrchestrate, isKimiAvailable } from './engine/kimi-k3.js';
import { runCrew, detectDeliverableType } from './engine/crew.js';
import { applyDeterministicVerification } from './engine/verification-pipeline.js';
import { runIntermediationCore } from './engine/intermediation-core.js';
import { buildProcessorPacket } from './engine/processor-packet.js';

const AI = '../assets/ai/';
const WORKER_ORIGIN = 'https://x1-proxy.calezamindset.workers.dev';
const PROXY_SECRET = process.env.LINKCORE_PROXY_SECRET || '';

// Limpieza (2026-08-16, carpeta separada solo-procesador): deployVercelShared
// y generateV0UI se eliminan aqui -- funciones de "haz cosas por mi cuenta"
// (desplegar en Vercel, generar UI con v0) propias del antiguo asistente,
// sin relacion con la intermediacion/verificacion/ensemble del procesador.
// Confirmado con grep: ningun consumidor real del procesador las llama.

var MCP_AGENTS = [
  { id: 'mcp-context7',    name: 'Context7',    category: 'docs',     color: '#6366f1', letter: 'C7', tools: ['resolve-library-id', 'query-docs'] },
  { id: 'mcp-github',      name: 'GitHub',      category: 'devops',   color: '#24292e', letter: 'GH', tools: ['repos', 'issues', 'PRs', 'branches', 'search'] },
  { id: 'mcp-october',     name: 'Oct. Themes', category: 'design',   color: '#f59e0b', letter: 'OT', tools: ['get_theme', 'get_theme_by_id'] },
  { id: 'mcp-firecrawl',   name: 'Firecrawl',   category: 'research', color: '#ef4444', letter: 'FC', tools: ['scrape', 'search', 'crawl', 'extract'] },
  { id: 'mcp-cf-docs',     name: 'CF Docs',     category: 'devops',   color: '#f6821f', letter: 'CD', tools: ['search_docs'] },
  { id: 'mcp-cf-builds',   name: 'CF Builds',   category: 'devops',   color: '#f6821f', letter: 'CB', tools: ['list_builds', 'get_build'] },
  { id: 'mcp-cf-bindings', name: 'CF Bindings', category: 'devops',   color: '#f6821f', letter: 'CN', tools: ['list_bindings', 'get_binding'] },
  { id: 'mcp-cf-obs',      name: 'CF Obs',      category: 'devops',   color: '#f6821f', letter: 'CO', tools: ['list_logs', 'get_metrics'] },
  { id: 'mcp-clickhouse',  name: 'ClickHouse',  category: 'data',     color: '#ffcc00', letter: 'CH', tools: ['query', 'list_databases', 'list_tables'] },
  { id: 'mcp-vercel',      name: 'Vercel',      category: 'devops',   color: '#000',    letter: 'VC', tools: ['list_projects', 'deploy', 'get_deployment'] },
  { id: 'mcp-qdrant',      name: 'Qdrant',      category: 'memory',   color: '#10b981', letter: 'QD', tools: ['store', 'find', 'delete', 'list_collections'] },
  { id: 'mcp-filesystem',  name: 'Filesystem',  category: 'files',    color: '#8b5cf6', letter: 'FS', tools: ['read_file', 'write_file', 'list_directory', 'search'] },
  { id: 'mcp-memory',      name: 'Memory',      category: 'memory',   color: '#06b6d4', letter: 'MG', tools: ['entities', 'relations', 'observations', 'search'] },
  { id: 'mcp-fetch',       name: 'Fetch',       category: 'research', color: '#14b8a6', letter: 'FT', tools: ['fetch_url'] },
  { id: 'mcp-git',         name: 'Git',         category: 'devops',   color: '#f97316', letter: 'GT', tools: ['log', 'diff', 'blame', 'status'] },
  { id: 'mcp-seqthink',    name: 'Seq. Think',  category: 'thinking', color: '#a855f7', letter: 'ST', tools: ['sequential_thinking'] },
  { id: 'mcp-cognee',      name: 'Cognee',      category: 'memory',   color: '#ec4899', letter: 'CG', tools: ['remember', 'recall', 'forget'] },
  { id: 'mcp-serena',      name: 'Serena',      category: 'code',     color: '#3b82f6', letter: 'SR', tools: ['search_code', 'edit_code', 'find_references'] },
];

// Prompts de sistema por sector — cada uno describe un rol + modelo open-source diferente.
const SECTOR_PROMPTS = {
  developer: 'Eres un arquitecto de software experto. Responde EN ESPAÑOL con ejemplos de codigo funcionales, buenas practicas y explicaciones claras. Usa `codigo` para bloques, **negrita** para conceptos clave.',
  writer: 'Eres un escritor profesional. Responde EN ESPAÑOL con textos fluidos, bien estructurados y adaptados al tono solicitado. Usa **negrita** para titulos, listas para enumerar. Crea contenido original de alta calidad literaria.',
  research: 'Eres un investigador experto. Responde EN ESPAÑOL con informacion estructurada, datos precisos y referencias. Usa **negrita** para terminos clave, listas para clasificar, y proporciona contexto profundo.',
  marketing: 'Eres un estratega de marketing. Responde EN ESPAÑOL con analisis de mercado, estrategias accionables y metricas. Usa **negrita** para KPIs, listas para canales y acciones.',
  finance: 'Eres un analista financiero. Responde EN ESPAÑOL con datos numericos precisos, tendencias y riesgos. Usa **negrita** para cifras clave y terminos financieros.',
  legal: 'Eres un asesor legal. Responde EN ESPAÑOL con lenguaje juridico claro, citando clausulas y estructuras contractuales. Usa **negrita** para terminos legales importantes.',
  email: 'Eres un ejecutivo de cuentas. Responde EN ESPAÑOL con correos profesionales, claros y efectivos. Estructura: asunto, saludo, cuerpo, despedida.',
  meeting: 'Eres un asistente ejecutivo. Responde EN ESPAÑOL con agendas de reunion, resumenes ejecutivos y seguimiento de accion. Usa **negrita** para roles y fechas.',
};

export const AGENTS = [
  { id: 'research',   name: 'Research',   ai: 'Gemini',      repo: 'google/gemini',         aiIcon: AI + 'googlegemini.svg',  color: '#4285f4' },
  { id: 'writer',     name: 'Writer',     ai: 'Llama 4',     repo: 'meta/llama',            aiIcon: AI + 'anthropic.svg',     color: '#d97706' },
  { id: 'developer',  name: 'Developer',  ai: 'Qwen3 Coder', repo: 'QwenLM/Qwen',           aiIcon: AI + 'openai.svg',         color: '#10a37f' },
  { id: 'marketing',  name: 'Marketing',  ai: 'Nemotron',    repo: 'nvidia/nemotron',       aiIcon: AI + 'googlegemini.svg',  color: '#4285f4' },
  { id: 'finance',    name: 'Finance',    ai: 'GLM 5.1',     repo: 'THUDM/GLM-5',           aiIcon: AI + 'anthropic.svg',     color: '#d97706' },
  { id: 'legal',      name: 'Legal',      ai: 'Mistral',     repo: 'mistralai/mistral',     aiIcon: AI + 'mistralai.svg',     color: '#ff7000' },
  { id: 'email',      name: 'Email',      ai: 'Llama 3.3',   repo: 'meta/llama',            aiIcon: AI + 'meta.svg',          color: '#0668e1' },
  { id: 'meeting',    name: 'Meeting',    ai: 'Gemini',      repo: 'google/gemini',         aiIcon: AI + 'googlegemini.svg',  color: '#4285f4' }
];

export function agentById(id) {
  return AGENTS.find(a => a.id === id) || AGENTS[0];
}

export function getBestAgent(query) {
  const t = query.toLowerCase();
  if (/codigo|code|programa|funcion|componente|react|debug|script|api|html|css|bug|error/.test(t)) return 'developer';
  if (/email|correo|gmail|mensaje|redacta/.test(t)) return 'email';
  if (/reunion|meeting|calendario|agenda/.test(t)) return 'meeting';
  if (/marketing|ventas|campana|seo/.test(t)) return 'marketing';
  if (/finanzas|inversion|budget|dinero|stock/.test(t)) return 'finance';
  if (/legal|contrato|ley/.test(t)) return 'legal';
  if (/escribir|texto|articul|blog|contenido|documento|\bdoc\b|informe|carta|resume|resumen|ensayo|guion|guión|presentacion|presentación|slide|crea|genera|redacta/.test(t)) return 'writer';
  return 'research';
}

var SECTOR_BY_AGENT = {
  developer: 'Desarrollo', email: 'Comunicacion', meeting: 'Reuniones',
  marketing: 'Marketing', finance: 'Finanzas', legal: 'Legal',
  writer: 'Redaccion', research: 'Investigacion'
};

export function detectSector(query) { return SECTOR_BY_AGENT[getBestAgent(query)] || 'Investigacion'; }
export function sectorForAgent(agentId) { return SECTOR_BY_AGENT[agentId] || 'Investigacion'; }

// getJudgeReason() (registro estatico "Arena AI"/"Cloudflare Worker
// cascada de 235 IAs") se elimino aqui el 2026-08-11: nunca ejecutaba
// nada, solo generaba una narrativa inventada que se mostraba al usuario
// como si describiera el modelo real que respondio -- confirmado en vivo,
// ver el judgeReason real construido mas abajo a partir de aiResult.

const GREETINGS = /^(hola|buenas|hey|hi|hello|que tal|como estas|buen[ao]s|saludos|gracias|ok|vale|perfecto|chao|adios|bye|buenos dias|buenas tardes|buenas noches|que onda|que hay|que pas|whats up|sup|hey|xup|yep|nope|si|no|dale|vamos|genial|increible|bien|mal|regular|mas o menos|asi asi|comprendo|entendido|entiendo|perfecto|excelente|genial|fantastico|maravilloso|ok then|cool|nice|good|bad|fine|great|awesome|amazing|hello there|good morning|good afternoon|good evening)$/i;
function isGreeting(q) { return GREETINGS.test(q.trim()); }


// Registro real de la cascada: que nivel se intento, si respondio y por que
// fallo. Lo consume la UI para explicar el despacho sin inventar datos.
function traceAdd(trace, tier, status, detail) {
  if (!trace) return;
  trace.push({ tier: tier, status: status, detail: detail, at: Date.now() });
}

// Puente IPC opcional de la aplicación de escritorio. Está aislado del
// procesador local y conserva un timeout corto para no bloquear el camino
// principal cuando la integración de escritorio no está disponible.
async function tryIPCProxy(messages, maxTokens, temperature, startedAt, trace) {
  var ai = typeof window !== 'undefined' && window.linkcoreAI;
  if (!ai || !ai.proxy) {
    traceAdd(trace, 'proxy-ipc', 'skipped', 'No disponible (solo existe dentro de la app de escritorio)');
    return null;
  }
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 3000);
    var result = await Promise.race([
      ai.proxy({ messages: messages, max_tokens: maxTokens, temperature: temperature }),
      new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 3000); })
    ]);
    clearTimeout(timer);
    if (result && result.choices && result.choices[0]) {
      var text = (result.choices[0].message && result.choices[0].message.content || '').trim();
      if (text) {
        var ipcOut = { text: text, model: result.model || 'desconocido', provider: result.x_provider || 'proxy', latencyMs: Date.now() - startedAt };
        traceAdd(trace, 'proxy-ipc', 'ok', (ipcOut.model || 'modelo desconocido') + ' via ' + ipcOut.provider);
        return ipcOut;
      }
    }
    traceAdd(trace, 'proxy-ipc', 'failed', 'Respuesta vacia del proxy IPC');
  } catch (e) {
    traceAdd(trace, 'proxy-ipc', 'failed', e && e.message === 'timeout' ? 'Timeout a los 3s' : (e && e.message) || 'error');
  }
  return null;
}


// El backend no contiene claves de inferencia ni una cascada remota de IA.
// El camino principal del procesador selecciona y ejecuta modelos locales.
// ── Seleccion del mejor repo open source, bajo demanda ────────────────
// Sin cache: el usuario pidio explicitamente que el proceso sea bajo
// demanda, es decir, que cada peticion consulte el catalogo real en vivo
// en vez de reutilizar una eleccion anterior. Tiene un coste real medido
// (~2-4s de busqueda por el rastreo amplio del catalogo, ver
// crawlCatalogBroad en hf-intermediation.js) incluso para respuestas
// cortas como un saludo -- es la contrapartida honesta de esa exigencia,
// no un descuido de rendimiento.
// Bug real (2026-07-31), encontrado reproduciendo un plan de 6 pasos:
// cada paso llamaba a esta funcion sin memoria de que familia ya se uso
// EN ESTE MISMO RUN, y como la seleccion es determinista (siempre el
// primer elegible), los 6 pasos elegian el mismo modelo (llama3.2:1b)
// seis veces -- "6 agentes consultados" que en realidad eran una sola
// voz repetida con distintos disfraces de rol. Eso no reduce error de
// nada: ensemble learning exige errores independientes entre
// participantes, no el mismo modelo hablando consigo mismo. `excludeFamilies`
// deja que quien llama (executeStep en crew.js) acumule que familias ya
// respondieron en este run y pida una distinta la proxima vez.
// Bug real, encontrado en vivo (2026-08-11) reproduciendo "Crea una app
// web de lista de tareas" por el camino real de crew.js: el paso del
// Desarrollador (categoria 'code') usaba qwen2.5:1.5b -- un modelo
// GENERICO que solo lista 'code' como una categoria mas entre varias --
// en vez de qwen2.5-coder:7b, ya instalado y especializado en codigo,
// porque selectDiverseOllama() prueba el tier 'small' antes que 'medium'
// por defecto (mas rapido, correcto para texto/razonamiento). El
// resultado real: el modelo de 1.5B nunca llego a escribir codigo, solo
// describio un arbol de carpetas hipotetico -- y los pasos siguientes
// (Analista, Diseñador), sin codigo real que revisar, alucinaron un
// backend con base de datos que nadie pidio. selectDiverseOllama() YA
// soporta opts.minTier:'medium' para invertir ese orden, pero ninguna
// capa intermedia lo dejaba pasar hasta aqui -- se añade como parametro
// explicito, no activado por defecto (mantiene la velocidad para
// categorias donde un modelo pequeño basta).
async function pickBestOpenSourceModel(query, category, excludeFamilies, minTier) {
  var hfMod = await import('./engine/hf-intermediation.js');
  var cat = category || hfMod.detectCategory(query);
  var exclude = excludeFamilies || [];

  var ollamaMod = await import('./engine/ollama-catalog.js');
  var ollamaSelection = await ollamaMod.intermediateOllama(query, { size: 1, category: cat, excludeFamilies: exclude, preferCapability: true, minTier: minTier });
  // Fuga remota real, encontrada auditando con la regla de Zen "ningun CCD
  // habla con el exterior por su cuenta, todo pasa por el IOD" (2026-08-12):
  // si el modelo elegido NO estaba instalado pero tenia hfId, esta funcion
  // devolvia providerHint:'huggingface' -- una llamada de red a
  // huggingface.co desde el camino PRINCIPAL de callAI(). Es exactamente la
  // misma fuga que ya se cerro en smart-router.js#routeQuery() el
  // 2026-08-11, pero alli se cerro solo en esa funcion; esta, que es la que
  // usa de verdad el camino principal, se quedo abierta. Alcanzable:
  // selectDiverseOllama() incluye modelos NO instalados en la lista (solo
  // los ordena al final), asi que basta con que las familias instaladas
  // queden excluidas para que se cuele uno remoto.
  // LinkCore es 100% local por decision explicita y repetida del usuario:
  // si no hay pieza local, se devuelve null y el llamador degrada de forma
  // visible, nunca se sale a la red sin pedirlo.
  if (ollamaSelection.ok && ollamaSelection.selected.length) {
    var picked = ollamaSelection.selected[0];
    if (picked.installed) {
      picked.providerHint = 'ollama';
      return picked;
    }
  }

  if (exclude.length) {
    var retrySelection = await ollamaMod.intermediateOllama(query, { size: 1, category: cat, excludeFamilies: [], preferCapability: true, minTier: minTier });
    if (retrySelection.ok && retrySelection.selected.length) {
      var retryPicked = retrySelection.selected[0];
      if (retryPicked.installed) {
        retryPicked.providerHint = 'ollama';
        return retryPicked;
      }
      // Misma fuga que arriba, en el camino de reintento: cerrada igual.
    }
  }

  // Fallback remoto a HuggingFace ELIMINADO (2026-08-12, misma auditoria):
  // esto llamaba a hfMod.intermediate() -> huggingface.co por red, y
  // devolvia providerHint:'huggingface' de forma incondicional cuando no
  // habia pieza local elegible. Era la tercera fuga de esta misma funcion
  // (las otras dos: providerHint 'huggingface' por hfId en el camino
  // principal y en el de reintento). LinkCore es 100% local por decision
  // explicita y repetida del usuario -- devolver null hace que el llamador
  // degrade de forma VISIBLE (trace 'open-source: skipped', luego el
  // fallback de modelos Ollama instalados de mas abajo), en vez de salir a
  // la red en silencio. El modulo hf-intermediation.js se sigue usando solo
  // para detectCategory(), que es puro texto y no toca la red.
  return null;
}

// ── Registro de piezas: LinkCore es el procesador, no una IA (decision de
// arquitectura del usuario, 2026-08-12) -- dispatcha a la pieza que
// corresponda, no responde el mismo. Antes esto era un ternario inline en
// callAI() (providerHint === 'ollama' ? callOllamaModel : ...); las tres
// funciones ya compartian la misma forma -- (modelId, query, opts) ->
// {ok, text, model, provider, latencyMs} -- sin que hubiera un punto unico
// que lo dejara explicito. Añadir una pieza nueva (otro backend de IA) es
// darle una entrada aqui con esa misma forma; el resto del pipeline
// (ensemble, verificacion, sintesis) no cambia.
var PROVIDER_REGISTRY = {
  ollama: callOllamaModel,
  cloudflare: callCFAIModel,
  huggingface: callHFModel, // default si no hay providerHint
};
function resolveProvider(providerHint) {
  return PROVIDER_REGISTRY[providerHint] || PROVIDER_REGISTRY.huggingface;
}

// ── Camino por defecto de TODA la app: repos open source ejecutados como
// servicio, cero espacio en disco.
//
// El orden importa y es deliberado. Antes esta funcion empezaba por Ollama
// local (descarga GB al disco) y seguia por la cascada de proveedores del
// Worker; ahora empieza por el catalogo open source, que es lo que el
// producto dice ser. La cascada del Worker queda SOLO como degradacion
// cuando el catalogo o el token no estan disponibles -- y se marca como
// tal en el trace, para que la UI nunca presente una respuesta de la
// cascada como si viniera del pipeline open source. ──
export async function callAI(query, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  var maxTokens = opts.maxTokens || 2000;
  var messages = [
    { role: 'system', content: opts.systemPrompt || 'Responde EN ESPAÑOL de forma clara y util. Nunca digas tu nombre ni te identifiques como una marca o producto concreto.' },
    { role: 'user', content: query }
  ];
  var temperature = opts.temperature || 0.1;
  var category = opts.category || null;
  var trace = [];

  // Presupuesto global (2026-08-14): mismo reloj que ORCHESTRATION_GLOBAL_
  // BUDGET_MS en orchestrator.js -- si ya se agoto antes de llegar aqui, ni
  // el intento principal merece la pena, directo al trace honesto.
  if (opts.deadlineTs && Date.now() > opts.deadlineTs) {
    traceAdd(trace, 'open-source', 'skipped', 'presupuesto global de tiempo ya agotado antes de intentar');
    return null;
  }

  // 1) Repo open source elegido por la intermediacion, ejecutado sin
  // descargarlo. Camino principal.
  if (opts.openSourceFirst !== false) {
    try {
      var best = await pickBestOpenSourceModel(query, category, opts.excludeFamilies, opts.minTier);
      if (best) {
        var caller = resolveProvider(best.providerHint);
        var hf = await caller(best.id, query, {
          systemPrompt: opts.systemPrompt, maxTokens: maxTokens,
          temperature: temperature, timeoutMs: opts.timeoutMs,
        });
        // Bug real, critico, reproducido en vivo (2026-08-03): un modelo
        // pequeño puede devolver el bloque de contexto interno inyectado
        // en su propio system prompt (buildContextBlock) en vez de
        // contestar -- esto vivia ya detectado dentro del ensemble
        // (ensemble-v2.js) pero NO aqui, el camino de "un solo modelo"
        // que smartQuery usa cuando el ensemble entero falla. Sin este
        // chequeo, la fuga se colaba precisamente en el camino de
        // ultimo recurso, cuando menos margen hay para que otra cosa la
        // corrija despues.
        if (hf && hf.ok && !looksLikeContextLeak(hf.text)) {
          traceAdd(trace, 'open-source', 'ok', best.id + ' (' + best.family + ', ' + best.license + ') en ' + hf.latencyMs + 'ms');
          return {
            text: hf.text, model: hf.model, provider: hf.provider,
            latencyMs: hf.latencyMs, openSource: true,
            family: best.family, lab: best.lab, license: best.license,
            hub: best.hub, github: best.github, trace: trace,
          };
        }
        traceAdd(trace, 'open-source', 'failed', best.id + ': ' + (hf && hf.ok && looksLikeContextLeak(hf.text) ? 'fuga de contexto detectada' : (hf && hf.error) || 'sin respuesta'));
      } else {
        traceAdd(trace, 'open-source', 'skipped', 'La intermediacion no devolvio ningun repo elegible');
      }
    } catch (e) {
      traceAdd(trace, 'open-source', 'error', (e && e.message) || 'error desconocido');
    }
  }

  // 2) IPC proxy (Electron, si el main process expone window.linkcoreAI.proxy)
  var r = await tryIPCProxy(messages, maxTokens, temperature, startedAt, trace);
  if (r) { r.trace = trace; r.degraded = true; return r; }

  // 3) Kimi K3 fallback: si esta configurado, usar como respaldo
  if (isKimiAvailable()) {
    try {
      var kimiResult = await callKimiK3(query, { systemPrompt: opts.systemPrompt, maxTokens: maxTokens, temperature: temperature });
      if (kimiResult && kimiResult.ok) {
        traceAdd(trace, 'kimi-k3', 'ok', 'Kimi K3 en ' + kimiResult.latencyMs + 'ms');
        return { text: kimiResult.text, model: kimiResult.model, provider: kimiResult.provider, latencyMs: kimiResult.latencyMs, trace: trace };
      }
    } catch (e) {
      traceAdd(trace, 'kimi-k3', 'error', e.message);
    }
  }

  // 5) Fallback: intentar cualquier modelo Ollama instalado antes de rendir.
  //    Si el camino principal falló (intermediación + proxy), al menos
  //    intentamos con un modelo local que sepamos que existe.
  try {
    var ollamaMod = await import('./engine/ollama-catalog.js');
    var allInstalled = ollamaMod.OLLAMA_MODELS.filter(function(m) { return m.installed && m.id.indexOf('embed') === -1; });
    // Root cause real, confirmado en vivo (2026-08-03): smollm2:135m (tier
    // 'tiny', 135M parametros) es el PRIMERO del catalogo, asi que este
    // bucle lo probaba primero, lo aceptaba como ok:true (ninguna deteccion
    // de fuga/eco/repeticion lo pillaba -- alucinaba tema equivocado y
    // mutaba hasta las instrucciones filtradas letra a letra) y nunca
    // llegaba a probar un modelo mas capaz. Perseguir cada nuevo patron de
    // basura de un modelo de 135M es una carrera que no se puede ganar.
    //
    // Primer intento de fix (excluir solo 'tiny') se probo en vivo y colgo
    // 3m21s: sin GPU, un modelo 'large' en frio (qwen3.6:latest = 235B,
    // qwen2.5-coder:32b) puede tardar minutos SOLO en cargar pesos, aparte
    // de precalentado (detectAndWarmUp() en index.js solo precarga
    // tiny/small). 'large' no es viable como fallback automatico en este
    // hardware -- ni siquiera como ultimo recurso.
    //
    // Bug real, encontrado en vivo (2026-08-09): la decision original de
    // arriba dejaba 'tiny' como ultimo recurso con la logica "una respuesta
    // imperfecta es mejor que ninguna". Falso, demostrado en vivo: al subir
    // el timeout de este mismo bucle (60s, ver mas abajo) para dar margen
    // real a 'small'/'medium', la cascada llego a probar smollm2:360m
    // ('tiny') para una pregunta de calculo financiero -- y devolvio, con
    // total confianza y formato limpio, un parrafo entero sobre un
    // "proyecto InvestLab" y "patrones de estrategia" que no tiene NADA que
    // ver con la pregunta. Paso todos los detectores (no es un eco ni
    // basura repetitiva, es prosa coherente sobre OTRO TEMA) y se
    // presento como respuesta valida. Una alucinacion de tema con
    // apariencia legitima es peor que un fallo honesto -- exactamente el
    // mismo motivo por el que ensemble-v2.js ya excluye 'tiny' del
    // ensemble. Se excluye tambien aqui: mejor "sin respuesta" que una
    // respuesta segura y equivocada.
    var bySmall = allInstalled.filter(function(m) { return m.tier === 'small'; });
    var byMedium = allInstalled.filter(function(m) { return m.tier === 'medium'; });
    var installed = bySmall.concat(byMedium);
    if (installed.length === 0) installed = allInstalled.filter(function(m) { return m.tier !== 'tiny'; });
    // Bug real, portable a CUALQUIER maquina, confirmado en vivo (2026-08-14):
    // este bucle no tenia techo de tiempo GLOBAL, solo un timeout de 60s POR
    // modelo -- con hasta 8-9 modelos instalados, el peor caso real es
    // 8-9 x 60s (hasta 9 minutos) antes de rendirse. No es un problema de
    // esta maquina en concreto: en cualquier ordenador bajo presion temporal
    // (poca RAM libre en ese momento, otros procesos, modo ahorro de
    // energia), la misma cascada puede alargarse sin limite porque nada la
    // corta salvo agotar la lista entera. Reproducido en vivo: una consulta
    // real tardo 367s (6.1 min) recorriendo 2 fugas de contexto + 3 timeouts
    // + 3 rechazos por tamaño antes de rendirse. Se anade un presupuesto
    // GLOBAL para toda la cascada (no por modelo): 150s da margen real para
    // 2-3 intentos genuinos incluso en hardware lento, sin permitir que la
    // suma de intentos crezca sin control. Al agotarse, se rinde con el
    // mismo trace honesto que ya deja cada intento (que modelo, por que
    // fallo) en vez de callarse hasta el ultimo modelo de la lista.
    // El techo local (150s) y el reloj global compartido (opts.deadlineTs,
    // ver ORCHESTRATION_GLOBAL_BUDGET_MS en orchestrator.js) compiten --
    // gana el que llegue antes, para que ninguna etapa individual pueda
    // agotar por si sola el presupuesto de toda la orquestacion.
    var localCap = Date.now() + 150000;
    var fallbackDeadline = opts.deadlineTs ? Math.min(localCap, opts.deadlineTs) : localCap;
    for (var fi = 0; fi < installed.length; fi++) {
      if (Date.now() > fallbackDeadline) {
        traceAdd(trace, 'fallback-ollama', 'skipped', 'presupuesto de tiempo agotado tras ' + fi + ' de ' + installed.length + ' modelos -- se rinde en vez de seguir probando');
        break;
      }
      var fallbackModel = installed[fi];
      // Bug real, encontrado en vivo (2026-08-09): este bucle es el ultimo
      // recurso antes del mensaje estatico "IA offline" (buildLocalFallback,
      // mas abajo) -- exactamente el momento en que MAS probable es que el
      // circuit breaker ya tenga varios modelos abiertos (acaban de fallar
      // en el ensemble un momento antes). Sin este chequeo, se reintentaba
      // cada modelo ya conocido como roto con 20s de margen cada uno --
      // con 4-5 modelos 'small'/'medium' de circuito abierto, son 80-100s
      // tirados antes de llegar siquiera al fallback estatico. Se salta
      // igual que ya hace ensemble-v2.js, sin gastar ningun timeout en un
      // modelo que ya sabemos que va a fallar.
      if (circuitIsOpen(fallbackModel.id)) {
        traceAdd(trace, 'fallback-ollama', 'skipped', fallbackModel.id + ': circuito abierto');
        continue;
      }
      // Bug real, encontrado en vivo (2026-08-09), el mismo patron que ya
      // se arreglo en orchestrator.js: 20s de margen para hasta 400 tokens
      // no alcanza en esta CPU (~10 tokens/seg medido) -- 400 tokens solos
      // ya piden ~40s, sin contar la evaluacion de un prompt largo. Este
      // bucle es precisamente el que se alcanza cuando el primer intento
      // (normalmente el modelo mas pequeño instalado) fallo con una
      // pregunta larga/compleja -- justo el caso donde el timeout corto
      // mas duele, porque el siguiente modelo probado necesita margen real
      // para hacerlo mejor, no menos tiempo.
      var fallbackResult = await callOllamaModel(fallbackModel.id, query, { systemPrompt: opts.systemPrompt, maxTokens: Math.min(maxTokens, 400), temperature: temperature, timeoutMs: 60000 });
      // Misma fuga de contexto que en el paso 1 -- este es el bucle que la
      // reprodujo en vivo (smollm2:360m devolviendo "Estado del proyecto
      // (Memory Bus)..." en vez de una respuesta real). Si el modelo actual
      // del bucle tiene una fuga, se sigue probando el SIGUIENTE modelo
      // instalado en vez de aceptarla como respuesta valida.
      if (fallbackResult && fallbackResult.ok && looksLikeContextLeak(fallbackResult.text)) {
        traceAdd(trace, 'fallback-ollama', 'failed', fallbackModel.id + ': fuga de contexto detectada');
        continue;
      }
      if (fallbackResult && fallbackResult.ok) {
        traceAdd(trace, 'fallback-ollama', 'ok', fallbackModel.id + ' en ' + fallbackResult.latencyMs + 'ms');
        circuitRecordSuccess(fallbackModel.id);
        learningRecord(query, fallbackModel.id, category, { ok: true, latencyMs: fallbackResult.latencyMs, tokens: (fallbackResult.text || '').length });
        return { text: fallbackResult.text, model: fallbackResult.model, provider: 'ollama-fallback', latencyMs: fallbackResult.latencyMs, trace: trace };
      }
      // Bug real, confirmado en vivo (2026-08-14): cuando fallbackResult.ok
      // era false por CUALQUIER motivo que no fuera fuga de contexto
      // (timeout, model_too_large, HTTP error, circuito recien abierto a
      // mitad del bucle) ninguno de los dos `if` de arriba disparaba, asi
      // que el bucle pasaba en silencio al siguiente modelo SIN dejar
      // rastro -- ni un traceAdd. Reproducido: un fallo real de la
      // orquestacion completa (475s, luego 285-300s en corridas
      // posteriores) devolvia un trace con 1-3 entradas cuando en realidad
      // se habian intentado 8 modelos -- imposible saber cuales fallaron
      // ni por que sin instrumentacion temporal. Un procesador que no deja
      // rastro de por que una unidad de ejecucion fallo es exactamente la
      // opacidad que este proyecto rechaza (ver CLAUDE.md: "degraded:true
      // nunca se presenta como si fuera el camino completo"). Se registra
      // el motivo real, sea cual sea, antes de pasar al siguiente modelo.
      circuitRecordFailure(fallbackModel.id);
      learningRecord(query, fallbackModel.id, category, { ok: false });
      traceAdd(trace, 'fallback-ollama', 'failed', fallbackModel.id + ': ' + ((fallbackResult && fallbackResult.error) || 'sin respuesta'));
    }
  } catch (e) {
    traceAdd(trace, 'fallback-ollama', 'error', e.message);
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════════
// PIPELINE OPEN SOURCE: INTERMEDIACION -> EJECUCION -> ENSEMBLE
//
// Camino principal de LinkCore. Tres etapas separadas a proposito:
//
//   1. INTERMEDIACION  engine/hf-intermediation.js elige, entre el
//                      catalogo real de repos open source, N modelos de
//                      FAMILIAS DE ARQUITECTURA distintas. Sin clave.
//   2. EJECUCION       cada modelo elegido corre en paralelo via el
//                      Worker (/hf/chat, HF_TOKEN server-side). Cero
//                      descargas, cero espacio en disco.
//   3. ENSEMBLE        engine/middleware.js coordinate(): deteccion de
//                      contradicciones + sintesis calibrada.
//
// La etapa 1 es la que hace que la 3 funcione: el ensemble solo reduce
// el error si los errores de los participantes son independientes, y eso
// exige arquitecturas distintas, no varias versiones del mismo modelo.
// ═══════════════════════════════════════════════════════════════════

// Ejecuta UN repo open source concreto. No hay cascada ni sustitucion:
// si este modelo falla, devuelve null y el ensemble lo cuenta como
// ausente en vez de rellenar el hueco con otro modelo (eso falsearia la
// composicion del ensemble).
export async function callHFModel(modelId, query, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  try {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 45000);
    var res = await fetch(WORKER_ORIGIN + '/hf/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-X1-Auth': PROXY_SECRET },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: opts.systemPrompt || 'Responde EN ESPANOL de forma clara y util. Nunca digas tu nombre ni te identifiques como una marca o producto concreto.' },
          { role: 'user', content: query }
        ],
        max_tokens: opts.maxTokens || 1200,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok || !data.text) {
      return { ok: false, model: modelId, error: (data && data.error) || ('HTTP ' + res.status) };
    }
    return {
      ok: true,
      text: data.text,
      model: modelId,
      provider: data.provider || 'huggingface',
      latencyMs: data.latencyMs || (Date.now() - startedAt),
    };
  } catch (e) {
    return { ok: false, model: modelId, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network_error' };
  }
}

// Igual que callHFModel() pero contra Cloudflare Workers AI (ver
// worker/src/worker.js#cfaiChat) -- el binding nativo `env.AI`, sin token
// ni cuota de facturacion externa. Mismo contrato de respuesta a
// proposito, para que pickBestOpenSourceModel() pueda tratarlos igual.
export async function callCFAIModel(modelId, query, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  try {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 45000);
    var res = await fetch(WORKER_ORIGIN + '/cfai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-X1-Auth': PROXY_SECRET },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: opts.systemPrompt || 'Responde EN ESPANOL de forma clara y util. Nunca digas tu nombre ni te identifiques como una marca o producto concreto.' },
          { role: 'user', content: query }
        ],
        max_tokens: opts.maxTokens || 1200,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok || !data.text) {
      return { ok: false, model: modelId, error: (data && data.error) || ('HTTP ' + res.status) };
    }
    return {
      ok: true,
      text: data.text,
      model: modelId,
      provider: data.provider || 'cloudflare-workers-ai',
      latencyMs: data.latencyMs || (Date.now() - startedAt),
    };
  } catch (e) {
    return { ok: false, model: modelId, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network_error' };
  }
}

// Modelos open source 100% locales via Ollama (ver engine/ollama-catalog.js)
// -- SIN ninguna empresa de por medio, ni Groq, ni Cloudflare, ni
// OpenRouter, ni HF: los pesos se descargan una vez (como instalar un
// programa) y corren para siempre gratis en este mismo ordenador. Se
// llama a localhost:11434 -- es el servidor local del RUNTIME de
// modelos (Ollama), un detalle interno de ejecucion, no el protocolo de
// control de LinkCore (que sigue siendo la tuberia con nombre, nunca
// localhost para eso).
// Techo centralizado, a proposito, para TODA llamada a Ollama sin
// importar quien la pida: crew.js/orchestrator.js piden hasta 3500-5000
// tokens por paso, un presupuesto calibrado para proveedores rapidos en
// la nube (Groq genera cientos de tokens/seg). En CPU local eso se
// traduce en minutos por paso -- verificado en vivo (2026-07-31, un plan
// de 6 pasos que no terminaba). En vez de perseguir cada valor
// hardcodeado repartido por el codigo (fragil, facil que se escape uno),
// se recorta aqui, en el unico sitio por el que pasa TODA llamada local.
var OLLAMA_MAX_TOKENS_CEILING = 700;

// Rendimiento real (2026-08-09): sin num_thread explicito, Ollama usa su
// propia deteccion automatica de hilos, no necesariamente los nucleos
// logicos reales de esta CPU -- medido en vivo, ~12% mas lento sin fijarlo.
// Como el pipeline ya ejecuta en serie (nunca dos modelos Ollama a la vez),
// no hace falta reservar nucleos para otra llamada concurrente -- solo se
// deja 1 nucleo libre para que el resto del sistema no se congele mientras
// responde.
var OLLAMA_NUM_THREAD = Math.max(1, os.cpus().length - 1);

// Extraido a constante (2026-08-17) para poder reusarlo desde el camino
// rapido de mas abajo sin duplicar el literal -- antes solo vivia inline
// en el body del fetch.
var DEFAULT_OLLAMA_SYSTEM_PROMPT = 'Responde EN ESPANOL de forma clara y util. Nunca digas tu nombre ni te identifiques como una marca o producto concreto.';

// ── CAMINO RAPIDO: proceso hijo persistente node-llama-cpp (2026-08-17) ──
// Wiring real de src/engine/local-inference-child.js (modulo probado
// standalone la misma noche -- ver su cabecera para la investigacion
// completa: reuso de child_process en vez de respawn, 45/45 llamadas
// limpias en la investigacion, apagado limpio confirmado por PID) al
// camino de produccion real. callOllamaModel() lo intenta ANTES del fetch
// HTTP de siempre -- si CUALQUIER paso falla (modelo no resuelve a un
// .gguf real en disco, node-llama-cpp no disponible en esta maquina,
// crash del child, timeout, o la respuesta no pasa los mismos 4 chequeos
// de calidad que ya aplica el camino HTTP), esta funcion devuelve null y
// callOllamaModel() cae al fetch de siempre sin marca ni efecto
// secundario. Nunca puede hacer que una llamada que antes funcionaba
// ahora falle -- en el peor caso es un intento extra silencioso delante
// del camino ya probado.
//
// Honesto sobre el alcance real de la paridad con el camino HTTP:
//  - `truncated` sale SIEMPRE false aqui: session.prompt() en local-
//    inference-child-worker.js solo devuelve el texto, no el equivalente
//    de `done_reason` que Ollama si expone (node-llama-cpp SI tiene
//    promptWithMeta() con stopReason, pero el worker probado esta noche
//    usa prompt() a secas -- cambiarlo es una extension real, no algo ya
//    verificado, y se deja fuera a proposito en vez de fingir que se
//    detecta).
//  - `modelConfidence` sale SIEMPRE null: no hay logprobs por esta via.
//    Ninguno de los dos rompe al llamador -- ensemble-v2.js ya trata
//    modelConfidence ausente como neutro (`typeof r.modelConfidence ===
//    'number'`), y pipe-server.js/pesos de sintesis no exigen `truncated`.
//  - El systemPrompt por llamada SI se preserva (2026-08-17, ver el fix
//    en local-inference-child-worker.js: session.setChatHistory() con un
//    unico turno 'system' antes de cada prompt) -- necesario porque
//    gstack.js/crew.js/orchestrator.js dependen de personas de sistema
//    distintas por llamada (revisor, mediador, planificador...) y el
//    child persistente se reusa entre llamadas con systemPrompt distinto.
//  - La RAM que ocupa el child persistente (pesos GGUF cargados en ESTE
//    proceso Node) NO esta coordinada con evictForModel()/keep_alive de
//    Ollama (ollama-catalog.js) -- ese controlador solo conoce la
//    residencia DENTRO de Ollama. En una maquina de 5.8GB sin margen, usar
//    el fast path y Ollama a la vez para modelos grandes puede acumular
//    presion de RAM que ningun desalojo ve. No resuelto aqui a proposito
//    (aumentaria mucho el alcance de este cambio); documentado como riesgo
//    operativo real, no una limitacion teorica.
async function tryPersistentInferenceFastPath(modelId, query, opts, maxTokens, effectiveTimeout, startedAt) {
  var childMod;
  try {
    childMod = await import('./engine/local-inference-child.js');
  } catch (e) {
    return null;
  }

  if (!childMod.isPersistentModelAvailable(modelId)) return null;

  // Comprobacion real de RAM ANTES de intentar (2026-08-18, hallazgo en
  // vivo): sin esto, bajo presion de memoria el intento fallaba con Vulkan
  // ErrorOutOfDeviceMemory o esperaba hasta el timeout completo (60s+)
  // antes de caer a HTTP Ollama -- tiempo entero malgastado en un intento
  // condenado desde el principio. Si ya se sabe que no cabe, se salta
  // directo a HTTP sin ese coste. Solo bloquea si el tamaño del modelo es
  // conocido (hasSufficientRamFor deja pasar cuando no puede medirlo).
  try {
    var catalogModRam = await import('./engine/ollama-catalog.js');
    var ramCheck = catalogModRam.hasSufficientRamFor(modelId);
    if (!ramCheck.ok) {
      console.log('[LinkCore] fast-path node-llama-cpp: RAM insuficiente para ' + modelId + ' (' + ramCheck.freeMB + 'MB libres, ' + ramCheck.needMB + 'MB necesarios) -- se salta el intento, va directo a HTTP Ollama');
      return null;
    }
  } catch (e) {}

  var handle;
  try {
    handle = await childMod.getOrCreatePersistentModel(modelId, { readyTimeoutMs: Math.max(effectiveTimeout, 60000) });
  } catch (e) {
    return null;
  }
  if (!handle || !handle.ok) {
    console.log('[LinkCore] fast-path node-llama-cpp no disponible para ' + modelId + ': ' + ((handle && handle.error) || 'desconocido') + ' -- cae a HTTP Ollama');
    return null;
  }

  var result;
  try {
    result = await childMod.promptPersistentModel(handle, query, {
      systemPrompt: opts.systemPrompt || DEFAULT_OLLAMA_SYSTEM_PROMPT,
      maxTokens: maxTokens,
      timeoutMs: effectiveTimeout,
    });
  } catch (e) {
    return null;
  }
  if (!result || !result.ok) {
    console.log('[LinkCore] fast-path node-llama-cpp fallo en ' + modelId + ': ' + ((result && result.error) || 'sin_respuesta') + ' -- cae a HTTP Ollama');
    return null;
  }

  var text = (result.text || '').trim();
  if (!text) return null;

  // Mismos 4 chequeos de calidad que el camino HTTP de mas abajo -- si el
  // fast path produce basura no se devuelve como si fuera buena, se cae al
  // camino HTTP para darle una oportunidad limpia con el modelo real.
  if (looksLikeEcho(text, (opts.systemPrompt || '') + '\n' + query)
    || looksLikeRepetitiveGarbage(text)
    || looksLikeRefusal(text)
    || looksLikeTopicMismatch(query, text)) {
    console.log('[LinkCore] fast-path node-llama-cpp: respuesta de ' + modelId + ' no paso los chequeos de calidad -- cae a HTTP Ollama');
    return null;
  }

  circuitRecordSuccess(modelId);
  var latencyMs = Date.now() - startedAt;
  cacheSet(query, modelId, { text: text, provider: 'node-llama-cpp-child', latencyMs: latencyMs });
  return {
    ok: true,
    text: text,
    model: modelId,
    provider: 'node-llama-cpp-child',
    latencyMs: latencyMs,
    truncated: false,
    modelConfidence: null,
  };
}

export async function callOllamaModel(modelId, query, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  var maxTokens = Math.min(opts.maxTokens || 400, OLLAMA_MAX_TOKENS_CEILING);

  // Chip pipeline: cache + circuit breaker + adaptive timeout
  var preflight = chipPreFlight(query, modelId);
  // Bug real, encontrado construyendo vNPU.CROSSCHECK (2026-08-17): un
  // acierto de cache se devolvia con ok:true SIN pasar por ninguno de los
  // chequeos de calidad de abajo (eco, basura repetitiva, rechazo, tema
  // equivocado) -- si una respuesta rota se guardaba en cache ANTES de que
  // looksLikeRepetitiveGarbage() la detectara (o antes de arreglar un bug
  // en ese detector, como paso hoy mismo: "No@@@@@@@@@@@@@@@@@@@@@@@@@@@"
  // de llama3.2:3b, 33 caracteres, colado por el gate de 80 caracteres que
  // esa funcion tenia), la misma basura se serviria PARA SIEMPRE desde
  // cache, incluso despues de arreglar el detector -- confirmado en vivo:
  // 3 llamadas seguidas devolvieron el mismo texto roto identico. Ahora un
  // acierto de cache se revalida contra los mismos chequeos que una
  // respuesta fresca antes de servirse; si falla, se trata como fallo de
  // cache (sigue al fetch real de abajo) en vez de repetir basura conocida.
  if (preflight.cacheHit) {
    var cachedText = preflight.cachedEntry.text;
    // Bug real, encontrado en caza de bugs adversarial (2026-08-17): si
    // cachedEntry.text era un valor no-string pero truthy (numero, array,
    // objeto, boolean -- p.ej. una entrada vieja/corrupta de storage.json,
    // o un futuro bug de otro llamador que guarde algo distinto a texto),
    // looksLikeEcho() reventaba con "responseText.trim is not a function"
    // dentro de callOllamaModel -- ANTES de este fix esa ruta ni siquiera
    // tocaba el valor cacheado, asi que un acierto de cache corrupto nunca
    // podia crashear aqui. null/undefined/'' ya se manejaban bien (falsy,
    // caen al fetch fresco sin excepcion); el hueco era solo texto-truthy
    // de tipo incorrecto. Se exige string explicitamente antes de pasarlo a
    // cualquiera de los 4 chequeos.
    var cacheStillGood = typeof cachedText === 'string' && cachedText
      && !looksLikeEcho(cachedText, (opts.systemPrompt || '') + '\n' + query)
      && !looksLikeRepetitiveGarbage(cachedText)
      && !looksLikeRefusal(cachedText)
      && !looksLikeTopicMismatch(query, cachedText);
    if (cacheStillGood) {
      return { ok: true, text: cachedText, model: modelId, provider: 'ollama-cache', latencyMs: 0, fromCache: true };
    }
    // Cae al camino normal de abajo (fetch real) -- no se borra la entrada
    // vieja explicitamente, pero cacheSet() de mas abajo la sobreescribe en
    // cuanto la nueva generacion pase sus propios chequeos.
  }
  if (preflight.circuitOpen) {
    return { ok: false, model: modelId, error: 'circuit_breaker_open' };
  }

  // Bug real, confirmado en vivo (2026-08-03): el orden anterior
  // (`preflight.timeout || opts.timeoutMs || 120000`) ignoraba en
  // silencio cualquier timeoutMs explicito que pasara el llamador --
  // preflight.timeout (adaptiveTimeout(), ver chip-core.js) casi siempre
  // es truthy, asi que ganaba siempre. ensemble-v2.js calcula su propio
  // timeout con cuidado (ronda 1: 15-45s, sin contencion porque ahora
  // corre en serie; ronda 2: 20s fijo) precisamente para que el ensemble
  // completo no se dispare de duracion -- y ese calculo se tiraba a la
  // basura, dejando que cada llamada usara el valor generico de
  // adaptiveTimeout() (hasta 60s para un modelo sin talla en el id, como
  // "llama3.2:latest"). Ahora el timeout explicito del llamador manda
  // cuando existe; preflight.timeout solo es el valor por defecto para
  // quien no pide uno concreto.
  var effectiveTimeout = opts.timeoutMs || preflight.timeout || 120000;

  // Camino rapido (2026-08-17): ver tryPersistentInferenceFastPath() arriba
  // para el porque completo. Se intenta ANTES del desalojo/fetch de Ollama
  // -- si resuelve y responde bien, ni siquiera se toca el servidor HTTP de
  // Ollama para esta llamada. Cualquier fallo cae limpio al camino de abajo.
  var fastPathResult = await tryPersistentInferenceFastPath(modelId, query, opts, maxTokens, effectiveTimeout, startedAt);
  if (fastPathResult) return fastPathResult;

  // Controlador de memoria (2026-08-12): antes de cargar una pieza nueva, si
  // la RAM libre real no da, se desalojan las residentes que no hacen falta
  // (ver evictForModel() en ollama-catalog.js -- no toca el objetivo si ya
  // esta caliente, ni el embedder). Sin esto los modelos se acumulaban a
  // razon de keep_alive por cada categoria distinta que la intermediacion
  // elegia: medido, 337MB libres de 5829MB.
  try {
    var catalogMod = await import('./engine/ollama-catalog.js');
    var evictResult = await catalogMod.evictForModel(modelId);
    if (evictResult && evictResult.evicted.length) {
      console.log('[LinkCore] memoria: ' + evictResult.reason);
    }
    // Bug real, grave, confirmado en vivo (2026-08-14): cuando
    // evictForModel() devuelve error 'modelo_demasiado_grande' (el modelo
    // pesa mas que el techo seguro de esta maquina, ningun desalojo lo
    // arregla), este catch solo mira `.evicted.length` -- el error se
    // ignoraba y se seguia igualmente al fetch() de abajo, que quedaba
    // colgado hasta el timeout intentando cargar algo que nunca cabe.
    // Reproducido: gemma4:latest (9608MB en una maquina de 5.83GB) tardo
    // 475s en fallar. Se corta aqui, al instante, con el mismo formato
    // {ok:false, error} que ya usa circuit_breaker_open arriba -- el
    // llamador (ensemble-v2.js) ya sabe descartar este modelo y probar
    // otro, no hace falta enseñarle nada nuevo, solo dejar de esconderle
    // el fallo real.
    if (evictResult && evictResult.error === 'modelo_demasiado_grande') {
      console.log('[LinkCore] memoria: ' + evictResult.reason);
      return { ok: false, model: modelId, error: 'model_too_large', reason: evictResult.reason };
    }
  } catch (e) {
    // Si el desalojo falla, se sigue: que Ollama gestione la presion.
  }

  try {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, effectiveTimeout);
    var res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: opts.systemPrompt || DEFAULT_OLLAMA_SYSTEM_PROMPT },
          { role: 'user', content: query }
        ],
        stream: false,
        // Bajado de '30m' a '5m' (2026-08-12): 30 minutos por modelo, con la
        // intermediacion eligiendo piezas distintas por categoria, garantiza
        // acumulacion en una maquina de 5.83GB -- es la causa medida de los
        // 337MB libres. 5m sigue dando el acierto de residencia que premia la
        // seleccion (consultas seguidas del mismo tipo reusan la pieza
        // caliente) sin retener RAM media hora despues de la ultima consulta.
        keep_alive: '5m',
        // Cambiado del endpoint compatible con OpenAI (/v1/chat/completions)
        // al endpoint nativo de Ollama (2026-08-09): el compatible NO admite
        // "options" (num_thread, etc.), asi que Ollama usaba su deteccion
        // automatica de hilos, no necesariamente los 12 nucleos logicos
        // reales de esta CPU. Medido en vivo, misma pregunta, 3 intentos:
        // sin num_thread ~27.5s, con num_thread=OLLAMA_NUM_THREAD ~24.1s
        // (~12% mas rapido). Como ensemble-v2.js ya ejecuta en serie (nunca
        // en paralelo), no hay contencion que compensar dejando nucleos
        // libres para otro modelo -- solo se deja 1 nucleo libre para que
        // el resto del sistema (SO, este mismo proceso) no se congele.
        options: {
          temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
          num_predict: maxTokens,
          num_thread: OLLAMA_NUM_THREAD,
        },
        // Confianza real del modelo (2026-08-17): verificado en vivo que el
        // endpoint nativo /api/chat (a diferencia del compatible con OpenAI,
        // ver la nota de arriba sobre num_thread) SI devuelve logprobs por
        // token cuando se pide -- data.logprobs = [{token, logprob, bytes}].
        // Antes la sintesis del ensemble solo pesaba heuristicas de TEXTO
        // (computeContentConfidence: longitud, estructura) sin usar la
        // probabilidad real que el propio modelo asigno a su respuesta.
        logprobs: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    var data = await res.json().catch(function () { return {}; });
    var text = (data.message && data.message.content || '').trim();
    if (!res.ok || !text) {
      circuitRecordFailure(modelId);
      return { ok: false, model: modelId, error: (data && data.error) || ('HTTP ' + res.status) };
    }
    // Fallo SILENCIOSO real, visto en las 4 pruebas en vivo de hoy
    // (2026-08-12): toda respuesta que llega al techo de tokens
    // (OLLAMA_MAX_TOKENS_CEILING) se entregaba cortada a media frase --
    // "...**Componentes de estado**\n\n*" -- sin ningun aviso. El usuario ve
    // una respuesta rota y no sabe si fallo el modelo, LinkCore, o si eso
    // es todo lo que hay. Va directamente contra la regla del propio
    // proyecto ("cero fallos silenciosos, todo fallo debe ser visible", rol
    // CEO de G-STACK en gstack.js). Ollama marca el motivo real del final
    // en done_reason: 'length' = corte por limite de tokens, 'stop' = el
    // modelo termino solo. Se propaga como `truncated` para que quien
    // llame pueda decidir, y se avisa en el propio texto para que nunca se
    // presente una respuesta a medias como si estuviera completa.
    var truncated = data.done_reason === 'length';
    if (truncated) {
      text += '\n\n[LinkCore] Respuesta cortada al alcanzar el limite de ' + maxTokens + ' tokens de esta pieza; no esta completa.';
    }
    // Bug real, confirmado en vivo TRES veces (2026-08-03), cada vez con
    // texto inyectado distinto (Memory Bus, prompt de revision del
    // ensemble, plantilla de instruccion del orquestador): un modelo
    // pequeño puede devolver un eco de su propio prompt de entrada en vez
    // de responder. callOllamaModel() es el UNICO sitio por el que pasa
    // TODA llamada real a Ollama (ensemble, orquestador, crew, fallback de
    // callAI) -- el chequeo aqui cubre los tres casos ya encontrados y
    // cualquier fuga futura con un texto nuevo, sin tener que perseguir
    // cada llamador por separado cada vez que aparezca una nueva.
    if (looksLikeEcho(text, (opts.systemPrompt || '') + '\n' + query)) {
      circuitRecordFailure(modelId);
      return { ok: false, model: modelId, error: 'echo_leak_detected' };
    }
    // Cuarto fallo real, confirmado en vivo (2026-08-03) con smollm2:135m:
    // no ecoa el prompt de entrada, se queda en bucle repitiendo sus
    // propias frases (memoria inyectada parafraseada) dentro de la misma
    // respuesta. Estructural del modelo, no de un texto concreto -- ver
    // looksLikeRepetitiveGarbage() en translation.js.
    if (looksLikeRepetitiveGarbage(text)) {
      circuitRecordFailure(modelId);
      return { ok: false, model: modelId, error: 'repetitive_garbage_detected' };
    }
    // Quinto fallo real, confirmado en vivo (2026-08-05): qwen2.5:0.5b
    // rechazo una peticion totalmente benigna ("haz un analisis del
    // mercado de sensores industriales") -- una llamada identica directa
    // a Ollama, sin pasar por LinkCore, respondio bien. No es que el
    // modelo no pueda, fue un fallo puntual -- pero SIN este chequeo, ese
    // rechazo se aceptaba como respuesta valida Y SE CACHEABA, sirviendose
    // despues repetidamente (verificado: hits:3 en storage.json) como si
    // fuera una respuesta real. Rechazado aqui para que no se cachee y el
    // llamador pueda reintentar con otro modelo.
    if (looksLikeRefusal(text)) {
      circuitRecordFailure(modelId);
      return { ok: false, model: modelId, error: 'refusal_detected' };
    }
    // Sexto fallo real, confirmado en vivo (2026-08-10): llama3.2:1b,
    // preguntado por el area de una parcela agricola, respondio con una
    // tabla comparando TypeScript y Python -- coherente, bien formateada,
    // sin eco ni repeticion (ninguno de los cinco chequeos de arriba lo
    // detectaba), simplemente sobre otro tema por completo. Ver
    // looksLikeTopicMismatch() en translation.js para el detalle y las
    // pruebas.
    if (looksLikeTopicMismatch(query, text)) {
      circuitRecordFailure(modelId);
      return { ok: false, model: modelId, error: 'topic_mismatch_detected' };
    }
    circuitRecordSuccess(modelId);
    var latencyMs = Date.now() - startedAt;
    // Media geometrica de la probabilidad por token (exp de la media de los
    // log-probs) -- proxy estandar de "cuanta certeza tuvo el modelo",
    // distinto de computeContentConfidence (que solo mira el TEXTO
    // resultante, nunca supo lo que el modelo penso mientras generaba). Si
    // Ollama no devuelve logprobs para este modelo/version, se omite en vez
    // de fingir un numero.
    var modelConfidence = null;
    if (Array.isArray(data.logprobs) && data.logprobs.length) {
      var sumLogprob = data.logprobs.reduce(function (s, t) { return s + (typeof t.logprob === 'number' ? t.logprob : 0); }, 0);
      modelConfidence = Math.exp(sumLogprob / data.logprobs.length);
    }
    cacheSet(query, modelId, { text: text, provider: 'ollama-local', latencyMs: latencyMs });
    return {
      ok: true,
      text: text,
      model: modelId,
      provider: 'ollama-local',
      latencyMs: latencyMs,
      truncated: truncated,
      modelConfidence: modelConfidence,
    };
  } catch (e) {
    circuitRecordFailure(modelId);
    return { ok: false, model: modelId, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.code === 'ECONNREFUSED' ? 'ollama_no_esta_corriendo' : (e && e.message) || 'network_error') };
  }
}

// callSpaceModel ELIMINADO (2026-08-17, auditoria de exports huerfanos):
// mismo patron que el bloque de abajo -- llamaba a WORKER_ORIGIN +
// '/space/chat' (huggingface.co por red via un Space propio) y no tenia
// NINGUN caller real en todo el repo (confirmado por grep, solo su propia
// definicion). Codigo muerto con una fuga remota sin cerrar es exactamente
// el tipo de mina que ya se retiro aqui mismo una vez -- se retira tambien.

// callOpenSourceEnsemble/FAMILY_PROFILES/familyProfile/communicateEnsemble
// ELIMINADOS (2026-08-12, limpieza de organizacion de archivos): huerfanos
// de verdad -- exportados pero sin NINGUN call site real en todo el
// repo, solo comentarios ajenos que ya decian "esto se borro por completo
// el 2026-08-09 junto con el bloque que lo llamaba" (orchestrator.js,
// vnpu-core.js). La definicion sobrevivio a su propio borrado: el bloque
// que las LLAMABA se quito hace dias, pero las funciones en si se
// quedaron aqui, sin usarse, con su propia fuga remota sin cerrar
// (communicateEnsemble llamaba a callHFModel() directo en su ronda 2,
// huggingface.co por red). El ensemble real de dos rondas que SI se usa
// hoy es ensemble-v2.js#ensembleRun() -- misma idea (ronda ciega -> los
// participantes se ven -> sintesis), implementada y en el camino vivo.
// Si algun dia hace falta retomar esta version concreta, esta en el
// historial de git de antes de este borrado -- salvo que, como el resto
// de codigo muerto de hoy, nunca llego a versionarse.

// ── Exa -- busqueda semantica real de codigo (GitHub, docs, blogs
// tecnicos), via el Worker (la clave EXA_KEY vive server-side, nunca en
// este archivo -- mismo motivo que Groq/NVIDIA ya se corrigieron). ──
export async function searchExaCode(query, opts) {
  opts = opts || {};
  try {
    var res = await fetch(WORKER_ORIGIN + '/exa/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-X1-Auth': PROXY_SECRET },
      body: JSON.stringify({ query: query, numResults: opts.numResults || 5, githubOnly: opts.githubOnly !== false }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok) return { ok: false, error: data.error || ('HTTP ' + res.status) };
    return { ok: true, results: data.results };
  } catch (e) {
    return { ok: false, error: e.message || 'network_error' };
  }
}

// ── Memoria manual (Ajustes) -- hechos que el usuario le pide a LinkCore
// que recuerde. localStorage, no chrome.storage (no existe en Electron). ──
export function loadManualMemory() { try { var raw = localStorage.getItem('x1_manual'); if (raw) { var d = JSON.parse(raw); if (Array.isArray(d)) return d; } } catch (e) {} return []; }
export function saveManualMemory(entries) { try { localStorage.setItem('x1_manual', JSON.stringify(entries)); } catch (e) {} }

// Limpieza (2026-08-14, pedida explicitamente): loadNotionPageId,
// saveNotionPageId y syncMemoryToNotion (sincronizacion de la memoria
// manual con una pagina de Notion via el Worker de X1) se eliminan --
// confirmado con grep en todo el repo que ningun caller real los usaba
// (ni CLI, ni MCP, ni ningun otro modulo), leftover de X1 sin ninguna
// funcion actual en LinkCore.

// Ensambla todo lo que LinkCore "sabe" antes de responder: memoria manual +
// conversacion reciente + herramientas del agente personalizado activo.
// Sin esto el system prompt es un texto de rol estatico que no cambia
// nunca -- de ahi que LinkCore pareciera no recordar nada ni saber que
// agente se le habia pedido usar.
export function buildContextBlock(opts) {
  opts = opts || {};
  var parts = [];
  var manual = loadManualMemory();
  if (manual.length) {
    parts.push('Hechos que el usuario te ha pedido recordar:\n' + manual.map(function (e) { return '- ' + e.topic + ': ' + e.content; }).join('\n'));
  }
  var convo = T.getMemoryContext();
  if (convo) parts.push('Conversacion reciente (usala para dar continuidad, no la repitas):\n' + convo);

  // MEMORY BUS: Inject knowledge graph context
  try {
    var graphContext = getContextSummary({ maxTokens: 600, query: opts.query || '' });
    if (graphContext) parts.push('Estado del proyecto (Memory Bus):\n' + graphContext);
  } catch (e) {}

  var block = parts.length ? '\n\n---\n' + parts.join('\n\n') : '';
  var CONTEXT_BLOCK_MAX_CHARS = 6000;
  if (block.length > CONTEXT_BLOCK_MAX_CHARS) {
    block = block.slice(0, CONTEXT_BLOCK_MAX_CHARS) + '…';
  }
  return block;
}

function addDecomposition(query, result) {
  try {
    var hasRealSteps = Array.isArray(result && result.steps) && result.steps.length > 0;
    if (result && (result.decompositionLabel || hasRealSteps)) {
      result.decomposed = true;
    }
  } catch (e) {}
  return result;
}

// ── CRITICA DE ENSEMBLE, ACOTADA (2026-08-12) ──
// Distinta de applyDeterministicVerification() a proposito: aquella son
// parsers reales (sin opinion, resultado siempre el mismo para el mismo
// texto); esto es una IA local opinando -- probabilistico, puede fallar o
// no ver nada, igual que cualquier revisor. Nunca se mezclan ni se
// presentan con el mismo nivel de certeza.
//
// Decision de arquitectura del usuario (2026-08-12): la respuesta la da
// SIEMPRE Claude, con SU tiempo de generacion (rapido). LinkCore no genera
// un borrador alternativo completo para esto -- seria volver al problema
// de siempre (minutos, porque el modelo tiene que escribir cientos de
// tokens). En vez de eso, se le pide a una pieza local, bien elegida por
// la intermediacion real (capacidad + aprendizaje + residencia en RAM, ver
// ollama-catalog.js), una critica CORTA y acotada (maxTokens bajo) del
// borrador que Claude ya escribio -- una segunda opinion real de una IA
// distinta, no una regeneracion completa. Medido en vivo: ~20-30s incluso
// con salida corta, porque en esta CPU hay coste fijo de evaluar el prompt
// de entrada sin importar cuanto se genere despues -- mas lento que la
// verificacion determinista (milisegundos), mucho mas rapido que un
// ensemble de borradores completos (minutos).
//
// Es ensemble learning e intermediacion real: la pieza se elige con la
// misma logica que cualquier otra llamada (preferCapability, sesgo
// aprendido, cache caliente), y el resultado se registra en el learning
// loop -- si la critica encuentra algo real, es señal de que vale la pena
// seguir invirtiendo en revisores; si nunca encuentra nada, se sabe medido,
// no supuesto.
export async function ensembleCritique(draft, query, opts) {
  opts = opts || {};
  var startedAt = Date.now();
  if (!draft || !draft.trim()) return { ok: false, error: 'sin_borrador' };

  var prompt = 'Revisa este borrador de respuesta y di, en maximo 3 lineas, ' +
    'si hay algun error factual o logico real. Si no encuentras ninguno, ' +
    'responde EXACTAMENTE: SIN PROBLEMAS. Nunca repitas el borrador entero.\n\n' +
    (query ? 'Pregunta original: ' + query + '\n\n' : '') +
    'Borrador a revisar:\n' + draft.slice(0, 2000);

  var result = await callAI(prompt, {
    systemPrompt: 'Eres un revisor tecnico critico y conciso. Tu unico trabajo es encontrar errores reales, no parafrasear ni alabar.',
    maxTokens: opts.maxTokens || 120,
    temperature: 0.1,
    timeoutMs: opts.timeoutMs || 30000,
    minTier: 'medium',
  });

  var latencyMs = Date.now() - startedAt;
  if (!result || !result.text) {
    return { ok: false, error: (result && result.error) || 'sin_respuesta', latencyMs: latencyMs };
  }

  var raw = result.text.trim();
  var foundIssue = raw.toUpperCase().indexOf('SIN PROBLEMAS') === -1;
  try {
    learningRecord(prompt, result.model, 'critique', {
      ok: true,
      latencyMs: latencyMs,
      tokens: raw.length,
      // Aqui SI se mide algo real de la pieza que hizo la critica: si
      // encontro un problema real y verificable con la deterministica, o
      // si dijo "sin problemas" y la deterministica tambien callo,
      // acerto -- eso es la calidad de un revisor.
      quality: 0.5,
    });
  } catch (e) {}

  return {
    ok: true,
    foundIssue: foundIssue,
    critique: raw,
    model: result.model,
    provider: result.provider,
    latencyMs: latencyMs,
  };
}

export async function smartQuery(query, agentId, opts) {
  opts = opts || {};
  T.addMemory('user', query);

  // Cache de respuesta FINAL (2026-08-08): repetir la misma pregunta
  // pasaba de 115.9s a 64.9s (solo 1.8x) porque la cache por-modelo
  // ahorraba las llamadas a los modelos pero rehacia ronda 2 + sintesis +
  // consenso + G-STACK desde cero. Con esto, una repeticion exacta
  // devuelve el resultado ya sintetizado sin tocar ningun modelo. Se
  // consulta ANTES de cualquier trabajo, y solo para consultas normales
  // -- un saludo no merece cache, y ya tiene su propio camino rapido.
  try {
    var cachedFinal = finalCacheGet(query, agentId);
    if (cachedFinal) {
      T.addMemory('assistant', cachedFinal.response);
      return Object.assign({}, cachedFinal, { fromCache: true });
    }
  } catch (e) {}

  // MEMORY BUS: Record command in journal
  try {
    addJournalEntry({ type: 'command', content: query, category: agentId || 'general' });
  } catch (e) {}
  var sector = agentId && agentId.indexOf('mcp-') === 0 ? 'MCP' : sectorForAgent(agentId);
  var agent = AGENTS.find(function(a) { return a.id === agentId; });
  var contextBlock = buildContextBlock(opts);
  var allowLegacyOrchestration = opts.enableLegacyOrchestration === true;

  // La identidad del producto cambia aqui: LinkCore ya no usa rutas de
  // orquestacion por defecto para preguntas normales. La via principal es
  // intermediacion + ensemble + verificacion. Los caminos heredados quedan
  // detras de un opt-in explicito para no romper compatibilidad interna.
  if (allowLegacyOrchestration && isKimiAvailable() && !isGreeting(query) && query.length > 200) {
    try {
      var kimiDecision = await kimiOrchestrate(query, {
        maxTokens: 100,
        temperature: 0.1,
      });

      if (kimiDecision && kimiDecision.ok) {
        console.log('[LinkCore] Orquestador: ' + kimiDecision.strategy + ' (' + kimiDecision.latencyMs + 'ms)');

        if (kimiDecision.strategy === 'direct' && kimiDecision.response) {
          T.addMemory('assistant', kimiDecision.response);
          return {
            response: kimiDecision.response,
            decomposed: false,
            model: kimiDecision.model || 'llama3.2:3b',
            provider: 'ollama-local',
            latencyMs: kimiDecision.latencyMs,
            orchestrator: 'llama3.2:3b',
          };
        }

        if (kimiDecision.models && kimiDecision.models.length) {
          opts.preferredModels = kimiDecision.models;
        }
      }
    } catch (e) {
      console.error('[LinkCore] Orquestador error:', e.message);
    }
  }

  // MCP Agent routing
  if (agentId && agentId.indexOf('mcp-') === 0) {
    var mcpAgent = MCP_AGENTS.find(function(a) { return a.id === agentId; });
    if (mcpAgent) {
      var mcpSystemPrompt = 'You are the ' + mcpAgent.name + ' MCP Agent. Category: ' + mcpAgent.category + '. Tools: ' + mcpAgent.tools.join(', ') + '. Help the user with their query using your available tools.' + contextBlock;
      var mcpResult = await callAI(query, { systemPrompt: mcpSystemPrompt });
      if (mcpResult && mcpResult.text) {
        T.addMemory('assistant', mcpResult.text);
        return addDecomposition(query, { response: mcpResult.text, tools: [], judgeReason: 'MCP Agent: ' + mcpAgent.name + ' (' + mcpAgent.category + ')', sector: 'MCP', model: mcpResult.model, provider: mcpResult.provider, latencyMs: mcpResult.latencyMs, agentName: mcpAgent.name, agentModel: 'MCP', agentRepo: '' });
      }
    }
  }

  // EMPLOYEE IA: Crew multi-agent for complex deliverables
  var deliverable = detectDeliverableType(query);
  if (allowLegacyOrchestration && deliverable !== 'text' && !agentId && isComplexTask(query)) {
    try {
      var crewResult = await runCrew(query, { onProgress: opts.onProgress });
      if (crewResult && crewResult.response) {
        // Verificacion determinista tambien aqui (2026-08-10): hasta ahora
        // math-verify/code-verify/coherence-verify solo protegian el
        // camino directo del ensemble (mas abajo en esta funcion) -- este
        // camino (runCrew(), tareas de tipo "research"/deliverable) es
        // otro pipeline real y distinto que nunca pasaba por ninguno de
        // los tres. Encontrado en vivo: una respuesta de este camino con
        // pasos matematicos internamente contradictorios (mismo calculo,
        // tres resultados distintos en tres "pasos") salio sin ningun
        // aviso. Mismo patron exacto que el bloque de ensemble, en el
        // mismo orden.
        var crewResponseText = crewResult.response;
        try {
          var crewMathFindings = verifyCalculations(crewResponseText);
          if (crewMathFindings.length > 0) {
            var crewMathWarn = ['⚠️ Aviso de verificación matemática (calculado, no otra opinión de IA):'];
            crewMathFindings.forEach(function (f) {
              crewMathWarn.push('  "' + f.pasoAnterior + '" = ' + f.valorAnterior + ', pero el siguiente paso dice "' + f.pasoSiguiente + '" = ' + f.valorSiguiente + ' (' + f.diffPct + '% de diferencia) — revisa este cálculo.');
            });
            crewResponseText = crewMathWarn.join('\n') + '\n\n' + crewResponseText;
          }
        } catch (e) {}
        try {
          var crewCodeFindings = await verifyCodeBlocks(crewResponseText);
          if (crewCodeFindings.length > 0) {
            var crewCodeWarn = ['⚠️ Aviso de sintaxis (verificado con un compilador real, no otra opinión de IA):'];
            crewCodeFindings.forEach(function (f) {
              crewCodeWarn.push('  [' + f.lang + '] ' + f.error);
            });
            crewResponseText = crewCodeWarn.join('\n') + '\n\n' + crewResponseText;
          }
        } catch (e) {}
        try {
          var crewCoherenceFindings = verifyComparisons(crewResponseText);
          if (crewCoherenceFindings.length > 0) {
            var crewCoherenceWarn = ['⚠️ Aviso de coherencia (el texto se contradice sobre la misma comparación):'];
            crewCoherenceFindings.forEach(function (f) {
              crewCoherenceWarn.push('  "' + f.afirmacionA + '" pero en otro punto dice "' + f.afirmacionB + '"');
            });
            crewResponseText = crewCoherenceWarn.join('\n') + '\n\n' + crewResponseText;
          }
        } catch (e) {}
        T.addMemory('assistant', crewResponseText);
        return addDecomposition(query, {
          response: crewResponseText,
          tools: [],
          judgeReason: crewResult.decompositionLabel || 'Employee IA crew',
          sector: crewResult.decompositionSector || 'Multi-agente',
          model: crewResult.modelsUsed && crewResult.modelsUsed.length ? crewResult.modelsUsed[0].model : null,
          provider: crewResult.modelsUsed && crewResult.modelsUsed.length ? crewResult.modelsUsed[0].provider : null,
          latencyMs: crewResult.totalLatencyMs,
          agentName: 'Crew',
          agentModel: 'Multi-IA',
          agentRepo: '',
          steps: crewResult.steps,
          deliverableType: crewResult.deliverableType,
          deployResult: crewResult.deployResult,
        });
      }
    } catch (e) {
      console.error('[LinkCore] crew error:', e.message);
    }
  }

  if (isGreeting(query)) {
    var res = await callAI(query, { maxTokens: 220, temperature: 0.4, systemPrompt: 'Describe LinkCore como un procesador de intermediación entre IAs, no como un asistente conversacional. Responde EN ESPAÑOL de forma breve y funcional. Explica que selecciona modelos, contrasta voces, media contradicciones y entrega una salida procesada para que otra IA la use.' + contextBlock });
    var greet = res && res.text ? res.text : 'LinkCore activo. Procesa tareas para una IA principal: selecciona modelos, contrasta respuestas, media contradicciones y devuelve una salida sintetizada.';
    T.addMemory('assistant', greet);
    return { response: greet, tools: [], judgeReason: null, sector: sector, model: res && res.model || null, provider: res && res.provider || null, latencyMs: res && res.latencyMs || 0, agentName: agent ? agent.name : 'LinkCore', agentModel: agent ? agent.ai : 'Router', agentRepo: agent ? agent.repo : '', decomposed: false, steps: [] };
  }

  // 1) IA por sector: cada sector usa su propio system prompt + modelo open-source
  var systemPrompt = (SECTOR_PROMPTS[agentId] || SECTOR_PROMPTS.research) + contextBlock;

  // Uber dispatch: intents complejos van PRIMERO al orquestador real
  // (task-graph.js: descompone en subtareas con relaciones productor-
  // consumidor; work-ledger.js: evita repetir/solapar trabajo ya hecho en
  // sesiones anteriores; semantic-translator.js: traduce contexto entre
  // estilos cognitivos de cada modelo). Esto es lo que de verdad impide
  // que varios agentes se pisen el trabajo -- exactamente el problema que
  // el ensemble de abajo NO resuelve (responde la query entera de un tiro
  // contra 2-3 modelos, sin descomponer nada).
  //
  // Bug real: este bloque vivia DESPUES del ensemble de abajo, y el
  // ensemble hace `return` en cuanto tiene exito -- que es casi siempre,
  // porque solo necesita que 1-2 modelos pequeños locales respondan. En la
  // practica el orquestador (con toda su maquinaria de coordinacion) casi
  // nunca se alcanzaba, ni siquiera en queries complejas que
  // shouldOrchestrate() si detectaba correctamente. Se mueve antes para
  // que la decision de descomponer se tome antes de que el camino rapido
  // capture la query.
  if (allowLegacyOrchestration && !agentId && shouldOrchestrate(query)) {
    try {
      var orch = await runOrchestration(query, { onProgress: opts.onProgress });
      if (orch && orch.response) {
        // Misma verificacion que el camino de runCrew() de arriba y el
        // ensemble de mas abajo (2026-08-10): este es el tercer pipeline
        // real que producia respuesta final sin pasar por ningun
        // verificador determinista.
        var orchResponseText = orch.response;
        try {
          var orchMathFindings = verifyCalculations(orchResponseText);
          if (orchMathFindings.length > 0) {
            var orchMathWarn = ['⚠️ Aviso de verificación matemática (calculado, no otra opinión de IA):'];
            orchMathFindings.forEach(function (f) {
              orchMathWarn.push('  "' + f.pasoAnterior + '" = ' + f.valorAnterior + ', pero el siguiente paso dice "' + f.pasoSiguiente + '" = ' + f.valorSiguiente + ' (' + f.diffPct + '% de diferencia) — revisa este cálculo.');
            });
            orchResponseText = orchMathWarn.join('\n') + '\n\n' + orchResponseText;
          }
        } catch (e) {}
        try {
          var orchCodeFindings = await verifyCodeBlocks(orchResponseText);
          if (orchCodeFindings.length > 0) {
            var orchCodeWarn = ['⚠️ Aviso de sintaxis (verificado con un compilador real, no otra opinión de IA):'];
            orchCodeFindings.forEach(function (f) {
              orchCodeWarn.push('  [' + f.lang + '] ' + f.error);
            });
            orchResponseText = orchCodeWarn.join('\n') + '\n\n' + orchResponseText;
          }
        } catch (e) {}
        try {
          var orchCoherenceFindings = verifyComparisons(orchResponseText);
          if (orchCoherenceFindings.length > 0) {
            var orchCoherenceWarn = ['⚠️ Aviso de coherencia (el texto se contradice sobre la misma comparación):'];
            orchCoherenceFindings.forEach(function (f) {
              orchCoherenceWarn.push('  "' + f.afirmacionA + '" pero en otro punto dice "' + f.afirmacionB + '"');
            });
            orchResponseText = orchCoherenceWarn.join('\n') + '\n\n' + orchResponseText;
          }
        } catch (e) {}
        orch.response = orchResponseText;
        T.addMemory('assistant', orch.response);
        return orch;
      }
    } catch (e) {
      console.error('[LinkCore] orchestrator:', e);
    }
  }

  // Cache semantica (2026-08-11): solo aqui, en el camino de intermediacion
  // principal -- Crew/MCP/orquestador legado ya pasaron sin activarse. Un
  // fallo de embeddings degrada a "sin cache", nunca bloquea la consulta.
  try {
    var semanticHit = await semanticCache.get(query);
    if (semanticHit) {
      try { chipEventRecord('semanticCacheHit'); } catch (e) {}
      T.addMemory('assistant', semanticHit.response);
      return addDecomposition(query, {
        response: semanticHit.response,
        tools: [],
        judgeReason: 'Cache semantica (similitud ' + Math.round(semanticHit.score * 100) + '%, coincide con: "' + semanticHit.matchedQuery.slice(0, 60) + '")',
        sector: sector,
        fromCache: 'semantic',
      });
    }
    try { chipEventRecord('semanticCacheMiss'); } catch (e) {}
  } catch (e) {}

  // INTERMEDIATION CORE: el procesador decide cuantas voces necesita la
  // consulta, que modelos las representan y si hace falta escalar a mas
  // contraste. Ya no es "modo simple" vs "ensemble": es un solo nucleo de
  // brokerage + mediacion + verificacion.
  try {
    var intermediationResult = await runIntermediationCore(query, {
      category: agentId || null,
      systemPrompt: systemPrompt,
      maxTokens: 1500,
      temperature: 0.2,
      preferredModelIds: opts.preferredModels || [],
      deadlineTs: opts.deadlineTs,
    }, {
      runEnsemble: ensembleRun,
      aiCaller: callAI,
      verify: applyDeterministicVerification,
      recordEvent: chipEventRecord,
    });

    if (intermediationResult && intermediationResult.ok && intermediationResult.text) {
      T.addMemory('assistant', intermediationResult.text);

      try {
        var usedModels = intermediationResult.ensemble && intermediationResult.ensemble.models && intermediationResult.ensemble.models.length
          ? intermediationResult.ensemble.models
          : (intermediationResult.model ? [intermediationResult.model] : []);
        addJournalEntry({
          type: 'intermediation',
          content: intermediationResult.text.slice(0, 1000),
          model: intermediationResult.model,
          category: agentId || 'general',
          latencyMs: intermediationResult.latencyMs,
          tokens: intermediationResult.text.length,
          metadata: {
            models: usedModels,
            intermediationPath: intermediationResult.intermediation && intermediationResult.intermediation.path,
            confidence: intermediationResult.intermediation && intermediationResult.intermediation.confidence && intermediationResult.intermediation.confidence.score,
          }
        });
        extractEntities(intermediationResult.text, { category: agentId || 'intermediation' });
        extractEntities(query, { category: 'user-query' });
      } catch (e) {}

      try {
        var edrModels = intermediationResult.ensemble && intermediationResult.ensemble.models && intermediationResult.ensemble.models.length
          ? intermediationResult.ensemble.models
          : (intermediationResult.model ? [intermediationResult.model] : []);
        var intermediationConfidence = intermediationResult.intermediation && intermediationResult.intermediation.confidence
          ? intermediationResult.intermediation.confidence.score
          : computeContentConfidence(intermediationResult.text);
        var consensusScore = intermediationResult.intermediation && intermediationResult.intermediation.confidence && typeof intermediationResult.intermediation.confidence.consensusScore === 'number'
          ? Math.round(intermediationResult.intermediation.confidence.consensusScore * 100)
          : (edrModels.length > 1 ? 70 : 0);
        recordDecision({
          query: query,
          modelsSelected: edrModels,
          reasoning: intermediationResult.intermediation && intermediationResult.intermediation.label
            ? intermediationResult.intermediation.label
            : ('intermediacion con ' + edrModels.length + ' modelo(s)'),
          outcome: 'success',
          qualityScore: Math.round(intermediationConfidence * 100),
          latencyMs: intermediationResult.latencyMs,
          consensusScore: consensusScore,
          learningSignal: { category: agentId || 'general', strategy: 'intermediation-core' },
        });
        edrModels.forEach(function (m) { mctsUpdate(m, agentId || 'general', intermediationConfidence); });
        if (edrModels.length >= 2) {
          recordCollaboration(edrModels, agentId || (intermediationResult.intermediation && intermediationResult.intermediation.profile && intermediationResult.intermediation.profile.brokerCategory) || 'general', {
            ok: true,
            latencyMs: intermediationResult.latencyMs,
            quality: intermediationConfidence,
            consensusScore: intermediationResult.intermediation && intermediationResult.intermediation.confidence
              ? intermediationResult.intermediation.confidence.consensusScore
              : null,
            contradictions: intermediationResult.intermediation && intermediationResult.intermediation.confidence
              ? intermediationResult.intermediation.confidence.contradictionCount
              : 0,
            mediated: !!(intermediationResult.ensemble && intermediationResult.ensemble.mediation && intermediationResult.ensemble.mediation.used),
            verificationFindings: !!(intermediationResult.intermediation && intermediationResult.intermediation.verification && intermediationResult.intermediation.verification.hasFindings),
            verificationResolved: !!(intermediationResult.intermediation && intermediationResult.intermediation.improvement && intermediationResult.intermediation.improvement.verificationResolved),
            contradictionsResolved: intermediationResult.intermediation && intermediationResult.intermediation.improvement
              ? intermediationResult.intermediation.improvement.contradictionsResolved
              : 0,
            confidenceGain: intermediationResult.intermediation && intermediationResult.intermediation.improvement
              ? intermediationResult.intermediation.improvement.confidenceGain
              : 0,
            consensusGain: intermediationResult.intermediation && intermediationResult.intermediation.improvement
              ? intermediationResult.intermediation.improvement.consensusGain
              : null,
            escalated: !!(intermediationResult.intermediation && intermediationResult.intermediation.escalated),
          }, intermediationResult.intermediation && intermediationResult.intermediation.learningContext ? intermediationResult.intermediation.learningContext : null);
        }
      } catch (e) {}

      var processorPacket = buildProcessorPacket(query, intermediationResult);
      var finalPayload = addDecomposition(query, {
        response: intermediationResult.text,
        tools: [],
        judgeReason: intermediationResult.intermediation && intermediationResult.intermediation.label
          ? intermediationResult.intermediation.label
          : 'Intermediación Core',
        sector: sector,
        model: intermediationResult.model,
        provider: intermediationResult.provider,
        latencyMs: intermediationResult.latencyMs,
        agentName: agent ? agent.name : 'LinkCore',
        agentModel: agent ? agent.ai : 'Router',
        agentRepo: agent ? agent.repo : '',
        ensemble: intermediationResult.ensemble,
        gstackReview: intermediationResult.gstackReview,
        neuralArbitrage: intermediationResult.neuralArbitrage,
        intermediation: intermediationResult.intermediation,
        processorPacket: processorPacket,
      });
      try { finalCacheSet(query, agentId, finalPayload); } catch (e) {}
      try { await semanticCache.set(query, finalPayload.response, { sector: sector }); } catch (e) {}
      return finalPayload;
    }
  } catch (e) {
    console.error('[LinkCore] intermediation-core:', e.message);
  }

  // Bug real, severo, encontrado en vivo (2026-08-11) probando el camino
  // de respaldo (cuando el ensemble+gstack falla/lanza): judgeReason se
  // calculaba AQUI, con getJudgeReason() -- una funcion que NUNCA llama a
  // ningun modelo, solo construye una narrativa a partir de un registro
  // ESTATICO (ai-registry.js/arena-models.js), con nombres de modelo,
  // ELO y una infraestructura ("Proxy Cloudflare Worker → cascada de 235
  // IAs") inventados. El resultado real que el usuario recibe (aiResult,
  // dos lineas mas abajo) SI viene de un modelo local de verdad -- pero
  // el texto que EXPLICA que respondio, mostrado al usuario, afirmaba
  // "Arena AI: Claude Fable 5 (anthropic, ELO 1382)... Cloudflare Worker"
  // sin relacion alguna con lo que en realidad paso. Es exactamente lo
  // que este proyecto prohibe explicitamente: fingir que ocurrio algo que
  // no ocurrio. Se corrige calculando judgeReason DESPUES de saber que
  // paso de verdad en cada uno de los tres caminos de este fallback
  // (respuesta real / herramientas / estatico), nunca antes.

  var aiResult = await callAI(query, { systemPrompt: systemPrompt });
  if (aiResult && aiResult.text) {
    var judgeReason = 'Respaldo directo (ensemble no disponible): ' + (aiResult.model || 'modelo local') + ' (' + (aiResult.provider || 'ollama-local') + ')';

    // Bug real, encontrado en vivo (2026-08-17): este camino (ultimo
    // recurso, cuando la intermediacion entera fallo) SI llamaba a
    // applyDeterministicVerification() unas lineas mas abajo, pero solo
    // para calcular la nota interna del learning-loop -- el aviso ⚠️ que
    // ella misma antepone al texto cuando encuentra un hallazgo real
    // (igual que hacen los caminos de runCrew() y runOrchestration() mas
    // arriba en esta misma funcion) nunca llegaba al usuario, se tiraba.
    // Se recalcula una sola vez, ANTES de guardar en memoria/journal y de
    // construir la respuesta, para que el mismo texto (con el aviso
    // delante si lo hay) sea lo que se guarda y lo que se devuelve.
    var fallbackResponseText = aiResult.text;
    var fallbackHasFindings = false;
    try {
      var qVerified = await applyDeterministicVerification(aiResult.text, query);
      fallbackResponseText = qVerified.text;
      fallbackHasFindings = qVerified.hasFindings;
    } catch (e) {}

    T.addMemory('assistant', fallbackResponseText);

    // MEMORY BUS: Record AI response + extract entities
    try {
      addJournalEntry({
        type: 'response',
        content: fallbackResponseText.slice(0, 1000),
        model: aiResult.model,
        category: agentId || 'general',
        latencyMs: aiResult.latencyMs,
        tokens: fallbackResponseText.length,
      });
      extractEntities(fallbackResponseText, { category: agentId || 'ai-response' });
      extractEntities(query, { category: 'user-query' });
    } catch (e) {}
    // Learning loop: registrar resultado para mejorar routing futuro
    try {
      var hfMod = await import('./engine/hf-intermediation.js');
      var detectedCategory = agentId || hfMod.detectCategory(query);
      // Bug real, de fondo, encontrado en vivo (2026-08-12): la "calidad"
      // que alimentaba el aprendizaje era `longitud_del_texto / 200`. Es
      // decir: cuanto MAS LARGO escribe un modelo, mejor nota se lleva --
      // asi que el procesador aprendia a enrutar hacia el modelo mas
      // verboso, no hacia el que hace mejor el trabajo. Afecta a TODO tipo
      // de tarea (crear una app, una presentacion, un analisis...), porque
      // es la señal con la que se decide a que pieza mandar cada cosa.
      //
      // Ahora la calidad sale de los verificadores deterministas, que es lo
      // unico que mide si el trabajo estaba bien hecho y no cuanto ocupa:
      // sin hallazgos = 1.0; cada hallazgo real (sintaxis de codigo rota,
      // contradiccion interna, la misma afirmacion dada por buena para dos
      // cosas distintas, la salida no coincide con lo que el texto dice que
      // produce) baja la nota. Una respuesta vacia o de una linea tampoco
      // puede puntuar alto, asi que se conserva un suelo minimo por
      // sustancia -- pero como TOPE, no como premio por escribir mas.
      var qualityScore = fallbackHasFindings ? 0.3 : 1;
      var substance = Math.min(1, (aiResult.text || '').trim().length / 120);
      learningRecord(query, aiResult.model, detectedCategory, {
        ok: true,
        latencyMs: aiResult.latencyMs || 0,
        tokens: (aiResult.text || '').length,
        quality: Math.min(qualityScore, substance),
      });
    } catch (e) {}
    // Bug real, encontrado en vivo (2026-08-17): callAI() marca
    // r.degraded = true cuando su unico camino real fue el proxy IPC (ver
    // linea ~338), pero ese flag nunca se copiaba al objeto que
    // smartQuery() devuelve aqui -- se perdia justo donde los consumers
    // reales (pipe-server.js, la capa de instrucciones vNPU, el CLI)
    // necesitan saber que la respuesta vino de un camino degradado, no del
    // camino completo. Viola literalmente la regla de CLAUDE.md: "si algo
    // se degrada... se marca explicitamente degraded:true, nunca se
    // presenta como si fuera el camino completo".
    return addDecomposition(query, {
      response: fallbackResponseText, tools: [],
      judgeReason: judgeReason, sector: sector,
      model: aiResult.model, provider: aiResult.provider, latencyMs: aiResult.latencyMs,
      agentName: agent ? agent.name : 'LinkCore', agentModel: agent ? agent.ai : 'Router', agentRepo: agent ? agent.repo : '',
      degraded: aiResult.degraded === true,
    });
  }

  // 2) Tools (GitHub/npm/SO) cuando la IA falla
  var toolResults = null;
  try { toolResults = await T.executeTools(query, agentId); } catch (e) { toolResults = null; }
  var toolText = null;
  try { toolText = T.formatToolResults(query, toolResults || {}); } catch (e) { toolText = null; }
  if (toolText) {
    var toolsUsed = T.toolsUsedList(toolResults || {});
    T.addMemory('assistant', toolText);
    return addDecomposition(query, { response: 'El motor IA esta temporalmente sin conexion. Resultados de busqueda:\n\n' + toolText, tools: toolsUsed, judgeReason: 'Sin respuesta de ningun modelo local; resultados de herramientas (' + toolsUsed.join(', ') + ')', sector: sector, agentName: agent ? agent.name : 'LinkCore', agentModel: agent ? agent.ai : 'Router', agentRepo: agent ? agent.repo : '' });
  }

  // 3) Fallback local
  // Bug real (2026-07-31, seccion 5 del estado): el fallback "IA offline"
  // se guardaba en la memoria de conversacion como si fuera una respuesta
  // real de la IA. Ese texto estatico se re-inyectaba luego como contexto
  // de consultas futuras (getMemoryContext), contaminando la conversacion
  // con "IA offline. Prueba: busca en github..." repetido. El fallback se
  // devuelve al usuario pero NO se guarda en memoria.
  var localFallback = await buildLocalFallback(query, agentId, sector);
  return addDecomposition(query, { response: localFallback, tools: [], judgeReason: 'IA offline: ningun modelo local respondio, sin herramientas aplicables', sector: sector, agentName: agent ? agent.name : 'LinkCore', agentModel: agent ? agent.ai : 'Router', agentRepo: agent ? agent.repo : '' });
}

// LinkCore es el procesador, no una IA (2026-08-12, decision de arquitectura
// explicita del usuario): cuando ninguna pieza real (modelo Ollama) responde,
// esta funcion NO debe generar una respuesta conversacional por sector como
// si LinkCore fuera el asistente ("dime X y preparo Y") -- eso es LinkCore
// actuando como la IA que da la respuesta, exactamente lo que no debe ser.
// Antes tenia 9 personas distintas por sector prometiendo redactar/preparar
// cosas que LinkCore nunca iba a escribir. Ahora reporta el fallo como lo
// haria un procesador: que pieza fallo, que se detecto, nada mas.
// Hallazgo real, panel de riesgo tecnico (2026-08-17): este fallback daba el
// MISMO mensaje generico ("revisa linkcore status o reintenta") tanto si
// Ollama no esta instalado/corriendo como si esta corriendo pero sin ningun
// modelo descargado -- "reintenta" es un consejo activamente incorrecto en
// ambos casos, nada cambia solo. Toda la informacion para distinguirlos ya
// existe (detectInstalledModels() en ollama-catalog.js ya diferencia
// 'ollama_unreachable' de "alcanzable con 0 modelos"), simplemente nunca se
// consultaba aqui. Ahora se hace una comprobacion barata y en vivo (un solo
// fetch a /api/tags, ~5s de margen) para dar la instruccion real que
// resuelve el problema, no una generica.
async function buildLocalFallback(query, agentId, sector) {
  var agent = AGENTS.find(function(a) { return a.id === agentId; });
  var agentName = agent ? agent.name : 'Asistente';
  var agentAI = agent ? agent.ai : 'IA';

  var base = '[LinkCore] Ningun modelo local respondio. Sector detectado: ' + sector +
    '. Pieza asignada: ' + agentName + ' (' + agentAI + '). ';

  try {
    var catalogMod = await import('./engine/ollama-catalog.js');
    var detection = await catalogMod.detectInstalledModels();
    if (!detection.ok) {
      return base + 'Ollama no responde en este ordenador -- instalalo (ollama.com) o arrancalo, y vuelve a intentarlo.';
    }
    if (!detection.installed || detection.installed.length === 0) {
      return base + 'Ollama esta corriendo pero no tiene ningun modelo descargado. Descarga uno pequeño para empezar: "ollama pull llama3.2:1b-instruct-q4_K_M", y vuelve a intentarlo.';
    }
  } catch (e) {
    // La comprobacion en si fallo (no la conexion a Ollama) -- se cae al
    // mensaje generico de siempre en vez de bloquear la respuesta por esto.
  }

  return base + 'Revisa "linkcore status" para ver el detalle, o reintenta.';
}

export { getMemoryContext, addMemory, clearMemory, loadMemory } from './tools.js';

// Limpieza (2026-08-16, carpeta separada solo-procesador): se elimina toda
// la superficie de "asistente personal" del antiguo producto (X1/Vektor) --
// auth de Google, proactividad (email/calendario), Google Docs/Gmail/
// Calendar/Sheets/Drive, auth y gestion de issues/PRs de GitHub, Google
// Custom Search, deploy/gestion de proyectos Vercel, y los stubs de
// CodeRabbit/Codeium (que ni siquiera tenian integracion real, ver sus
// propios comentarios). Nada de esto participa en intermediacion, ensemble
// o verificacion -- es la app de asistente de productividad que LinkCore
// no es. Se confirmo con grep, funcion por funcion, que ningun archivo del
// procesador real (src/engine/*, orchestrator, ensemble, kimi-k3, etc.)
// llama a ninguna de ellas.
//
// Se conservan intactas SOLO 3 funciones de GitHub -- getGithubToken,
// fetchGithubRepoTree, fetchGithubFileContent -- porque
// src/engine/github-search.js (busqueda semantica real de codigo, parte
// del procesador) las usa de verdad para indexar un repo bajo demanda.
function getLocalJSON(key) { try { var raw = localStorage.getItem('x1_' + key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
function setLocalJSON(key, value) { try { localStorage.setItem('x1_' + key, JSON.stringify(value)); } catch (e) {} }
function removeLocal(key) { try { localStorage.removeItem('x1_' + key); } catch (e) {} }

export function getGithubToken() { return Promise.resolve(getLocalJSON('github_token')); }

// Arbol de archivos real de un repo (API real de Git Trees, recursivo) +
// contenido real de un archivo (API real de Contents, decodificado de
// base64) -- usado por github-search.js para indexar un repo bajo demanda.
export function fetchGithubRepoTree(token, owner, repo) {
  return fetch('https://api.github.com/repos/' + owner + '/' + repo, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
  }).then(function (r) { return r.json(); }).then(function (info) {
    var branch = (info && info.default_branch) || 'main';
    return fetch('https://api.github.com/repos/' + owner + '/' + repo + '/git/trees/' + branch + '?recursive=1', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !Array.isArray(data.tree)) return [];
      return data.tree.filter(function (t) { return t.type === 'blob'; }).slice(0, 300).map(function (t) { return { path: t.path, sha: t.sha }; });
    });
  }).catch(function () { return []; });
}
export function fetchGithubFileContent(token, owner, repo, path) {
  return fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/'), {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (!data || data.encoding !== 'base64' || !data.content) return { ok: false, error: 'No se pudo leer el archivo.' };
    try {
      var text = decodeURIComponent(atob(data.content.replace(/\n/g, '')).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return { ok: true, content: text };
    } catch (e) {
      return { ok: false, error: 'Archivo binario, no se puede mostrar como texto.' };
    }
  }).catch(function () { return { ok: false, error: 'Error de red leyendo el archivo.' }; });
}

export { WORKER_ORIGIN };

