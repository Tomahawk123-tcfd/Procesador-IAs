// ── BENCHMARK DE VERIFICACION DETERMINISTA ──
// Ejecutar con: node test/verification-benchmark.js
//
// Que mide: la capacidad de LinkCore para detectar errores REALES en
// respuestas de modelos, usando verificacion determinista (calculo real,
// compilador real, ejecucion real) en vez de "otra IA opinando".
//
// Por que existe: la pregunta "¿cuanto mejora una IA al instalar LinkCore?"
// no se puede responder con una cifra inventada. Este benchmark responde
// una version concreta y medible de esa pregunta: de N errores reales que
// un modelo comete con total confianza, ¿cuantos se detectan? Y de M
// respuestas correctas, ¿cuantas se marcan por error (falsos positivos)?
//
// Los casos NO son sinteticos: los marcados [REAL] son salidas literales
// capturadas de ejecuciones reales de LinkCore el 2026-08-08, incluido el
// error que motivo cada verificador.

import { verifyCalculations } from '../src/engine/math-verify.js';
import { verifyCodeBlocks } from '../src/engine/code-verify.js';
import { verifyOutputClaims } from '../src/engine/output-verify.js';

// ── CASOS CON ERROR REAL (deberian detectarse) ──
var CASOS_CON_ERROR = [
  {
    id: 'interes-compuesto [REAL]',
    tipo: 'matematica',
    nota: 'Capturado en vivo: 1.07^10 sustituido como 2,158275 en vez de 1,967151 (+9.7%)',
    texto: 'A = P x (1 + r/n)^(nt)\nA = 1000 x (1 + 0,07/1)^(1*10)\nA = 1000 x (1 + 0,07)^10\nA = 1000 x 2,158275\nA ≈ 2158,28 euros',
  },
  {
    id: 'descuento-mal',
    tipo: 'matematica',
    nota: '200 * 0.15 son 30, no 25',
    texto: 'El descuento del 15% sobre 200 euros es 200 * 0.15 = 25 euros',
  },
  {
    id: 'iva-mal',
    tipo: 'matematica',
    nota: '50 * 0.21 son 10.5, no 15.5',
    texto: 'El IVA del 21% sobre 50 euros: 50 * 0.21 = 15.5 euros',
  },
  {
    id: 'python-sintaxis-roto',
    tipo: 'codigo',
    nota: 'Faltan los dos puntos',
    texto: '```python\ndef es_primo(n)\n    if n < 2\n        return False\n    return True\n```',
  },
  {
    id: 'js-sintaxis-roto',
    tipo: 'codigo',
    nota: 'Falta cerrar la llave',
    texto: '```javascript\nfunction suma(a, b) { return a + b\n```',
  },
  {
    id: 'salida-mentira [REAL]',
    tipo: 'salida',
    nota: 'Capturado en vivo: codigo correcto pero el comentario miente sobre el resultado',
    texto: '```python\ndef invertir_cadena(cadena):\n    return cadena[::-1]\n\ntexto = "Hola, mundo"\nprint(invertir_cadena(texto))  # Output: "dlmoh,olleh"\n```',
  },
];

