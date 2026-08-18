import { OLLAMA_MODELS, selectDiverseOllama, MAX_SAFE_MODEL_SIZE_MB } from './ollama-catalog.js';

// Bug real, grave, confirmado en vivo (2026-08-14): kimiOrchestrate() y
// kimiRouteToBestModel() construian su lista de "empleados" disponibles
// filtrando OLLAMA_MODELS solo por `installed`, sin el mismo guardia de
// tamaño que ya usa selectDiverseOllama() (MAX_SAFE_MODEL_SIZE_MB, 60% de
// la RAM total). Consecuencia real: la jefa (Kimi K3, llama3.2:3b) recibia
// gemma4:latest (9608MB, marcado installed:true, mas grande que TODA la
// RAM de esta maquina) como una opcion valida en su lista de candidatos, y
// lo elegia como "el mas capaz" -- ella no tiene forma de saber que ese
// empleado no cabe. El paso siguiente (evictForModel(), ya con guardia
// propio desde hoy) rechaza cargarlo, pero para entonces la jefa ya tomo
// una decision imposible de cumplir. Se filtra aqui, en el origen: la lista
// que ve la jefa nunca incluye a alguien que no puede contratar.
function installedAndSafe() {
  return OLLAMA_MODELS.filter(function (m) {
    return m.installed && m.id.indexOf('embed') === -1 && (m.sizeMB || 0) <= MAX_SAFE_MODEL_SIZE_MB;
  });
}

var ORCHESTRATOR_MODEL = 'llama3.2:3b';
// Bug real, grave, confirmado en vivo (2026-08-14): 8000ms no alcanza ni de
// lejos para que la jefa (llama3.2:3b, CPU sin GPU) complete su propia
// decision de enrutamiento -- medido en vivo, la MISMA llamada (100 tokens
// de presupuesto) tarda ~20.2s en responder. Con 8s de margen, Kimi K3
// fallaba por timeout en la inmensa mayoria de los casos, degradando
// SIEMPRE a "router no devolvio JSON valido, pipeline completo" (ver el
// catch de kimiOrchestrate() mas abajo) -- la "IA principal orquestando
// especializadas" de la definicion del producto nunca llegaba a decidir
// nada real, solo fallaba en silencio una y otra vez. Subido a un valor con
// margen real sobre lo medido, no al limite exacto (20.2s + margen para
// variacion de carga de la maquina, cold-load si el modelo no esta ya
// caliente).
var ORCHESTRATOR_TIMEOUT = 45000;
var ORCHESTRATOR_MAX_TOKENS = 100;

export function isKimiAvailable() {
  var model = OLLAMA_MODELS.find(function(m) { return m.id === ORCHESTRATOR_MODEL; });
  return model && model.installed;
}

