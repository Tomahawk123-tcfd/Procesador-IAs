// ═══════════════════════════════════════════════════════════════
// LINKCORE HANDOFF PACKET
// La respuesta literal y honesta a "tengo que dar contexto todo el
// rato y os solapais entre vosotras" (OpenCode, DeepSeek, Claude...).
//
// LinkCore no puede inyectar memoria dentro de otra herramienta --
// no tiene acceso a la API interna de un chat de DeepSeek o de
// OpenCode. Lo que SI puede hacer, real y verificable: reunir todo
// lo que ya sabe (hechos durables + memoria con intencion + trabajo
// ya completado) y generar UN bloque de texto listo para pegar,
// adaptado al estilo de lectura nativo del sitio donde lo vayas a
// pegar -- usando el mismo traductor semantico que ya hace esto
// entre las IAs del ensemble (semantic-translator.js). Un comando,
// un paste, contexto correcto -- en vez de reescribirlo cada vez.
// ═══════════════════════════════════════════════════════════════

import { memReadAll } from './middleware.js';
import { recallByIntent } from './intent-memory.js';
import { getLedger } from './work-ledger.js';

// Perfiles de destino para el traductor. Donde existe un perfil real y
// medido en ai-registry.js (anthropic/openai/deepseek), se reutiliza --
// no se reinventa. 'opencode' y 'generic' no son modelos con perfil
// propio (OpenCode es una CLI, no una familia de arquitectura), asi que
// llevan un perfil razonado explicitamente como tal, no medido.
var TARGET_PROFILES = {
  claude: { thinkingStyle: 'structured', promptStyle: 'cautious', maxContextLength: 2000, label: 'Claude / Claude Code' },
  gpt: { thinkingStyle: 'direct', promptStyle: 'direct', maxContextLength: 1800, label: 'ChatGPT / GPT-4o' },
  deepseek: { thinkingStyle: 'chain-of-thought', promptStyle: 'analytical', maxContextLength: 2000, label: 'DeepSeek' },
  // OpenCode es una CLI de codigo, no un modelo -- perfil razonado, no
  // medido: quien trabaja en una terminal quiere contexto denso y
  // accionable, sin prosa. Documentado como juicio, no como dato.
  opencode: { thinkingStyle: 'structured', promptStyle: 'direct', maxContextLength: 1600, label: 'OpenCode' },
  generic: { thinkingStyle: 'balanced', promptStyle: 'balanced', maxContextLength: 1800, label: 'Generico' },
};

function getTargetProfile(target) {
  return TARGET_PROFILES[String(target || 'generic').toLowerCase()] || TARGET_PROFILES.generic;
}

// ═══════════════════════════════════════════
// RECOLECCION
// ═══════════════════════════════════════════

// Hechos durables: solo la rama 'main' de memory.js -- lo que se
// escribio como conocimiento de proyecto, no el ruido de pasos
// intermedios de una ejecucion concreta (esos llevan '::' en la clave,
// ver la nota en crew.js).
function collectDurableFacts(limit) {
  var entries = memReadAll({ branch: 'main' });
  var facts = Object.keys(entries)
    .filter(function (k) { return k.indexOf('::') === -1; })
    .map(function (k) {
      var e = entries[k];
      return { key: k, value: e.value, agentId: e.agentId, updatedAt: e.updatedAt };
    });
  facts.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  return facts.slice(0, limit);
}

function collectRecentIntent(query, limit) {
  return recallByIntent(query || '', { limit: limit }).map(function (e) {
    return { content: e.content, scope: e.intent ? e.intent.scope : 'general', createdAt: e.createdAt };
  });
}

function collectRecentWork(limit) {
  return getLedger({ limit: limit }).map(function (e) {
    return { label: e.label, category: e.category, resultPreview: e.resultPreview, completedAt: e.completedAt, source: e.source };
  });
}

// ═══════════════════════════════════════════
// SINTESIS DEL BLOQUE
// ═══════════════════════════════════════════
//
// IMPORTANTE, y una correccion sobre la marcha: el primer intento hacia
// pasar este bloque por buildContextPacket()/translateForModel() de
// semantic-translator.js, reutilizando el traductor del ensemble. Un
// test end-to-end demostro que eso ROMPIA el paquete: buildContextPacket
// esta hecho para extraer decisiones/razonamiento de PROSA LIBRE escrita
// por una IA (busca frases con "por lo tanto", "porque", "la mejor
// opcion"...). Aqui los datos YA estan estructurados (hechos, memoria,
// trabajo previo) -- el extractor de frases solo capturaba la primera
// linea de cabecera como "evidencia" y descartaba el resto, porque
// ninguna viñeta coincidia con sus patrones de prosa. Es la herramienta
// correcta para un trabajo distinto (traducir el output crudo de un LLM
// para que otro lo entienda), no para formatear datos que ya tienen
// estructura. Usarla aqui habria tirado la mayoria del contexto.
//
// El formateador de abajo es propio, mas simple, y honesto sobre lo que
// hace: adapta la PRESENTACION (numerada como pasos de razonamiento,
// como encabezados markdown, o compacta sin adornos) al estilo de
// lectura del destino -- mismo principio que el traductor real, aplicado
// con la herramienta que de verdad encaja con datos ya estructurados.

