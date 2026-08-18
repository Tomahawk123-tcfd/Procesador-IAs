// ── CATALOGO DE REFERENCIAS: CONOCIMIENTO EXTERNO SIN INVENTARLO ──
//
// Hueco medido que ni el ALU ni GROUND podian cerrar: las respuestas que citan
// una referencia normativa o tecnica EQUIVOCADA ("el derecho de supresion es el
// Articulo 12 del RGPD", "SQL Injection es CWE-79"). No es aritmetica, no se
// contradice consigo misma, y la fuente correcta no viene en la pregunta: hace
// falta conocimiento externo. Inventarlo dentro del codigo seria convertir el
// procesador en una IA que opina, que es exactamente lo que no es.
//
// La salida es un catalogo DECLARADO: un fichero versionado que la empresa
// instala y del que es dueña, igual que una taxonomia de anotacion. El
// procesador no sabe derecho ni seguridad; sabe cruzar lo que la respuesta dice
// con lo que el catalogo declara, y decir de que version del catalogo viene el
// aviso -- eso es auditable y discutible, una opinion de modelo no.
//
// Formato:
//
//   {
//     "id": "rgpd-articulos", "version": "2026-08", "source": "Reglamento (UE) 2016/679",
//     "entries": [
//       { "concept": "derecho de supresión", "aliases": ["derecho al olvido", "right to erasure"],
//         "reference": "Artículo 17", "referencePattern": "art[íi]culo\\s*(\\d+)" }
//     ]
//   }
//
// Regla de silencio: solo se avisa si la respuesta menciona el concepto Y da una
// referencia del mismo tipo (mismo `referencePattern`) en la misma frase, y esa
// referencia no es la declarada. Si no cita referencia, o cita otra clase de
// referencia, no hay nada que cruzar y se calla.

function deaccent(s) {
  return String(s).toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
}

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?;:\n])\s+/).filter(function (s) { return s.trim().length > 0; });
}

export function validateCatalog(catalog) {
  var errors = [];
  if (!catalog || typeof catalog !== 'object') return ['catalogo_no_es_objeto'];
  if (!catalog.id) errors.push('falta_id');
  if (!catalog.version) errors.push('falta_version');
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) errors.push('entries_vacio');
  (catalog.entries || []).forEach(function (e, i) {
    if (!e || !e.concept) errors.push('entrada_' + i + '_sin_concept');
    else if (!e.reference) errors.push('entrada_' + i + '_sin_reference');
    else if (!e.referencePattern) errors.push('entrada_' + i + '_sin_referencePattern');
    else {
      try { new RegExp(e.referencePattern, 'i'); } catch (err) { errors.push('entrada_' + i + '_patron_invalido'); }
    }
  });
  return errors;
}

export function verifyReferenceCatalog(text, catalog) {
  var errors = validateCatalog(catalog);
  // Un catalogo mal formado no produce avisos silenciosamente: se devuelve el
  // error como hallazgo del propio catalogo para que el operador lo arregle en
  // vez de creer que no habia nada que señalar.
  if (errors.length > 0) return [{ tipo: 'catalogo_invalido', detalle: errors.join(', ') }];

  var findings = [];
  var sentences = sentencesOf(text);
  catalog.entries.forEach(function (entry) {
    var names = [entry.concept].concat(Array.isArray(entry.aliases) ? entry.aliases : []);
    var flatNames = names.map(deaccent);
    var refRe = new RegExp(entry.referencePattern, 'gi');
    var declared = deaccent(entry.reference);
    sentences.forEach(function (sentence) {
      var flat = deaccent(sentence);
      var mentionsConcept = flatNames.some(function (n) { return n && flat.indexOf(n) !== -1; });
      if (!mentionsConcept) return;
      refRe.lastIndex = 0;
      var m;
      var citedSameKind = [];
      while ((m = refRe.exec(sentence)) !== null) citedSameKind.push(m[0]);
      if (citedSameKind.length === 0) return;   // no cita referencia: nada que cruzar
      var citesDeclared = citedSameKind.some(function (c) {
        var flatC = deaccent(c).replace(/\s+/g, ' ').trim();
        return flatC === declared || flatC.indexOf(declared) !== -1 || declared.indexOf(flatC) !== -1;
      });
      if (citesDeclared) return;
      findings.push({
        tipo: 'referencia_contraria_al_catalogo',
        concepto: entry.concept,
        referenciaCitada: citedSameKind.join(', '),
        referenciaDelCatalogo: entry.reference,
        catalogo: catalog.id + '@' + catalog.version + (catalog.source ? ' (' + catalog.source + ')' : ''),
        frase: sentence.trim(),
      });
    });
  });
  return findings;
}
