// ── VERIFICACION DE SINTAXIS DE CODIGO, DETERMINISTA ──
// Mismo patron que math-verify.js (2026-08-08): ningun LLM garantiza que
// el codigo que genera compile de verdad. Un parser real si lo garantiza.
// Deliberadamente solo SINTAXIS, nunca EJECUCION -- ejecutar codigo
// generado por un modelo es una superficie de riesgo real (efectos
// secundarios, bucles infinitos, acceso a disco/red) que este chequeo no
// necesita para su proposito (avisar de "esto no compila", no "esto hace
// lo que dice que hace"). Python: ast.parse() (analiza la gramatica, NUNCA
// ejecuta, a diferencia de exec()/eval()). JavaScript: vm.Script() de
// Node (compila y valida sintaxis; no se llama a runInThisContext(), asi
// que tampoco se ejecuta). El codigo se escribe a un archivo temporal y
// se pasa por argv al proceso hijo -- nunca interpolado en un string de
// shell, para no abrir una via de inyeccion con codigo que el propio
// usuario no escribio.

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { pythonSyntaxCheck, pythonApiCheck } from './python-worker.js';

var FENCE_PATTERN = /```(\w+)?\n([\s\S]*?)```/g;

function extractCodeBlocks(text) {
  if (!text) return [];
  var blocks = [];
  var match;
  FENCE_PATTERN.lastIndex = 0;
  while ((match = FENCE_PATTERN.exec(text)) !== null) {
    var lang = (match[1] || '').toLowerCase();
    var code = match[2];
    if (code.trim().length === 0) continue;
    blocks.push({ lang: lang, code: code });
  }
  return blocks;
}

// ── EXISTENCIA REAL DE API, DETERMINISTA (2026-08-17, hallazgo #5) ──
// Sintaxis correcta no significa que la funcion/metodo llamado EXISTA de
// verdad -- un modelo puede alucinar `os.path.doesnt_exist_at_all()` con
// sintaxis perfecta. Esto se detecta por introspeccion real (ast.parse +
// hasattr sobre el modulo YA IMPORTADO), no por otro modelo "opinando".
// Deliberadamente acotado a la LIBRERIA ESTANDAR de Python (sys.
// stdlib_module_names): importar un modulo de verdad para inspeccionarlo
// SI ejecuta el codigo a nivel de modulo de esa libreria (a diferencia de
// ast.parse(), que nunca ejecuta nada) -- para la libreria estandar eso es
// un efecto conocido y seguro (la propia instalacion de Python ya la trae
// y la ejecuta en cada arranque del interprete); para un paquete de
// terceros arbitrario NO lo es, asi que esos se omiten sin veredicto en
// vez de importarlos a ciegas. Solo cubre el patron `modulo.atributo`
// donde `modulo` viene de un `import modulo` simple -- `from X import Y`
// y aliases anidados quedan fuera de este primer alcance, no se inventa
// una cobertura que no existe. JavaScript queda fuera a proposito: Node
// no expone un AST recorrible desde vm.Script() sin un parser externo, y
// añadir uno violaria la regla de cero dependencias npm de este proyecto.
// Reemplazado por el worker Python persistente (2026-08-18). Medicion real
// en esta maquina ANTES del cambio: una verificacion con bloque Python
// costaba 740.54ms (1/seg) frente a 0.03ms del camino solo-texto, porque
// esta funcion y checkPythonSyntax() arrancaban CADA UNA un interprete de
// Python completo por llamada. Con el worker persistente: 0.30ms (3.298/seg)
// para esta comprobacion y 0.21ms (4.743/seg) para la de sintaxis, con
// resultados identicos en los cuatro casos de control (sintaxis valida,
// sintaxis invalida, API alucinada os.path.is_valid, API real
// os.path.exists). La logica de analisis es la MISMA (ast.parse +
// importlib sobre stdlib, el codigo nunca se ejecuta), solo cambia donde
// vive. Ver src/engine/python-worker.js.
//
// Semantica de degradacion preservada exactamente: si Python no esta
// disponible, el worker muere o hay timeout, se devuelve [] / {ok:null} --
// "no se pudo verificar", NUNCA "verificado y limpio".
function checkPythonApiExistence(code) {
  return pythonApiCheck(code);
}