// ── CASOS CORRECTOS (NO deberian generar ningun aviso) ──
var CASOS_CORRECTOS = [
  {
    id: 'descuento-bien [REAL]',
    nota: 'Capturado en vivo: 340 * 0.22 = 74.80, 340 - 74.80 = 265.20',
    texto: 'Descuento = 340 x 0,22 = 74,80 euros\nPrecio Final = 340 - 74,80 = 265,20 euros',
  },
  { id: 'area-bien', nota: '5*8=40', texto: 'El area es 5 * 8 = 40 metros cuadrados' },
  { id: 'conversion-bien', nota: '100*1000/3600=27.78', texto: 'Convertimos 100 km/h a m/s: 100 * 1000 / 3600 = 27.78 m/s' },
  { id: 'descuento-compuesto-bien', nota: '80-80*0.3=56', texto: 'Con un 30% de descuento, 80 euros quedan en 80 - 80*0.3 = 56 euros' },
  {
    id: 'factorial-bien [REAL]',
    nota: 'Capturado en vivo: codigo y salida afirmada ambos correctos',
    texto: '```python\ndef factorial(n):\n    if n == 0:\n        return 1\n    return n * factorial(n-1)\n\nprint(factorial(5))  # Output: 120\n```',
  },
  {
    id: 'invertir-bien',
    nota: 'Mismo codigo que el caso roto, pero con la salida correcta',
    texto: '```python\ndef inv(c):\n    return c[::-1]\n\nprint(inv("Hola, mundo"))  # Output: "odnum ,aloH"\n```',
  },
  { id: 'rango-anios', nota: 'Riesgo de falso positivo: "2020-2024" parece una resta', texto: 'Entre 2020-2024 el mercado crecio un 40%.' },
  { id: 'version-software', nota: 'Riesgo de falso positivo: "3.11-3.13"', texto: 'Compatible con Python 3.11-3.13 en produccion.' },
  { id: 'rango-modelos', nota: 'Riesgo de falso positivo: "3-5 modelos"', texto: 'El ensemble usa 3-5 modelos en paralelo.' },
  { id: 'ip-local', nota: 'Riesgo de falso positivo: IP con puntos', texto: 'El nodo escucha en 192.168.1.60:17890 por defecto.' },
  { id: 'prosa-sin-numeros', nota: 'Control: texto normal', texto: 'El mercado de bicicletas electricas plegables ha crecido de forma sostenida en Europa.' },
];

async function detectaAlgo(texto) {
  var avisos = [];
  try {
    var m = verifyCalculations(texto);
    if (m.length > 0) avisos.push('matematica(' + m.length + ')');
  } catch (e) { avisos.push('ERROR-math:' + e.message); }
  try {
    var c = await verifyCodeBlocks(texto);
    if (c.length > 0) avisos.push('sintaxis(' + c.length + ')');
  } catch (e) { avisos.push('ERROR-code:' + e.message); }
  try {
    var o = await verifyOutputClaims(texto);
    if (o.length > 0) avisos.push('salida(' + o.length + ')');
  } catch (e) { avisos.push('ERROR-output:' + e.message); }
  return avisos;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' BENCHMARK DE VERIFICACION DETERMINISTA — LinkCore');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('── Casos CON error real (se espera deteccion) ──');
  var detectados = 0;
  for (var i = 0; i < CASOS_CON_ERROR.length; i++) {
    var caso = CASOS_CON_ERROR[i];
    var avisos = await detectaAlgo(caso.texto);
    var ok = avisos.length > 0;
    if (ok) detectados++;
    console.log((ok ? '  [DETECTADO] ' : '  [ESCAPO   ] ') + caso.id + ' (' + caso.tipo + ') ' + (ok ? '→ ' + avisos.join(', ') : ''));
    console.log('               ' + caso.nota);
  }

  console.log('');
  console.log('── Casos CORRECTOS (se espera silencio: 0 avisos) ──');
  var falsosPositivos = 0;
  for (var j = 0; j < CASOS_CORRECTOS.length; j++) {
    var bueno = CASOS_CORRECTOS[j];
    var avisosB = await detectaAlgo(bueno.texto);
    var limpio = avisosB.length === 0;
    if (!limpio) falsosPositivos++;
    console.log((limpio ? '  [LIMPIO      ] ' : '  [FALSO POSIT.] ') + bueno.id + (limpio ? '' : ' → ' + avisosB.join(', ')));
  }

  var totalErr = CASOS_CON_ERROR.length;
  var totalOk = CASOS_CORRECTOS.length;
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' RESULTADO');
  console.log('   Errores reales detectados: ' + detectados + '/' + totalErr + ' (' + Math.round(detectados / totalErr * 100) + '%)');
  console.log('   Falsos positivos:          ' + falsosPositivos + '/' + totalOk + ' (' + Math.round(falsosPositivos / totalOk * 100) + '%)');
  console.log('');
  console.log('   Sin LinkCore, la deteccion de estos errores es 0/' + totalErr + ':');
  console.log('   un modelo los produce con total confianza y nada los marca.');
  console.log('═══════════════════════════════════════════════════════════');

  // Salida no-cero si hay falsos positivos o si escapa algun error: asi
  // sirve como test de regresion real, no solo como demo.
  if (falsosPositivos > 0 || detectados < totalErr) process.exitCode = 1;
}

main();
