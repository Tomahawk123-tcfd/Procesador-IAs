// ═══════════════════════════════════════════════════════════════
// LINKCORE CREW — CrewAI/AutoGen-style Agent Framework
// 3 Layers: Universal Translation + Consensus + Shared Memory
// Handles: apps, documents, presentations, audio, images, video
// ═══════════════════════════════════════════════════════════════

import { callAI, WORKER_ORIGIN } from '../backend.js';
import {
  coordinate as middlewareCoordinate,
  memWrite as middlewareMemWrite,
  memReadAll as middlewareMemReadAll,
  memFormat as middlewareMemFormat,
} from './middleware.js';
import { buildContextPacket, translateForModel, detectThinkingStyle } from './semantic-translator.js';
import { getCognitiveProfile } from '../ai-registry.js';
import { computeContentConfidence } from './translation.js';

// ═══════════════════════════════════════════
// DELIVERABLE TYPE DETECTION
// ═══════════════════════════════════════════

var DELIVERABLE_TYPES = {
  // Bug real (2026-07-30), encontrado reproduciendo "Escribe un email
  // profesional pidiendo una reunion": no existia un tipo 'email' propio,
  // asi que caia al generico 'text', que no tiene prompts para coder/
  // designer (solo writer/planner/analyst en DELIVERABLE_PROMPTS.text).
  // Cuando el plan generado por el planner asignaba un paso a coder o
  // designer (facil que pase: el planner solo tiene un prompt vago,
  // "crea un plan de 2-4 pasos"), ese paso usaba el system prompt
  // GENERICO del agente (ej. "Eres el Diseñador UI de LinkCore...") sin
  // relacion con escribir un correo, produciendo contenido fuera de tema
  // que a veces ganaba como "salida de mayor confianza" y sustituia el
  // email real. 'email' tiene que ir ANTES que 'document' -- si no, el
  // "\bcontenido\b" de document la captura primero.
  email: /escribe.*(email|correo)|redacta.*(email|correo)|email.*profesional|correo.*formal|draft.*email|borrador.*email|\bcorreo electronico\b/i,
  // Bug real (2026-07-31), encontrado reproduciendo "Investiga a fondo
  // las ventajas de TypeScript frente a Python para APIs de alta
  // concurrencia": disparadores sueltos sin limite de palabra (`api`,
  // `css`, `react`, `build`, `pagina`, `desarrolla`...) hacian que
  // "APIs" (dentro de una pregunta de investigacion) bastara para
  // clasificar la tarea entera como "construir una app" -- el pipeline
  // de app ejecutaba pasos de Diseñador/Escritor que generaban la
  // paleta de colores/CSS de LinkCore, sin relacion alguna con la
  // pregunta real del usuario. Exige verbo de construccion + sustantivo
  // de producto, igual que el mismo fix ya aplicado en
  // task-decomposer.js para el trigger 'code-project'.
  // Bug real, severo (2026-08-12), mismo patron que APP_TRIGGER en
  // build-pipeline-planner.js y 'code-project' en task-decomposer.js: el
  // `.*` sin limite cruzaba frases enteras. Reproducido en vivo: "Crea un
  // plan de dos pasos: primero resume que es una red neuronal, despues
  // explica una aplicacion practica" (un resumen, sin proyecto de por
  // medio) se clasifico como 'app' -> useCrew=true -> runCrew() con roles
  // Analista/Escritor/Diseñador totalmente ajenos a la pregunta real,
  // 30+ minutos, respuesta final sobre "diseñar la estructura del sitio
  // web con CSS". Mismo fix: no cruza puntuacion de fin de frase, exige
  // articulo antes del sustantivo, rechaza si le sigue un adjetivo que lo
  // delate como abstracto.
  app: /\b(crea|programa|desarrolla|construye|implementa|monta|lanza|despliega)\b[^.:;!?\n]{0,40}\b(?:una?|el|la|mi|esta|nuestro|nuestra)\s+(app|aplicaci[oó]n|c[oó]digo|pagina\s+web|landing|dashboard|proyecto|sistema|plataforma|producto|api)\b(?!\s+(pr[aá]ctica|te[oó]rica|conceptual))|\bnuevo\s+proyecto\b|\b(create|build|implement)\b[^.:;!?\n]{0,40}\b(?:an?|the|my)\s+(app|project|website|dashboard|api)\b|\bdespliega(r)?\b[^.:;!?\n]{0,40}\bvercel\b/i,
  document: /escribe.*doc|crea.*doc|redacta|genera.*informe|propuesta|contrato|articulo|blog|contenido|escritura|writing|draft|borrador|whitepaper|paper|ensayo|guia|manual|plan.*de.*negocio|canvas/i,
  presentation: /presentacion|slides|diapositiva|pitch|deck|powerpoint|keynote|exposicion|conferencia|charla|ponencia/i,
  audio: /voz.*off|voice.?over|narracion|locucion|grabar.*voz|generar.*audio|texto.*audio|tts|leer.*texto|leeme|lee.*esto|convertir.*texto.*audio|sintesis.*vocal|audio.*generado|podcast|locutor|sonido|musica|cancion/i,
  // Bug real, encontrado en vivo (2026-08-10) probando el fix de arriba:
  // "foto" y "pic" sin limite atrapan substrings dentro de otras palabras
  // ("fotos[i]ntesis", "t[i]pico"). Segundo bug real, encontrado probando
  // la PROPIA correccion: \b en JS solo reconoce [A-Za-z0-9_] como
  // caracter de palabra -- una vocal acentuada ("í" en "fotosíntesis")
  // cuenta como limite de palabra igual que un espacio, asi que
  // "\bfoto(s)?\b" seguia coincidiendo con "fotos" dentro de
  // "fotos[í]ntesis". Se usa un lookahead negativo explicito contra
  // cualquier letra (incluidas acentuadas) en vez de \b.
  image: /genera.*imagen|crea.*imagen|dibuja|illustra|image.*generat|\bpic(?![a-zà-ÿ])|\bfoto(s)?(?![a-zà-ÿ])|imagen.*de|banner|logo|icono|mockup|diseno.*visual|poster|infografia/i,
  video: /genera.*video|crea.*video|video.*explicativo|animacion|animate|motion|promo.*video|reel|tiktok|youtube/i,
  data: /analiza.*datos|procesa.*datos|grafica|visualiza|estadistica|data.*analysis|dashboard|metricas|kpi|excel|csv|hoja.*calcul|grafico|chart/i,
  // Bug real, catastrofico, encontrado en vivo (2026-08-10): "que.*es"
  // (sin anclar) no exige que las dos palabras esten juntas -- solo que
  // "que" aparezca en algun punto y las dos letras "es" en CUALQUIER
  // punto posterior, aunque sea a mitad de otra palabra ("d[es]canso",
  // "d[es]arrollo", "r[es]to"...). Un problema de matematicas de una
  // frase ("...maiz que ocupe... y el resto para descanso, calcula el
  // area... mostrando el desarrollo paso a paso") lo disparaba entero,
  // clasificando una pregunta simple de calculo como "informe de
  // investigacion" -- el pipeline mas pesado del sistema (6 pasos,
  // deteccion/mediacion de contradicciones, ~20 min), con el resultado
  // real de una respuesta incoherente donde una directa habria bastado.
  // Se ancla a la expresion real que se queria capturar ("que es X?"),
  // con las dos palabras adyacentes.
  //
  // Bug real, severo (2026-08-12): incluso anclado, "qué es X" (la
  // pregunta mas comun del español) seguia bastando solo, igual que
  // define/explica/mejores/recomienda -- una peticion de resumen con
  // "...primero resume que es una red neuronal..." disparaba 'research'
  // y escalaba a runCrew() (6 pasos, minutos) para lo que era una
  // pregunta trivial. Mismo criterio ya aplicado en task-decomposer.js:
  // las señales debiles (que es/define/explica/mejores/recomienda) solo
  // cuentan si la query TAMBIEN tiene una señal real de necesitar
  // informacion externa (actual, tendencias, comparar, fuentes...).
  // investiga/research/estudia/etc. siguen bastando solas.
  research: {
    test: function (t) {
      var strong = /investiga|research|busca.*informacion|analiza.*mercado|estudia|explora.*tema|deep.*dive|reporte|informe.*detallado/i;
      var weakVerb = /\bqu[eé]\s+es\b|\bdefine\b|\bexplica\b|\bmejores\b|\brecomienda\b|\bcompara\b|\bevalua\b/i;
      var externalSignal = /\bactual(es|idad)?\b|\breciente(s)?\b|\b[uú]ltim[oa]s?\b|\bnoticias?\b|\bmercado\b|\bcompara(r|cion|ci[oó]n)?\b|\bfuentes?\b|\best[ao]d[ií]sticas?\b|\btendencias?\b|\bprecios?\b|\bventajas?\b|\bfrente a\b|\bversus\b|\bvs\.?\b/i;
      return strong.test(t) || (weakVerb.test(t) && externalSignal.test(t));
    },
  },
};

