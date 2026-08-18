const GITHUB_API = 'https://api.github.com';
const SEARCH_API = 'https://api.github.com/search';
const NPM_API = 'https://registry.npmjs.org/-/v1/search';
const SO_API = 'https://api.stackexchange.com/2.3/search';

let memoryStore = [];
const MEMORY_KEY = 'x1_memory';
const MAX_MEMORY = 50;

export function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (raw) memoryStore = JSON.parse(raw);
  } catch (e) { memoryStore = []; }
  return memoryStore;
}

// Bug real: loadMemory() nunca se llamaba desde ningun sitio del arranque de
// la app -- memoryStore empezaba en [] en cada reinicio de Electron, aunque
// localStorage SI tenia el historial guardado (addMemory llama a
// saveMemory() correctamente). Efecto: dentro de una misma sesion la
// memoria funcionaba, pero al cerrar y volver a abrir LinkCore parecia "no
// recordar nada". Efecto de modulo -- se ejecuta en cuanto este archivo se
// importa por primera vez, antes de cualquier addMemory/getMemoryContext.
loadMemory();

export function saveMemory() {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memoryStore.slice(-MAX_MEMORY)));
  } catch (e) {}
}

export function addMemory(role, content) {
  if (!content || typeof content !== 'string') return;
  var str = content.trim();
  if (!str) return;

  // Filtrar ecos del contexto o system prompt en las respuestas del asistente
  if (role === 'assistant') {
    if (str.indexOf('---') !== -1 ||
        /Conversaci[oó]n reciente|Conversaciones futuras|Hechos que el usuario|Usuario:|LinkCore:|Asistente:/i.test(str)) {
      return;
    }
  }

  // Deduplicación estricta en las últimas 5 entradas
  var recent = memoryStore.slice(-5);
  for (var i = 0; i < recent.length; i++) {
    if (recent[i].role === role && recent[i].content.trim() === str) return;
  }

  memoryStore.push({ role: role, content: str, ts: Date.now() });
  if (memoryStore.length > MAX_MEMORY) memoryStore = memoryStore.slice(-MAX_MEMORY);
  saveMemory();
}

// Bug real (2026-07-31, seccion 5 del estado): esto inyectaba hasta 8
// entradas COMPLETAS sin limite de tamaño. Cada respuesta de la IA podia
// ser de 3000-5500+ caracteres; 8 de esas = 30-40KB de prompt. En CPU sin
// GPU, el tiempo de evaluacion del prompt escala con su longitud, y el
// contexto acumulado hacia que smartQuery() agotara el timeout de 120s de
// Ollama ANTES de generar un token -- mientras callAI() con prompt corto
// respondia en ~47s. Ahora se recorta con un presupuesto total de
// caracteres, priorizando los mensajes MAS RECIENTES (los que de verdad
// dan continuidad a la conversacion actual).
const MEMORY_CONTEXT_MAX_CHARS = 4000; // ~1000 tokens -- presupuesto para CPU

export function getMemoryContext() {
  var entries = memoryStore.slice(-8);
  var parts = entries.map(m =>
    (m.role === 'user' ? 'Usuario' : 'LinkCore') + ': ' + m.content
  );
  var out = '';
  for (var i = parts.length - 1; i >= 0; i--) {
    var block = parts[i];
    var candidate = out === '' ? block : block + '\n' + out;
    if (candidate.length > MEMORY_CONTEXT_MAX_CHARS) {
      var budget = MEMORY_CONTEXT_MAX_CHARS - (out === '' ? 0 : out.length + 1) - 1;
      if (budget > 120) {
        out = block.slice(0, budget) + '…' + (out === '' ? '' : '\n' + out);
      }
      break;
    }
    out = candidate;
  }
  return out;
}

export function clearMemory() {
  memoryStore = [];
  saveMemory();
}

export async function githubSearch(query) {
  try {
    const r = await fetch(SEARCH_API + '/repositories?q=' + encodeURIComponent(query) + '&sort=stars&per_page=5');
    if (!r.ok) return null;
    const d = await r.json();
    return (d.items || []).map(repo => ({
      name: repo.full_name,
      description: repo.description || '',
      stars: repo.stargazers_count,
      language: repo.language,
      url: repo.html_url
    }));
  } catch (e) { return null; }
}

export async function githubSearchCode(query) {
  try {
    const r = await fetch(SEARCH_API + '/code?q=' + encodeURIComponent(query) + '&per_page=5');
    if (!r.ok) return null;
    const d = await r.json();
    return (d.items || []).map(item => ({
      name: item.name,
      path: item.path,
      repo: item.repository?.full_name,
      url: item.html_url
    }));
  } catch (e) { return null; }
}

export async function npmSearch(query) {
  try {
    const r = await fetch(NPM_API + '?text=' + encodeURIComponent(query) + '&size=5');
    if (!r.ok) return null;
    const d = await r.json();
    return (d.objects || []).map(p => ({
      name: p.package?.name,
      description: p.package?.description,
      version: p.package?.version,
      url: 'https://www.npmjs.com/package/' + p.package?.name
    }));
  } catch (e) { return null; }
}

