// Sonda offline del ALU determinista: corre applyDeterministicVerification
// contra un corpus sin arrancar el servicio ni Ollama (VERIFY no genera
// nada, asi que es reproducible en cualquier maquina y en CI).
//
//   node scripts/offline-verify-probe.mjs [--corpus=./benchmark-corpus-independent.mjs]
import { applyDeterministicVerification } from '../src/engine/verification-pipeline.js';

var corpusArg = process.argv.find(function (a) { return a.startsWith('--corpus='); });
var corpusPath = corpusArg ? corpusArg.slice('--corpus='.length) : './benchmark-corpus-independent.mjs';
var mod = await import(corpusPath);
var CASES = mod.CASES;

var rows = [];
for (var c of CASES) {
  var flawed = await applyDeterministicVerification(c.flawedDraft, c.query);
  var correct = await applyDeterministicVerification(c.correctDraft, c.query);
  rows.push({
    id: c.id,
    category: c.category,
    expectedGap: !!c.expectedGap,
    caught: flawed.hasFindings,
    channels: flawed.channels,
    falsePositive: correct.hasFindings,
    fpChannels: correct.channels,
  });
}

var flawedCaught = rows.filter(function (r) { return r.caught; }).length;
var fps = rows.filter(function (r) { return r.falsePositive; });
rows.forEach(function (r) {
  console.log(
    (r.caught ? 'HIT ' : 'MISS') + ' ' +
    (r.falsePositive ? 'FALSO-POS ' : '          ') +
    r.id.padEnd(14) +
    (r.channels.length ? '[' + r.channels.join(',') + ']' : '') +
    (r.falsePositive ? ' fp[' + r.fpChannels.join(',') + ']' : '') +
    (r.expectedGap ? ' (gap esperado)' : '')
  );
});
console.log('');
console.log('recall: ' + flawedCaught + '/' + rows.length + ' (' + Math.round((100 * flawedCaught) / rows.length) + '%)');
console.log('falsos positivos: ' + fps.length + '/' + rows.length + (fps.length ? ' -> ' + fps.map(function (r) { return r.id; }).join(', ') : ''));
