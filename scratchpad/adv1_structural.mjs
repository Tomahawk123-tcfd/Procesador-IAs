import { verifyStructuralCoherence, verifyCrossVoiceFacts, extractClaims, normalizeEntity } from '../src/engine/structural-verify.js';

function section(t){ console.log('\n=== ' + t + ' ==='); }

// TEST A: 4-hop transitive chain (A=B, B=C, C=D, D negated vs A)
section('4-hop transitive chain');
var text4hop = 'El hierro es un metal. El metal es un elemento quimico. El elemento quimico es materia. El hierro no es materia.';
var claims = extractClaims(text4hop);
console.log('claims extracted:', claims.map(c => ({subj: c.subjectNorm, pred: c.predicateNorm, negated: c.negated})));
var r1 = verifyStructuralCoherence(text4hop);
console.log('findings:', r1.findings.length, 'threshold:', r1.threshold, 'pairsAnalyzed:', r1.pairsAnalyzed);
r1.findings.forEach(f => console.log('  ->', f.claimA.text, '|', f.claimB.text, 'drivenBy:', f.drivenBy, 'totalTension:', f.totalTension));
var caughtViaTopo = r1.findings.some(f => f.drivenBy.indexOf('topological') !== -1);
console.log('RESULT: 4-hop chain caught via topological channel =', caughtViaTopo);

// TEST B: accent-stripping false positive risk - minimal pairs in Spanish
section('accent-stripping false-positive risk (sabana vs sábana)');
console.log('normalizeEntity("sabana") =', JSON.stringify(normalizeEntity('sabana')));
console.log('normalizeEntity("sábana") =', JSON.stringify(normalizeEntity('sábana')));
console.log('normalizeEntity("una sabana") =', JSON.stringify(normalizeEntity('una sabana')));
console.log('normalizeEntity("una sábana") =', JSON.stringify(normalizeEntity('una sábana')));

var textAccentFP = 'El desierto es una sabana. El desierto no es una sábana.';
var claimsFP = extractClaims(textAccentFP);
console.log('claims:', claimsFP.map(c => ({subj: c.subjectNorm, pred: c.predicateNorm, negated: c.negated})));
var r2 = verifyStructuralCoherence(textAccentFP);
console.log('findings:', r2.findings.length);
r2.findings.forEach(f => console.log('  ->', f.claimA.text, '|', f.claimB.text, 'drivenBy:', f.drivenBy));
console.log('RESULT: false positive fired due to accent collapse =', r2.findings.length > 0);

// also test with cross-voice fact check (two independent voices, savanna vs bedsheet)
section('accent-stripping false positive via verifyCrossVoiceFacts');
var voices = [
  { model: 'voiceA', text: 'El desierto es una sabana.' },
  { model: 'voiceB', text: 'El desierto es una sábana.' },
];
var crossFindings = verifyCrossVoiceFacts(voices);
console.log('crossVoiceFacts findings:', JSON.stringify(crossFindings, null, 2));
console.log('RESULT: cross-voice false positive (different real entities collapsed) =', crossFindings.length > 0);

// another real minimal pair: "esta" (this) vs "está" (is/located)
section('accent-stripping: esta vs está');
console.log('normalizeEntity("esta") =', JSON.stringify(normalizeEntity('esta')));
console.log('normalizeEntity("está") =', JSON.stringify(normalizeEntity('está')));

// TEST: re-verify original motivating bug for topological channel: Paris/París accent bug should NOT falsely disagree
section('Original bug: Paris vs París should NOT be flagged as disagreement');
var voicesParis = [
  { model: 'voiceA', text: 'La capital de Francia es Paris.' },
  { model: 'voiceB', text: 'La capital de Francia es París.' },
];
var parisFindings = verifyCrossVoiceFacts(voicesParis);
console.log('findings:', JSON.stringify(parisFindings));
console.log('RESULT: Paris/París correctly NOT flagged =', parisFindings.length === 0);

// TEST: original 2-hop motivating topological example (PostgreSQL SQL/NoSQL style)
section('Original bug: 2-hop topological chain (short motivating example)');
var text2hop = 'PostgreSQL es SQL. SQL es relacional. PostgreSQL no es relacional.';
var r3 = verifyStructuralCoherence(text2hop);
console.log('claims:', extractClaims(text2hop).map(c => ({subj: c.subjectNorm, pred: c.predicateNorm, negated: c.negated})));
console.log('findings:', r3.findings.length, 'threshold', r3.threshold);
r3.findings.forEach(f => console.log('  ->', f.claimA.text, '|', f.claimB.text, 'drivenBy:', f.drivenBy));
console.log('RESULT: 2-hop chain still caught =', r3.findings.some(f => f.drivenBy.indexOf('topological') !== -1));
