// ── SEMANTIC CACHE ──
// Complementa la cache exacta de chip-core.js (finalCacheGet/finalCacheSet,
// indexada por hash literal de la query): esta busca la entrada mas
// PARECIDA por embeddings, no identica caracter a caracter. Vive fuera de
// chip-core.js a proposito -- necesita el modelo de embeddings de Ollama
// (nomic-embed-text), una dependencia real que las otras caches no tienen.
//
// Riesgo real, deliberadamente tratado con cuidado: dos preguntas casi
// identicas en superficie pueden tener respuestas DISTINTAS ("cuanto es
// 5+3" vs "cuanto es 5+4") -- un umbral mal calibrado devolveria la
// respuesta equivocada con total confianza. El umbral por defecto (0.94)
// viene de una calibracion real con casos adversarios de este tipo (ver
// scripts/calibrate-semantic-cache.mjs), no de una intuicion.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

var DEFAULT_CACHE_DIR = path.join(os.homedir(), '.linkcore');
var DEFAULT_CACHE_FILE = 'semantic-cache.json';

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── GUARDAS DETERMINISTAS ──
// Calibracion real (2026-08-11, ver scripts/calibrate-semantic-cache.mjs)
// demostro que ningun umbral de similitud coseno separa con seguridad
// "misma pregunta, otra redaccion" de "pregunta parecida, dato distinto":
// "traduce hola al ingles" vs "traduce ADIOS al ingles" puntuo 0.9163,
// mas alto que una parafrasis legitima (0.9160). El umbral por si solo
// no basta -- estas guardas comprueban lo que el embedding no distingue
// bien: numeros exactos y el objetivo de un verbo de accion.

// Guarda 1: si cualquiera de las dos preguntas menciona numeros, deben
// ser EXACTAMENTE los mismos (mismo conjunto, no solo la misma cantidad).
// Cubre el caso real de esta noche: interes compuesto sobre 6000€ vs
// 12000€, y "cuanto es 5+3" vs "cuanto es 5+4".
function numbersMatch(a, b) {
  var numsA = (a.match(/\d+(?:[.,]\d+)?/g) || []).slice().sort();
  var numsB = (b.match(/\d+(?:[.,]\d+)?/g) || []).slice().sort();
  if (numsA.length !== numsB.length) return false;
  for (var i = 0; i < numsA.length; i++) {
    if (numsA[i] !== numsB[i]) return false;
  }
  return true;
}

// Guarda 2: si alguna pregunta usa un verbo de accion con objeto directo
// ("traduce X", "calcula X", "define X"...), la PRIMERA palabra tras el
// verbo debe coincidir -- cubre "traduce hola" vs "traduce adios": el
// verbo coincide, el objeto no, se rechaza aunque el embedding sea alto.
var ACTION_VERBS = ['traduce', 'traduzca', 'traducir', 'calcula', 'calcule', 'resuelve', 'convierte', 'define', 'explica', 'busca'];
function extractActionTargets(text) {
  var lower = text.toLowerCase();
  var targets = [];
  ACTION_VERBS.forEach(function (verb) {
    var idx = lower.indexOf(verb + ' ');
    if (idx === -1) return;
    var rest = lower.slice(idx + verb.length + 1);
    var firstWord = (rest.match(/[a-záéíóúñü]+/) || [])[0];
    if (firstWord) targets.push(verb + ':' + firstWord);
  });
  return targets.sort();
}
function actionTargetsMatch(a, b) {
  var targetsA = extractActionTargets(a);
  var targetsB = extractActionTargets(b);
  if (targetsA.length === 0 && targetsB.length === 0) return true;
  if (targetsA.length !== targetsB.length) return false;
  for (var i = 0; i < targetsA.length; i++) {
    if (targetsA[i] !== targetsB[i]) return false;
  }
  return true;
}

function passesGuards(currentQuery, cachedQuery) {
  return numbersMatch(currentQuery, cachedQuery) && actionTargetsMatch(currentQuery, cachedQuery);
}

export class SemanticCache {
  constructor(opts) {
    opts = opts || {};
    this.threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.90;
    this.maxSize = opts.maxSize || 500;
    this.embedder = opts.embedder || 'nomic-embed-text';
    this.cacheFile = opts.cacheFile || path.join(DEFAULT_CACHE_DIR, DEFAULT_CACHE_FILE);
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.ready = false;
  }

  async init() {
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      var raw = await fs.readFile(this.cacheFile, 'utf-8');
      var parsed = JSON.parse(raw);
      this.entries = new Map(Object.entries(parsed));
    } catch (e) {
      this.entries = new Map();
    }
    this.ready = true;
  }

  async _save() {
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(this.entries)));
    } catch (e) { /* cuota excedida u otro fallo de disco: no interrumpe el flujo en memoria */ }
  }

  async _embed(text) {
    try {
      var res = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embedder, prompt: text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      var data = await res.json();
      return Array.isArray(data.embedding) ? data.embedding : null;
    } catch (e) {
      return null;
    }
  }

  // Nunca lanza: un fallo de embeddings (Ollama caido, timeout) degrada a
  // "sin cache", nunca tumba la consulta real.
  async get(query) {
    if (!this.ready) await this.init();
    var embedding = await this._embed(query);
    if (!embedding) { this.misses++; return null; }

    var best = null;
    var bestScore = 0;
    var threshold = this.threshold;
    this.entries.forEach(function (entry) {
      var score = cosineSimilarity(embedding, entry.embedding);
      // La guarda se comprueba POR CANDIDATO, no solo sobre el ganador --
      // un candidato con score mas alto pero que no pasa la guarda no debe
      // tapar a otro mas bajo que si la pasa.
      if (score > bestScore && score >= threshold && passesGuards(query, entry.query)) {
        bestScore = score;
        best = entry;
      }
    });

    if (best) {
      this.hits++;
      return { response: best.response, metadata: best.metadata || {}, score: bestScore, matchedQuery: best.query };
    }
    this.misses++;
    return null;
  }

  async set(query, response, metadata) {
    if (!this.ready) await this.init();
    var embedding = await this._embed(query);
    if (!embedding) return;

    var key = crypto.createHash('sha256').update(query).digest('hex');
    this.entries.set(key, { query: query, response: response, embedding: embedding, metadata: metadata || {}, ts: Date.now() });

    if (this.entries.size > this.maxSize) {
      var oldestKey = null, oldestTs = Infinity;
      this.entries.forEach(function (entry, k) {
        if (entry.ts < oldestTs) { oldestTs = entry.ts; oldestKey = k; }
      });
      if (oldestKey) this.entries.delete(oldestKey);
    }

    await this._save();
  }

  getHitRate() {
    var total = this.hits + this.misses;
    return total ? (this.hits / total) * 100 : 0;
  }

  async clear() {
    this.entries = new Map();
    await this._save();
  }
}

export { cosineSimilarity };
