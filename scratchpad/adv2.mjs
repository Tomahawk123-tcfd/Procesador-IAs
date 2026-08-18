import { detectLineContradictions, lineLevelConsensus } from '../src/engine/neural-arbitrage.js';

function section(title) { console.log('\n=== ' + title + ' ==='); }

section('1. singleValueSubstitution: TWO differing tokens (should NOT fire)');
{
  const linesA = ['Newton nacio en 1642 en Woolsthorpe.'];
  const linesB = ['Newton nacio en 1643 en Cambridge.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log(JSON.stringify(res, null, 2));
}

section('2. singleValueSubstitution: ONE differing digit token (should fire, baseline)');
{
  const linesA = ['Newton nacio en 1643.'];
  const linesB = ['Newton nacio en 1642.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log(JSON.stringify(res, null, 2));
}

section('3. GPT-4 vs GPT-5 (digit token, hyphenated) tokenization check');
{
  const linesA = ['El modelo usado es GPT-4.'];
  const linesB = ['El modelo usado es GPT-5.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log(JSON.stringify(res, null, 2));
}

section('4. looksLikeMetaLine: English preamble filtering');
{
  const linesA = ["Sure, here's a quick overview.", 'PostgreSQL is a relational database.'];
  const linesB = ["Let me explain briefly.", 'PostgreSQL is a NoSQL database.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log(JSON.stringify(res, null, 2));
}

section('5. looksLikeMetaLine: legit content starting with "Claro que" (Spanish)');
{
  const linesA = ['Claro que Peru limita con Brasil.'];
  const linesB = ['Peru no limita con Brasil.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log('contradictions found:', res.length);
  console.log(JSON.stringify(res, null, 2));
}

section('6. Original motivating bug: Canberra vs Sidney (2026-08-17)');
{
  const linesA = ['La capital de Australia es Canberra, una ciudad planificada.'];
  const linesB = ['La capital de Australia es Sidney, la ciudad mas grande del pais.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log(JSON.stringify(res, null, 2));
}

section('7. reason-02 benchmark: preamble should not create phantom contradiction vs real content');
{
  const linesA = ['¡Claro! Aqui te explico brevemente.', 'PostgreSQL es una base de datos relacional.'];
  const linesB = ['PostgreSQL es una base de datos relacional y robusta.'];
  const res = detectLineContradictions(linesA, linesB, 'modelA', 'modelB');
  console.log('contradictions found:', res.length);
  console.log(JSON.stringify(res, null, 2));
}