function detectDeliverableType(query) {
  for (var type in DELIVERABLE_TYPES) {
    if (DELIVERABLE_TYPES[type].test(query)) return type;
  }
  return 'text';
}

// ═══════════════════════════════════════════
// LAYER 1: SHARED MEMORY
// ═══════════════════════════════════════════
//
// HASTA 2026-07-28 este modulo mantenia su PROPIO store en RAM
// (`var memoryStore = {}`), en paralelo al de middleware.js/memory.js --
// pese a que ya importaba middlewareMemWrite/middlewareMemFormat sin
// usarlos para el camino real. Es el propio codigo reproduciendo, dentro
// de LinkCore, el sintoma exacto que LinkCore existe para resolver:
// "os solapais entre vosotras". Dos runCrew() consecutivos pisaban las
// mismas claves planas (`coder_output`, `writer_output`...) porque nada
// distinguia una ejecución de la siguiente, y todo se perdia al recargar
// porque memory.js tampoco persistia entonces (ver su cabecera).
//
// Arreglo real, no cosmetico -- con una correccion sobre la marcha que
// vale la pena dejar escrita porque casi se cuela: el primer intento
// confio en el `branch` de memory.js para el aislamiento (write(key,
// value, agent, {branch}))). Un test con dos ejecuciones simultaneas
// escribiendo la misma clave logica ('coder_output') en dos branches
// distintas demostro que se PISABAN igual que antes. Causa: en
// memory.js, `_store[key]` es UN SOLO slot global por nombre de clave;
// `branch` es solo una etiqueta sobre ese slot, no un espacio de
// almacenamiento separado por (branch, key). `_branches[branch][key] =
// version` es un indice de "que branch toco esta clave", no una copia
// del valor. Nadie en el codebase habia usado `opts.branch` en un write()
// antes de este cambio, asi que el bug llevaba ahi desde siempre sin que
// nada lo ejercitara -- exactamente el tipo de fallo que solo aparece al
// intentar usar de verdad una feature que llevaba tiempo sin probarse.
//
// Arreglo que SI aisla: la clave real que se escribe en el store lleva el
// identificador del run como prefijo (`crew_171234::coder_output`), asi
// que dos ejecuciones nunca comparten slot aunque se solapen en el
// tiempo -- el aislamiento vive en el nombre de la clave, no en una
// etiqueta que memory.js no llega a respetar. Los hechos DURABLES de una
// ejecución (plan, respuesta final, URL de deploy) se escriben SIN
// prefijo, en la clave plana de siempre, que es la que orchestrator.js ya
// lee -- asi un runCrew() de hoy informa a un runOrchestration() de
// manana sin que el usuario repita contexto.

function branchFor(runId) { return 'crew_' + runId; }
function scopedKey(key, branch) { return branch ? (branch + '::' + key) : key; }

function memoryWrite(key, value, agent, branch) {
  middlewareMemWrite(scopedKey(key, branch), value, agent);
}

function memoryRead(key, branch) {
  var all = middlewareMemReadAll();
  var entry = all[scopedKey(key, branch)];
  return entry ? entry.value : null;
}

function memoryReadAll(branch) {
  var entries = middlewareMemReadAll();
  var prefix = branch ? branch + '::' : null;
  var out = {};
  Object.keys(entries).forEach(function(k) {
    if (prefix && k.indexOf(prefix) !== 0) return;
    var shortKey = prefix ? k.slice(prefix.length) : k;
    out[shortKey] = entries[k].value;
  });
  return out;
}

function memoryQuery(query, branch) {
  var t = (query || '').toLowerCase();
  var entries = middlewareMemReadAll();
  var prefix = branch ? branch + '::' : null;
  var results = [];
  Object.keys(entries).forEach(function(k) {
    if (prefix && k.indexOf(prefix) !== 0) return;
    var entry = entries[k];
    var val = String(entry.value || '').toLowerCase();
    if (k.toLowerCase().indexOf(t) !== -1 || val.indexOf(t) !== -1) {
      results.push({ key: prefix ? k.slice(prefix.length) : k, value: entry.value, agent: entry.agentId });
    }
  });
  return results;
}

// Formatea la memoria DE ESTA EJECUCION (claves con su prefijo de run)
// fusionada con los hechos durables (claves planas, sin prefijo de
// ninguna otra ejecucion) -- asi cada paso ve tanto lo que ya hicieron
// sus companeros en este mismo run como lo que se decidio en sesiones
// anteriores, sin que el usuario tenga que repetirlo. Una clave plana que
// resulte ser el prefijo casual de otra (raro, pero posible) no puede
// colarse: se exige el separador '::' completo, no solo el texto.
function memoryFormat(branch) {
  var entries = middlewareMemReadAll();
  var prefix = branch ? branch + '::' : null;
  var lines = [];
  Object.keys(entries).forEach(function(k) {
    var isThisRun = prefix && k.indexOf(prefix) === 0;
    var isDurable = k.indexOf('::') === -1; // sin '::' = clave plana = hecho durable en 'main'
    if (!isThisRun && !isDurable) return;
    var e = entries[k];
    var shortKey = isThisRun ? k.slice(prefix.length) : k;
    lines.push('- [' + e.agentId + '] ' + shortKey + ': ' + String(e.value).slice(0, 200));
  });
  if (!lines.length) return '';
  return ['Memoria compartida entre agentes:'].concat(lines).join('\n');
}

// Ya no hace falta "limpiar" nada entre ejecuciones: cada runCrew() usa
// una rama nueva por diseno, asi que el aislamiento es automatico. Se
// mantiene exportada por compatibilidad de API mas que nada.
function memoryClear() { /* no-op: el aislamiento es por rama, no por reset global */ }

// ═══════════════════════════════════════════
// LAYER 2: UNIVERSAL TRANSLATION
// ═══════════════════════════════════════════

