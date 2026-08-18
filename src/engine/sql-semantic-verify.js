// ── VERIFICACION DETERMINISTA DE SEMANTICA SQL ──
//
// Hueco real y documentado por el propio corpus empresarial
// (scripts/benchmark-corpus-enterprise.mjs, los 5 casos `sql` marcados
// expectedGap:true): "ningun verificador de este proyecto analiza SQL --
// code-verify.js solo cubre Python/JavaScript/bash/JSON. No hay ningun error
// de sintaxis que detectar (el SQL es valido), el fallo es semantico".
//
// Ese hueco es exactamente el que importa en empresa: el SQL que una IA
// escribe mal casi nunca falla al compilar, falla al ejecutarse en produccion
// contra datos reales:
//
//   UPDATE users SET status = 'inactive';        -- sin WHERE: toca TODA la tabla
//   WHERE email = NULL                            -- nunca es verdad: 0 filas, en silencio
//   WHERE COUNT(*) > 10                           -- agregado en WHERE, no en HAVING
//   INNER JOIN ... (pidiendo "incluyendo los que no tienen ninguno")
//   ORDER BY total ASC LIMIT 5                    -- pidiendo el "top 5"
//   order_date <= '2025-03-31'                    -- pierde el ultimo dia si es timestamp
//
// Ninguno de estos seis necesita un modelo para detectarse: son propiedades
// comprobables de la consulta, cruzadas con la INTENCION que el propio usuario
// escribio en su pregunta. Eso es lo que hace este modulo. No es un motor SQL
// ni un analizador completo: es un conjunto acotado de reglas de altisima
// precision, cada una con su condicion de silencio para no gritar sobre
// consultas correctas.

