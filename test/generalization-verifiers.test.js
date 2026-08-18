import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyUnits, verifyUnitAwareArithmetic } from '../src/engine/unit-verify.js';
import { verifyAlgebraicSubstitution } from '../src/engine/algebra-verify.js';
import { verifyConclusionConsistency, verifyRoundingClaim } from '../src/engine/conclusion-verify.js';
import { verifySqlSemantics } from '../src/engine/sql-semantic-verify.js';
import { verifySourceFidelity } from '../src/engine/source-fidelity-verify.js';
import { verifyConfigIntent } from '../src/engine/config-intent-verify.js';
import { verifyFinancialFormulas } from '../src/engine/financial-verify.js';
import { verifyQueryGrounding, verifyOwnershipAttribution, verifyReferenceRange } from '../src/engine/query-grounding-verify.js';
import { verifyCodeContract } from '../src/engine/code-contract-verify.js';

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

test('financial channel catches a percentage taken over the wrong base', function () {
  var query = 'Una empresa tiene ingresos de 4.200.000 EUR y costes de 3.100.000 EUR. ¿Cuál es el margen de beneficio como porcentaje de los ingresos?';
  var flawed = 'Beneficio = 4.200.000 - 3.100.000 = 1.100.000 EUR. Margen = 1.100.000 / 3.100.000 = 35,5%.';
  var correct = 'Beneficio = 4.200.000 - 3.100.000 = 1.100.000 EUR. Margen = 1.100.000 / 4.200.000 = 26,2%.';
  assert.equal(verifyFinancialFormulas(flawed, query).length, 1);
  assert.equal(verifyFinancialFormulas(correct, query).length, 0);
});

test('financial channel catches markup solved with the target-margin formula', function () {
  var query = 'Un producto cuesta 40 EUR al por mayor y se aplica un markup del 60% para fijar el precio de venta. ¿Cuál es el precio de venta?';
  assert.equal(verifyFinancialFormulas('Precio de venta = Coste / (1 - markup) = 40 / 0,40 = 100 EUR.', query).length, 1);
  assert.equal(verifyFinancialFormulas('Precio de venta = Coste x (1 + markup) = 40 x 1,60 = 64 EUR.', query).length, 0);
});

test('financial channel catches an inverted per-unit division and an omitted tax', function () {
  var shares = 'Se emiten 2.000.000 de acciones nuevas para recaudar 10.000.000 EUR. ¿Cuál es el precio por acción?';
  assert.equal(verifyFinancialFormulas('Precio por acción = 2.000.000 / 10.000.000 = 0,20 EUR.', shares).length, 1);
  assert.equal(verifyFinancialFormulas('Precio por acción = 10.000.000 / 2.000.000 = 5 EUR.', shares).length, 0);
  var invoice = 'Una factura de 12.000 EUR + IVA del 21% debe pagarse en 3 plazos iguales. ¿Cuánto es cada plazo?';
  assert.equal(verifyFinancialFormulas('Cada plazo = 12.000 / 3 = 4.000 EUR.', invoice).length, 1);
  assert.equal(verifyFinancialFormulas('Total con IVA = 12.000 x 1,21 = 14.520 EUR. Cada plazo = 14.520 / 3 = 4.840 EUR.', invoice).length, 0);
});

test('grounding channel catches content attributed to the wrong party', function () {
  var query = 'Resume la cláusula: "El Proveedor será responsable de todos los daños directos derivados de su incumplimiento, con un límite máximo de 500.000 EUR. El Cliente será responsable de proporcionar acceso oportuno a los sistemas necesarios."';
  var flawed = 'El Proveedor, por su parte, es responsable de dar acceso a tiempo a los sistemas necesarios.';
  var correct = 'El Cliente, por su parte, es responsable de dar acceso a tiempo a los sistemas necesarios.';
  assert.equal(verifyQueryGrounding(flawed, query).length, 1);
  assert.equal(verifyQueryGrounding(correct, query).length, 0);
});