function translateInput(query, agent, previousAgentOutputs, branch) {
  // Bug real, encontrado en vivo (2026-08-10): memoryFormat(branch) como
  // valor por defecto de 'context' se usaba TAL CUAL para el primer paso
  // de cualquier plan (antes de que exista trabajo real de otro agente) --
  // en ese punto memoryFormat() solo tiene metadatos de proceso
  // ("- [system] deliverable_type: research", "- [planner] plan: ...").
  // Un modelo pequeño, al generar una seccion de "fuentes recomendadas",
  // confundio ese formato con contenido citable y lo repitio como si
  // fueran fuentes reales ("[LinkCore] - [Planner Output]: ..."). El
  // contexto UTIL de pasos anteriores ya se construye aparte, mas abajo
  // (buildContextPacket/translateForModel), cuando SI hay salida real de
  // otro agente -- memoryFormat() nunca hacia falta aqui como valor por
  // defecto, solo generaba ruido con apariencia de dato real.
  var base = {
    goal: query,
    context: 'Sin contexto previo.',
    constraints: 'Responde en espanol. Formato profesional. Sin emojis.',
    agent: agent.role,
    category: agent.primaryCategory,
    timestamp: Date.now(),
  };

  if (previousAgentOutputs && previousAgentOutputs.length > 0) {
    var relevantOutputs = previousAgentOutputs.filter(function(o) { return o && o.success && o.data; });
    if (relevantOutputs.length > 0) {
      var targetProfile = getCognitiveProfile({ provider: 'default', category: agent.primaryCategory });
      var contextParts = [];

      relevantOutputs.forEach(function(output) {
        var packet = buildContextPacket(
          output.data,
          { name: output.model || 'previous-agent', id: null, elo: 1300 },
          agent.role
        );
        if (packet) {
          contextParts.push(translateForModel(packet, targetProfile));
        } else {
          contextParts.push(output.data.slice(0, 800));
        }
      });

      base.context = 'Resultados de agentes previos (traducidos para ti):\n\n' + contextParts.join('\n\n---\n\n');
    }
  }

  return base;
}

function translateOutput(raw, agent) {
  if (!raw || !raw.text) return { success: false, data: null, confidence: 0 };
  var text = raw.text;
  // Bug real (2026-07-30): esta formula propia colapsaba casi siempre en el
  // mismo numero -- la inmensa mayoria de respuestas de un LLM superan 100
  // caracteres Y tienen un "- " o "**" en alguna parte, asi que 0.5+0.2+0.1
  // = 0.6 salia para practicamente cualquier respuesta real, exactamente
  // como el bug ya corregido en normalizeToStandard() de translation.js.
  // Se unifica con la misma heuristica de contenido en vez de mantener dos
  // formulas distintas que coincidian por casualidad en el mismo defecto.
  var confidence = computeContentConfidence(text);
  return {
    success: true,
    data: text,
    model: raw.model,
    provider: raw.provider,
    agent: agent.role,
    confidence: confidence,
    timestamp: Date.now(),
  };
}

// ═══════════════════════════════════════════
// LAYER 3: CONSENSUS & MEDIATION
// ═══════════════════════════════════════════

function detectContradictions(outputs) {
  var contradictions = [];
  var valid = outputs.filter(function(o) { return o && o.success; });
  for (var i = 0; i < valid.length; i++) {
    for (var j = i + 1; j < valid.length; j++) {
      var a = (valid[i].data || '').toLowerCase();
      var b = (valid[j].data || '').toLowerCase();
      var signals = ['no es correcto', 'estoy en desacuerdo', 'error', 'falso', 'equivocado', 'no coincide', 'contradice'];
      for (var s = 0; s < signals.length; s++) {
        if (a.indexOf(signals[s]) !== -1 || b.indexOf(signals[s]) !== -1) {
          contradictions.push({
            agents: [valid[i].agent, valid[j].agent],
            signal: signals[s],
            output1: valid[i].data.slice(0, 500),
            output2: valid[j].data.slice(0, 500),
          });
          break;
        }
      }
    }
  }
  return contradictions;
}

async function mediate(contradictions, context) {
  if (!contradictions.length) return null;
  var prompt = 'Contradiccion detectada entre agentes especializados.\n\n';
  // Defensa adicional a la correccion en memory.js#detectSemanticConflicts:
  // cualquier detector de contradicciones futuro que no incluya `.agents`/
  // `.output1`/`.output2` en la raiz del objeto se salta en vez de tumbar
  // TODO el ensemble a mitad de mediacion -- un desacuerdo que no se puede
  // describir no es motivo para perder la respuesta que si se obtuvo.
  contradictions.forEach(function(c) {
    if (!c || !Array.isArray(c.agents) || c.agents.length < 2) return;
    prompt += 'Agente ' + c.agents[0] + ': ' + (c.output1 || '') + '\n\n';
    prompt += 'Agente ' + c.agents[1] + ': ' + (c.output2 || '') + '\n\n';
  });
  prompt += 'Contexto: ' + (context || 'Ninguno') + '\n\n';
  prompt += 'Resuelve la contradiccion. Si no puedes, presenta ambas posturas con sus argumentos y recomendacion.';
  var result = await callAI(prompt, {
    systemPrompt: 'Eres un mediador experto. Resuelve contradicciones entre agentes de IA con evidencia y razonamiento.',
    category: 'reasoning',
    maxTokens: 2000,
    temperature: 0.2,
  });
  return result ? result.text : null;
}

function unifyResponses(outputs, mediation) {
  var valid = outputs.filter(function(o) { return o && o.success; });
  if (!valid.length) return 'No se obtuvieron respuestas de los agentes.';
  var avgConfidence = valid.reduce(function(s, o) { return s + o.confidence; }, 0) / valid.length;
  var lines = [];

  // Bug real (2026-07-30), encontrado reproduciendo "Escribe un email
  // profesional pidiendo una reunion": cuando el detector de
  // contradicciones (regex sobre numeros sueltos, con falsos positivos ya
  // documentados) marcaba una contradiccion, esta funcion DESCARTABA por
  // completo el contenido real de los agentes (el email de verdad que el
  // writer ya habia escrito) y mostraba SOLO lo que el mediador
  // respondiera -- que en este caso fue una descripcion de la memoria
  // compartida ("incluyendo [planner], [designer], [coder]...") en vez de
  // una respuesta util, porque la "contradiccion" que se le paso a
  // mediar no era real. El contenido real del equipo va SIEMPRE primero;
  // la mediacion se anade como nota aparte solo si aporta algo, nunca
  // sustituye el trabajo ya hecho.
  var primary = valid.length === 1 ? valid[0] : valid.slice().sort(function(a, b) { return b.confidence - a.confidence; })[0];
  lines.push(primary.data);

  if (valid.length > 1) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Agentes consultados:**');
    valid.forEach(function(o) {
      lines.push('- `' + o.agent + '` (' + o.model + '/' + o.provider + ') — confianza: ' + Math.round(o.confidence * 100) + '%');
    });
  }

  if (mediation) {
    lines.push('');
    lines.push('**Nota de conciliacion** (se detecto una posible discrepancia entre agentes):');
    lines.push(mediation);
  }

  lines.push('');
  lines.push('**Confianza promedio:** ' + Math.round(avgConfidence * 100) + '%');
  return lines.join('\n');
}

// ═══════════════════════════════════════════
// DELIVERABLE-SPECIFIC SYSTEM PROMPTS
// ═══════════════════════════════════════════

