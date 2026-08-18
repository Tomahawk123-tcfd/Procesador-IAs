import { assessConfidence } from './src/engine/confidence-unit.js';

async function run(label, text, opts) {
  var r = await assessConfidence(text, opts || {});
  console.log('=== ' + label + ' ===');
  console.log('score=' + r.score + ' escalate=' + r.recommendEscalation);
  console.log(r.reason.slice(0, 120));
  console.log();
}

async function main() {
  await run('pure arithmetic answer "El resultado es 42"', 'Para calcular 6 * 7, multiplicamos 6 por 7. El resultado es 42.');
  await run('pure arithmetic with equals symbol only', '6 * 7 = 42');
  await run('final numeric answer, English', 'To compute 6 * 7 we multiply. The answer is 42.');
  await run('typical math derivation', 'Paso 1: 15 + 27 = 42. Paso 2: 42 * 2 = 84. El total es 84.');
  await run('percentage calc with narrative', 'El precio original era 100. Con un descuento del 20%, el precio final es 80.');
}
main().catch(e => { console.error('CRASH', e); process.exit(1); });