test('grounding channel catches an exception of the source presented as absolute', function () {
  var query = 'Según esta definición: "\'Información Confidencial\' significa toda información técnica, comercial o financiera divulgada por una parte a la otra, EXCEPTO la información que ya sea de dominio público en el momento de la divulgación." ¿Un dato ya público está protegido?';
  var flawed = 'Sí. La definición cubre toda información técnica, comercial o financiera divulgada, y un dato ya público también queda protegido por esta cláusula.';
  var correct = 'No. La definición excluye explícitamente la información que ya sea de dominio público en el momento de la divulgación.';
  assert.equal(verifyQueryGrounding(flawed, query).length, 1);
  assert.equal(verifyQueryGrounding(correct, query).length, 0);
});

test('grounding channel catches an enumeration value the source never lists', function () {
  var query = 'Según el manual aportado como fuente: "GET /v2/orders/{id} devuelve el pedido con el estado actual. El campo status puede ser: pending, shipped, delivered, cancelled." ¿Qué valores puede tener status?';
  var flawed = 'El campo status puede tomar los valores: pending, shipped, delivered, cancelled o refunded.';
  var correct = 'El campo status puede tomar los valores: pending, shipped, delivered o cancelled.';
  assert.equal(verifyQueryGrounding(flawed, query).length, 1);
  assert.equal(verifyQueryGrounding(correct, query).length, 0);
});

// Regresiones de precision encontradas en revision del PR #1. Los cuatro casos
// eran avisos sobre respuestas CORRECTAS, que es el fallo mas caro de este
// producto: un operador que recibe avisos falsos deja de leer los avisos.
test('unit channel reads Spanish thousands separators without inventing an error', function () {
  assert.deepEqual(verifyUnitAwareArithmetic('El total es 1.100.000 EUR / 2 = 550.000 EUR'), []);
  assert.deepEqual(verifyUnitAwareArithmetic('55 liters / 3.785 = 14.5 US gallons'), []);
  assert.equal(verifyUnitAwareArithmetic('55 liters / 3.785 = 20.8 US gallons').length, 1);
});

test('rounding rule requires an approximation marker, not just a connector', function () {
  assert.deepEqual(verifyRoundingClaim('Total cost = 100 dollars, so 20 boxes are needed.'), []);
  assert.equal(verifyRoundingClaim('(350-32)*5/9 = 176.7, so about 143 degrees C').length, 1);
});

test('config channel ignores extra network ranges when the requested one is used', function () {
  var query = 'Configura un security group que permita SSH solo desde la red interna de la oficina (10.0.5.0/24).';
  var correct = '```yaml\nvpc_cidr: 10.0.0.0/16\nrules:\n  - port: 22\n    source: 10.0.5.0/24\n```';
  var flawed = '```yaml\nrules:\n  - port: 22\n    source: 0.0.0.0/0\n```';
  assert.deepEqual(verifyConfigIntent(correct, query), []);
  assert.equal(verifyConfigIntent(flawed, query).length, 1);
});

test('config channel accepts the requested value in any key that measures it', function () {
  var query = 'Configura backups que retengan copias diarias durante 30 días.';
  var correct = '```yaml\nbackup:\n  schedule_days: 7\n  retention_days: 30\n```';
  var flawed = '```yaml\nbackup:\n  schedule_days: 7\n  retention_days: 3\n```';
  assert.deepEqual(verifyConfigIntent(correct, query), []);
  assert.equal(verifyConfigIntent(flawed, query).length, 1);
});

// Canal codeContract: el codigo COMPILA, pero no cumple lo que se pidio. Es el
// hueco que el corpus empresarial marcaba con 4/5 casos sin detectar.
test('code contract catches an off-by-one bound against the requested count', function () {
  var query = 'Escribe una función en Python que devuelva los primeros n elementos de una lista.';
  assert.equal(verifyCodeContract('```python\ndef first_n(items, n):\n    return items[:n+1]\n```', query).length, 1);
  assert.deepEqual(verifyCodeContract('```python\ndef first_n(items, n):\n    return items[:n]\n```', query), []);
});