// Extrae las consultas del texto: bloques ```sql``` primero (lo normal en una
// respuesta de IA) y, si no hay, cualquier sentencia que arranque por un verbo
// SQL. No se intenta parsear prosa que hable de SQL sin escribirlo.
export function extractSqlStatements(text) {
  var body = String(text || '');
  var statements = [];
  var fenced = /```(?:sql|SQL)?\s*([\s\S]*?)```/g;
  var m;
  while ((m = fenced.exec(body)) !== null) {
    if (/\b(SELECT|UPDATE|DELETE|INSERT|MERGE)\b/i.test(m[1])) statements.push(m[1].trim());
  }
  if (statements.length === 0) {
    var bare = /\b(?:SELECT|UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b[\s\S]*?(?:;|$)/gi;
    while ((m = bare.exec(body)) !== null) {
      var candidate = m[0].trim();
      if (candidate.length > 12) statements.push(candidate);
    }
  }
  return statements;
}

function clauseAfter(sql, keyword) {
  var re = new RegExp('\\b' + keyword + '\\b([\\s\\S]*?)(?=\\b(?:WHERE|GROUP\\s+BY|HAVING|ORDER\\s+BY|LIMIT|RETURNING|WINDOW|UNION)\\b|;|$)', 'i');
  var m = re.exec(sql);
  return m ? m[1] : null;
}

var LAST_DAY_OF_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Intencion del usuario, leida de SU pregunta -- nunca inferida de la propia
// respuesta (si la respuesta pudiera justificarse a si misma, el verificador
// no verificaria nada).
// Falso negativo real, encontrado midiendo el caso sql-01 del corpus
// empresarial: este patron incluia "todas las cuentas", asi que la pregunta
// "desactiva todas las cuentas de usuarios inactivos desde hace mas de 2 años"
// silenciaba el aviso de UPDATE sin WHERE -- justo el caso que se queria
// detectar. "Todas las cuentas QUE CUMPLEN X" sigue siendo un subconjunto
// filtrado; solo callan las formulas que piden explicitamente la tabla entera.
var WANTS_ALL_ROWS = /\b(all\s+rows|every\s+row|toda\s+la\s+tabla|todas\s+las\s+filas|sin\s+filtro|sin\s+condici[óo]n|whole\s+table)\b/i;
var WANTS_HIGHEST = /\b(top|mayores?|m[áa]s\s+(?:altos?|vendidos?|caros?|activos?)|highest|largest|best|mejores?|maximos?)\b/i;
var WANTS_LOWEST = /\b(bottom|menores?|m[áa]s\s+bajos?|lowest|smallest|worst|peores?|minimos?)\b/i;
var WANTS_UNMATCHED = /\b(incluyendo|include|includes|including|aunque\s+no|sin\s+(?:ning[úu]n|ninguna|pedidos?|[óo]rdenes)|even\s+if|que\s+(?:a[úu]n\s+)?no\s+(?:han|hayan|tienen)|no\s+han\s+hecho|todos?\s+los\s+clientes)\b/i;
var WANTS_WHOLE_MONTH = /\b(?:todo\s+el\s+mes|entire\s+month|whole\s+month|durante\s+(?:todo\s+)?el\s+mes|del\s+mes\s+de)\b/i;

export function verifySqlSemantics(text, query) {
  var statements = extractSqlStatements(text);
  if (statements.length === 0) return [];
  var q = String(query || '');
  var findings = [];
  function add(finding) { findings.push(finding); }

  statements.forEach(function (sql) {
    var flat = sql.replace(/\s+/g, ' ');

    // 1) UPDATE/DELETE sin WHERE: escribe sobre toda la tabla. Solo se calla
    //    si el usuario pidio explicitamente afectar a todas las filas.
    var writeMatch = /\b(UPDATE|DELETE)\b/i.exec(flat);
    if (writeMatch && !/\bWHERE\b/i.test(flat) && !WANTS_ALL_ROWS.test(q)) {
      add({
        tipo: 'escritura_sin_where',
        sentencia: writeMatch[1].toUpperCase(),
        detalle: 'la sentencia no lleva WHERE: afecta a TODAS las filas de la tabla',
      });
    }

    // 2) Comparacion con NULL usando "=" / "!=" / "<>": en SQL estandar nunca
    //    es verdadera, la consulta devuelve 0 filas en silencio.
    var nullCmp = /(?:=|!=|<>)\s*NULL\b/i.exec(flat);
    if (nullCmp) {
      add({
        tipo: 'comparacion_con_null',
        fragmento: nullCmp[0].trim(),
        detalle: 'NULL no es comparable con "=" ni "<>": hay que usar IS NULL / IS NOT NULL',
      });
    }

    // 3) Agregado dentro de WHERE: corresponde a HAVING.
    var whereClause = clauseAfter(flat, 'WHERE');
    if (whereClause && /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(whereClause)) {
      add({
        tipo: 'agregado_en_where',
        fragmento: whereClause.trim().slice(0, 120),
        detalle: 'un agregado no puede filtrarse en WHERE: se filtra en HAVING',
      });
    }

    // 4) INNER JOIN cuando la pregunta pide incluir las filas SIN pareja.
    if (WANTS_UNMATCHED.test(q) && /\bJOIN\b/i.test(flat) && !/\b(LEFT|RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\b/i.test(flat)) {
      add({
        tipo: 'join_interno_descarta_filas',
        detalle: 'se pidio incluir las filas sin correspondencia, pero el JOIN es interno: descarta justo esas filas',
      });
    }

    // 5) Direccion de ORDER BY contraria a lo que se pidio, con LIMIT (un
    //    "top N" ordenado ASC devuelve los N peores). Sin LIMIT el orden no
    //    cambia el conjunto devuelto, asi que no se reporta.
    var orderBy = /\bORDER\s+BY\b([\s\S]*?)(?=\bLIMIT\b|;|$)/i.exec(flat);
    if (orderBy && /\bLIMIT\b/i.test(flat)) {
      var descending = /\bDESC\b/i.test(orderBy[1]);
      if (WANTS_HIGHEST.test(q) && !WANTS_LOWEST.test(q) && !descending) {
        add({ tipo: 'orden_invertido', detalle: 'se pidieron los valores mas altos pero el ORDER BY es ascendente (con LIMIT devuelve los mas bajos)' });
      }
      if (WANTS_LOWEST.test(q) && !WANTS_HIGHEST.test(q) && descending) {
        add({ tipo: 'orden_invertido', detalle: 'se pidieron los valores mas bajos pero el ORDER BY es descendente (con LIMIT devuelve los mas altos)' });
      }
    }

    // 6) Limite superior inclusivo sobre el ultimo dia del mes: con una
    //    columna de timestamp, "<= '2025-03-31'" pierde todo lo ocurrido ese
    //    dia despues de medianoche. Solo se reporta si la pregunta habla de un
    //    mes completo (si se pidio "hasta el 31" el limite es intencionado).
    var inclusive = /<=\s*'(\d{4})-(\d{2})-(\d{2})(?:\s+00:00:00)?'/.exec(flat);
    if (inclusive && WANTS_WHOLE_MONTH.test(q)) {
      var month = parseInt(inclusive[2], 10);
      var day = parseInt(inclusive[3], 10);
      if (month >= 1 && month <= 12 && day === LAST_DAY_OF_MONTH[month - 1]) {
        add({
          tipo: 'rango_de_fechas_inclusivo',
          fragmento: inclusive[0],
          detalle: 'sobre una columna de timestamp este limite excluye las horas del ultimo dia: usar "< " del dia 1 del mes siguiente',
        });
      }
    }
  });

  return findings;
}
