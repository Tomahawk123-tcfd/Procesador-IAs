// ═══════════════════════════════════════════════════════════════
// BANCO DE PRUEBAS REAL DEL PROCESADOR (2026-08-12)
//
// Objetivo: medir, no prometer. ¿Que aporta de verdad LinkCore sobre
// una respuesta que ya escribio una IA? Se mide la tasa de deteccion
// sobre casos con defectos REALES y conocidos, mas los casos limpios
// (para medir falsos positivos, que son igual de importantes: un
// verificador que avisa siempre no sirve de nada).
//
// Cada caso lleva la fuente del defecto: los marcados [REAL] salieron
// de fallos observados en vivo durante el desarrollo, no inventados
// para que el banco salga bien.
// ═══════════════════════════════════════════════════════════════

import { applyDeterministicVerification } from '../src/backend.js';

var CASES = [
  // ── DEFECTOS REALES (deben detectarse) ──
  {
    id: 'operacion-equivocada',
    fuente: '[REAL] llama3.2:3b via MCP, 2026-08-12',
    query: 'Cuanto es 15 por 4?',
    draft: '15 ÷ 4 = 3.75. La respuesta final es 3,75.',
    debeDetectar: true,
  },
  {
    id: 'afirmacion-duplicada',
    fuente: '[REAL] qwen2.5:0.5b, comparacion Java/Go, 2026-08-12',
    query: 'Compara Java y Go para servicios backend',
    draft: '### Ventajas de Java:\n1. **Sistema operativo integrado**: Java se ejecuta dentro del sistema operativo, lo que significa que las aplicaciones pueden interactuar con los recursos del sistema de manera mas eficiente.\n\n### Ventajas de Go:\n1. **Sistema operativo integrado**: Go se ejecuta dentro del sistema operativo, lo que significa que las aplicaciones pueden interactuar con los recursos del sistema de manera mas eficiente.',
    debeDetectar: true,
  },
  {
    id: 'codigo-python-roto',
    fuente: 'sintaxis invalida real (falta cierre de parentesis)',
    query: 'Dame una funcion en Python que sume dos numeros',
    draft: 'Aqui tienes:\n\n```python\ndef suma(a, b:\n    return a + b\n```',
    debeDetectar: true,
  },
  {
    id: 'codigo-js-roto',
    fuente: 'sintaxis invalida real (llave sin cerrar)',
    query: 'Dame una funcion en JavaScript',
    draft: '```javascript\nfunction suma(a, b) {\n  return a + b;\n```',
    debeDetectar: true,
  },
  {
    id: 'json-roto',
    fuente: 'sintaxis invalida real (coma final)',
    query: 'Dame un package.json minimo',
    draft: '```json\n{\n  "name": "app",\n  "version": "1.0.0",\n}\n```',
    debeDetectar: true,
  },
  {
    id: 'contradiccion-comparativa',
    fuente: 'contradiccion literal sobre el mismo par',
    query: 'Compara PostgreSQL y SQLite',
    draft: 'PostgreSQL es mejor que SQLite para aplicaciones grandes. Pero en escenarios reales SQLite es mejor que PostgreSQL.',
    debeDetectar: true,
  },

  // ── CASOS LIMPIOS (NO deben disparar aviso: mide falsos positivos) ──
  {
    id: 'limpio-operacion-correcta',
    fuente: 'control',
    query: 'Cuanto es 15 por 4?',
    draft: '15 x 4 = 60.',
    debeDetectar: false,
  },
  {
    id: 'limpio-codigo-valido',
    fuente: 'control',
    query: 'Dame una funcion en Python',
    draft: '```python\ndef suma(a, b):\n    return a + b\n```',
    debeDetectar: false,
  },
  {
    id: 'limpio-comparacion-real',
    fuente: 'control',
    query: 'Compara Java y Go',
    draft: 'Java tiene un ecosistema mas maduro y mejor tooling empresarial. Go compila a binarios estaticos y arranca mas rapido, con goroutines para concurrencia ligera.',
    debeDetectar: false,
  },
  {
    id: 'limpio-explicacion',
    fuente: 'control',
    query: 'Que es una red neuronal?',
    draft: 'Una red neuronal es un modelo computacional inspirado en la estructura del cerebro. Consta de capas de nodos conectados que transforman la entrada mediante pesos ajustables.',
    debeDetectar: false,
  },
  {
    // Caso limite añadido al relajar termsMatch() por prefijo (2026-08-12):
    // dos VERSIONES distintas de lo mismo no son una contradiccion. Si el
    // matcher se relajara por primera palabra en vez de por prefijo, esto
    // daria un falso positivo.
    id: 'limpio-versiones-distintas',
    fuente: 'control (riesgo de falso positivo del fix de prefijo)',
    query: 'Compara versiones de Java',
    draft: 'Java 17 es mejor que Java 8 en rendimiento. Ademas Java 8 es mejor que Java 6 en soporte.',
    debeDetectar: false,
  },
];

async function main() {
  var verdaderosPositivos = 0, falsosNegativos = 0;
  var verdaderosNegativos = 0, falsosPositivos = 0;
  var latencias = [];

  console.log('=== BANCO DE PRUEBAS DEL PROCESADOR LINKCORE ===');
  console.log('');

  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    var t0 = Date.now();
    var r = await applyDeterministicVerification(c.draft, c.query);
    var ms = Date.now() - t0;
    latencias.push(ms);

    var detecto = !!r.hasFindings;
    var acierto = detecto === c.debeDetectar;

    if (c.debeDetectar) {
      if (detecto) verdaderosPositivos++; else falsosNegativos++;
    } else {
      if (detecto) falsosPositivos++; else verdaderosNegativos++;
    }

    console.log((acierto ? '  OK  ' : ' FALLO') + ' [' + ms + 'ms] ' + c.id);
    console.log('        esperado=' + (c.debeDetectar ? 'detectar' : 'limpio') + ' obtenido=' + (detecto ? 'detectado' : 'limpio') + '  ' + c.fuente);
    if (detecto) {
      var aviso = (r.text || '').split('\n').find(function (l) { return l.indexOf('⚠️') !== -1; });
      if (aviso) console.log('        -> ' + aviso.trim());
    }
  }

  var conDefecto = verdaderosPositivos + falsosNegativos;
  var limpios = verdaderosNegativos + falsosPositivos;
  var media = Math.round(latencias.reduce(function (a, b) { return a + b; }, 0) / latencias.length);
  var maxLat = Math.max.apply(null, latencias);

  console.log('');
  console.log('=== RESULTADO MEDIDO ===');
  console.log('Deteccion de defectos reales: ' + verdaderosPositivos + '/' + conDefecto + ' (' + Math.round(verdaderosPositivos / conDefecto * 100) + '%)');
  console.log('Casos limpios sin falso aviso: ' + verdaderosNegativos + '/' + limpios + ' (' + Math.round(verdaderosNegativos / limpios * 100) + '%)');
  console.log('Latencia media: ' + media + 'ms | maxima: ' + maxLat + 'ms');
  console.log('');
  console.log('Nota honesta: esto mide SOLO los defectos mecanicos que un parser');
  console.log('puede probar (sintaxis, contradicciones literales, operacion pedida).');
  console.log('NO mide si el contenido es factualmente correcto -- ninguna capa');
  console.log('determinista puede hacer eso.');
}

main().catch(function (e) { console.error('ERROR:', e.message); process.exit(1); });
