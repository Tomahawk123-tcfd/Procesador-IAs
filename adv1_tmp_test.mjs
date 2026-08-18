import { assessConfidence } from './src/engine/confidence-unit.js';

async function run(label, text, opts) {
  var t0 = Date.now();
  var r = await assessConfidence(text, opts || {});
  var dt = Date.now() - t0;
  console.log('=== ' + label + ' (' + dt + 'ms) ===');
  console.log(JSON.stringify(r, null, 2));
  console.log();
}

async function main() {
  // 1. mixed factual + arithmetic
  await run('mixed factual+arithmetic', 'La capital de Francia es París, que tiene 2100000 habitantes y creció 15% + 3% este año.');

  // 2. very long text (thousands of chars)
  var longText = '';
  for (var i = 0; i < 500; i++) longText += 'El total es ' + i + ' más 5 igual ' + (i+5) + '. ';
  await run('very long arithmetic-ish text (' + longText.length + ' chars)', longText);

  var longFactual = '';
  for (var i = 0; i < 300; i++) longFactual += 'Entidad' + i + ' es CosaGenerica' + (i % 7) + '. ';
  await run('very long factual-ish text (' + longFactual.length + ' chars)', longFactual);

  // 3. no claims, no arithmetic - poem
  await run('poem, no claims no arithmetic', 'El viento canta bajo la luna,\nlas olas bailan sin fortuna,\nel corazón sueña despacio,\ny el tiempo pasa sin espacio.');

  await run('joke', '¿Por qué los programadores prefieren el frío? Porque odian los bugs.');

  // poem with "es" pattern that could false-positive as factual claim
  await run('poem with X es Y phrasing', 'La vida es un sueño,\nel amor es un juego,\nel destino no es cruel,\nsolo es incierto.');

  // 4. malformed payloads
  await run('draft undefined', undefined, { hasFindings: false });
  await run('draft null', null, { hasFindings: false });
  await run('draft number', 12345, { hasFindings: false });
  await run('draft array', [1, 2, 3], { hasFindings: false });
  await run('draft object', { a: 1, b: 'x' }, { hasFindings: false });
  await run('draft boolean true', true, { hasFindings: false });
  await run('draft empty string', '', { hasFindings: false });

  // hasFindings true short-circuit
  await run('hasFindings true (should short circuit, no ram check)', 'cualquier texto', { hasFindings: true });

  // RAM check injection - simulate no RAM
  await run('factual claim, RAM check throws', 'La capital de Francia es París.', {
    hasFindings: false,
  });

  console.log('DONE');
}

main().catch(function (e) { console.error('CRASHED:', e); process.exit(1); });
