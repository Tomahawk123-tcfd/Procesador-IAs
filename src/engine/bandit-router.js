// ── BANDIT CONTEXTUAL (LinUCB) PARA ARRANQUE EN FRIO DE MODELOS ──
// (2026-08-17, hallazgo de investigacion #10, ref. OrcaRouter arXiv:2605.30736)
//
// getLearnedBias() en learning-loop.js devuelve 0 ("sin opinion") mientras
// un par (modelo, categoria) tenga menos de MIN_SAMPLES muestras -- exacto
// el hueco que describe el hallazgo: un modelo recien anadido al catalogo
// (o uno que casi nunca se elige) no tiene historial de MCTS/pairings, asi
// que compite a ciegas contra piezas con años de datos. Este modulo no
// sustituye ese sistema (que funciona bien UNA VEZ hay datos) -- rellena
// especificamente el hueco de arranque en frio con un bandit contextual
// LinUCB real (Li et al. 2010, "A Contextual-Bandit Approach to
// Personalized News Article Recommendation"): cada modelo es un "brazo"
// con su propia matriz de confianza, y el score que devuelve equilibra
// explotacion (lo que ya parece funcionar) con exploracion (incertidumbre
// real, no una moneda al aire) desde la PRIMERA consulta, no desde la
// tercera.
//
// Vector de contexto (d=6), deliberadamente pequeño para que la inversion
// de matriz (Gauss-Jordan, sin dependencias) sea barata y estable:
//   [1, log(longitud_query+1)/10, es_code, es_reasoning, es_text, es_general]
// Sin `query` disponible en el llamador (algunos sitios de este proyecto
// solo tienen `category`), el vector se degrada a solo el termino de sesgo
// + categoria -- sigue siendo un bandit real, solo con menos contexto.

import { localStorage } from '../memory-bus.js';

var STORAGE_KEY = 'lc_bandit_v1';
var DIM = 6;
var ALPHA = 1.0; // exploracion estandar de LinUCB (Li et al. 2010) -- no es un valor "verificado optimo" para este catalogo, es el default razonable de la literatura
var CATEGORIES = ['code', 'reasoning', 'text', 'general'];

var _arms = {}; // modelId -> { A: number[][], b: number[], pulls: number }

function _load() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') _arms = parsed;
    }
  } catch (e) {}
}

function _save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_arms)); } catch (e) {}
}

_load();

function identity(n) {
  var m = [];
  for (var i = 0; i < n; i++) {
    m.push([]);
    for (var j = 0; j < n; j++) m[i].push(i === j ? 1 : 0);
  }
  return m;
}

function getArm(modelId) {
  if (!_arms[modelId]) {
    _arms[modelId] = { A: identity(DIM), b: new Array(DIM).fill(0), pulls: 0 };
  }
  return _arms[modelId];
}

// Vector de contexto real a partir de la categoria (siempre disponible) y,
// si se pasa, el texto de la query (longitud como proxy de complejidad de
// la tarea -- no hay analisis semantico aqui, es deliberadamente barato).
function buildContext(category, query) {
  var x = new Array(DIM).fill(0);
  x[0] = 1;
  var qLen = query && typeof query.length === 'number' && isFinite(query.length) && query.length >= 0 ? query.length : 0;
  var lenTerm = Math.log(qLen + 1) / 10;
  x[1] = isFinite(lenTerm) ? lenTerm : 0; // bug real (2026-08-17, hallazgo del cazador de bugs): un `query.length` no-finito (objeto con .length=Infinity/NaN en vez de string real) colaba Infinity/NaN en el vector de contexto, contaminaba A/b PARA SIEMPRE (se persiste), y invertMatrix no lo detectaba (su guarda de singularidad compara contra 1e-10, que nunca dispara con Infinity/NaN) -- getBanditScore quedaba devolviendo NaN en todas las consultas futuras para ese brazo, incluso con queries normales despues
  var catIdx = CATEGORIES.indexOf(category || 'general');
  if (catIdx === -1) catIdx = CATEGORIES.indexOf('general');
  x[2 + catIdx] = 1;
  return x;
}

