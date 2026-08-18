// ═══════════════════════════════════════════════════════════════
// CORPUS AUTOESCRITO — 30 casos, 5 categorias x 6. Cada caso trae un
// borrador CORRECTO (lo que una IA jefe fluida podria escribir bien) y un
// borrador FLAWED con UN fallo concreto, real e inequivoco inyectado. Los
// fallos se eligieron para ser plausibles (no "2+2=5"), y varios casos se
// dejan A PROPOSITO fuera del alcance de los verificadores existentes
// (marcados `expectedGap`) para medir la cobertura real, no solo los casos
// favorables.
//
// Limitacion honesta (2026-08-18): este corpus lo escribi yo (la misma IA
// que construyo y arreglo los verificadores) y luego arregle los
// verificadores hasta que pasaran estos mismos casos. Es un metodo real de
// desarrollo (nunca se descarto un caso que fallara, cada fix se verifico
// en vivo), pero no es un corpus INDEPENDIENTE de un tercero -- ver
// scripts/benchmark-corpus-independent.mjs para la version escrita por un
// agente que nunca vio el codigo de los verificadores.
// ═══════════════════════════════════════════════════════════════

export var CASES = [
  // ── MATH / ARITMETICA ──────────────────────────────────────────
  {
    id: 'math-01', category: 'math',
    query: '¿Cuánto es 23 por 17?',
    correctDraft: '23 x 17 = 391.',
    flawedDraft: '23 x 17 = 381.',
    flaw: 'producto incorrecto (391 vs 381)',
  },
  {
    id: 'math-02', category: 'math',
    query: '¿Cuánto es 12,5 por 8?',
    correctDraft: '12,5 x 8 = 100.',
    flawedDraft: '12,5 x 8 = 105.',
    flaw: 'producto incorrecto (100 vs 105)',
  },
  {
    id: 'math-03', category: 'math',
    query: '¿Cuánto es el 15% de 240?',
    correctDraft: 'El 15% de 240 es 0,15 x 240 = 36.',
    flawedDraft: 'El 15% de 240 es 0,15 x 240 = 38.',
    flaw: 'resultado incorrecto (36 vs 38)',
  },
  {
    id: 'math-04', category: 'math',
    query: '¿Cuánto es 84 dividido entre 6?',
    correctDraft: '84 ÷ 6 = 14.',
    flawedDraft: '84 - 6 = 78.',
    flaw: 'resuelve una resta en vez de la división pedida (el resultado, 78, es correcto para esa resta -- el fallo es la operación, no el número)',
  },
  {
    id: 'math-05', category: 'math',
    query: 'Si inviertes 1000 euros al 5% anual compuesto durante 12 años, ¿cuánto tendrás aproximadamente?',
    correctDraft: '1000 x (1,05)^12 = 1795,86 euros aproximadamente.',
    flawedDraft: '1000 x (1,05)^12 = 1895,86 euros aproximadamente.',
    flaw: 'interés compuesto mal calculado (1795,86 vs 1895,86)',
  },
  {
    id: 'math-06', category: 'math',
    query: 'Un producto cuesta 480 euros con un descuento del 18%. ¿Cuál es el precio final?',
    correctDraft: 'Descuento = 480 x 0,18 = 86,40 euros\nPrecio final = 480 - 86,40 = 393,60 euros',
    flawedDraft: 'Descuento = 480 x 0,18 = 86,40 euros\nPrecio final = 480 - 86,40 = 383,60 euros',
    flaw: 'precio final incorrecto (393,60 vs 383,60)',
    note: 'GAP CONOCIDO, encontrado construyendo este benchmark: math-verify.js#verifyCalculations calcula un campo `label` por paso (linea 155-159, comentario que dice "agrupar por etiqueta lo arregla") pero ese campo NUNCA se usa para filtrar la comparación de pasos consecutivos (bucle real en líneas ~241-255) -- compara el descuento (86,40) contra el precio final (393,60), dos cantidades DISTINTAS, y grita un falso "355% de diferencia" incluso en el borrador CORRECTO. Confirmado en vivo antes de fijar este caso.',
  },

  // ── CODE / CODIGO CON BUGS REALES ──────────────────────────────
  {
    id: 'code-01', category: 'code',
    query: 'Escribe una función en Python que sume dos números.',
    correctDraft: '```python\ndef suma(a, b):\n    return a + b\n```',
    flawedDraft: '```python\ndef suma(a, b)\n    return a + b\n```',
    flaw: 'falta ":" tras la firma de la función -- SyntaxError real',
  },
  {
    id: 'code-02', category: 'code',
    query: 'Escribe una función en JavaScript que compruebe si un número es par.',
    correctDraft: '```javascript\nfunction esPar(n) {\n  return n % 2 === 0;\n}\n```',
    flawedDraft: '```javascript\nfunction esPar(n) {\n  return n % 2 === 0;\n```',
    flaw: 'falta la llave de cierre -- SyntaxError real',
  },
  {
    id: 'code-03', category: 'code',
    query: 'Escribe una función en Python que devuelva los primeros n números pares empezando en 0.',
    correctDraft: '```python\ndef primeros_pares(n):\n    return [2*i for i in range(n)]\n```',
    flawedDraft: '```python\ndef primeros_pares(n):\n    return [2*i for i in range(n + 1)]\n```',
    flaw: 'error de "off-by-one": devuelve n+1 elementos en vez de n -- puramente semántico, sin error de sintaxis',
    note: 'GAP ESPERADO: code-verify.js solo comprueba sintaxis (ast.parse/vm.Script) y existencia de API de la stdlib -- nunca comportamiento. Este caso no tiene ningún error sintáctico que detectar.',
    expectedGap: true,
  },
  {
    id: 'code-04', category: 'code',
    query: 'Escribe código Python que compruebe si una ruta existe usando el módulo os.',
    correctDraft: "```python\nimport os\nprint(os.path.exists('/tmp/test'))\n```",
    flawedDraft: "```python\nimport os\nprint(os.path.is_valid('/tmp/test'))\n```",
    flaw: 'os.path.is_valid no existe en la librería estándar de Python (API alucinada)',
  },
  {
    id: 'code-05', category: 'code',
    query: 'Escribe un script bash que liste archivos .txt en el directorio actual.',
    correctDraft: '```bash\nfor f in *.txt; do\n  echo "$f"\ndone\n```',
    flawedDraft: '```bash\nfor f in *.txt; do\n  echo "$f"\n```',
    flaw: 'falta "done" -- bucle for sin terminar, SyntaxError real de bash',
  },
  {
    id: 'code-06', category: 'code',
    query: 'Genera un JSON de configuración con host y puerto.',
    correctDraft: '```json\n{"host": "localhost", "port": 8080}\n```',
    flawedDraft: '```json\n{"host": "localhost", "port": 8080,}\n```',
    flaw: 'coma final -- JSON inválido',
  },

  // ── FACTUAL / COMPARACIONES ─────────────────────────────────────
  {
    id: 'fact-01', category: 'factual',
    query: '¿Cuál es la capital de Canadá?',
    correctDraft: 'La capital de Canadá es Ottawa.',
    flawedDraft: 'La capital de Canadá es Toronto.',
    flaw: 'capital incorrecta (Toronto es la ciudad más grande, no la capital)',
  },
  {
    id: 'fact-02', category: 'factual',
    query: '¿Cuál es la capital de Australia?',
    correctDraft: 'La capital de Australia es Canberra.',
    flawedDraft: 'La capital de Australia es Sídney.',
    flaw: 'capital incorrecta (mismo caso documentado en vnpu-core.js sobre CROSSCHECK)',
  },
  {
    id: 'fact-03', category: 'factual',
    query: 'Compara Python y Java en velocidad de desarrollo para prototipos rápidos.',
    correctDraft: 'Python es mejor que Java para prototipar rápido gracias a su sintaxis concisa. Ambos lenguajes tienen usos distintos según el proyecto.',
    flawedDraft: 'Python es mejor que Java para prototipar rápido gracias a su sintaxis concisa. Sin embargo, para ese mismo caso, Java es mejor que Python.',
    flaw: 'autocontradicción directa: afirma "Python mejor que Java" y "Java mejor que Python" para la misma comparación',
  },
  {
    id: 'fact-04', category: 'factual',
    query: '¿En qué año llegó el ser humano a la Luna por primera vez?',
    correctDraft: 'El ser humano llegó a la Luna por primera vez en 1969.',
    flawedDraft: 'El ser humano llegó a la Luna por primera vez en 1968.',
    flaw: 'año incorrecto (1969 vs 1968)',
  },
  {
    id: 'fact-05', category: 'factual',
    query: '¿Cuál es la montaña más alta del mundo?',
    correctDraft: 'La montaña más alta del mundo es el monte Everest.',
    flawedDraft: 'La montaña más alta del mundo es el K2.',
    flaw: 'montaña incorrecta (K2 es la segunda más alta, no la primera)',
  },
  {
    id: 'fact-06', category: 'factual',
    query: '¿Cuál es la capital de Brasil?',
    correctDraft: 'La capital de Brasil es Brasilia.',
    flawedDraft: 'La capital de Brasil es Río de Janeiro.',
    flaw: 'capital incorrecta (Río fue la capital histórica, ya no lo es)',
  },

  // ── TEMPORAL / ARITMETICA DE AÑOS ──────────────────────────────
  {
    id: 'temporal-01', category: 'temporal',
    query: 'Si una empresa se fundó en 2010, ¿en qué año cumplió 15 años?',
    correctDraft: '15 años después de 2010 es 2025.',
    flawedDraft: '15 años después de 2010 es 2024.',
    flaw: 'año incorrecto (2025 vs 2024)',
  },
  {
    id: 'temporal-02', category: 'temporal',
    query: 'Si alguien nació en 1990, ¿en qué año cumplió 30 años?',
    correctDraft: '30 años después de 1990 es 2020.',
    flawedDraft: '30 años después de 1990 es 2019.',
    flaw: 'año incorrecto (2020 vs 2019)',
  },
  {
    id: 'temporal-03', category: 'temporal',
    query: 'Un edificio fue demolido 40 años antes de 2020. ¿En qué año se demolió?',
    correctDraft: '40 años antes de 2020 es 1980.',
    flawedDraft: '40 años antes de 2020 es 1970.',
    flaw: 'año incorrecto, error mayor (1980 vs 1970)',
  },
  {
    id: 'temporal-04', category: 'temporal',
    query: '¿Qué año fue 25 años antes de 2015?',
    correctDraft: '25 años antes de 2015 es 1990.',
    flawedDraft: '25 años antes de 2015 es 1995.',
    flaw: 'año incorrecto (1990 vs 1995)',
  },
  {
    id: 'temporal-05', category: 'temporal',
    query: 'Resume brevemente qué año es actualmente y cuántos años han pasado desde el año 2000.',
    correctDraft: 'El año actual es 2026. Han pasado 26 años desde el año 2000.',
    flawedDraft: 'El año actual es 2026. Sin embargo, como dijimos antes, hoy es el año 2024.',
    flaw: 'se contradice sobre cuál es el año actual (2026 vs 2024) dentro del mismo texto',
  },
  {
    id: 'temporal-06', category: 'temporal',
    query: 'Una ley se aprobó 60 años después de 1950. ¿En qué año se aprobó?',
    correctDraft: '60 años después de 1950 es 2010.',
    flawedDraft: '60 años después de 1950 es 2015.',
    flaw: 'año incorrecto (2010 vs 2015)',
  },

  // ── REASONING / RAZONAMIENTO MULTI-PASO ────────────────────────
  {
    id: 'reason-01', category: 'reasoning',
    query: 'Compras 3 camisetas a 15 euros cada una y 2 pantalones a 40 euros cada uno. ¿Cuánto pagas en total?',
    correctDraft: '3 camisetas a 15 euros son 45 euros. 2 pantalones a 40 euros son 80 euros. Total = 45 + 80 = 125 euros.',
    flawedDraft: '3 camisetas a 15 euros son 45 euros. 2 pantalones a 40 euros son 80 euros. Total = 45 + 80 = 135 euros.',
    flaw: 'suma final incorrecta (125 vs 135)',
  },
  {
    id: 'reason-02', category: 'reasoning',
    query: 'Explica brevemente la relación entre PostgreSQL, las bases de datos relacionales y SQL.',
    correctDraft: 'PostgreSQL es una base de datos relacional. Una base de datos relacional es un sistema basado en SQL. PostgreSQL es un sistema basado en SQL.',
    flawedDraft: 'PostgreSQL es una base de datos relacional. Una base de datos relacional es un sistema basado en SQL. PostgreSQL no es un sistema basado en SQL.',
    flaw: 'contradicción transitiva: afirma A=B, B=C, pero también A≠C dentro del mismo texto',
    note: 'GAP CERRADO 2026-08-17: verifyStructuralCoherence existía pero no estaba conectado a verification-pipeline.js, y además su umbral por percentil-de-lote nunca disparaba con pocas afirmaciones (una cadena contradictoria de 3 claims ocupa 2 de 3 pares -- mayoría, no atípico). Ambos huecos corregidos: se conectó el verificador y se añadió un disparo directo para el canal topológico (señal discreta de grafo, no continua) sin pasar por el umbral relativo. Verificado en vivo con linkcore vnpu VERIFY.',
  },
  {
    id: 'reason-03', category: 'reasoning',
    query: 'Ana tiene el doble de edad que Juan. Juan tiene 8 años. En 5 años, ¿cuántos años tendrán juntos entre los dos?',
    correctDraft: 'Ana tiene 2 x 8 = 16 años. En 5 años, Ana tendrá 16 + 5 = 21 años y Juan tendrá 8 + 5 = 13 años. Juntos sumarán 21 + 13 = 34 años.',
    flawedDraft: 'Ana tiene 2 x 8 = 16 años. En 5 años, Ana tendrá 16 + 5 = 21 años y Juan tendrá 8 + 5 = 13 años. Juntos sumarán 21 + 13 = 44 años.',
    flaw: 'suma final incorrecta en el último paso (34 vs 44)',
  },
  {
    id: 'reason-04', category: 'reasoning',
    query: 'Un rectángulo mide 12 metros de largo y 5 metros de ancho. ¿Cuál es su área y su perímetro?',
    correctDraft: 'El área es 12 x 5 = 60 metros cuadrados y el perímetro es 2 x (12 + 5) = 34 metros.',
    flawedDraft: 'El área es 12 x 5 = 60 metros cuadrados y el perímetro es 2 x (12 + 5) = 32 metros.',
    flaw: 'perímetro incorrecto (34 vs 32), área correcta',
  },
  {
    id: 'reason-05', category: 'reasoning',
    query: 'Marta es 5 años mayor que Pedro. Pedro es 3 años mayor que Luis. ¿Cuántos años mayor es Marta que Luis?',
    correctDraft: 'Marta es mayor que Luis por 5 + 3 = 8 años.',
    flawedDraft: 'Marta es mayor que Luis por 5 + 3 = 6 años.',
    flaw: 'suma incorrecta (8 vs 6)',
  },
  {
    id: 'reason-06', category: 'reasoning',
    query: 'Un tren sale a las 14:00 y tarda 3 horas en llegar. Si además se retrasa 45 minutos, ¿a qué hora llega?',
    correctDraft: 'Sale a las 14:00 y tarda 3 horas, así que llegaría a las 17:00. Con 45 minutos de retraso adicional, la hora de llegada final es las 17:45.',
    flawedDraft: 'Sale a las 14:00 y tarda 3 horas, así que llegaría a las 17:00. Con 45 minutos de retraso adicional, la hora de llegada final es las 18:15.',
    flaw: 'hora final incorrecta (17:45 vs 18:15)',
    note: 'GAP ESPERADO: ningún verificador de este proyecto cubre aritmética de horas (HH:MM) -- math-verify.js solo evalúa expresiones numéricas puras, temporal-verify.js solo cubre aritmética de AÑOS.',
    expectedGap: true,
  },
];
