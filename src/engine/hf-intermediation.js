// ═══════════════════════════════════════════════════════════════
// LINKCORE — CAPA 1: INTERMEDIACION
//
// Selecciona, entre el catalogo real de repositorios de modelos open
// source, TODAS las familias de arquitectura independientes que sean
// relevantes para UNA peticion concreta -- sin numero fijo. Es la etapa
// que convierte "hay miles de repos" en "estos van a responder a esto".
//
// Por que el catalogo de Hugging Face y no GitHub a secas: un repo de
// GitHub contiene el CODIGO de un modelo; no se puede invocar. Los repos
// del Hub contienen los PESOS y son ejecutables sin descargarlos. Cada
// entrada de aqui es un repositorio git real y publico -- se cruza con
// GitHub cuando el repo declara su origen (ver githubRepoFromTags).
//
// Escala real medida en vivo (2026-07-27), recorriendo el catalogo
// COMPLETO de repos ejecutables por cursor: 6.000 repos, 2.709
// laboratorios (autores) distintos, pero solo 26 FAMILIAS DE ARQUITECTURA
// realmente independientes -- 4 de ellas (Qwen, Llama, Mistral, Gemma)
// concentran el 97% de los repos. "Acceder a todas las IAs open source"
// significa aqui: la BUSQUEDA cubre ese universo real (miles de repos,
// no un puñado), y la SELECCION saca todas las familias relevantes que
// encuentre -- sin techo arbitrario, acotada solo por cuantas familias
// independientes existen de verdad.
//
// Bajo demanda: nada de esto se cachea. Cada llamada consulta el
// catalogo en vivo -- es mas lento que servir una lista precalculada,
// pero es la unica forma honesta de decir "acceso a todas las IAs open
// source" en vez de "acceso a las que elegi la ultima vez".
//
// Verificado en vivo: la API del catalogo responde 200 sin ninguna clave
// y con CORS abierto (incluida la cabecera Link de paginacion), asi que
// esta capa se llama directa desde el cliente. Solo la EJECUCION (capa
// 2) pasa por el Worker, porque esa si necesita un token secreto.
// ═══════════════════════════════════════════════════════════════

import { getLearnedBias } from './learning-loop.js';

// ── Perfiles de tarea ──────────────────────────────────────────────
// Un solo termino de busqueda NO da diversidad: comprobado en vivo,
// `search=coder` devuelve 8 resultados y los 8 son de Qwen. Como el
// ensemble solo reduce el error si los errores estan DESCORRELACIONADOS,
// un ensemble de 3 Qwen no es un ensemble: es el mismo modelo tres veces.
// Por eso cada categoria lanza VARIAS consultas distintas al catalogo y
// luego se fusionan -- es la forma de que aparezcan laboratorios que una
// sola busqueda nunca habria sacado.
var TASK_PROFILES = {
  code: {
    queries: ['coder', 'code instruct', 'starcoder', 'codellama', 'devstral'],
    keywords: ['coder', 'code', 'starcoder', 'codegen', 'codestral', 'devstral'],
  },
  reasoning: {
    queries: ['reasoning', 'r1 distill', 'thinking', 'math instruct', 'qwq'],
    keywords: ['r1', 'reason', 'think', 'math', 'qwq', 'o1', 'cot'],
  },
  writing: {
    queries: ['instruct', 'chat', 'gemma it', 'mistral instruct', 'nemotron'],
    keywords: ['instruct', 'chat', 'it', 'tulu', 'hermes'],
  },
  general: {
    queries: ['instruct', 'chat', 'mixtral', 'llama instruct', 'phi'],
    keywords: ['instruct', 'chat'],
  },
};

// ── Licencias ─────────────────────────────────────────────────────
// Solo pesos realmente abiertos. Se rechaza explicitamente cc-by-nc
// (prohibe uso comercial) y todo lo que no declare licencia: si un repo
// no dice bajo que terminos publica sus pesos, no entra en el catalogo
// de LinkCore -- prefiero un candidato menos a uno que no podamos usar.
var OPEN_LICENSE_PREFIXES = [
  'apache-2.0', 'mit', 'bsd', 'llama', 'gemma', 'qwen', 'deepseek',
  'openrail', 'bigscience', 'cc-by-4.0', 'cc-by-sa', 'cc0', 'gpl', 'mpl',
  'falcon', 'tii-falcon', 'nvidia-open-model', 'intel-research', 'other',
];

