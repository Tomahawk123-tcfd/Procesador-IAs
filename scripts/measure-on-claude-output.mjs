// ═══════════════════════════════════════════════════════════════
// ¿MEJORA EL PROCESADOR LAS RESPUESTAS DE CLAUDE? (2026-08-12)
//
// Pregunta directa del usuario: ¿son peores las respuestas de Claude
// SIN el procesador que CON el procesador?
//
// Todas las mediciones anteriores de esta sesion fueron sobre salidas de
// modelos LOCALES (0.5B-3B) o sobre casos sinteticos escritos a mano.
// Ninguna midio lo unico que el usuario pregunta: que encuentra el
// procesador en las respuestas REALES de Claude.
//
// Este script lee la transcripcion real de la sesion (los mensajes que
// Claude escribio de verdad, no casos preparados) y pasa cada uno por
// applyDeterministicVerification() -- exactamente lo que hace el hook
// Stop ya activo. El resultado es la respuesta honesta a esa pregunta,
// medida, no supuesta.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import readline from 'node:readline';
import { applyDeterministicVerification } from '../src/backend.js';

var TRANSCRIPT = process.argv[2];
if (!TRANSCRIPT) {
  console.error('uso: node measure-on-claude-output.mjs <ruta-transcripcion.jsonl>');
  process.exit(1);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
      .map(function (b) { return b.text; })
      .join('\n');
  }
  return '';
}

async function main() {
  var stream = fs.createReadStream(TRANSCRIPT, { encoding: 'utf-8' });
  var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  var pairs = [];
  var pendingUser = '';

  for await (var line of rl) {
    var t = line.trim();
    if (!t) continue;
    var e;
    try { e = JSON.parse(t); } catch (err) { continue; }
    var role = e.message && e.message.role;
    var content = e.message && e.message.content;
    if (!role || content === undefined) continue;
    var text = extractText(content);
    if (!text || !text.trim()) continue;
    if (role === 'user') {
      pendingUser = text;
    } else if (role === 'assistant') {
      pairs.push({ query: pendingUser, draft: text });
    }
  }

  console.log('Respuestas reales de Claude analizadas: ' + pairs.length);
  console.log('');

  var conHallazgo = 0;
  var porTipo = {};
  var latencias = [];
  var ejemplos = [];

  for (var i = 0; i < pairs.length; i++) {
    var p = pairs[i];
    var t0 = Date.now();
    var r;
    try {
      r = await applyDeterministicVerification(p.draft, p.query);
    } catch (e2) {
      continue;
    }
    latencias.push(Date.now() - t0);

    if (r && r.hasFindings) {
      conHallazgo++;
      var avisos = (r.text || '').split('\n').filter(function (l) { return l.indexOf('⚠️') !== -1; });
      avisos.forEach(function (a) {
        var tipo = a.replace('⚠️', '').split(/[:(]/)[0].trim();
        porTipo[tipo] = (porTipo[tipo] || 0) + 1;
      });
      if (ejemplos.length < 5) {
        ejemplos.push({ indice: i, aviso: avisos[0] || '', fragmento: p.draft.slice(0, 150) });
      }
    }
  }

  var media = latencias.length ? Math.round(latencias.reduce(function (a, b) { return a + b; }, 0) / latencias.length) : 0;

  console.log('=== RESULTADO MEDIDO SOBRE RESPUESTAS REALES DE CLAUDE ===');
  console.log('Respuestas con al menos un hallazgo: ' + conHallazgo + '/' + pairs.length +
    ' (' + (pairs.length ? (conHallazgo / pairs.length * 100).toFixed(1) : 0) + '%)');
  console.log('Latencia media de la verificacion: ' + media + 'ms');
  console.log('');

  var tipos = Object.keys(porTipo);
  if (tipos.length) {
    console.log('Hallazgos por tipo:');
    tipos.sort(function (a, b) { return porTipo[b] - porTipo[a]; }).forEach(function (k) {
      console.log('  ' + porTipo[k] + 'x  ' + k);
    });
    console.log('');
    console.log('Ejemplos (para revisar a mano si son reales o ruido):');
    ejemplos.forEach(function (ej) {
      console.log('  [#' + ej.indice + '] ' + ej.aviso.trim());
      console.log('        "' + ej.fragmento.replace(/\n/g, ' ') + '..."');
    });
  } else {
    console.log('Ningun hallazgo en ninguna respuesta de Claude.');
  }
}

main().catch(function (e) { console.error('ERROR:', e.message); process.exit(1); });