var DELIVERABLE_PROMPTS = {
  app: {
    coder: 'Eres el Desarrollador Principal de LinkCore. Genera codigo COMPLETO y FUNCIONAL para una aplicacion web.\n\nRequisitos obligatorios:\n- Archivos HTML, CSS y JS completos (no fragmentos)\n- Diseño responsivo y profesional\n- Manejo de errores incluido\n- Codigos de colores y estilos consistentes\n- Estructura de archivos clara\n\nFormato de entrega:\n- Primer bloque: index.html completo\n- Segundo bloque: style.css completo\n- Tercer bloque: app.js completo\n- Cada bloque en ```html, ```css, ```js respectivamente\n\nNO des explicaciones. SOLO entrega el codigo listo para ejecutar.',
    planner: 'Eres el Arquitecto de Software de LinkCore. Analiza la peticion y define: stack tecnologico, estructura de archivos, funcionalidades core, y dependencias. Plan concreto con 2-4 pasos.',
    writer: 'Eres el Documentador de LinkCore. Genera el README.md del proyecto con: descripcion, como instalar, como usar, y screenshots ASCII.',
    designer: 'Eres el Diseñador UI de LinkCore. Define la paleta de colores, tipografia, espaciado, y layout responsivo. Entrega un CSS listo para usar.',
    analyst: 'Eres el QA Engineer de LinkCore. Revisa el codigo generado, detecta bugs, sugiere mejoras de seguridad y rendimiento.',
  },
  email: {
    writer: 'Eres el Redactor de Correos de LinkCore. Escribe el EMAIL COMPLETO, listo para enviar.\n\nFormato:\n- Asunto: una linea clara y especifica\n- Saludo apropiado al contexto (formal/informal segun se pida)\n- Cuerpo: breve, directo, un objetivo claro por parrafo\n- Cierre y firma generica\n\nSOLO el email. Sin explicaciones antes o despues, sin meta-comentarios sobre lo que vas a escribir.',
    planner: 'Eres el Estratega de Comunicacion de LinkCore. Define en 1-2 frases: tono apropiado (formal/informal), objetivo concreto del correo, y cualquier dato que falte para redactarlo (destinatario, fecha propuesta). No escribas el email tu, eso lo hace el redactor.',
    analyst: 'Eres el Revisor de LinkCore. Revisa brevedad, claridad y que el correo tenga una llamada a la accion clara. Sugiere solo si hay algo que corregir.',
  },
  document: {
    writer: 'Eres el Escritor Profesional de LinkCore. Genera el documento COMPLETO en markdown.\n\nRequisitos:\n- Contenido completo, no placeholder ni "aqui va el contenido"\n- Estructura con headers (##, ###)\n- Argumentos con datos y evidencia\n- Conclusiones accionables\n- Formato profesional, sin emojis\n\nEl documento debe ser LISTO PARA USAR. No hables sobre el documento, ESCRIBE el documento.',
    planner: 'Eres el Editor Jefe de LinkCore. Define la estructura del documento: secciones, puntos clave por seccion, tono, y publico objetivo.',
    analyst: 'Eres el Investigador de LinkCore. Proporciona datos, estadisticas y fuentes relevantes para respaldar el contenido del documento.',
    designer: 'Eres el Maquetador de LinkCore. Define formato visual: tablas, listas, callouts, y estructura markdown optima para el tipo de documento.',
  },
  presentation: {
    writer: 'Eres el Presentador de LinkCore. Genera una presentacion completa en formato markdown con diapositivas.\n\nFormato por diapositiva:\n---\n## Titulo de la Diapositiva\n\nContenido principal (viñetas, datos, argumentos)\n\n- Punto clave 1\n- Punto clave 2\n- Punto clave 3\n---\n\nGenera 8-15 diapositivas. Incluye: portada, problema, solucion, mercado, equipo, traction, financials, ask. Cada diapositiva debe tener contenido REAL, no placeholder.',
    planner: 'Eres el Estratega de Pitch de LinkCore. Define la narrativa: que contar, en que orden, y que dato clave en cada diapositiva.',
    analyst: 'Eres el Analista de Mercado de LinkCore. Proporciona datos de mercado, TAM/SAM/SOM, competidores, y metricas clave.',
    designer: 'Eres el Diseñador de Pitch Deck de LinkCore. Define el estilo visual, colores por tipo de diapositiva, y layout optimo.',
  },
  audio: {
    writer: 'Eres el Guionista de Audio de LinkCore. Genera el guion COMPLETO optimizado para locucion.\n\nFormato:\n- Texto natural para leer en voz alta\n- Marca pausas con [...] (3 segundos) y [..] (1 segundo)\n- Marca énfasis con MAYUSCULAS\n- Indica tono entre parentesis: (tono: entusiasta), (tono: serio)\n- Incluye estimacion de duracion por seccion\n\nEl guion debe sonar NATURAL leido en voz alta. Evita frases escritas, usa lenguaje conversacional.',
    planner: 'Eres el Director de Audio de LinkCore. Define: duracion total, estructura (intro-desarrollo-cierre), tono, audiencia objetivo, y estilo de narracion.',
    analyst: 'Eres el Investigador de Contenido de LinkCore. Proporciona datos, anécdotas y datos curiosos para enriquecer el guion.',
  },
  image: {
    designer: 'Eres el Art Director de LinkCore. Genera prompts DETALLADOS para generacion de imagenes.\n\nFormato por prompt:\n- Sujeto principal: que aparece\n- Estilo: fotografico/illustration/3d/watercolor/etc\n- Composicion: plano, angulo, encuadre\n- Iluminacion: tipo, direccion, color\n- Paleta de colores: dominantes y acentos\n- Texto: si aplica, contenido y tipografia\n- Resolucion: dimensiones recomendadas\n\nGenera 3-5 prompts variados. Cada prompt listo para copiar en DALL-E, Midjourney o Flux.',
    planner: 'Eres el Director Creativo de LinkCore. Define el concepto visual: que comunicar, audiencia, estilo, y variaciones a explorar.',
    writer: 'Eres el Copywriter Visual de LinkCore. Genera textos complementarios: slogans, titulares, y copy para acompanar la imagen.',
  },
  video: {
    writer: 'Eres el Guionista de Video de LinkCore. Genera el guion COMPLETO con estructura visual.\n\nFormato:\n[CORTE 1: Descripcion visual]\nNARRACION: Texto que se dice\n[Duracion: X segundos]\n\n[CORTE 2: Descripcion visual]\nNARRACION: Texto que se dice\n[Duracion: X segundos]\n\nIncluye: tiempos, transiciones, musica de fondo sugerida, y graficos en pantalla.',
    planner: 'Eres el Director de Video de LinkCore. Define: duracion total, estructura narrative, estilo visual, y plataforma objetivo.',
    designer: 'Eres el Storyboard Artist de LinkCore. Describe cada frame: composicion, colores, texto en pantalla, y elementos visuales.',
    analyst: 'Eres el Análisis de Engagement de LinkCore. Define: hook inicial, ritmo, puntos de retention, y call-to-action.',
  },
  data: {
    analyst: 'Eres el Data Scientist de LinkCore. Analiza los datos proporcionados y genera insights accionables.\n\nFormato:\n- Resumen ejecutivo (2-3 lineas)\n- Metricas clave con valores\n- Tendencias identificadas\n- Comparativas relevantes\n- Recomendaciones priorizadas (top 3-5)\n- Visualizaciones sugeridas (tipo de grafico + datos)\n\nEntrega datos CONCRETOS, no generalidades.',
    writer: 'Eres el Narrador de Datos de LinkCore. Transforma los hallazgos del analista en un informe legible con contexto y recomendaciones.',
    planner: 'Eres el Estratega de Datos de LinkCore. Define que metricas son relevantes, que comparativas hacer, y que conclusiones buscar.',
  },
  research: {
    analyst: 'Eres el Investigador Senior de LinkCore. Realiza un análisis profundo con datos concretos.\n\nFormato:\n- Contexto y antecedentes\n- Hallazgos clave (5-10 puntos)\n- Datos y estadisticas relevantes\n- Comparativas con competencia/alternativas\n- Tendencias del mercado\n- Conclusiones y recomendaciones\n- Fuentes citadas\n\nCada punto debe tener EVIDENCIA, no opiniones.',
    writer: 'Eres el Editor de Investigación de LinkCore. Transforma el análisis en un reporte legible, bien estructurado y profesional.',
    planner: 'Eres el Director de Investigación de LinkCore. Define el alcance, preguntas clave, fuentes a consultar, y criterios de calidad.',
    designer: 'Eres el Visualizador de Información de LinkCore. Sugiere tablas, graficos y diagramas para presentar los datos del analisis.',
  },
  text: {
    writer: 'Eres el Escritor de LinkCore. Genera contenido profesional y completo. Directo al punto, sin relleno.',
    planner: 'Eres el Planificador de LinkCore. Estructura el contenido en pasos claros.',
    analyst: 'Eres el Analista de LinkCore. Proporciona datos y evidencia.',
  },
};