// Misma sustitucion que checkPythonApiExistence(): antes arrancaba un
// interprete de Python por llamada solo para un ast.parse(). Ahora va por
// el worker persistente, con la misma semantica exacta de {ok, error} y la
// misma degradacion a {ok:null} cuando Python no esta disponible.
function checkPythonSyntax(code) {
  return pythonSyntaxCheck(code);
}

function checkJsSyntax(code) {
  // vm.Script() compila y valida sintaxis; NUNCA se llama a
  // runInThisContext()/runInContext(), asi que el codigo no se ejecuta.
  try {
    new vm.Script(code);
    return { ok: true, error: null };
  } catch (e) {
    if (e instanceof SyntaxError) return { ok: false, error: e.message };
    return { ok: null, error: null }; // otro tipo de error (no de sintaxis) -- no es lo que este chequeo busca
  }
}

// Bash: `bash -n` LEE el script y comprueba la sintaxis SIN ejecutar
// ningun comando (documentado en bash(1): "read commands but do not
// execute them") -- mismo principio que ast.parse()/vm.Script(), nunca
// se corre el codigo que un modelo pudo haber generado. Verificado que
// bash esta instalado en esta maquina antes de añadir esto (2026-08-12) --
// go/javac/php/ruby NO lo estan, por eso solo se cubre bash de los
// lenguajes adicionales probados esa noche.
function checkBashSyntax(code) {
  return new Promise(function (resolve) {
    var tmpFile = join(tmpdir(), 'linkcore-syntax-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.sh');
    try {
      writeFileSync(tmpFile, code, 'utf8');
    } catch (e) {
      resolve({ ok: null, error: null });
      return;
    }
    var proc = spawn('bash', ['-n', tmpFile], { timeout: 5000 });
    var err = '';
    proc.stderr.on('data', function (d) { err += d; });
    proc.on('close', function (code_) {
      try { unlinkSync(tmpFile); } catch (e) {}
      if (code_ === 0) resolve({ ok: true, error: null });
      else if (err.trim()) resolve({ ok: false, error: err.trim().replace(tmpFile, '<script>') });
      else resolve({ ok: null, error: null });
    });
    proc.on('error', function () {
      try { unlinkSync(tmpFile); } catch (e) {}
      resolve({ ok: null, error: null }); // bash no disponible: no bloquea, no se verifica
    });
  });
}

// JSON: JSON.parse() ya es un parser real y estricto -- sin subproceso,
// sin coste, mas rapido que cualquier otro chequeo de este archivo.
function checkJsonSyntax(code) {
  try {
    JSON.parse(code);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

var LANG_ALIASES = {
  python: 'python', py: 'python',
  javascript: 'javascript', js: 'javascript', node: 'javascript',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  json: 'json',
};

var CHECKERS = {
  python: checkPythonSyntax,
  javascript: checkJsSyntax, // sincrono, pero se envuelve para tratarlo igual que los async
  bash: checkBashSyntax,
  json: checkJsonSyntax, // sincrono
};

async function verifyCodeBlocks(text) {
  var blocks = extractCodeBlocks(text);
  var findings = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var normalizedLang = LANG_ALIASES[b.lang];
    if (!normalizedLang) continue; // lenguaje no soportado todavia -- no se inventa un veredicto
    var result = await CHECKERS[normalizedLang](b.code);
    if (result.ok === false) {
      findings.push({ lang: normalizedLang, error: result.error, codePreview: b.code.trim().slice(0, 200) });
      continue;
    }
    // La existencia de API solo tiene sentido si la sintaxis ya es valida
    // (result.ok === true) -- sobre codigo roto no hay AST fiable que
    // recorrer, y ya se reporto el problema real de sintaxis arriba.
    if (normalizedLang === 'python' && result.ok === true) {
      var missingApis = await checkPythonApiExistence(b.code);
      if (missingApis.length) {
        findings.push({
          lang: normalizedLang,
          error: 'Llamada a API que no existe en la libreria estandar instalada: ' + missingApis.join(', '),
          codePreview: b.code.trim().slice(0, 200),
        });
      }
    }
  }
  return findings;
}

export { verifyCodeBlocks, extractCodeBlocks };
