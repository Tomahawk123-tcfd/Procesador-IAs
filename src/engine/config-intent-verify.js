// ── VERIFICACION DETERMINISTA DE CONFIGURACION CONTRA LO PEDIDO ──
//
// Hueco real y documentado por el corpus empresarial (los 5 casos `ops`,
// todos marcados expectedGap:true): "JSON valido/YAML no es un error de
// sintaxis -- ningun verificador de este proyecto entiende el significado
// operativo de un CIDR abierto". Los cinco borradores defectuosos son
// sintacticamente perfectos y operativamente desastrosos:
//
//   source: 0.0.0.0/0          pidiendo acceso SSH solo desde 10.0.5.0/24
//   rejectUnauthorized: false  pidiendo "verificando siempre el certificado"
//   backoffMs: 0, multiplier:1 pidiendo "backoff exponencial razonable"
//   retention_days: 3          pidiendo retencion de 30 dias
//   scope: "global"            pidiendo 100 peticiones/minuto POR USUARIO
//
// La clave de que esto sea verificable sin un modelo: el requisito esta
// escrito en la pregunta del usuario, en literales (un CIDR, un numero con su
// unidad, "por usuario", "verificando el certificado"). Comparar el literal
// pedido contra el literal entregado es aritmetica de cadenas, no criterio.
//
// Alcance honesto: NO se valida una configuracion "en general" ni se opina
// sobre buenas practicas. Cada regla exige que el requisito aparezca en la
// PREGUNTA (excepto la de verificacion TLS desactivada, que es peligrosa por
// si misma) y calla en cuanto el usuario pide explicitamente lo contrario.

import { amountParser } from './number-format.js';

function blocksOf(text) {
  var body = String(text || '');
  var blocks = [];
  var fenced = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;
  var m;
  while ((m = fenced.exec(body)) !== null) blocks.push(m[1]);
  // Solo se audita configuracion escrita como bloque de codigo. Aceptar la
  // prosa como si fuera configuracion produjo falsos positivos inmediatos
  // (una frase como "11:45 PM + 5:30 = 5:15 AM" se leia como la clave
  // "minutes"): en prosa, "palabra: valor" no significa nada configurable.
  return blocks;
}