function formatForTarget(facts, intent, work, profile) {
  var style = profile.thinkingStyle;

  function factLine(f) { return f.key + ': ' + String(f.value).slice(0, 300); }
  function intentLine(e) { return '[' + e.scope + '] ' + String(e.content).slice(0, 200); }
  function workLine(w) {
    var when = Math.round((Date.now() - w.completedAt) / 60000);
    return '"' + w.label + '" (' + (when < 1 ? 'hace instantes' : 'hace ' + when + ' min') + ', ' + w.category + '): ' +
      (w.resultPreview ? String(w.resultPreview).slice(0, 200) : 'sin resumen');
  }

  var lines = [];

  if (style === 'chain-of-thought') {
    var n = 1;
    if (facts.length) {
      lines.push('Hechos ya confirmados del proyecto (no los repreguntes):');
      facts.forEach(function (f) { lines.push('  ' + (n++) + '. ' + factLine(f)); });
      lines.push('');
    }
    if (intent.length) {
      lines.push('Contexto reciente relevante para esta tarea:');
      intent.forEach(function (e) { lines.push('  ' + (n++) + '. ' + intentLine(e)); });
      lines.push('');
    }
    if (work.length) {
      lines.push('Trabajo ya completado -- razona sobre esto en vez de rehacerlo:');
      work.forEach(function (w) { lines.push('  ' + (n++) + '. ' + workLine(w)); });
      lines.push('');
    }
    lines.push('Por lo tanto: continua desde aqui, no repitas lo anterior.');
  } else if (style === 'direct') {
    if (facts.length) lines.push('Hechos: ' + facts.map(factLine).join(' · '));
    if (intent.length) lines.push('Contexto: ' + intent.map(intentLine).join(' · '));
    if (work.length) lines.push('Ya hecho: ' + work.map(workLine).join(' · '));
  } else {
    // structured / balanced / cualquier otro: encabezados markdown, la
    // presentacion mas legible para pegar en un chat o editor.
    if (facts.length) {
      lines.push('## Hechos del proyecto (ya establecidos)');
      facts.forEach(function (f) { lines.push('- ' + factLine(f)); });
      lines.push('');
    }
    if (intent.length) {
      lines.push('## Contexto reciente relevante');
      intent.forEach(function (e) { lines.push('- ' + intentLine(e)); });
      lines.push('');
    }
    if (work.length) {
      lines.push('## Trabajo ya completado (no repetir)');
      work.forEach(function (w) { lines.push('- ' + workLine(w)); });
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════
// EMPAQUETADO PRINCIPAL
// ═══════════════════════════════════════════

// opts: { target, query, maxFacts, maxIntent, maxWork }
function buildHandoffPacket(opts) {
  opts = opts || {};
  var maxFacts = opts.maxFacts || 10;
  var maxIntent = opts.maxIntent || 6;
  var maxWork = opts.maxWork || 6;
  var target = opts.target || 'generic';
  var profile = getTargetProfile(target);

  var facts = collectDurableFacts(maxFacts);
  var intent = collectRecentIntent(opts.query, maxIntent);
  var work = collectRecentWork(maxWork);

  if (!facts.length && !intent.length && !work.length) {
    return {
      ok: false,
      reason: 'sin_contexto',
      text: '',
      target: target,
      generatedAt: Date.now(),
    };
  }

  var body = formatForTarget(facts, intent, work, profile);
  var header = '--- Contexto de LinkCore para ' + profile.label + ' (generado ' + new Date(Date.now()).toISOString().slice(0, 16).replace('T', ' ') + ') ---\n\n';
  var fullText = header + body;

  // Recorte duro si el bloque excede el contexto tipico del destino --
  // mejor un paquete truncado y avisado que uno que el destino ignore
  // parcialmente sin saberlo.
  var truncated = false;
  if (fullText.length > profile.maxContextLength) {
    fullText = fullText.slice(0, profile.maxContextLength - 20) + '\n[...recortado...]';
    truncated = true;
  }

  return {
    ok: true,
    text: fullText,
    target: target,
    truncated: truncated,
    factCount: facts.length,
    intentCount: intent.length,
    workCount: work.length,
    charCount: fullText.length,
    // Heuristica gruesa (≈4 caracteres/token en espanol/ingles mixto) --
    // deliberadamente etiquetada como aproximada, no una medicion real
    // del tokenizer de destino.
    approxTokens: Math.round(fullText.length / 4),
    generatedAt: Date.now(),
  };
}

function getAvailableTargets() {
  return Object.keys(TARGET_PROFILES).map(function (k) {
    return { id: k, label: TARGET_PROFILES[k].label };
  });
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

export {
  buildHandoffPacket,
  getAvailableTargets,
  collectDurableFacts,
  collectRecentIntent,
  collectRecentWork,
};
