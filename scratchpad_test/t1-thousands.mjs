import { verifyCalculations, safeEval } from '../src/engine/math-verify.js';

function show(label, fn) {
  try {
    console.log('---', label, '---');
    console.log(JSON.stringify(fn(), null, 2));
  } catch (e) {
    console.log('THREW:', e.stack);
  }
}

// 4+ comma groups
show('4-group thousands correct', () => verifyCalculations('Total = 1,234,567,890 + 1 = 1234567891'));
show('4-group thousands WRONG', () => verifyCalculations('Total = 1,234,567,890 + 1 = 999'));

// comma-3-digits that's genuinely a European decimal in context
show('euro-decimal-looking-like-thousands (should be consistent not crash)', () => verifyCalculations('Precio = 100 + 9,268 = 109,268'));

// comma-3-digit group followed by more numeric-looking chars
show('trailing percent after comma-3', () => verifyCalculations('Crecimiento = 9,268% del total'));
show('trailing close-paren after comma-3', () => verifyCalculations('(el resultado es 9,268)'));
show('direct stmt with percent suffix', () => verifyCalculations('200 + 9,068 = 9,268%'));