export async function stackOverflowSearch(query) {
  try {
    const r = await fetch(SO_API + '?order=desc&sort=relevance&intitle=' + encodeURIComponent(query) + '&site=stackoverflow&pagesize=3');
    if (!r.ok) return null;
    const d = await r.json();
    return (d.items || []).map(q => ({
      title: q.title,
      answers: q.answer_count,
      score: q.score,
      url: q.link
    }));
  } catch (e) { return null; }
}

// Deteccion de herramientas: ahora por agente y por intencion, no solo keywords.
export function detectTools(query, agentId) {
  var t = (query || '').toLowerCase().trim();
  if (!t || /^(hola|buenas|hey|hi|hello|que tal|como estas|buen[ao]s|saludos|gracias|ok|vale|perfecto|chao|adios|bye|si|no|dale|vamos|genial|bien|mal)$/i.test(t)) return [];

  var tools = [];

  // Developer -> GitHub + npm por defecto
  if (agentId === 'developer') {
    tools.push('github');
    if (/npm|paquete|package|dependencia|instalar|install/.test(t)) tools.push('npm');
    if (/error|bug|solucion|problem|fix|stack/.test(t)) tools.push('stackoverflow');
  }
  // Research -> SO + GitHub
  else if (agentId === 'research') {
    if (/error|bug|solucion|problem|fix/.test(t)) tools.push('stackoverflow');
    if (/github|repo|codigo|code|librer[ia]a|library/.test(t)) tools.push('github');
  }
  // Writer, Email, Meeting, Marketing, Finance, Legal -> no tools especificas
  // pero si menciona herramientas explicitas, las usa

  // Deteccion explicita (sobreescribe agente)
  if (/github|repo|repositorio|codigo fuente|source code/.test(t)) {
    if (tools.indexOf('github') === -1) tools.push('github');
  }
  if (/buscar|search|investiga|que es|define|explica|encuentra|mejores|recomienda/.test(t)) {
    if (agentId === 'developer' || agentId === 'research') {
      if (tools.indexOf('github') === -1) tools.push('github');
    }
  }
  if (/npm|paquete|package|dependencia/.test(t)) {
    if (tools.indexOf('npm') === -1) tools.push('npm');
  }
  if (/stack.?overflow|solucion|error|bug|no funciona|crashea|exception|traceback/.test(t)) {
    if (tools.indexOf('stackoverflow') === -1) tools.push('stackoverflow');
  }

  // Dedupe
  return tools.filter(function(v, i, a) { return a.indexOf(v) === i; });
}

export async function executeTools(query, agentId) {
  const tools = detectTools(query, agentId);
  const results = {};
  if (!tools.length) return results;

  const promises = tools.map(async tool => {
    switch (tool) {
      case 'github': {
        const repos = await githubSearch(query);
        if (repos) results.github = repos;
        const code = await githubSearchCode(query);
        if (code) results.code = code;
        break;
      }
      case 'npm': {
        const pkgs = await npmSearch(query);
        if (pkgs) results.npm = pkgs;
        break;
      }
      case 'stackoverflow': {
        const so = await stackOverflowSearch(query);
        if (so) results.stackoverflow = so;
        break;
      }
    }
  });
  await Promise.allSettled(promises);
  return results;
}

// Lista de herramientas ejecutadas (para el badge Tools en el mensaje).
export function toolsUsedList(results) {
  var list = [];
  if (results.github && results.github.length) list.push('github');
  if (results.npm && results.npm.length) list.push('npm');
  if (results.stackoverflow && results.stackoverflow.length) list.push('stackoverflow');
  return list;
}

// Formatea resultados de tools en texto legible para el chat.
export function formatToolResults(query, results) {
  var parts = [];

  if (results.github && results.github.length > 0) {
    parts.push('**Repositorios en GitHub**');
    results.github.forEach(function(r, i) {
      parts.push('**' + (i + 1) + '. [' + r.name + '](' + r.url + ')** - ' + r.stars + ' stars, ' + (r.language || 'N/A'));
      if (r.description) parts.push('   ' + r.description);
    });
    parts.push('');
  }

  if (results.code && results.code.length > 0) {
    parts.push('**Codigo relevante**');
    results.code.forEach(function(c) {
      parts.push('- `' + c.repo + '/' + c.path + '`');
    });
    parts.push('');
  }

  if (results.npm && results.npm.length > 0) {
    parts.push('**Paquetes npm**');
    results.npm.forEach(function(p) {
      parts.push('- **' + p.name + '** v' + p.version + ': ' + (p.description || ''));
    });
    parts.push('');
  }

  if (results.stackoverflow && results.stackoverflow.length > 0) {
    parts.push('**Stack Overflow**');
    results.stackoverflow.forEach(function(q) {
      parts.push('- [' + q.title + '](' + q.url + ') (' + q.answers + ' respuestas, score: ' + q.score + ')');
    });
    parts.push('');
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n');
}

export function buildResponse(query, toolResults) {
  return formatToolResults(query, toolResults) || 'No encontre resultados para "' + query + '". Intenta con otros terminos.';
}