test('code contract catches a file handle that is never closed', function () {
  var query = 'Escribe una función en Python que abra un archivo, lo procese línea por línea, y lo cierre.';
  assert.equal(verifyCodeContract('```python\ndef process_file(path):\n    f = open(path)\n    for line in f:\n        handle(line)\n```', query).length, 1);
  assert.deepEqual(verifyCodeContract('```python\ndef process_file(path):\n    with open(path) as f:\n        for line in f:\n            handle(line)\n```', query), []);
});

test('code contract catches truthiness used as an existence check', function () {
  var query = 'Escribe una función en JavaScript que compruebe si un valor existe en un objeto de configuración antes de usarlo, para evitar acceder a una propiedad indefinida.';
  assert.equal(verifyCodeContract('```javascript\nfunction getTimeout(config) {\n  if (config.timeoutMs) {\n    return config.timeoutMs;\n  }\n  return DEFAULT_TIMEOUT_MS;\n}\n```', query).length, 1);
  assert.deepEqual(verifyCodeContract('```javascript\nfunction getTimeout(config) {\n  if (config.timeoutMs !== undefined) {\n    return config.timeoutMs;\n  }\n  return DEFAULT_TIMEOUT_MS;\n}\n```', query), []);
});

test('code contract stays silent when the query does not ask for the property', function () {
  // Sin peticion explicita no hay contrato que comprobar: avisar aqui seria
  // opinar sobre estilo, y un aviso opinable destruye la confianza en el canal.
  assert.deepEqual(verifyCodeContract('```python\ndef first_n(items, n):\n    return items[:n+1]\n```', 'Escribe una función en Python.'), []);
});

test('financial catches a margin divided by cost when the query asks it over sales', function () {
  var query = 'Vendemos a 120 EUR con un coste de 90 EUR. ¿Cuál es el margen sobre ventas?';
  assert.equal(verifyFinancialFormulas('El margen es (120 - 90) / 90 = 33,3%.', query).length, 1);
  assert.deepEqual(verifyFinancialFormulas('El margen es (120 - 90) / 120 = 25%.', query), []);
  // La misma cuenta sobre el coste es CORRECTA si lo que se pide es markup:
  // el canal mira la base que pide la pregunta, no la formula en abstracto.
  assert.deepEqual(verifyFinancialFormulas('El markup es (120 - 90) / 90 = 33,3%.', 'Vendemos a 120 EUR con un coste de 90 EUR. ¿Cuál es el markup?'), []);
});

test('grounding catches inverted ownership between the two parties of a clause', function () {
  var query = 'Resume esta cláusula de propiedad intelectual: "Todo trabajo derivado creado por el Contratista específicamente para este proyecto será propiedad del Cliente. Las herramientas, bibliotecas y metodologías preexistentes del Contratista permanecen siendo propiedad del Contratista."';
  var flawed = 'Todo el trabajo, incluidas las herramientas y metodologías preexistentes del Contratista, pasa a ser propiedad del Cliente al finalizar el proyecto.';
  var correct = 'El trabajo creado específicamente para este proyecto pasa a ser propiedad del Cliente. Las herramientas y metodologías que el Contratista ya tenía antes del proyecto siguen siendo del Contratista.';
  assert.equal(verifyOwnershipAttribution(flawed, query).length, 1);
  assert.deepEqual(verifyOwnershipAttribution(correct, query), []);
});

test('grounding catches a reference beyond the extent stated in the query', function () {
  var query = 'Un informe técnico afirma: "Como se detalla en la Sección 7 de este mismo informe, la latencia p99 se mantuvo por debajo de 200ms." El informe completo solo tiene 5 secciones. ¿Es correcta esta referencia?';
  assert.equal(verifyReferenceRange('Sí, la referencia a la Sección 7 es válida.', query).length, 1);
  assert.deepEqual(verifyReferenceRange('No, la Sección 7 no existe: el informe solo tiene 5 secciones.', query), []);
});
