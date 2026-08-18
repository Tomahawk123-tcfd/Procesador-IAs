// ═══════════════════════════════════════════════════════════════
// GITHUB SEMANTIC SEARCH — busca codigo relevante en un repo real de
// GitHub via su API (sin clonar), genera embeddings con el modelo local
// nomic-embed-text (ya instalado en Ollama, gratis, cero nube), y
// devuelve solo los fragmentos mas relevantes como contexto.
//
// No es "integracion con Windsurf" -- no llama a ninguna API de
// Windsurf. Es una busqueda semantica propia, inspirada en como se
// describe su indexado remoto, honesta sobre lo que es.
//
// Reusa fetchGithubRepoTree/fetchGithubFileContent/getGithubToken de
// backend.js (ya existian, del conector de GitHub de Ajustes) en vez de
// duplicar el cliente de la API de GitHub.
//
// Limites deliberados (no fingidos): indexa UN repo concreto bajo
// demanda (no "los 10 repos mas populares" de golpe -- eso agota el
// limite de peticiones de la API de GitHub en minutos), y hasta
// MAX_FILES_PER_INDEX archivos por repo.
// ═══════════════════════════════════════════════════════════════

var OLLAMA_URL = 'http://localhost:11434';
var CODE_EXTENSIONS = ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'rb', 'php', 'swift', 'kt', 'md'];
var MAX_FILES_PER_INDEX = 40;
var MAX_CHARS_PER_FILE = 4000;

var repoIndexCache = {}; // "owner/repo" -> [{path, embedding, preview}]

async function backend() {
  return import('../backend.js');
}