// ═══════════════════════════════════════════
// AGENT DEFINITIONS (CrewAI-style)
// ═══════════════════════════════════════════

var AGENT_DEFS = [
  {
    role: 'planner',
    name: 'Planificador',
    goal: 'Analizar la peticion del usuario, descomponerla en subtareas claras y asignar cada una al agente mas adecuado.',
    backstory: 'Experiencia en gestion de proyectos complejos y coordinacion de equipos multidisciplinares.',
    primaryCategory: 'reasoning',
    capabilities: ['reasoning', 'text'],
    systemPrompt: 'Eres el Planificador de LinkCore. Analiza peticiones y crea planes de ejecución claros con pasos concretos.',
  },
  {
    role: 'coder',
    name: 'Desarrollador',
    goal: 'Escribir codigo funcional, limpio y profesional en cualquier lenguaje o framework.',
    backstory: 'Ingeniero senior full-stack con experiencia en multiples frameworks y lenguajes.',
    primaryCategory: 'code',
    capabilities: ['code', 'reasoning'],
    systemPrompt: 'Eres el Desarrollador de LinkCore. Genera codigo completo, funcional y profesional.',
  },
  {
    role: 'writer',
    name: 'Escritor',
    goal: 'Crear contenido escrito profesional: documentos, informes, propuestas, guiones, contenido para apps.',
    backstory: 'Editor profesional con experiencia en multiple formatos y estilos.',
    primaryCategory: 'text',
    capabilities: ['text', 'reasoning'],
    systemPrompt: 'Eres el Escritor de LinkCore. Genera contenido profesional, estructurado y listo para usar.',
  },
  {
    role: 'analyst',
    name: 'Analista',
    goal: 'Analizar datos, tendencias, mercados y situaciones complejas para generar insights accionables.',
    backstory: 'Analista senior con experiencia en investigación de mercado, datos y estrategia.',
    primaryCategory: 'reasoning',
    capabilities: ['reasoning', 'text'],
    systemPrompt: 'Eres el Analista de LinkCore. Realiza análisis profundos con datos concretos y recomendaciones.',
  },
  {
    role: 'designer',
    name: 'Diseñador',
    goal: 'Crear prompts detallados para imagenes, layouts UI/UX, y briefs de diseño visual.',
    backstory: 'Director de arte con experiencia en diseño digital y generacion de contenido visual.',
    primaryCategory: 'text',
    capabilities: ['text', 'reasoning'],
    systemPrompt: 'Eres el Diseñador de LinkCore. Genera prompts detallados y especificaciones visuales.',
  },
  {
    role: 'mediator',
    name: 'Mediador',
    goal: 'Resolver contradicciones entre agentes y unificar respuestas en una coherente.',
    backstory: 'Negociador experto con experiencia en resolucion de conflictos.',
    primaryCategory: 'reasoning',
    capabilities: ['reasoning', 'text'],
    systemPrompt: 'Eres el Mediador de LinkCore. Resuelves contradicciones con evidencia y razonamiento.',
  },
];

function getAgent(role) {
  return AGENT_DEFS.find(function(a) { return a.role === role; }) || AGENT_DEFS[0];
}

// ═══════════════════════════════════════════
// VERCEL DEPLOYMENT
// ═══════════════════════════════════════════

function extractCodeBlocks(text) {
  var blocks = [];
  var regex = /```(\w+)?\n([\s\S]*?)```/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ lang: match[1] || 'text', code: match[2].trim() });
  }
  return blocks;
}

