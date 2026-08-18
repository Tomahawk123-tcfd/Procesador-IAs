import { verifyStructuralCoherence, extractClaims, normalizeEntity } from '../src/engine/structural-verify.js';

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

section('1. 4-hop transitive chain (A=B,B=C,C=D, D negated against A)');
{
  const text = 'Python es un lenguaje interpretado. Un lenguaje interpretado es un lenguaje dinamico. Un lenguaje dinamico es un lenguaje flexible. Python no es un lenguaje flexible.';
  const claims = extractClaims(text);
  console.log('claims:', claims.map(c => ({ subj: c.subjectNorm, pred: c.predicateNorm, neg: c.negated })));
  const result = verifyStructuralCoherence(text);
  console.log('findings count:', result.findings.length);
  result.findings.forEach(f => console.log(' - drivenBy:', f.drivenBy, 'channels:', f.channels, 'reason:', f.reason));
}

section('2. Accent-stripping false collision: ano/o vs ano (potential false positive)');
{
  console.log('normalizeEntity("año") =', JSON.stringify(normalizeEntity('año')));
  console.log('normalizeEntity("ano") =', JSON.stringify(normalizeEntity('ano')));
  console.log('normalizeEntity("peña") =', JSON.stringify(normalizeEntity('peña')));
  console.log('normalizeEntity("pena") =', JSON.stringify(normalizeEntity('pena')));

  const text = 'El año es largo. El ano no es largo.';
  const claims = extractClaims(text);
  console.log('claims:', claims.map(c => ({ subj: c.subjectNorm, pred: c.predicateNorm, neg: c.negated })));
  const result = verifyStructuralCoherence(text);
  console.log('findings count:', result.findings.length);
  result.findings.forEach(f => console.log(' - drivenBy:', f.drivenBy, 'reason:', f.reason, 'claimA:', f.claimA, 'claimB:', f.claimB));
}

section('3. Sanity: legit accent-only merge should still work (Paris/París)');
{
  const text = 'La capital de Francia es Paris. La capital de Francia no es París.';
  const result = verifyStructuralCoherence(text);
  console.log('findings count (expect >0, they should be treated as SAME entity+predicate so no topological path... actually this checks predicate merge):', result.findings.length);
  console.log(JSON.stringify(result, null, 2));
}