async function embedText(text) {
  var res = await fetch(OLLAMA_URL + '/api/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!res.ok) throw new Error('Ollama embeddings HTTP ' + res.status);
  var data = await res.json();
  if (!data.embedding) throw new Error('Sin embedding en la respuesta de Ollama');
  return data.embedding;
}

function cosineSimilarity(a, b) {
  var dot = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Detecta una referencia real "owner/repo" en el texto del usuario. Solo
// busca en GitHub si el usuario menciono un repo de verdad -- nunca
// dispara una busqueda a ciegas sobre "todo GitHub".
//
// Bug real, confirmado en vivo (2026-08-13): el patron original
// (`\b\w[\w.-]*\/\w[\w.-]*\b`) no exigia ningun indicio real de "esto es
// un repo" -- cualquier "X/Y" en el texto del usuario colaba, contradiciendo
// el comentario de arriba. Reproducido: "A/B testing" -> {A, B}; "la
// reunion es el 13/08" -> {13, 08}; "receta: 1/2 taza" -> {1, 2}; "visita
// https://example.com/docs" -> {example.com, docs}; "modelo
// cliente/servidor" -> {cliente, servidor}. Con token de GitHub conectado,
// cada uno de estos dispara una llamada HTTP real a la API (orchestrator.js
// linea 270 -> findGithubContext -> indexRepository), gastando cuota y
// latencia en peticiones que no tienen nada que ver con un repositorio.
// Se corrige exigiendo una señal real de "esto es GitHub": o bien la URL
// completa (`github.com/owner/repo`, la señal mas fuerte posible, no
// necesita palabra clave adicional), o bien que el texto mencione
// "repo"/"repositorio"/"github" en algun punto junto al patron owner/repo.
// Ademas, owner y repo ahora deben empezar por letra (no digito) -- las
// fechas ("13/08") y fracciones ("1/2") nunca son un nombre real de repo
// o usuario de GitHub.
var GITHUB_URL_PATTERN = /github\.com\/([a-zA-Z][\w.-]{0,38})\/([a-zA-Z][\w.-]{0,99})/i;
var BARE_REPO_PATTERN = /\b([a-zA-Z][\w.-]{0,38})\/([a-zA-Z][\w.-]{0,99})\b/;
var REPO_SIGNAL = /\brepo(sitorio)?\b|\bgithub\b/i;
export function detectRepoReference(text) {
  text = text || '';
  var urlMatch = GITHUB_URL_PATTERN.exec(text);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  if (!REPO_SIGNAL.test(text)) return null;
  var m = BARE_REPO_PATTERN.exec(text);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Indexa UN repo bajo demanda: estructura real, hasta MAX_FILES_PER_INDEX
// archivos de codigo, embedding real por archivo (nomic-embed-text local).
// Solo guarda embedding + una vista previa corta, no el archivo completo.
export async function indexRepository(owner, repo, opts) {
  opts = opts || {};
  var key = owner + '/' + repo;
  if (repoIndexCache[key] && !opts.force) return { ok: true, cached: true, files: repoIndexCache[key].length };

  var mod = await backend();
  var token = opts.token || await mod.getGithubToken();
  if (!token) return { ok: false, error: 'no_github_token', hint: 'Conecta GitHub en Ajustes o pasa un token.' };

  var tree = await mod.fetchGithubRepoTree(token, owner, repo);
  if (!tree || !tree.length) return { ok: false, error: 'Repo no encontrado o sin archivos accesibles.' };

  var codeFiles = tree.filter(function (f) {
    var ext = f.path.split('.').pop().toLowerCase();
    return CODE_EXTENSIONS.indexOf(ext) !== -1;
  }).slice(0, MAX_FILES_PER_INDEX);

  var entries = [];
  for (var i = 0; i < codeFiles.length; i++) {
    try {
      var fileRes = await mod.fetchGithubFileContent(token, owner, repo, codeFiles[i].path);
      if (!fileRes.ok) continue;
      var snippet = fileRes.content.slice(0, MAX_CHARS_PER_FILE);
      var embedding = await embedText(snippet);
      entries.push({ path: codeFiles[i].path, embedding: embedding, preview: snippet.slice(0, 300) });
    } catch (e) {
      // Un archivo individual que falle no tira el indexado entero.
    }
  }

  repoIndexCache[key] = entries;
  return { ok: true, cached: false, files: entries.length, attempted: codeFiles.length };
}

export async function searchIndexedRepo(owner, repo, query, limit) {
  var key = owner + '/' + repo;
  var index = repoIndexCache[key];
  if (!index || !index.length) return { ok: false, error: 'Repo no indexado todavia. Llama a indexRepository primero.' };

  var queryEmbedding = await embedText(query);
  var scored = index.map(function (e) {
    return { path: e.path, preview: e.preview, similarity: cosineSimilarity(queryEmbedding, e.embedding) };
  });
  scored.sort(function (a, b) { return b.similarity - a.similarity; });
  return { ok: true, results: scored.slice(0, limit || 5) };
}

// Busca contexto de GitHub relevante para una peticion del usuario, solo
// si menciono explicitamente un repo real (owner/repo). Indexa bajo
// demanda si hace falta. Devuelve null si no hay repo mencionado -- nunca
// busca a ciegas.
export async function findGithubContext(query, opts) {
  var ref = detectRepoReference(query);
  if (!ref) return null;

  var indexResult = await indexRepository(ref.owner, ref.repo, opts);
  if (!indexResult.ok) return { ok: false, error: indexResult.error, repo: ref.owner + '/' + ref.repo };

  var search = await searchIndexedRepo(ref.owner, ref.repo, query, 3);
  if (!search.ok || !search.results.length) return { ok: false, error: 'sin resultados relevantes', repo: ref.owner + '/' + ref.repo };

  return {
    ok: true,
    repo: ref.owner + '/' + ref.repo,
    filesIndexed: indexResult.files,
    results: search.results,
    contextText: search.results.map(function (r) {
      return '=== ' + r.path + ' (similitud ' + (r.similarity * 100).toFixed(0) + '%) ===\n' + r.preview;
    }).join('\n\n'),
  };
}

export function getIndexStats() {
  var stats = {};
  Object.keys(repoIndexCache).forEach(function (k) { stats[k] = repoIndexCache[k].length; });
  return stats;
}
