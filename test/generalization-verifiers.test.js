import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyUnits } from '../src/engine/unit-verify.js';
import { verifyAlgebraicSubstitution } from '../src/engine/algebra-verify.js';
import { verifyConclusionConsistency } from '../src/engine/conclusion-verify.js';
import { verifySqlSemantics } from '../src/engine/sql-semantic-verify.js';
import { verifySourceFidelity } from '../src/engine/source-fidelity-verify.js';
import { verifyConfigIntent } from '../src/engine/config-intent-verify.js';

// Cada caso lleva su pareja correcta: un verificador que solo acierta el fallo
// pero grita sobre la respuesta buena es inservible en produccion, porque el
// operador aprende a ignorar sus avisos. Por eso todos los tests de aqui
// comprueban las dos direcciones.

test('unit channel catches arithmetic carrying units and stays quiet when it is right', function () {
  assert.equal(verifyUnits('55 liters / 3.785 ≈ 20.8 US gallons').length, 1);
  assert.equal(verifyUnits('55 liters / 3.785 ≈ 14.5 US gallons').length, 0);
});

test('unit channel catches wrong decimal-to-minutes decomposition', function () {
  assert.equal(verifyUnits('12 / 5 = 2.4 hours, which is about 2 hours 40 minutes.').length, 1);
  assert.equal(verifyUnits('12 / 5 = 2.4 hours, which is about 2 hours 24 minutes.').length, 0);
});

test('unit channel catches a remainder that exceeds its own base unit', function () {
  assert.equal(verifyUnits('The total weight is 7 lbs 18 oz.').length, 1);
  assert.equal(verifyUnits('The total weight is 7 lbs 8 oz.').length, 0);
});

test('algebra channel catches a ratio declared one way and substituted the other', function () {
  var flawed = 'The rule is sugar = flour × (2/3). With 750 g of flour, sugar = 750 × 3/2 = 1125 g.';
  var correct = 'The rule is sugar = flour × (2/3). With 750 g of flour, sugar = 750 × 2/3 = 500 g.';
  assert.equal(verifyAlgebraicSubstitution(flawed).length, 1);
  assert.equal(verifyAlgebraicSubstitution(correct).length, 0);
});

test('algebra channel catches an inverted isolation of the unknown', function () {
  var flawed = 'Since selling price = C × 1.65, we get C = 18.50 × 1.65 ≈ 30.53.';
  var correct = 'Since selling price = C × 1.65, we get C = 18.50 / 1.65 ≈ 11.21.';
  assert.equal(verifyAlgebraicSubstitution(flawed).length, 1);
  assert.equal(verifyAlgebraicSubstitution(correct).length, 0);
});

test('conclusion channel catches a final answer that contradicts its own derivation', function () {
  var flawed = 'Counting forward from Monday: Tuesday, Wednesday. So the meeting is on Thursday.';
  var correct = 'Counting forward from Monday: Tuesday, Wednesday. So the meeting is on Wednesday.';
  assert.equal(verifyConclusionConsistency(flawed, 'What day is the meeting?').length, 1);
  assert.equal(verifyConclusionConsistency(correct, 'What day is the meeting?').length, 0);
});

test('conclusion channel catches a yes/no verdict incompatible with its explanation', function () {
  var query = 'Policy: refunds need a return within 30 days AND a receipt. A customer returned on day 25 with no receipt. Is the refund valid?';
  var flawed = 'Yes, the refund is valid. The return happened on day 25, which satisfies the time condition, but the customer had no receipt, so the second condition fails.';
  var correct = 'No, the refund is not valid. The return happened on day 25, which satisfies the time condition, but the customer had no receipt, so the second condition fails.';
  assert.equal(verifyConclusionConsistency(flawed, query).length, 1);
  assert.equal(verifyConclusionConsistency(correct, query).length, 0);
});

test('sql channel catches a write with no WHERE clause', function () {
  var query = 'Desactiva todas las cuentas de usuarios que no han entrado desde hace más de 2 años.';
  var flawed = "```sql\nUPDATE users SET status = 'inactive';\n```";
  var correct = "```sql\nUPDATE users SET status = 'inactive' WHERE last_login < NOW() - INTERVAL '2 years';\n```";
  assert.equal(verifySqlSemantics(flawed, query).length, 1);
  assert.equal(verifySqlSemantics(correct, query).length, 0);
});