async function callOrchestratorPrompt(prompt, opts) {
  opts = opts || {};
  var startedAt = Date.now();

  try {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || ORCHESTRATOR_TIMEOUT);

    var res = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ORCHESTRATOR_MODEL,
        messages: [
          { role: 'system', content: opts.systemPrompt || 'Eres el orquestador de LinkCore.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: opts.maxTokens || ORCHESTRATOR_MAX_TOKENS,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.1,
        keep_alive: '5m',
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    var data = await res.json().catch(function () { return {}; });

    if (!res.ok || !data.choices || !data.choices[0]) {
      return { ok: false, model: ORCHESTRATOR_MODEL, error: (data && data.error) || ('HTTP ' + res.status) };
    }

    var text = (data.choices[0].message && data.choices[0].message.content || '').trim();
    if (!text) {
      return { ok: false, model: ORCHESTRATOR_MODEL, error: 'empty_response' };
    }

    return {
      ok: true,
      text: text,
      model: ORCHESTRATOR_MODEL,
      provider: 'ollama-local',
      latencyMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      ok: false,
      model: ORCHESTRATOR_MODEL,
      error: e && e.name === 'AbortError' ? 'timeout' : (e && e.code === 'ECONNREFUSED' ? 'ollama_no_esta_corriendo' : (e && e.message) || 'network_error'),
    };
  }
}

export async function callKimiK3(query, opts) {
  return callOrchestratorPrompt(query, opts);
}

export async function kimiOrchestrate(query, opts) {
  opts = opts || {};
  var startedAt = Date.now();

  var installedModels = installedAndSafe();
  var modelIds = installedModels.map(function(m) { return m.id; }).join(', ');

  // Bug real, confirmado en vivo (2026-08-14), en DOS capas:
  // 1) El system prompt original ("Orquestador. d=directo,e=ensemble.
  //    Respuesta corta.") era demasiado criptico -- el modelo lo ignoraba
  //    por completo y contestaba la pregunta del usuario en prosa normal,
  //    sin rastro de JSON.
  // 2) Tras hacer el system prompt mas directivo, el modelo SI producia
  //    JSON valido -- pero con un esquema inventado por el mismo
  //    (`{"v":[...], "dv":[...]}`, listando ventajas/desventajas de la
  //    pregunta) en vez de las claves pedidas (s/r/m/t), porque el formato
  //    compacto "T:...\nM:...\nJSON:{...}" no deja claro que la tarea del
  //    usuario NO se debe responder, solo enrutar. Se sustituye por
  //    instrucciones en lenguaje natural + un ejemplo COMPLETO y concreto
  //    del JSON esperado (no una plantilla con "..."), verificado en vivo:
  //    con este formato el modelo de 3B produce el esquema exacto pedido.
  var prompt = 'Tarea del usuario a enrutar (NO la respondas, solo decide como enrutarla): "' + query.slice(0, 300) + '"\n' +
    'Modelos disponibles: ' + modelIds + '\n' +
    'Tu unica salida debe ser exactamente un JSON con estas claves (s, r, m, t), como este ejemplo:\n' +
    '{"s":"e","r":"motivo breve de la decision","m":["' + (installedModels[0] ? installedModels[0].id : 'modelo-id') + '"],"t":null}\n' +
    's = "d" (respuesta directa, sin ensemble) o "e" (ensemble). Si s="d", pon la respuesta real en "t"; si s="e", deja "t":null.';

  var result = await callOrchestratorPrompt(prompt, {
    systemPrompt: 'Eres un router. Tu unica salida es un objeto JSON con las claves exactas s,r,m,t. Nunca respondas la tarea del usuario, solo decide como enrutarla.',
    maxTokens: 150,
    temperature: 0.1,
  });

  if (!result.ok) {
    return null;
  }

  try {
    var cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // Red de seguridad (2026-08-14): si aun con la instruccion explicita el
    // modelo mete el JSON en medio de prosa, se extrae el primer objeto
    // `{...}` en vez de exigir que TODA la respuesta sea JSON puro.
    if (cleaned.charAt(0) !== '{') {
      var jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleaned = jsonMatch[0];
    }
    var parsed = JSON.parse(cleaned);
    // Bug real, confirmado en vivo (2026-08-14): el prompt pide al modelo
    // la letra corta ("d"/"e", ver mas arriba), pero los dos callers reales
    // (backend.js#smartQuery, orchestrator.js#runOrchestration) comprueban
    // el string completo `=== 'direct'` -- con `strategy` quedandose como
    // la letra literal "d", esa comprobacion nunca era verdadera, asi que
    // el camino de respuesta directa de Kimi K3 (cuando SI decide
    // correctamente que no hace falta ensemble) era codigo muerto en la
    // practica, cayendo siempre al pipeline completo aunque Kimi acertara.
    // No se detecto antes porque Kimi casi nunca completaba a tiempo (ver
    // el fix de ORCHESTRATOR_TIMEOUT mas arriba); al arreglar eso, este
    // desajuste paso de invisible a real. Se normaliza aqui, en el unico
    // punto que produce el valor, en vez de tocar cada consumidor.
    var rawStrategy = parsed.s || parsed.strategy || 'e';
    var strategy = (rawStrategy === 'd' || rawStrategy === 'direct') ? 'direct' : 'ensemble';
    return {
      ok: true,
      strategy: strategy,
      reason: parsed.r || parsed.reason || '',
      models: parsed.m || parsed.models || [],
      response: parsed.t || parsed.text || parsed.response || null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (e) {
    // Bug real, critico: este orquestador (llama3.2:3b, 100 tokens, JSON
    // comprimido) solo tiene un trabajo, decidir direct-vs-ensemble -- NUNCA
    // se le pidio que respondiera la query. Cuando el modelo pequeño no
    // logra producir JSON valido (probable, dado el presupuesto de tokens),
    // este catch devolvia strategy:'direct' con response:result.text -- el
    // intento fallido y truncado del modelo de ESCRIBIR el JSON de
    // enrutamiento, no una respuesta real. Los dos callers
    // (backend.js#smartQuery, orchestrator.js#runOrchestration) tratan
    // exactamente esa combinacion (`strategy==='direct' && response`) como
    // "esta es la respuesta final, no hace falta nada mas" -- asi que
    // cualquier query >200 caracteres podia acabar recibiendo como
    // respuesta final un fragmento de JSON roto en vez de pasar por
    // ensemble/orquestacion. Ahora un fallo de parseo degrada a 'ensemble'
    // (pipeline completo) en vez de fingir una respuesta directa que nunca
    // se genero.
    return {
      ok: true,
      strategy: 'ensemble',
      reason: 'router no devolvio JSON valido, degradando a pipeline completo',
      models: [],
      response: null,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export async function kimiRouteToBestModel(query, category) {
  var modelIds = installedAndSafe().map(function(m) { return m.id; }).join(',');

  var result = await callOrchestratorPrompt('Q:' + query.slice(0, 200) + '\nIDs:' + modelIds + '\nID:', {
    systemPrompt: 'Solo el ID.',
    maxTokens: 30,
    temperature: 0.1,
  });

  if (result.ok && result.text) {
    var modelId = result.text.trim().replace(/['"]/g, '').split('\n')[0].trim();
    var found = OLLAMA_MODELS.find(function(m) { return m.id === modelId; });
    if (found) return found;
  }

  var fallback = selectDiverseOllama(category || 'general', 1, [], { preferCapability: true });
  return fallback.ok && fallback.selected.length ? fallback.selected[0] : null;
}