// Valor de una clave en JSON/YAML/JS sin parsear el formato: `clave: valor`,
// `"clave": valor`, `clave = valor`. Devuelve el literal en crudo.
function valueOf(block, keyPattern) {
  var re = new RegExp('["\'`]?\\b(' + keyPattern + ')\\b["\'`]?\\s*[:=]\\s*(["\'][^"\']*["\']|[^,\\n}]+)', 'i');
  var m = re.exec(block);
  if (!m) return null;
  return { key: m[1], raw: String(m[2]).trim().replace(/[,;]$/, '').replace(/^["']|["']$/g, '') };
}

// Todas las claves cuyo nombre casa con el patron, no solo la primera. Un
// bloque con `schedule_days: 7` y `retention_days: 30` respeta una peticion
// de 30 dias, pero mirando unicamente la primera coincidencia se reportaba
// como incumplida.
function valuesOf(block, keyPattern) {
  var re = new RegExp('["\'`]?\\b(' + keyPattern + ')\\b["\'`]?\\s*[:=]\\s*(["\'][^"\']*["\']|[^,\\n}]+)', 'gi');
  var out = [];
  var m;
  while ((m = re.exec(block)) !== null) {
    out.push({ key: m[1], raw: String(m[2]).trim().replace(/[,;]$/, '').replace(/^["']|["']$/g, '') });
  }
  return out;
}

var CIDR = /\b(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/g;

function cidrToRange(cidr) {
  var parts = String(cidr).split('/');
  var octets = parts[0].split('.').map(function (o) { return parseInt(o, 10); });
  if (octets.length !== 4 || octets.some(function (o) { return !isFinite(o) || o > 255; })) return null;
  var prefix = parseInt(parts[1], 10);
  if (!isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  var value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  var size = prefix === 0 ? 4294967296 : Math.pow(2, 32 - prefix);
  var base = prefix === 0 ? 0 : Math.floor(value / size) * size;
  return { base: base, size: size, prefix: prefix };
}

// Solo es un hallazgo la red ESTRICTAMENTE mas ancha que la pedida y que la
// contiene: eso es exactamente el fallo que se persigue (0.0.0.0/0 en lugar
// del /24 de la oficina). Un `vpc_cidr` o una segunda regla con otro rango no
// contradicen nada, y reportarlos convertia configuraciones correctas en
// avisos.
function isWiderThan(given, asked) {
  var g = cidrToRange(given);
  var a = cidrToRange(asked);
  if (!g || !a) return false;
  if (g.prefix >= a.prefix) return false;
  return a.base >= g.base && a.base + a.size <= g.base + g.size;
}

var ASKS_RESTRICTED_NETWORK = /\b(solo|s[óo]lo|only|[úu]nicamente|internal|interna|oficina|office|vpn)\b/i;
var ASKS_PUBLIC_ACCESS = /\b(p[úu]blico|public|desde\s+internet|from\s+anywhere|abierto\s+a\s+todos)\b/i;
var ASKS_CERT_VERIFICATION = /\b(verific\w*|valid\w*|comprob\w*|certificad\w*|certificate|tls|ssl|https)\b/i;
var ASKS_SKIP_VERIFICATION = /\b(sin\s+verificar|self[-\s]?signed|autofirmad\w+|ignorar\s+el\s+certificado|skip\s+(?:cert|verification)|desactiva\w*\s+la\s+verificaci[óo]n)\b/i;
var ASKS_EXPONENTIAL_BACKOFF = /\b(backoff|exponencial|exponential|espera\s+creciente|jitter)\b/i;
var ASKS_PER_USER_SCOPE = /\b(por\s+usuario|per[-\s]?user|cada\s+usuario|por\s+cliente|per[-\s]?client|por\s+ip|per[-\s]?ip)\b/i;

// La notacion de miles/decimales se decide una vez por texto (number-format.js).
function numberParserFor(contextText) {
  var parse = amountParser(contextText);
  return function (raw) { return parse(String(raw).replace(/[^\d.,-]/g, '')); };
}

// Requisitos numericos con unidad escritos en la pregunta ("durante 30 dias",
// "100 peticiones por minuto"). Se emparejan con la clave de configuracion
// cuyo nombre contiene esa unidad (retention_days <- "dias",
// rateLimitPerMinute <- "minuto"). Sin coincidencia de unidad no se compara
// nada: un numero suelto en la pregunta no dice a que clave pertenece.
var UNIT_ALIASES = [
  { words: ['d[íi]as?', 'days?'], keyHints: ['day', 'dia', 'retention', 'retencion'] },
  { words: ['horas?', 'hours?'], keyHints: ['hour', 'hora', 'ttl'] },
  { words: ['minutos?', 'minutes?'], keyHints: ['minute', 'minuto'] },
  { words: ['reintentos?', 'retries', 'retry'], keyHints: ['retry', 'retries', 'reintento'] },
  { words: ['r[ée]plicas?', 'replicas?'], keyHints: ['replica'] },
];

export function verifyConfigIntent(text, query) {
  var q = String(query || '');
  if (!q) return [];
  var toNumber = numberParserFor(q + '\n' + String(text || ''));
  var findings = [];
  blocksOf(text).forEach(function (block) {
    // 1) CIDR entregado distinto del CIDR pedido (el caso 0.0.0.0/0).
    var askedCidrs = q.match(CIDR) || [];
    var givenCidrs = block.match(CIDR) || [];
    var requestedIsHonoured = askedCidrs.some(function (asked) { return givenCidrs.indexOf(asked) !== -1; });
    if (askedCidrs.length > 0 && givenCidrs.length > 0 && !requestedIsHonoured) {
      givenCidrs.forEach(function (given) {
        if (askedCidrs.indexOf(given) !== -1) return;
        if (!askedCidrs.some(function (asked) { return isWiderThan(given, asked); })) return;
        findings.push({
          tipo: 'red_no_solicitada',
          pedido: askedCidrs.join(', '),
          entregado: given,
          detalle: given === '0.0.0.0/0'
            ? 'abre el acceso a todo internet cuando la pregunta pedia una red concreta'
            : 'la red configurada no es la que se pidio',
        });
      });
    } else if (givenCidrs.indexOf('0.0.0.0/0') !== -1 && ASKS_RESTRICTED_NETWORK.test(q) && !ASKS_PUBLIC_ACCESS.test(q)) {
      findings.push({
        tipo: 'red_no_solicitada',
        pedido: 'acceso restringido',
        entregado: '0.0.0.0/0',
        detalle: 'abre el acceso a todo internet cuando la pregunta pedia restringirlo',
      });
    }

    // 2) Verificacion de certificado desactivada. Peligrosa por si misma: se
    //    reporta salvo que la pregunta pida explicitamente saltarsela.
    var insecure = [
      { key: 'rejectUnauthorized', unsafe: 'false' },
      { key: 'insecureSkipVerify', unsafe: 'true' },
      { key: 'strictSSL', unsafe: 'false' },
      { key: 'verify', unsafe: 'false' },
      { key: 'ssl_verify', unsafe: 'false' },
      { key: 'validate_certs', unsafe: 'false' },
    ];
    insecure.forEach(function (spec) {
      var found = valueOf(block, spec.key);
      if (!found) return;
      if (String(found.raw).toLowerCase() !== spec.unsafe) return;
      if (ASKS_SKIP_VERIFICATION.test(q)) return;
      if (!ASKS_CERT_VERIFICATION.test(q)) return;
      findings.push({
        tipo: 'verificacion_tls_desactivada',
        entregado: found.key + ': ' + found.raw,
        detalle: 'desactiva la validacion del certificado del servidor (expone la conexion a un ataque man-in-the-middle)',
      });
    });

    // 3) Backoff pedido pero inexistente: espera inicial 0 o multiplicador <= 1
    //    convierten N reintentos en N llamadas inmediatas.
    if (ASKS_EXPONENTIAL_BACKOFF.test(q)) {
      var delay = valueOf(block, 'backoff_?ms|backoffMs|initial_?backoff|retry_?delay_?ms|delayMs|wait_?ms');
      var multiplier = valueOf(block, 'backoff_?multiplier|backoffFactor|multiplier|factor');
      var delayValue = delay ? toNumber(delay.raw) : null;
      var multiplierValue = multiplier ? toNumber(multiplier.raw) : null;
      var problems = [];
      if (delayValue === 0) problems.push(delay.key + ': 0');
      if (multiplierValue !== null && multiplierValue <= 1) problems.push(multiplier.key + ': ' + multiplier.raw);
      if (problems.length > 0) {
        findings.push({
          tipo: 'backoff_inexistente',
          entregado: problems.join(', '),
          detalle: 'se pidio un backoff creciente pero los reintentos saldrian sin espera efectiva (riesgo de saturar mas el servicio que ya falla)',
        });
      }
    }

    // 4) Ambito global cuando se pidio por usuario.
    if (ASKS_PER_USER_SCOPE.test(q)) {
      var scope = valueOf(block, 'scope|ambito|granularity|per');
      if (scope && /^(global|all|todos|shared)$/i.test(String(scope.raw))) {
        findings.push({
          tipo: 'ambito_incorrecto',
          pedido: 'por usuario',
          entregado: scope.key + ': ' + scope.raw,
          detalle: 'el limite se aplicaria al conjunto de usuarios, no a cada usuario como se pidio',
        });
      }
    }

    // 5) Numero con unidad pedido en la pregunta y contradicho por la clave
    //    correspondiente de la configuracion.
    UNIT_ALIASES.forEach(function (alias) {
      var askRe = new RegExp('(\\d[\\d.,]*)\\s*(?:' + alias.words.join('|') + ')', 'i');
      var asked = askRe.exec(q);
      if (!asked) return;
      var askedValue = toNumber(asked[1]);
      if (askedValue === null) return;
      var keyPattern = '[A-Za-z_]*(?:' + alias.keyHints.join('|') + ')[A-Za-z_]*';
      var candidates = valuesOf(block, keyPattern).map(function (candidate) {
        return { key: candidate.key, raw: candidate.raw, value: toNumber(candidate.raw) };
      }).filter(function (candidate) { return candidate.value !== null; });
      if (candidates.length === 0) return;
      // Basta con que UNA de las claves del bloque entregue el valor pedido:
      // el resto son otros ajustes que miden la misma unidad, no un
      // incumplimiento.
      if (candidates.some(function (candidate) { return candidate.value === askedValue; })) return;
      var given = candidates[0];
      findings.push({
        tipo: 'valor_distinto_del_pedido',
        pedido: asked[0],
        entregado: given.key + ': ' + given.raw,
        detalle: 'la configuracion no respeta el valor que pedia la pregunta',
      });
    });
  });
  return findings;
}
