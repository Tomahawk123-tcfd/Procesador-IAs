import { verifyCalculations, verifyOperationMatchesQuery } from './math-verify.js';
import { verifyCodeBlocks } from './code-verify.js';
import { verifyOutputClaims } from './output-verify.js';
import { verifyComparisons, verifyDuplicateClaims } from './coherence-verify.js';
import { verifyTemporalClaims } from './temporal-verify.js';
import { verifyStructuralCoherence } from './structural-verify.js';

// Canales de verificacion que este pipeline sabe ejecutar. Se exporta para
// que el motor de calidad agregada (quality-engine.js) pueda listar TODOS
// los verificadores existentes, incluidos los que no han disparado nunca:
// un verificador con 0 disparos en trafico real es peso muerto y el
// operador merece verlo en la tabla, no que desaparezca por no tener datos
// (2026-08-18).
export var VERIFICATION_CHANNELS = ['operation', 'math', 'code', 'output', 'coherence', 'duplicate', 'temporal', 'structural'];

// Aplica los verificadores deterministas del procesador sobre un texto y
// antepone avisos cuando encuentra un problema real. Se extrae a modulo
// propio para que el nucleo de intermediacion y otros consumers (pipe,
// backends alternos) compartan EXACTAMENTE la misma logica sin crear ciclos.
//
// Devuelve, ademas del texto y el booleano agregado, QUE canal disparo y
// con cuantos hallazgos (2026-08-18). Antes solo salia `hasFindings`, un
// unico booleano: con eso era imposible saber que verificador estaba
// ganandose su coste en produccion y cual no habia disparado nunca. Los
// campos son ADITIVOS -- ningun consumer existente (backend.js,
// pipe-server.js, vnpu-core.js, benchmarks) lee mas que .text/.hasFindings.
export async function applyDeterministicVerification(text, query) {
  var out = text;
  var hasFindings = false;
  var channels = [];
  var findingCounts = {};
  var channelErrors = [];
  function note(channel, count) {
    channels.push(channel);
    findingCounts[channel] = count;
  }
  try {
    var opFindings = verifyOperationMatchesQuery(query, text);
    if (opFindings.length > 0) {
      hasFindings = true;
      note('operation', opFindings.length);
      var opWarningLines = ['⚠️ Aviso: la operación resuelta no es la que se pidió:'];
      opFindings.forEach(function (f) {
        opWarningLines.push('  se pidió una ' + f.pedida + ' pero la respuesta resuelve una ' + f.usadas.join('/') + '.');
      });
      out = opWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('operation'); }
  try {
    var mathFindings = verifyCalculations(text);
    if (mathFindings.length > 0) {
      hasFindings = true;
      note('math', mathFindings.length);
      var warningLines = ['⚠️ Aviso de verificación matemática (calculado, no otra opinión de IA):'];
      mathFindings.forEach(function (f) {
        warningLines.push('  "' + f.pasoAnterior + '" = ' + f.valorAnterior + ', pero el siguiente paso dice "' + f.pasoSiguiente + '" = ' + f.valorSiguiente + ' (' + f.diffPct + '% de diferencia) — revisa este cálculo.');
      });
      out = warningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('math'); }
  try {
    var codeFindings = await verifyCodeBlocks(text);
    if (codeFindings.length > 0) {
      hasFindings = true;
      note('code', codeFindings.length);
      var codeWarningLines = ['⚠️ Aviso de sintaxis (verificado con un compilador real, no otra opinión de IA):'];
      codeFindings.forEach(function (f) {
        codeWarningLines.push('  [' + f.lang + '] ' + f.error);
      });
      out = codeWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('code'); }
  try {
    var outputFindings = await verifyOutputClaims(text);
    if (outputFindings.length > 0) {
      hasFindings = true;
      note('output', outputFindings.length);
      var outWarningLines = ['⚠️ Aviso de salida (el código se ejecutó de verdad y no produce lo que el texto afirma):'];
      outputFindings.forEach(function (f) {
        outWarningLines.push('  afirma "' + f.afirmado + '" pero al ejecutarlo produce "' + f.real + '"');
      });
      out = outWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('output'); }
  // Bug real, potencial (2026-08-16): verifyComparisons/verifyDuplicateClaims
  // se llamaban con `out` (el texto acumulado, con los avisos de las
  // verificaciones anteriores YA pegados delante) en vez de `text` (el texto
  // original generado por la IA). coherence-verify.js documenta su propio
  // alcance como "escanea el TEXTO YA GENERADO" -- eso significa la salida
  // del modelo, no los avisos que este mismo pipeline le antepuso. Escanear
  // `out` arriesga que un verificador detecte una falsa contradiccion/
  // duplicado dentro de SU PROPIO texto de aviso o el de otro verificador
  // anterior, en vez de en el contenido real. Se corrige pasando siempre
  // `text` (el original, sin tocar) a ambos.
  try {
    var coherenceFindings = verifyComparisons(text);
    if (coherenceFindings.length > 0) {
      hasFindings = true;
      note('coherence', coherenceFindings.length);
      var coherenceWarningLines = ['⚠️ Aviso de coherencia (el texto se contradice sobre la misma comparación):'];
      coherenceFindings.forEach(function (f) {
        coherenceWarningLines.push('  "' + f.afirmacionA + '" pero en otro punto dice "' + f.afirmacionB + '"');
      });
      out = coherenceWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('coherence'); }
  try {
    var dupFindings = verifyDuplicateClaims(text);
    if (dupFindings.length > 0) {
      hasFindings = true;
      note('duplicate', dupFindings.length);
      var dupWarningLines = ['⚠️ Aviso de coherencia (la misma afirmación se presenta como propia de dos cosas distintas):'];
      dupFindings.forEach(function (f) {
        dupWarningLines.push('  "' + f.afirmacionA + '" y "' + f.afirmacionB + '"');
      });
      out = dupWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('duplicate'); }
  // Cuarto verificador determinista (2026-08-17): aritmetica de años y
  // consistencia del "año actual" dentro del mismo texto. Mismo patron que
  // los de arriba -- se llama con `text` (el original), nunca con `out`.
  try {
    var temporalFindings = verifyTemporalClaims(text);
    if (temporalFindings.length > 0) {
      hasFindings = true;
      note('temporal', temporalFindings.length);
      var temporalWarningLines = ['⚠️ Aviso temporal (calculado, no otra opinión de IA):'];
      temporalFindings.forEach(function (f) {
        if (f.tipo === 'aritmetica_de_años') {
          temporalWarningLines.push('  "' + f.texto + '" -- ' + f.cantidad + ' años ' + f.direccion + ' de ' + f.base + ' es ' + f.añoCorrecto + ', no ' + f.añoAfirmado + '.');
        } else if (f.tipo === 'año_actual_inconsistente') {
          var partes = f.afirmaciones.map(function (a) { return a.año + ' ("' + a.ejemplos[0] + '")'; });
          temporalWarningLines.push('  el texto afirma más de un "año actual" distinto: ' + partes.join(' vs. ') + '.');
        }
      });
      out = temporalWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('temporal'); }
  // Quinto verificador determinista (2026-08-17): coherencia estructural
  // (cierre transitivo sobre afirmaciones "X es Y"). Existia construido
  // desde antes (structural-verify.js#verifyStructuralCoherence) pero
  // nunca se importaba aqui -- hueco real encontrado por el propio
  // benchmark (scripts/benchmark-verification.mjs, caso reason-02: "A es
  // B", "B es C", pero tambien "A no es C" dentro del mismo texto, ningun
  // otro verificador lo cazaba). El umbral de percentil-por-lote de esa
  // funcion tambien tuvo que arreglarse (ver nota en structural-verify.js)
  // antes de que detectase el caso real que motivo conectarla.
  try {
    var structuralResult = verifyStructuralCoherence(text);
    if (structuralResult.findings.length > 0) {
      hasFindings = true;
      note('structural', structuralResult.findings.length);
      var structuralWarningLines = ['⚠️ Aviso de coherencia estructural (cadena de afirmaciones que se contradice a si misma):'];
      structuralResult.findings.forEach(function (f) {
        structuralWarningLines.push('  ' + f.reason);
      });
      out = structuralWarningLines.join('\n') + '\n\n' + out;
    }
  } catch (e) { channelErrors.push('structural'); }
  return {
    text: out,
    hasFindings: hasFindings,
    channels: channels,
    findingCounts: findingCounts,
    channelErrors: channelErrors,
  };
}