test('sql channel catches equality against NULL and aggregates inside WHERE', function () {
  var nullCompare = '```sql\nSELECT id FROM users WHERE email = NULL;\n```';
  assert.equal(verifySqlSemantics(nullCompare, 'Usuarios sin email').length, 1);
  assert.equal(verifySqlSemantics('```sql\nSELECT id FROM users WHERE email IS NULL;\n```', 'Usuarios sin email').length, 0);
  var aggregate = '```sql\nSELECT user_id FROM orders GROUP BY user_id WHERE COUNT(*) > 10;\n```';
  assert.equal(verifySqlSemantics(aggregate, 'Usuarios con más de 10 pedidos').length, 1);
});

test('sql channel catches an inner join that drops the rows the question asked for', function () {
  var query = 'Lista todos los clientes con su número de pedidos, incluyendo los que no han hecho ninguno.';
  var flawed = '```sql\nSELECT c.name, COUNT(o.id) FROM customers c INNER JOIN orders o ON o.customer_id = c.id GROUP BY c.name;\n```';
  var correct = '```sql\nSELECT c.name, COUNT(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.name;\n```';
  assert.equal(verifySqlSemantics(flawed, query).length, 1);
  assert.equal(verifySqlSemantics(correct, query).length, 0);
});

test('source channel catches a figure the quoted clause does not support', function () {
  var query = 'Resume esta cláusula: "Either party may terminate this Agreement upon ninety (90) days prior written notice to the other party, provided that all outstanding invoices are settled before the effective termination date."';
  var flawed = 'The clause allows termination with 30 days of prior written notice, once invoices are settled.';
  var correct = 'The clause allows termination with 90 days of prior written notice, once invoices are settled.';
  assert.equal(verifySourceFidelity(flawed, query).length, 1);
  assert.equal(verifySourceFidelity(correct, query).length, 0);
});

test('source channel stays silent when the question carries no quoted source', function () {
  assert.equal(verifySourceFidelity('El plazo es de 30 días.', '¿Cuál es el plazo de preaviso habitual?').length, 0);
});

test('config channel catches a CIDR wider than the one requested', function () {
  var query = 'Escribe un security group en YAML que permita SSH solo desde la red interna de la oficina (10.0.5.0/24).';
  var flawed = '```yaml\nsecurity_group:\n  rules:\n    - port: 22\n      source: 0.0.0.0/0\n```';
  var correct = '```yaml\nsecurity_group:\n  rules:\n    - port: 22\n      source: 10.0.5.0/24\n```';
  assert.equal(verifyConfigIntent(flawed, query).length, 1);
  assert.equal(verifyConfigIntent(correct, query).length, 0);
});

test('config channel catches disabled certificate verification and a missing backoff', function () {
  var tlsQuery = 'Configura la conexión TLS de un cliente a un servicio interno, verificando siempre el certificado del servidor.';
  assert.equal(verifyConfigIntent('```javascript\nconst c = new HttpsClient({ rejectUnauthorized: false });\n```', tlsQuery).length, 1);
  assert.equal(verifyConfigIntent('```javascript\nconst c = new HttpsClient({ rejectUnauthorized: true });\n```', tlsQuery).length, 0);
  var retryQuery = 'Escribe una política de reintentos JSON con un backoff exponencial razonable.';
  assert.equal(verifyConfigIntent('```json\n{"maxRetries": 5, "backoffMs": 0, "backoffMultiplier": 1}\n```', retryQuery).length, 1);
  assert.equal(verifyConfigIntent('```json\n{"maxRetries": 5, "backoffMs": 500, "backoffMultiplier": 2}\n```', retryQuery).length, 0);
});

test('config channel catches a value that contradicts the requested one', function () {
  var query = 'Escribe una configuración de backup automático que retenga copias diarias durante 30 días.';
  assert.equal(verifyConfigIntent('```yaml\nbackup:\n  retention_days: 3\n```', query).length, 1);
  assert.equal(verifyConfigIntent('```yaml\nbackup:\n  retention_days: 30\n```', query).length, 0);
});
