import { extractClaims } from './src/engine/structural-verify.js';

function show(label, text) {
  console.log('=== ' + label + ' ===');
  console.log(JSON.stringify(extractClaims(text), null, 2));
  console.log();
}

show('mixed', 'La capital de Francia es París, que tiene 2100000 habitantes y creció 15% + 3% este año.');
show('arith answer', 'Para calcular 6 * 7, multiplicamos 6 por 7. El resultado es 42.');
show('derivation', 'Paso 1: 15 + 27 = 42. Paso 2: 42 * 2 = 84. El total es 84.');
show('percent', 'El precio final es 80%.');
show('currency', 'El coste total es 42 dólares.');