function licenseFromTags(tags) {
  var found = null;
  (tags || []).forEach(function (t) {
    if (String(t).indexOf('license:') === 0) found = String(t).slice(8);
  });
  return found;
}

function isOpenLicense(license) {
  if (!license) return false;
  var l = String(license).toLowerCase();
  if (l.indexOf('-nc') !== -1 || l.indexOf('noncommercial') !== -1) return false;
  for (var i = 0; i < OPEN_LICENSE_PREFIXES.length; i++) {
    if (l.indexOf(OPEN_LICENSE_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// ── Familia de arquitectura ────────────────────────────────────────
// LA pieza critica de todo el sistema, y la que mas facil es equivocar.
//
// Hallazgo real (2026-07-27, verificado modelo a modelo): agrupar por el
// AUTOR del repo da diversidad falsa. Una seleccion que parecia tener 3
// laboratorios distintos --deepreinforce-ai, nvidia, Qwen-- resulto ser,
// mirando config.model_type: qwen3_5_moe, gemma4 y qwen3_5. Es decir, dos
// de los tres eran Qwen por dentro, y el de "nvidia" era en realidad una
// cuantizacion del Gemma de Google. Promediar eso NO es ensemble learning:
// dos modelos de la misma familia comparten arquitectura y datos de
// entrenamiento, luego comparten sus errores, y el teorema que sustenta
// todo esto ("combinar reduce el error") solo se cumple si los errores son
// INDEPENDIENTES. Un ensemble de tres Qwen es un Qwen con mas latencia.
//
// Por eso la diversidad se mide sobre config.model_type normalizado, que
// la API devuelve con expand[]=config en la misma peticion del listado.
var ARCH_ALIASES = {
  gpt_oss: 'gpt-oss',
  chatglm: 'glm',
  codellama: 'llama',
  mixtral: 'mistral',
  nemotron_h: 'nemotron',
};

function archFamily(modelType) {
  if (!modelType) return null;
  var t = String(modelType).toLowerCase();
  // El mapa de alias va PRIMERO porque contiene los casos donde la raiz
  // alfabetica sola daria un resultado equivocado: gpt_oss debe quedarse
  // como familia propia y no colapsar a "gpt" (que es GPT-2, otra cosa).
  if (ARCH_ALIASES[t]) return ARCH_ALIASES[t];
  // Raiz alfabetica hasta el primer digito o guion bajo. Quitar solo
  // numeros de version no bastaba: qwen3_next se quedaba en "qwen3_next"
  // y contaba como familia distinta de qwen3_moe siendo ambos Qwen --
  // exactamente el fallo de diversidad falsa que este modulo existe para
  // evitar, colandose por un sufijo de palabra en vez de por el autor.
  // qwen3_next -> qwen | qwen2_5_vl -> qwen | deepseek_v3 -> deepseek
  var m = t.match(/^[a-z]+/);
  var base = m ? m[0] : t;
  return ARCH_ALIASES[base] || base;
}

// Raiz alfabetica de un nombre libre ("DeepSeek-R1" -> deepseek), pasada
// por el mismo mapa de alias que archFamily para no divergir.
function nameRoot(s) {
  var m = String(s || '').toLowerCase().match(/^[a-z]+/);
  if (!m) return null;
  return ARCH_ALIASES[m[0]] || m[0];
}

// TERCER fallo de diversidad falsa encontrado en vivo, y el mas sutil de
// los tres. Los dos anteriores (agrupar por autor; qwen3_next sin colapsar
// a qwen) se veian en el nombre. Este no:
//
//   deepseek-ai/DeepSeek-R1            -> config.model_type = deepseek
//   deepseek-ai/DeepSeek-R1-Distill-Llama-70B -> config.model_type = llama
//
// archFamily los separa en "deepseek" y "llama" y el ensemble reporta dos
// familias independientes. Arquitectonicamente es correcto -- el segundo
// ES un Llama. Estadisticamente es falso: se entreno destilando las
// salidas de R1, asi que hereda sus modos de fallo. Cuando el profesor se
// equivoca, los dos se equivocan igual, y promediarlos no cancela nada.
// El teorema del ensemble exige errores independientes, no arquitecturas
// distintas -- la arquitectura solo era un proxy, y aqui el proxy falla.
//
// Para efectos de independencia, la familia efectiva de un destilado es la
// del PROFESOR. Se conserva la arquitectura real aparte (`arch`) para no
// perder trazabilidad: el repo sigue siendo un Llama y la UI debe poder
// decirlo.
function lineageFamily(id, modelType, derivedFrom) {
  var arch = archFamily(modelType);
  var parts = String(id || '').split('/');
  var author = parts[0] || '';
  var name = parts[parts.length - 1] || '';

  var teacher = null;
  var dm = name.match(/^(.+?)[\-_]distill/i);
  if (dm) {
    teacher = nameRoot(dm[1]);
    // Si lo que precede a "Distill" no identifica al profesor (empieza por
    // la arquitectura destino, o es un prefijo generico), el autor del repo
    // lo hace: en los destilados oficiales publica el laboratorio profesor.
    if (!teacher || teacher === arch) teacher = nameRoot(author);
  }
  // Respaldo: el tag base_model declara explicitamente una destilacion.
  if (!teacher && derivedFrom && /distill/i.test(String(derivedFrom))) {
    teacher = nameRoot(String(derivedFrom).split('/').pop());
  }

  if (teacher && arch && teacher !== arch) {
    return { family: teacher, arch: arch, distilledFrom: teacher };
  }
  return { family: arch, arch: arch, distilledFrom: null };
}

// Origen declarado cuando el repo es un derivado (cuantizacion, fine-tune,
// adaptador). Sirve para trazabilidad honesta en la UI: enseñar que
// "nvidia/Gemma-4-31B-NVFP4" es, de hecho, google/gemma-4.
function baseModelRoot(tags) {
  var root = null;
  (tags || []).forEach(function (t) {
    var s = String(t);
    if (s.indexOf('base_model:') !== 0) return;
    var ref = s.slice(11).replace(/^(finetune|quantized|adapter|merge):/, '');
    if (ref.indexOf('/') !== -1 && !root) root = ref;
  });
  return root;
}

// Muchos repos del Hub declaran su repositorio de GitHub en los tags
// (arxiv, base_model, o el propio nombre del laboratorio). Cuando existe,
// se expone para que la UI pueda enseñar el repo de codigo real detras
// de cada modelo que participo -- trazabilidad, no decoracion.
var LAB_GITHUB = {
  'Qwen': 'https://github.com/QwenLM',
  'deepseek-ai': 'https://github.com/deepseek-ai',
  'meta-llama': 'https://github.com/meta-llama',
  'mistralai': 'https://github.com/mistralai',
  'google': 'https://github.com/google-deepmind',
  'microsoft': 'https://github.com/microsoft',
  'nvidia': 'https://github.com/NVIDIA',
  'openai': 'https://github.com/openai',
  'zai-org': 'https://github.com/zai-org',
  'NousResearch': 'https://github.com/NousResearch',
  'MiniMaxAI': 'https://github.com/MiniMax-AI',
  'allenai': 'https://github.com/allenai',
  'HuggingFaceTB': 'https://github.com/huggingface',
  'tiiuae': 'https://github.com/tiiuae',
  'XiaomiMiMo': 'https://github.com/XiaomiMiMo',
};

function githubRepoFromTags(lab) {
  return LAB_GITHUB[lab] || null;
}

// ── Disponibilidad real, no solo declarada ──────────────────────────
// Fallo real encontrado en ejecucion (2026-07-27): un repo puede
// aparecer en el catalogo bajo inference_provider=all (es decir, EXISTE
// al menos un proveedor que dice servirlo) y el router de HF igual
// rechazar la llamada con "not supported by any provider you have
// access to". Comprobado modelo a modelo: los 3 casos que fallaron
// tenian UN SOLO proveedor listado, featherless-ai; el que si funciono
// tenia dos (novita + featherless-ai). No es un fallo del modelo, es que
// esta cuenta concreta no tiene acceso habilitado a featherless-ai en
// hf.co/settings/inference-providers. Se excluye al puntuar elegibilidad
// -- si mas adelante se habilita esa cuenta, basta con quitar esta
// entrada, no hay que tocar nada mas del pipeline.
var PROVIDERS_WITHOUT_ACCOUNT_ACCESS = ['featherless-ai'];

function hasUsableProvider(mapping) {
  if (!Array.isArray(mapping) || !mapping.length) return false;
  return mapping.some(function (p) {
    return p.status === 'live' && PROVIDERS_WITHOUT_ACCOUNT_ACCESS.indexOf(p.provider) === -1;
  });
}

// ── Consulta al catalogo ───────────────────────────────────────────

// buildUrl/catalogUrl/queryCatalog/crawlCatalogBroad/intermediate() se
// eliminaron (2026-08-17, auditoria de exports huerfanos): eran la unica
// maquinaria de este archivo que de verdad tocaba la red (huggingface.co),
// y llevaban CERO callers reales desde que backend.js dejo de invocar
// intermediate() el 2026-08-12 ("LinkCore es 100% local por decision
// explicita y repetida del usuario", ver backend.js linea ~236). Codigo
// muerto que hace fetch() a un dominio externo es exactamente el tipo de
// mina que este proyecto ya ha desactivado varias veces (Groq, tier
// 'large' remoto, pickBestOpenSourceModel) -- un `import { intermediate }`
// futuro por error habria reintroducido la misma fuga ya cerrada. Las
// funciones de puntuacion/seleccion de mas abajo (scoreCandidate,
// selectEnsemble, etc.) son puro calculo local sobre datos ya obtenidos --
// sin riesgo de red por si solas -- se dejan como estaban.

// ── Puntuacion ─────────────────────────────────────────────────────
// Combina cuatro señales observables del propio repo. No hay ninguna
// nota inventada ni "elo" arbitrario: descargas y likes son contadores
// reales que devuelve la API, y la fecha tambien.
var WEIGHTS = { taskMatch: 0.32, adoption: 0.26, community: 0.12, freshness: 0.12, canonical: 0.18 };

function matchesTask(id, profile) {
  var low = String(id || '').toLowerCase();
  var match = 0;
  (profile.keywords || []).forEach(function (kw) {
    if (low.indexOf(kw) !== -1) match = 1;
  });
  return match;
}

function scoreCandidate(model, profile, family, category) {
  var id = String(model.id || '').toLowerCase();
  var taskMatch = matchesTask(id, profile);

  // Repo canonico: lo publica el laboratorio que creo la arquitectura
  // (Qwen/Qwen3 si, Jackrong/Qwopus-27B no). Se prima porque su
  // procedencia es verificable y suele estar mejor mantenido que un
  // fine-tune suelto de la comunidad -- que ademas hereda los fallos del
  // modelo base sin aportar independencia al ensemble.
  var author = String(model.author || id.split('/')[0]).toLowerCase();
  var canonical = family && author.indexOf(family) !== -1 ? 1 : 0;

  // Escala logaritmica: la diferencia entre 1k y 100k descargas importa
  // mucho; entre 10M y 28M, casi nada. Lineal daria todo el peso al #1.
  var downloads = model.downloads || 0;
  var adoption = Math.min(Math.log10(downloads + 1) / 8, 1);

  var likes = model.likes || 0;
  var community = Math.min(Math.log10(likes + 1) / 4, 1);

  // Un modelo de hace 3 años casi siempre esta superado por uno nuevo del
  // mismo laboratorio. Decae de forma suave a lo largo de ~2 años.
  var freshness = 0.5;
  if (model.createdAt) {
    var ageDays = (Date.now() - new Date(model.createdAt).getTime()) / 86400000;
    freshness = Math.max(0, Math.min(1, 1 - ageDays / 730));
  }

  // Bucle de aprendizaje: termino ADITIVO y acotado (ver learning-loop.js),
  // aparte de los pesos de arriba que suman 1.0 -- nunca puede voltear una
  // seleccion por si solo, solo desempata o refuerza levemente entre
  // candidatos ya parecidos en merito. Con cero historial (la app recien
  // instalada, o esta misma familia+categoria nunca antes ejecutada),
  // devuelve 0 y el comportamiento es identico al de antes de este modulo.
  var learned = getLearnedBias(family, category);

  return (
    taskMatch * WEIGHTS.taskMatch +
    adoption * WEIGHTS.adoption +
    community * WEIGHTS.community +
    freshness * WEIGHTS.freshness +
    canonical * WEIGHTS.canonical +
    learned
  );
}

var FAMILY_BACKUP_LIMIT = 2;

// Un representante (el de mayor puntuacion) por familia de arquitectura,
// con hasta FAMILY_BACKUP_LIMIT candidatos de RESPALDO de la misma
// familia colgados en `.backups`.
//
// Por que hace falta esto: fallo real encontrado en ejecucion
// (2026-07-27) -- el catalogo marca un repo como servible
// (inference_provider=all) y al invocarlo de verdad la API de HF
// responde "not supported by any provider". El catalogo no es 100%
// fiable sobre disponibilidad EN VIVO, solo sobre que existe y declara
// soportar inferencia. Un respaldo de la MISMA familia no compromete la
// independencia del ensemble (sigue siendo un solo voto por familia,
// solo que con un segundo intento si el primero no responde de verdad).
function groupBestByFamily(scored) {
  var byFamily = {};
  scored.forEach(function (m) {
    var key = m.family || m.lab;
    if (!byFamily[key]) byFamily[key] = [];
    byFamily[key].push(m);
  });

  return Object.keys(byFamily).map(function (key) {
    var sorted = byFamily[key].slice().sort(function (a, b) { return b.score - a.score; });
    var primary = sorted[0];
    primary.backups = sorted.slice(1, 1 + FAMILY_BACKUP_LIMIT);
    return primary;
  }).sort(function (a, b) { return b.score - a.score; });
}

// ── Seleccion de tamaño FIJO (compatibilidad + casos puntuales, ej.
// "dame solo el mejor modelo") ──────────────────────────────────────
// Ordenar por puntuacion y coger los N primeros da (comprobado en vivo)
// modelos que comparten familia y por tanto FALLAN EN LO MISMO. Aqui se
// coge como maximo UN modelo por familia de arquitectura mientras queden
// familias distintas. Si no hay suficientes, se rellena con el mejor
// disponible pero se MARCA (sameFamilyFallback) para que la capa de
// ensemble sepa que esos dos votos no son independientes.
function selectEnsemble(scored, size) {
  var representatives = groupBestByFamily(scored);
  var chosen = representatives.slice(0, size);

  if (chosen.length < size) {
    var chosenIds = {};
    chosen.forEach(function (m) { chosenIds[m.id] = true; });
    var fillers = scored
      .filter(function (m) { return !chosenIds[m.id]; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, size - chosen.length)
      .map(function (m) { m.sameFamilyFallback = true; return m; });
    chosen = chosen.concat(fillers);
  }

  return chosen;
}

// ── Seleccion DINAMICA (modo por defecto) ───────────────────────────
// Sin numero fijo. Se queda con TODAS las familias de arquitectura cuyo
// representante encaja con la tarea (taskMatch=1 -- ver TASK_PROFILES),
// sin techo artificial: el limite real es cuantas familias independientes
// existan y sean relevantes, que hoy son como mucho las 26 medidas en
// vivo. Una pregunta especifica (categoria code/reasoning/writing, con
// palabras clave estrechas) filtra a un puñado; una pregunta generica
// (categoria general, palabras clave anchas como "instruct"/"chat", que
// casi todas las familias modernas publican) deja pasar muchas mas --
// es una consecuencia real de la relevancia, no un numero elegido a mano.
//
// minFamilies es un suelo de seguridad, no el objetivo: garantiza que
// incluso una tarea muy especifica con pocos matches directos reciba
// suficientes votos como para que el ensemble tenga sentido (por debajo
// de 2 no hay nada que reconciliar). Se rellena con las familias mejor
// puntuadas aunque no encajen por palabra clave, y se marca
// (generalFallback) para que quede claro que esos votos entraron por
// suelo minimo, no por relevancia directa.
function selectDynamic(scored, minFamilies) {
  var floor = minFamilies || 2;
  var representatives = groupBestByFamily(scored);
  var relevant = representatives.filter(function (m) { return m.taskMatch === 1; });

  var chosen = relevant.slice();
  if (chosen.length < floor) {
    var chosenIds = {};
    chosen.forEach(function (m) { chosenIds[m.id] = true; });
    var fillers = representatives
      .filter(function (m) { return !chosenIds[m.id]; })
      .slice(0, floor - chosen.length)
      .map(function (m) { m.generalFallback = true; return m; });
    chosen = chosen.concat(fillers);
  }

  return chosen.sort(function (a, b) { return b.score - a.score; });
}

// ── Etapa completa ─────────────────────────────────────────────────

function detectCategory(query) {
  var t = (query || '').toLowerCase();
  if (/codigo|code|programa|funcion|componente|react|debug|script|api|html|css|bug|error/.test(t)) return 'code';
  if (/analiza|compara|estrategia|plan|razona|por que|demuestra|calcula|matemat/.test(t)) return 'reasoning';
  if (/escrib|redacta|articul|documento|informe|carta|resume|ensayo|guion/.test(t)) return 'writing';
  return 'general';
}

// Narracion humana de la seleccion, construida SOLO a partir de campos
// ya calculados (taskMatch, generalFallback, score) -- nunca prosa
// inventada. Es lo que responde "por que estas familias y no otras"
// cuando LinkCore explica en que esta pensando.
function explainSelection(selection) {
  if (!selection || !selection.selected || !selection.selected.length) {
    return 'Sin candidatos elegibles tras filtrar por licencia abierta, soporte de chat y proveedor disponible.';
  }
  var byRelevance = selection.selected.filter(function (m) { return m.taskMatch === 1 && !m.generalFallback; });
  var byFloor = selection.selected.filter(function (m) { return m.generalFallback; });

  var parts = [];
  parts.push(selection.considered + ' repos rastreados, ' + selection.eligible + ' elegibles (licencia abierta + soporta chat + proveedor con acceso), ' +
    selection.familiesAvailable + ' familias de arquitectura distintas disponibles.');

  if (byRelevance.length) {
    parts.push(byRelevance.length + ' elegidas por relevancia directa a la tarea: ' +
      byRelevance.map(function (m) { return m.family + ' (' + m.id + ', score ' + m.score.toFixed(2) + ')'; }).join(', ') + '.');
  }
  if (byFloor.length) {
    parts.push(byFloor.length + ' añadidas por suelo minimo de independencia (no coincidian por palabra clave, pero aportan un voto mas para que el ensemble tenga sentido): ' +
      byFloor.map(function (m) { return m.family + ' (' + m.id + ')'; }).join(', ') + '.');
  }
  if (!selection.independent) {
    parts.push('Aviso: ' + selection.selected.length + ' modelos elegidos pero solo ' + selection.families + ' familias distintas -- algun voto no es independiente.');
  }

  return parts.join(' ');
}

export {
  detectCategory,
  scoreCandidate,
  selectEnsemble,
  selectDynamic,
  groupBestByFamily,
  matchesTask,
  hasUsableProvider,
  isOpenLicense,
  licenseFromTags,
  archFamily,
  lineageFamily,
  explainSelection,
  baseModelRoot,
  TASK_PROFILES,
};
