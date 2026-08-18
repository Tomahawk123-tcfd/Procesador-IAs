// ── VERIFICACION DE SALIDA AFIRMADA, DETERMINISTA ──
// Fallo real, encontrado en vivo (2026-08-08): a "escribe una funcion que
// invierta una cadena" el ensemble devolvio codigo CORRECTO
// (`return cadena[::-1]`) pero con un comentario que MENTIA sobre su
// resultado:
//
//     texto = "Hola, mundo"
//     print(invertir_cadena(texto))  # Output: "dlmoh,olleh"
//
// El inverso real de "Hola, mundo" es "odnum ,aloH", no "dlmoh,olleh".
// code-verify.js no lo detecta (y hace bien: la SINTAXIS es valida) y
// math-verify.js tampoco (no hay aritmetica). Es un error semantico: la
// afirmacion sobre el comportamiento es falsa. Ningun LLM garantiza no
// cometerlo -- ejecutar el codigo de verdad si lo detecta con certeza.
//
// DECISION DE SEGURIDAD, deliberada y restrictiva: ejecutar codigo
// generado por un modelo es una superficie de riesgo real. Solo se ejecuta
// codigo que pasa un filtro estatico ESTRICTO (lista negra de todo lo que
// toque disco, red, procesos, o el propio interprete) y ademas en un
// directorio temporal, sin red heredada, con timeout duro. Si el filtro no
// esta seguro, NO se ejecuta y NO se emite veredicto -- el silencio es
// preferible a ejecutar algo dudoso o a inventar una conclusion.

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Cualquier aparicion de uno de estos tokens descarta la ejecucion. Es
// deliberadamente agresivo: preferimos no verificar un snippet legitimo
// (falso negativo, inocuo) antes que ejecutar uno peligroso.
// TODOS en minusculas a proposito: la comparacion es case-insensitive y se
// hace sobre el codigo ya pasado a minusculas. Bug real encontrado por el
// propio test unitario de este modulo (2026-08-08): la lista tenia
// 'while True' con T mayuscula, y al compararla contra el codigo ya en
// minusculas nunca coincidia -- 'while True: pass' pasaba el filtro como
// "seguro". El timeout de 5s del spawn lo habria matado igual, asi que el
// impacto real estaba acotado, pero un filtro de seguridad que falla en
// silencio es exactamente lo que no se puede dejar pasar.
var UNSAFE_TOKENS = [
  'import', '__import__', 'open(', 'exec(', 'eval(', 'compile(',
  'os.', 'sys.', 'subprocess', 'socket', 'requests', 'urllib', 'shutil',
  'pathlib', 'globals(', 'locals(', 'getattr(', 'setattr(', 'delattr(',
  'input(', 'breakpoint(', '__builtins__', 'while true', 'while 1',
  'file(', 'execfile(', 'popen', 'system(', 'remove(', 'rmdir(', 'unlink(',
  'write(', 'chmod', 'fork', 'kill(', 'exit(', 'quit(',
];

function isSafeToRun(code) {
  var lower = code.toLowerCase();
  for (var i = 0; i < UNSAFE_TOKENS.length; i++) {
    if (lower.indexOf(UNSAFE_TOKENS[i]) !== -1) return false;
  }
  // Un snippet razonable para verificar es corto. Un bloque enorme es mas
  // probable que sea un programa con efectos que un ejemplo autocontenido.
  if (code.length > 4000) return false;
  if (code.split('\n').length > 120) return false;
  return true;
}

// Extrae afirmaciones de salida de los comentarios idiomaticos que usan
// los modelos: "# Output: ...", "# => ...", "# resultado: ...",
// "# imprime: ...". Se queda con el texto afirmado, quitando comillas.
// Bug real, encontrado en vivo (2026-08-10): los dos puntos eran
// opcionales (":?"), asi que un comentario puramente DESCRIPTIVO como
// "# Imprime la suma de todos los números en la lista" (explica QUE hace
// el codigo, no afirma un valor concreto) se capturaba entero como si
// "la suma de todos los números en la lista" fuera el resultado
// literal afirmado -- falso positivo real en codigo correcto, marcado
// como si mintiera. Los dos puntos ahora son obligatorios: solo
// "# Output: X" / "# imprime: X" cuentan como afirmacion de un valor,
// "# imprime X" (sin separador) es descripcion, no se evalua.
var CLAIM_PATTERNS = [
  /#\s*(?:output|salida|resultado|imprime|prints?|returns?|devuelve)\s*:\s*(.+)/gi,
  /#\s*=>\s*(.+)/g,
];