// Inversion de matriz por Gauss-Jordan -- sin dependencias, DIM=6 la hace
// barata (36 celdas). Si la matriz sale singular (no deberia: A empieza
// como identidad y solo se le suman actualizaciones de rango 1, que la
// mantienen definida positiva), se devuelve la identidad en vez de NaN --
// degrada a "sin opinion aun" en vez de contaminar el score con basura.
function invertMatrix(matrix) {
  var n = matrix.length;
  // Defensa adicional (2026-08-17): la guarda de singularidad de mas abajo
  // compara contra 1e-10 y NUNCA dispara si la matriz ya trae Infinity/NaN
  // (p.ej. estado cargado de disco corrompido por una version anterior del
  // bug de buildContext, o cualquier otra via futura) -- Infinity no es
  // "< 1e-10" y las comparaciones con NaN siempre dan false. Se comprueba
  // explicitamente antes de invertir para que la promesa del comentario de
  // abajo ("nunca NaN") sea real y no solo se cumpla por casualidad.
  for (var ri = 0; ri < n; ri++) {
    for (var ci = 0; ci < n; ci++) {
      if (!isFinite(matrix[ri][ci])) return identity(n);
    }
  }
  var aug = matrix.map(function (row, i) {
    var identityRow = new Array(n).fill(0);
    identityRow[i] = 1;
    return row.concat(identityRow);
  });

  for (var col = 0; col < n; col++) {
    var pivotRow = col;
    for (var r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(aug[pivotRow][col]) < 1e-10) return identity(n); // singular: no fingir un resultado
    var tmp = aug[col]; aug[col] = aug[pivotRow]; aug[pivotRow] = tmp;

    var pivot = aug[col][col];
    for (var c = 0; c < 2 * n; c++) aug[col][c] /= pivot;

    for (var r2 = 0; r2 < n; r2++) {
      if (r2 === col) continue;
      var factor = aug[r2][col];
      for (var c2 = 0; c2 < 2 * n; c2++) aug[r2][c2] -= factor * aug[col][c2];
    }
  }

  return aug.map(function (row) { return row.slice(n); });
}

function matVec(matrix, vec) {
  return matrix.map(function (row) {
    return row.reduce(function (sum, v, i) { return sum + v * vec[i]; }, 0);
  });
}

function dot(a, b) {
  return a.reduce(function (sum, v, i) { return sum + v * b[i]; }, 0);
}

// Score UCB real: theta^T x + alpha * sqrt(x^T A^-1 x). Positivo siempre
// (el termino de exploracion es una raiz cuadrada), pensado para SUMARSE
// como un termino de arranque en frio, no para sustituir el sesgo
// aprendido una vez hay datos reales.
export function getBanditScore(modelId, category, query) {
  var arm = getArm(modelId);
  var x = buildContext(category, query);
  var Ainv = invertMatrix(arm.A);
  var theta = matVec(Ainv, arm.b);
  var exploitation = dot(theta, x);
  var AinvX = matVec(Ainv, x);
  var exploration = ALPHA * Math.sqrt(Math.max(0, dot(x, AinvX)));
  return exploitation + exploration;
}

// reward en [0,1] -- mismo tipo de señal que learning-loop.js ya deriva
// (exito + calidad determinista), no una escala nueva que haya que
// recalibrar por separado.
export function recordBanditOutcome(modelId, category, query, reward) {
  if (typeof reward !== 'number' || !isFinite(reward)) return;
  reward = Math.max(0, Math.min(1, reward));
  var arm = getArm(modelId);
  var x = buildContext(category, query);
  for (var i = 0; i < DIM; i++) {
    for (var j = 0; j < DIM; j++) arm.A[i][j] += x[i] * x[j];
    arm.b[i] += reward * x[i];
  }
  arm.pulls++;
  _save();
}

export function getBanditPulls(modelId) {
  return _arms[modelId] ? _arms[modelId].pulls : 0;
}

export function clearBanditState() {
  _arms = {};
  _save();
}