async function deployToVercel(files, projectName) {
  try {
    var res = await fetch(WORKER_ORIGIN + '/vercel/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files, projectName: projectName || 'linkcore-app-' + Date.now() }),
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      return { ok: false, error: err.error || 'Deploy failed' };
    }
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function buildDeployFiles(codeBlocks) {
  var files = [];
  var hasHtml = false;
  codeBlocks.forEach(function(block) {
    var lang = (block.lang || '').toLowerCase();
    if (lang === 'html' || block.code.indexOf('<!DOCTYPE') !== -1 || block.code.indexOf('<html') !== -1) {
      files.push({ file: 'index.html', data: block.code });
      hasHtml = true;
    } else if (lang === 'css' || block.code.indexOf('{') !== -1 && (block.code.indexOf('color:') !== -1 || block.code.indexOf('margin:') !== -1 || block.code.indexOf('padding:') !== -1 || block.code.indexOf('display:') !== -1)) {
      files.push({ file: 'style.css', data: block.code });
    } else if (lang === 'javascript' || lang === 'js') {
      files.push({ file: 'app.js', data: block.code });
    }
  });
  if (!hasHtml && files.length) {
    var cssLink = files.some(function(f) { return f.file === 'style.css'; }) ? '<link rel="stylesheet" href="style.css">' : '';
    var jsLink = files.some(function(f) { return f.file === 'app.js'; }) ? '<script src="app.js"></script>' : '';
    files.unshift({ file: 'index.html', data: '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>LinkCore App</title>\n' + cssLink + '\n</head>\n<body>\n' + jsLink + '\n</body>\n</html>' });
  }
  return files;
}

// ═══════════════════════════════════════════
// CREW EXECUTOR
// ═══════════════════════════════════════════

async function executeStep(agent, task, context, deliverableType, previousAgentOutputs, branch, usedFamilies) {
  // Bug real (2026-07-31), encontrado reproduciendo "Investiga a fondo
  // las ventajas de TypeScript frente a Python...": translateInput()
  // espera un STRING (la meta de la tarea) como primer argumento, pero
  // aqui se le pasaba el objeto `task` {goal, expectedOutput} entero.
  // base.goal quedaba como el objeto -> el prompt real enviado a la IA
  // empezaba literalmente con "[object Object]", sin ninguna mencion de
  // la tarea real. Con el system prompt repitiendo "...de LinkCore" en
  // cada rol, el modelo, sin tarea real que seguir, alucinaba una
  // investigacion sobre la propia LinkCore (paleta de colores, layout)
  // en vez de responder lo que el usuario pidio -- reproducible en TODA
  // consulta que pasara por runCrew(), no solo en la mal-clasificada
  // como 'app'.
  var translated = translateInput(task.goal, agent, previousAgentOutputs, branch);
  var prompt = translated.goal;
  if (translated.context && translated.context !== 'Sin contexto previo.') {
    prompt += '\n\nContexto de pasos anteriores:\n' + translated.context.slice(0, 1500);
  }
  if (task.expectedOutput) {
    prompt += '\n\nResultado esperado: ' + task.expectedOutput;
  }

  // Bug real (2026-07-30): si el plan asignaba un paso a un rol sin
  // prompt definido para este tipo de entrega (ej. 'coder' o 'designer'
  // en un email -- DELIVERABLE_PROMPTS.email solo tiene writer/planner/
  // analyst), caia al system prompt GENERICO y cross-dominio del agente
  // (agent.systemPrompt, ej. "Eres el Diseñador UI de LinkCore..."),
  // completamente ajeno a la tarea real -- ese paso generaba contenido
  // fuera de tema que a veces ganaba como "salida de mayor confianza" y
  // sustituia la respuesta real. Ahora cae primero al prompt de `writer`
  // del MISMO tipo de entrega (siempre relacionado con la tarea real) en
  // vez de saltar a un rol sin relacion con lo que se pidio.
  var prompts = DELIVERABLE_PROMPTS[deliverableType] || DELIVERABLE_PROMPTS.text;
  var systemPrompt = prompts[agent.role] || prompts.writer || agent.systemPrompt;

  // Bug real, encontrado en vivo (2026-08-11) reproduciendo "Crea una app
  // web de lista de tareas": el paso del Desarrollador se resolvia con
  // qwen2.5:1.5b (generico, 'code' es solo una etiqueta mas entre varias)
  // en vez de qwen2.5-coder:7b (ya instalado, especializado) porque
  // callAI() prueba 'small' antes que 'medium' por defecto -- mas rapido,
  // razonable para prosa, pero el modelo de 1.5B nunca llego a escribir
  // codigo real, solo describio un arbol de carpetas hipotetico, y los
  // pasos siguientes (sin codigo real que revisar) alucinaron un backend
  // con base de datos que nadie pidio. Solo el rol 'coder' necesita este
  // empujon -- escritor/analista/diseñador ya funcionan con modelos
  // pequeños, subirles el tier a todos solo perderia velocidad sin
  // ganancia real de calidad.
  var result = await callAI(prompt, {
    systemPrompt: systemPrompt + ' Responde EN ESPANOL de forma profesional y directa, sin emojis ni meta-comentarios.',
    category: agent.primaryCategory,
    maxTokens: deliverableType === 'app' ? 5000 : 3500,
    temperature: 0.3,
    minTier: agent.role === 'coder' ? 'medium' : undefined,
    // Bug real (2026-07-31): sin esto, cada paso elegia el mismo modelo
    // local (siempre el primero elegible), asi que un plan de 6 pasos
    // consultaba 6 veces la MISMA IA con distinto disfraz de rol -- no
    // reduce error de nada, ensemble learning exige voces independientes.
    excludeFamilies: usedFamilies || [],
  });
  var translated_out = translateOutput(result, agent);
  // Se propaga la familia usada para que runCrew() la acumule y el
  // SIGUIENTE paso pida una distinta -- ver excludeFamilies arriba.
  translated_out.family = result && result.family;
  if (translated_out.success) {
    // Rama del run, no 'main': la salida cruda de un rol intermedio
    // (coder_output, writer_output...) es ruido de trabajo, no un hecho
    // durable que otra sesion deba heredar. Los hechos que SI merecen
    // sobrevivir (plan, respuesta final) se escriben aparte en runCrew().
    memoryWrite(agent.role + '_output', translated_out.data.slice(0, 500), agent.role, branch);
  }
  return translated_out;
}

async function runCrew(query, opts) {
  opts = opts || {};
  var onProgress = opts.onProgress;
  var startedAt = Date.now();
  // Rama propia de esta ejecucion: aisla sus pasos intermedios de
  // cualquier otro runCrew() sin necesidad de "limpiar" nada (ver la
  // nota larga sobre LAYER 1 arriba).
  var runBranch = branchFor(startedAt);

  function emit(evt) { try { if (onProgress) onProgress(evt); } catch(e) {} }

  var deliverableType = detectDeliverableType(query);
  memoryWrite('deliverable_type', deliverableType, 'system', runBranch);

  emit({ type: 'plan_start', message: 'Detectado tipo de entrega: ' + deliverableType + '. Analizando peticion...' });

  var planner = getAgent('planner');
  // Bug real (2026-07-31), mismo dia y misma reproduccion que el fix de
  // translateInput() de arriba, pero una capa mas atras: incluso con
  // translateInput() arreglado, planGoal en si mismo NUNCA citaba la
  // peticion real del usuario -- decia "Analiza esta peticion" sin
  // incluirla. El unico sitio que SI llevaba el query real era el
  // parametro `context` de executeStep(planner, ..., query, ...), que
  // la funcion nunca lee (parametro muerto). Resultado: el planificador
  // generaba un plan sobre lo primero que se le ocurriera con el system
  // prompt "...de LinkCore" de fondo -- y como parsePlanSteps() extrae
  // el goal de CADA paso posterior del texto que el planificador
  // escribio (nunca vuelve a mirar el query original), el tema
  // inventado se propagaba a los 6 pasos siguientes. Con la peticion
  // real citada aqui, el plan -y todo lo que de el se deriva- gira
  // sobre el tema correcto.
  var planGoal = 'Peticion real del usuario: "' + query + '"\n\nAnaliza esta peticion y crea un plan de ejecución con 2-4 pasos concretos.';
  if (deliverableType === 'app') {
    planGoal += ' Tipo de entrega: APLICACION WEB. El agente coder debe generar HTML/CSS/JS COMPLETO y FUNCIONAL. El agente designer define la paleta y layout.';
  } else if (deliverableType === 'document') {
    planGoal += ' Tipo de entrega: DOCUMENTO PROFESIONAL. El agente writer genera el contenido COMPLETO en markdown.';
  } else if (deliverableType === 'presentation') {
    planGoal += ' Tipo de entrega: PRESENTACION/DECK. El agente writer genera diapositivas en markdown con contenido REAL.';
  } else if (deliverableType === 'audio') {
    planGoal += ' Tipo de entrega: GUION DE AUDIO. El agente writer genera el guion optimizado para locucion con marcas de pausa y tono.';
  } else if (deliverableType === 'image') {
    planGoal += ' Tipo de entrega: PROMPTS DE IMAGEN. El agente designer genera prompts detallados para DALL-E/Midjourney.';
  } else if (deliverableType === 'video') {
    planGoal += ' Tipo de entrega: GUION DE VIDEO. El agente writer genera guion con cortes, narracion y duraciones.';
  } else if (deliverableType === 'data') {
    planGoal += ' Tipo de entrega: ANALISIS DE DATOS. El agente analyst genera metricas, tendencias y recomendaciones.';
  } else if (deliverableType === 'research') {
    planGoal += ' Tipo de entrega: INVESTIGACION. El agente analyst genera reporte con datos, fuentes y conclusiones.';
  }
  planGoal += ' Para cada paso indica: que hacer, que agente lo ejecuta (planner/coder/writer/analyst/designer), y que resultado se espera.';

  var planResult = await executeStep(planner, {
    goal: planGoal,
    expectedOutput: 'Plan numerado con pasos, agente asignado y resultado esperado.',
  }, query, deliverableType, null, runBranch);

  // 'original_query' es ruido de este run -> rama propia. 'plan' es un
  // hecho que vale la pena que otra sesion herede sin repetirlo -> se
  // escribe SIN branch, es decir en 'main' (el default de memory.js),
  // igual que hace orchestrator.js con sus propios hechos durables.
  memoryWrite('original_query', query, 'system', runBranch);
  memoryWrite('plan', planResult.data || 'Plan directo sin descomposición', 'planner');

  emit({ type: 'plan_done', plan: planResult.data, deliverableType: deliverableType, message: 'Plan creado para ' + deliverableType + '. Iniciando ejecucion...' });

  var steps = parsePlanSteps(planResult.data, query, deliverableType);
  var results = [];
  // Familias ya consultadas EN ESTE RUN -- ver el comentario en
  // executeStep(). Se reinicia sola cuando se agotan (pickBestOpenSourceModel
  // vuelve a intentar sin exclusiones), asi nunca se queda sin candidatos.
  var usedFamilies = [];

  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var agent = getAgent(step.agent);
    emit({ type: 'step_start', step: i + 1, total: steps.length, agent: agent.name, message: 'Paso ' + (i + 1) + '/' + steps.length + ': ' + agent.name + ' ejecutando...' });
    var ctx = memoryFormat(runBranch);
    var previousOutputs = results.filter(function(r) { return r && r.success; });
    var result = await executeStep(agent, { goal: step.goal, expectedOutput: step.expected }, ctx, deliverableType, previousOutputs, runBranch, usedFamilies);
    if (result.family) usedFamilies.push(result.family);
    results.push(result);
    // Bug real, encontrado en vivo (2026-08-10): este mensaje decia
    // "completado" siempre, sin importar si el paso tuvo exito o no --
    // un paso que fallo (result.success:false, ningun modelo respondio
    // valido) se narraba igual que uno real, exactamente lo contrario
    // del criterio del resto del sistema (nunca afirmar un exito que no
    // paso). Ahora refleja el resultado real de este paso.
    emit({ type: 'step_done', step: i + 1, total: steps.length, agent: agent.name, success: !!result.success, result: result.data ? result.data.slice(0, 200) : null, message: 'Paso ' + (i + 1) + ' ' + (result.success ? 'completado' : 'fallo, sin respuesta valida de ningun modelo') + ': ' + agent.name });
  }

  emit({ type: 'consensus_start', message: 'Detectando contradicciones y unificando respuestas...' });

  var agentOutputs = results.filter(function(r) { return r && r.success; }).map(function(r, i) {
    return { agent: r.agent || steps[i].agent, content: r.data };
  });

  var coordResult = null;
  if (agentOutputs.length > 1) {
    try {
      coordResult = await middlewareCoordinate(agentOutputs, {
        branch: runBranch,
        onProgress: function(evt) { emit({ type: 'middleware_' + evt.type, message: evt.message }); },
      });
    } catch(coordErr) {
      console.error('[LinkCore] Crew middleware error:', coordErr);
    }
  }

  var contradictions = coordResult ? coordResult.contradictions : detectContradictions(results);
  var mediation = coordResult ? coordResult.mediation : null;
  if (!mediation && contradictions.length) {
    emit({ type: 'mediation_start', message: 'Contradiccion detectada. Activando mediador...' });
    mediation = await mediate(contradictions, memoryFormat(runBranch));
  }

  // Bug real, gemelo del ya arreglado en orchestrator.js, confirmado en
  // vivo (2026-08-03): `results` es la salida de una tuberia SECUENCIAL
  // (planner -> writer -> writer -> ... -> developer, cada paso
  // construyendo sobre el anterior via memoryFormat()), no votos
  // PARALELOS independientes sobre la misma pregunta. Pasarla por
  // middlewareCoordinate() como si lo fueran generaba contradicciones
  // falsas en masa (45 en una corrida real de 6 pasos) y arriesgaba
  // sustituir el resultado final (el ultimo paso, que es el que de
  // verdad ensambla la entrega) por un borrador intermedio de mayor
  // "confianza" segun unifyResponses() -- que ordena por confianza, no
  // por posicion en la tuberia. El resultado real es siempre el ultimo
  // paso completado con exito; coordResult/mediation quedan solo como
  // nota informativa, nunca deciden que texto gana.
  var lastSuccessful = null;
  for (var lsi = results.length - 1; lsi >= 0; lsi--) {
    if (results[lsi] && results[lsi].success && results[lsi].data) {
      lastSuccessful = results[lsi];
      break;
    }
  }

  // Bug real, encontrado en vivo (2026-08-11) probando "crea una app de
  // lista de tareas" por el camino real: para deliverableType 'app',
  // `unified` tomaba SOLO el texto del ULTIMO paso exitoso -- en la
  // practica casi siempre el paso de Diseñador (paleta de colores, CSS de
  // maquetacion), no el HTML/JS real que un paso ANTERIOR (Desarrollador)
  // ya habia generado. Ese codigo real SI llegaba al intento de despliegue
  // en Vercel (el bloque de mas abajo ya lo agregaba de todos los pasos
  // para eso) pero nunca al TEXTO que el usuario de verdad lee -- una app
  // con codigo funcional generado internamente pero invisible en la
  // respuesta final. Se construye `unified` a partir de los mismos
  // ficheros ya filtrados por buildDeployFiles() (reutilizado, no
  // duplicado) -- esa funcion YA descarta bloques de codigo que no
  // encajan como html/css/js, lo cual de paso protege contra que un paso
  // que alucino algo fuera de tema (ej. un backend PHP inventado que
  // nadie pidio) cuele su bloque de codigo en la respuesta final.
  var appFiles = [];
  if (deliverableType === 'app') {
    var allCode = results.filter(function(r) { return r && r.success; }).map(function(r) { return r.data; }).join('\n\n');
    var codeBlocks = extractCodeBlocks(allCode);
    appFiles = buildDeployFiles(codeBlocks);
  }

  var unified;
  if (deliverableType === 'app' && appFiles.length) {
    unified = appFiles.map(function(f) {
      var ext = f.file.split('.').pop();
      var lang = ext === 'html' ? 'html' : ext === 'css' ? 'css' : ext === 'js' ? 'javascript' : ext;
      return '**' + f.file + '**\n```' + lang + '\n' + f.data + '\n```';
    }).join('\n\n');
  } else {
    unified = lastSuccessful ? lastSuccessful.data : unifyResponses(results, mediation);
  }

  var deployResult = null;
  if (deliverableType === 'app' && appFiles.length) {
    emit({ type: 'deploy_start', message: 'Preparando despliegue en Vercel...' });
    deployResult = await deployToVercel(appFiles, 'linkcore-' + Date.now());
    if (deployResult && deployResult.ok && deployResult.url) {
      unified += '\n\n**Aplicacion desplegada:** ' + deployResult.url;
      memoryWrite('deploy_url', deployResult.url, 'system');
    }
  }

  var totalMs = Date.now() - startedAt;
  memoryWrite('final_response', unified.slice(0, 500), 'synthesizer');

  emit({ type: 'done', deliverableType: deliverableType, deployResult: deployResult, message: 'Entrega de tipo ' + deliverableType + ' lista. ' + totalMs + 'ms.' });

  return {
    response: unified,
    decomposed: true,
    decompositionLabel: 'Equipo de agentes (' + deliverableType + ')',
    decompositionSector: 'Multi-agente',
    deliverableType: deliverableType,
    deployResult: deployResult,
    steps: steps.map(function(s, i) {
      var agent = getAgent(s.agent);
      return {
        id: 'step-' + i,
        label: s.goal.slice(0, 80),
        desc: s.expected || '',
        ai: agent.name,
        category: agent.primaryCategory,
        status: results[i] && results[i].success ? 'completed' : 'error',
        driver: { name: results[i] ? results[i].model : null },
        provider: results[i] ? results[i].provider : null,
        latencyMs: 0,
        result: results[i] ? results[i].data : null,
      };
    }),
    modelsUsed: results.filter(function(r) { return r && r.success; }).map(function(r) {
      return { subtask: r.agent, model: r.model, provider: r.provider };
    }),
    plan: { label: 'Equipo de agentes (' + deliverableType + ')', subtasks: steps },
    logs: [],
    totalLatencyMs: totalMs,
    contradictions: contradictions,
    mediation: mediation,
    // Bug real, encontrado en vivo (2026-08-10): sin `runBranch` aqui,
    // memoryReadAll() no filtra nada (su guarda es `if (prefix && ...)`,
    // y sin branch prefix es null/falsy) -- devuelve el volcado COMPLETO
    // de memoria de TODAS las ejecuciones de runCrew() que ha habido, no
    // solo la de esta consulta. Coincide con contenido cruzado real visto
    // en una respuesta (datos de una consulta sobre una parcela agricola
    // mezclados con una consulta sin relacion sobre programacion).
    memory: memoryReadAll(runBranch),
  };
}

// Bug real, catastrofico, encontrado en vivo (2026-08-10) reproduciendo
// "Investiga que es el machine learning" por el camino real (CLI, no
// funcion aislada): el planificador SIEMPRE devuelve cada paso numerado
// con sub-vinetas debajo ("   - Agente: Analyst", "   - Resultado
// Esperado: ..."), formato que el propio prompt de planGoal (mas arriba)
// le pide explicitamente. El parser trataba CUALQUIER linea que empezara
// por "- " como un paso independiente -- asi que esas dos sub-vinetas de
// metadatos se colaban como si fueran tareas reales, con "Agente:
// Analyst" o "Resultado Esperado: Definicion clara..." como *goal*
// literal enviado a una IA. Confirmado con un test aislado (mismo codigo,
// texto de plan realista): de 4 "pasos" generados, 2 eran metadatos y el
// verdadero paso 3 del plan nunca se alcanzaba porque el cupo de 4 se
// agotaba con basura. Explica de una vez tres sintomas que parecian
// sueltos: (1) todos los pasos salian con agente "Escritor" (el regex de
// clasificacion, en español, nunca reconocia "Agente: Analyst" en
// ingles), (2) el contenido se repetia entre pasos (un modelo al que se
// le pide "ejecuta: Agente: Analyst" no tiene tarea real que seguir y
// reafirma lo del paso anterior), (3) mas lento de lo necesario (pasos
// gastados en metadatos en vez de en el plan real).
//
// Arreglo: las sub-vinetas de metadatos ahora se leen como atributos del
// paso ANTERIOR (agente asignado, resultado esperado) en vez de crear un
// paso nuevo -- y de paso se usa el agente que el propio planificador ya
// eligio (ROLE_NAMES, nombres reales del equipo) en lugar de adivinarlo
// con un regex sobre el texto del titulo, que solo se usa como fallback
// cuando el plan no incluye una linea "Agente:" explicita.
var ROLE_NAMES = {
  planner: /planificador|planner/i,
  coder: /desarrollador|coder|programador/i,
  writer: /escritor|writer|redactor/i,
  analyst: /analista|analyst/i,
  designer: /dise[nñ]ador|designer/i,
};
var META_AGENT_RE = /^[\-\*]?\s*(?:agente|agent)\s*:\s*(.+)/i;
var META_EXPECTED_RE = /^[\-\*]?\s*(?:resultado\s*esperado|expected(?:\s*output)?)\s*:\s*(.+)/i;

var NUMBERED_LINE_RE = /^(\d+[\.\)]\s|paso\s|step\s)/i;