function normalizeClaim(raw) {
  var s = raw.trim();
  // Quita comillas envolventes (simples, dobles, o tipograficas).
  s = s.replace(/^["'“‘]|["'”’]$/g, '');
  return s.trim();
}

function extractOutputClaims(code) {
  var claims = [];
  for (var p = 0; p < CLAIM_PATTERNS.length; p++) {
    var pattern = CLAIM_PATTERNS[p];
    pattern.lastIndex = 0;
    var m;
    while ((m = pattern.exec(code)) !== null) {
      var claimed = normalizeClaim(m[1]);
      // Descarta afirmaciones vacias o puramente descriptivas (sin nada
      // concreto que comparar).
      if (claimed.length === 0 || claimed.length > 200) continue;
      claims.push(claimed);
    }
  }
  return claims;
}

function runPythonCaptured(code) {
  return new Promise(function (resolve) {
    var dir;
    try {
      dir = mkdtempSync(join(tmpdir(), 'linkcore-run-'));
    } catch (e) {
      resolve({ ok: false, stdout: '' });
      return;
    }
    var file = join(dir, 'snippet.py');
    try {
      writeFileSync(file, code, 'utf8');
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
      resolve({ ok: false, stdout: '' });
      return;
    }
    // -I = modo aislado (ignora variables de entorno PYTHON* y el
    // directorio del script en sys.path). cwd = el temporal, para que
    // cualquier ruta relativa quede confinada ahi.
    var proc = spawn('python', ['-I', file], { cwd: dir, timeout: 5000 });
    var out = '';
    var finished = false;
    function done(ok) {
      if (finished) return;
      finished = true;
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      resolve({ ok: ok, stdout: out });
    }
    proc.stdout.on('data', function (d) {
      out += d;
      if (out.length > 20000) { try { proc.kill(); } catch (e) {} } // corta salida desbocada
    });
    proc.on('close', function (code2) { done(code2 === 0); });
    proc.on('error', function () { done(false); });
  });
}

var FENCE_PATTERN = /```(\w+)?\n([\s\S]*?)```/g;

// Devuelve las afirmaciones de salida que NO coinciden con lo que el
// codigo produce de verdad al ejecutarlo. Nunca corrige el texto: reporta,
// para que el llamador avise al usuario.
async function verifyOutputClaims(text) {
  if (!text) return [];
  var findings = [];
  FENCE_PATTERN.lastIndex = 0;
  var m;
  while ((m = FENCE_PATTERN.exec(text)) !== null) {
    var lang = (m[1] || '').toLowerCase();
    if (lang !== 'python' && lang !== 'py') continue; // solo Python por ahora
    var code = m[2];
    var claims = extractOutputClaims(code);
    if (claims.length === 0) continue;
    if (!isSafeToRun(code)) continue; // filtro de seguridad: no se ejecuta, no se opina
    var run = await runPythonCaptured(code);
    if (!run.ok) continue; // no ejecuto limpio: no se puede concluir nada honestamente
    var actual = run.stdout;
    if (actual.trim().length === 0) continue; // no imprimio nada que comparar
    for (var i = 0; i < claims.length; i++) {
      var claimed = claims[i];
      // Comparacion tolerante: la afirmacion debe aparecer en la salida
      // real (ignorando comillas y espacios de mas). Asi no se penaliza
      // que el comentario diga `"abc"` y la salida real sea `abc`.
      var actualNorm = actual.replace(/["'\s]/g, '');
      var claimedNorm = claimed.replace(/["'\s]/g, '');
      if (claimedNorm.length === 0) continue;
      if (actualNorm.indexOf(claimedNorm) === -1) {
        findings.push({
          afirmado: claimed,
          real: actual.trim().slice(0, 200),
          codigoPreview: code.trim().slice(0, 200),
        });
      }
    }
  }
  return findings;
}

export { verifyOutputClaims, extractOutputClaims, isSafeToRun };
