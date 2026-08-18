import { verifyCalculations } from '../src/engine/math-verify.js';

function show(label, fn) {
  try {
    console.log('---', label, '---');
    console.log(JSON.stringify(fn(), null, 2));
  } catch (e) {
    console.log('THREW:', e.stack);
  }
}

// 3+ chained expressions on one line, all correct
show('3-chain all correct', () => verifyCalculations('10 + 5 = 15 = 20 - 5 = 15'));

// 3+ chain with error in the MIDDLE segment
show('3-chain error in middle', () => verifyCalculations('10 + 5 = 16 = 20 - 5 = 15'));

// 3+ chain with error in the FIRST segment
show('3-chain error in first', () => verifyCalculations('10 + 5 = 14 = 20 - 5 = 15'));

// 3+ chain with error in LAST segment
show('3-chain error in last', () => verifyCalculations('10 + 5 = 15 = 20 - 5 = 99'));

// 5-segment chain (A=B=C=D=E style), all consistent
show('5-chain all correct', () => verifyCalculations('100 = 50 + 50 = 20 + 80 = 10 + 90 = 40 + 60'));

// 5-segment chain, error deep inside
show('5-chain error deep', () => verifyCalculations('100 = 50 + 50 = 20 + 80 = 10 + 91 = 40 + 60'));

// Last segment malformed/unparseable
show('last segment malformed', () => verifyCalculations('10 + 5 = 15 = 20 - 5 = abc123###'));
show('last segment malformed 2', () => verifyCalculations('10 + 5 = 15 = 20 -'));
show('last segment truncated mid-op', () => verifyCalculations('10 + 5 = 15 = 20 - 5 ='));

// classic bug case from comments: real-world example
show('real example from comment: temp conversion double =', () => verifyCalculations('318 x 5/9 ≈ 176.7'));
show('real example: fraction reduction chain', () => verifyCalculations('Future value = 8200 x (1+0,003417)^36 ≈ 8200 x 1,1303 ≈ $9.268'));