function parsePlanSteps(planText, originalQuery, deliverableType) {
  if (!planText) return [{ goal: originalQuery, expected: 'Respuesta completa', agent: 'writer' }];
  var steps = [];
  var lines = planText.split('\n');
  var agentKeywords = {
    planner: /planif|descomp|analizar.*peticion|organizar|definir.*estructura|definir.*stack|arquitect/i,
    coder: /codigo|programa|app|funcion|componente|implement|deploy|html|css|js|react|api|archivos|code|desarroll/i,
    writer: /escrib|redacta|documento|informe|propuesta|contenido|guion|copy|texto|presentacion|slide|brief|lee/i,
    analyst: /analiz|investig|datos|metrica|tendencia|mercado|comparar|evaluar|estrategia|qa|test|revis/i,
    designer: /disen|ui|ux|mockup|wireframe|visual|imagen|prompt|layout|color|tipografia|paleta|estilo/i,
  };

  // Bug real, encontrado en vivo (2026-08-10) en la MISMA corrida usada para
  // verificar el fix de las sub-vinetas de metadatos: el planificador no
  // siempre empieza directo por el plan numerado -- a veces antepone un
  // preambulo ("**Analisis:**" + vinetas sueltas con su propio
  // razonamiento) ANTES del plan real. Esas vinetas de preambulo tambien
  // empiezan por "- "/"* ", asi que el mismo fallo que las sub-vinetas de
  // metadatos (tratarlas como pasos independientes) se colaba por una via
  // distinta: el "paso 1" real de una corrida en vivo acabo siendo
  // literalmente "La pregunta es clara y especifica, lo que indica que se
  // busca una investigacion..." -- una frase de analisis, no una tarea --
  // y ese paso, sin tarea real que seguir, fallo sin respuesta valida
  // (gasto uno de los 4 pasos disponibles en nada). Si el plan usa
  // numeracion en algun punto, las vinetas sueltas dejan de crear pasos
  // nuevos (solo se leen como metadatos del paso numerado anterior, o se
  // ignoran si no lo son) -- el fallback de "solo vinetas, sin numeracion"
  // (planes que nunca numeran) se mantiene igual que antes.
  var hasNumberedSteps = lines.some(function(l) { return NUMBERED_LINE_RE.test(l.trim()); });

  var current = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.length < 10) continue;

    var metaAgent = META_AGENT_RE.exec(line);
    if (metaAgent && current) {
      var roleValue = metaAgent[1].trim();
      for (var role in ROLE_NAMES) {
        if (ROLE_NAMES[role].test(roleValue)) { current.agent = role; break; }
      }
      continue;
    }
    var metaExpected = META_EXPECTED_RE.exec(line);
    if (metaExpected && current) {
      current.expected = metaExpected[1].trim() || current.expected;
      continue;
    }

    var isNumbered = NUMBERED_LINE_RE.test(line);
    var isBullet = /^[\-\*]\s/.test(line);
    if (isNumbered || (isBullet && !hasNumberedSteps)) {
      var text = line.replace(/^(\d+[\.\)]\s|paso\s\d+:\s?|step\s\d+:\s?|[\-\*]\s)/i, '').trim();
      if (text.length < 8) continue;
      var assignedAgent = 'writer';
      Object.keys(agentKeywords).forEach(function(role) {
        if (agentKeywords[role].test(text)) assignedAgent = role;
      });
      current = { goal: text, expected: 'Resultado profesional y completo', agent: assignedAgent };
      steps.push(current);
    }
    // Vineta suelta que no es numerada, no es metadato del paso actual, y
    // el plan SI usa numeracion en otra parte: es comentario/preambulo del
    // planificador (p.ej. "**Analisis:** - ..."), no una tarea -- se
    // ignora a proposito en vez de convertirla en un paso falso.
  }
  if (!steps.length) {
    steps.push({ goal: originalQuery, expected: 'Respuesta completa y profesional', agent: 'writer' });
  }
  // Bug real, encontrado en vivo (2026-08-10): el prompt del planificador
  // (mas arriba, planGoal) le pide al modelo "un plan de 2-4 pasos
  // concretos", pero este limite dejaba pasar hasta 6 -- inconsistente
  // con lo que se pedia. Un modelo pequeño que ya se paso de la cuenta
  // (6 pasos para "investiga que es el machine learning", una pregunta
  // simple) se dejaba pasar tal cual, alargando innecesariamente el
  // tiempo total (cada paso de mas es una llamada real a un modelo).
  return steps.slice(0, 4);
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  runCrew,
  executeStep,
  getAgent,
  AGENT_DEFS,
  detectDeliverableType,
  DELIVERABLE_PROMPTS,
  memoryWrite,
  memoryRead,
  memoryReadAll,
  memoryQuery,
  memoryFormat,
  memoryClear,
  detectContradictions,
  mediate,
  unifyResponses,
  translateInput,
  translateOutput,
  extractCodeBlocks,
  buildDeployFiles,
  deployToVercel,
};
