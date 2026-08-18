// ═══════════════════════════════════════════════════════════════
// LINKCORE vNPU CORE — VIRTUAL NEURAL PROCESSING UNIT INSTRUCTION PLANNER
// High-performance software-defined NPU layer. Este es el decodificador de
// instrucciones REAL del procesador (2026-08-16): antes de esta fecha, el
// trabajo real vivia repartido entre las tools MCP (mcp/linkcore-server.js,
// llamadas con forma de API) y este archivo, que solo se ejercitaba desde
// `linkcore benchmark`. Decision del fundador: nada de MCP, nada de
// "API" -- LinkCore se instala como componente de sistema y CUALQUIER IA
// jefe (Claude Code, OpenCode, u otra) le manda una INSTRUCCION con opcode,
// igual que el software le manda una instruccion a un procesador real
// (AMD Ryzen), no una llamada a funcion remota. Este archivo es ese
// decodificador unico: runVNPUInstruction(opcode, payload) es la unica
// puerta de entrada real al motor (smartQuery/verify/critique/route),
// alcanzable via `linkcore vnpu <OPCODE>` (bin/linkcore-cli.js) sobre la
// tuberia con nombre -- nunca HTTP, nunca MCP.
//
// Opcodes reales, cada uno respaldado por una funcion que de verdad hace
// el trabajo (nunca un opcode "de mentira" sin implementacion detras):
//   EXEC       -> smartQuery(): pipeline completo (orquestador/ensemble/
//                 verificacion), la misma via que `linkcore ask`.
//   ROUTE      -> intermediateOllama(): decide que pieza ejecutaria una
//                 tarea, sin ejecutarla.
//   VERIFY     -> applyDeterministicVerification(): capa 1, milisegundos,
//                 sin generacion (auditoria de un borrador ya escrito).
//   CRITIQUE   -> ensembleCritique(): capa 2, ~20-30s, segunda opinion real
//                 de una pieza local.
//   CROSSCHECK -> la IA jefe (Claude/Opus/Sonnet, quien accede al
//                 procesador) se trata como UNA VOZ MAS del ensemble, no
//                 como un consumidor externo pasivo (2026-08-17, pedido
//                 explicito del fundador: "el modelo (Opus o Sonnet) se
//                 incluye en el sistema"). Modelos locales responden a la
//                 MISMA pregunta a ciegas (nunca ven el borrador de la IA
//                 jefe -- si lo vieran, su respuesta dejaria de ser
//                 confirmacion independiente), y se les aplica la MISMA
//                 deteccion de contradicciones ya construida y verificada
//                 para el ensemble local (neural-arbitrage.js#
//                 arbitrateResponses, con firma HMAC real por instalacion).
//                 Esto no es "otra IA opinando sobre tu respuesta" -- es
//                 verificacion determinista (coseno/Jaccard/emparejamiento
//                 por mejor coincidencia tematica) contra respuestas
//                 generadas de forma independiente, exactamente la misma
//                 maquina que ya se usa para comparar dos modelos locales
//                 entre si.
//   AUDIT      -> runBatchAudit(): VERIFY sobre un conjunto entero, con
//                 puerta de calidad (2026-08-18). Es la instruccion que
//                 convierte el procesador en infraestructura y no en una
//                 utilidad manual: una empresa no verifica una respuesta,
//                 verifica su conjunto de evaluacion en cada despliegue y
//                 necesita un veredicto (pasa/no pasa) que pueda cortar un
//                 CI. Mismo codigo determinista que VERIFY, nunca una
//                 variante paralela que pudiera divergir.
//   TELEMETRY  -> getVNPUStats(): estado real del hardware + historial de
//                 instrucciones ejecutadas.
//   ENSEMBLE   -> retirado a proposito (ver el case mas abajo): el ensemble
//                 real vive en ensembleRun() de ensemble-v2.js, usado desde
//                 dentro de EXEC. No se duplica aqui.
// Se elimino SPECULATE del set: nunca tuvo una implementacion real detras
// (ejecucion especulativa de verdad no esta construida) -- mantenerlo en
// la lista de opcodes habria sido anunciar una capacidad que no existe,
// justo lo que este proyecto prohibe (ver CLAUDE.md §4).
// ═══════════════════════════════════════════════════════════════

import { getHardwareProfile, inspectOllamaHardware } from './hardware-profiler.js';

var telemetryLedger = [];

export var VNPU_OPCODES = {
  EXEC: 'vNPU.EXEC',
  ROUTE: 'vNPU.ROUTE',
  VERIFY: 'vNPU.VERIFY',
  CRITIQUE: 'vNPU.CRITIQUE',
  CROSSCHECK: 'vNPU.CROSSCHECK',
  AUTOVERIFY: 'vNPU.AUTOVERIFY',
  GROUND: 'vNPU.GROUND',
  AUDIT: 'vNPU.AUDIT',
  ENSEMBLE: 'vNPU.ENSEMBLE',
  TELEMETRY: 'vNPU.TELEMETRY',
};

export function recordTelemetry(meta) {
  var entry = {
    ts: Date.now(),
    opcode: meta.opcode || VNPU_OPCODES.EXEC,
    model: meta.model || 'unknown',
    provider: meta.provider || 'local',
    latencyMs: meta.latencyMs || 0,
    tokens: meta.tokens || 0,
    tokensPerSec: meta.latencyMs > 0 && meta.tokens > 0 ? parseFloat(((meta.tokens / meta.latencyMs) * 1000).toFixed(2)) : 0,
    success: meta.success !== false,
  };
  telemetryLedger.push(entry);
  if (telemetryLedger.length > 500) telemetryLedger.shift();
  return entry;
}

export function getVNPUStats() {
  var hw = getHardwareProfile();
  var totalCalls = telemetryLedger.length;
  var successful = telemetryLedger.filter(function (e) { return e.success; });
  var avgLatency = successful.length
    ? Math.round(successful.reduce(function (sum, e) { return sum + e.latencyMs; }, 0) / successful.length)
    : 0;
  var avgTPS = successful.length
    ? parseFloat((successful.reduce(function (sum, e) { return sum + e.tokensPerSec; }, 0) / successful.length).toFixed(2))
    : 0;

  return {
    hardware: hw,
    totalInferences: totalCalls,
    successfulInferences: successful.length,
    avgLatencyMs: avgLatency,
    avgTokensPerSec: avgTPS,
    recentTelemetry: telemetryLedger.slice(-10),
  };
}

// Puente unico hacia el historial de calidad persistente
// (engine/quality-engine.js, 2026-08-18). Import dinamico y try/catch por
// la misma razon que el resto de imports de este archivo: registrar
// telemetria de calidad NUNCA puede tumbar la instruccion que la produjo.
// `options._suppressQualityRecord` existe para que AUTOVERIFY, que llama
// a VERIFY y a CROSSCHECK por dentro, no genere tres eventos por una sola
// instruccion -- registra el suyo, compuesto, y silencia los internos.
async function recordQuality(options, info) {
  if (options && options._suppressQualityRecord) return null;
  try {
    var qe = await import('./quality-engine.js');
    var verified = info.verified || {};
    return qe.recordQualityEvent({
      opcode: info.opcode,
      contentType: qe.classifyContent(info.draft),
      category: info.category || null,
      draftChars: typeof info.draft === 'string' ? info.draft.length : 0,
      channels: verified.channels || [],
      channelErrors: verified.channelErrors || [],
      findingCounts: verified.findingCounts || {},
      hasFindings: !!verified.hasFindings,
      confScore: info.confidence ? info.confidence.score : null,
      confEscalate: info.confidence ? !!info.confidence.recommendEscalation : null,
      confRam: info.confidence && typeof info.confidence.ramAvailable === 'boolean' ? info.confidence.ramAvailable : null,
      escalated: !!info.escalated,
      cc: info.cc || null,
      verifyMs: typeof info.verifyMs === 'number' ? info.verifyMs : null,
      totalMs: typeof info.totalMs === 'number' ? info.totalMs : null,
    });
  } catch (e) {
    return null;
  }
}

// Puente hacia el registro de auditoria encadenado y firmado
// (engine/audit-ledger.js, construido 2026-08-18, cableado 2026-08-18 --
// existia pero ningun opcode lo llamaba). Mismo criterio que
// recordQuality(): import dinamico + try/catch, registrar auditoria NUNCA
// puede tumbar la instruccion que la produjo. `_suppressAuditRecord`
// evita que AUTOVERIFY registre tres veces la misma revision (la interna
// de VERIFY, la de CROSSCHECK si escala, y la compuesta final) -- solo la
// compuesta queda en el rastro de auditoria.
async function recordAudit(options, info) {
  if (options && options._suppressAuditRecord) return null;
  try {
    var al = await import('./audit-ledger.js');
    var verified = info.verified || {};
    return al.recordVerification({
      opcode: info.opcode,
      draft: info.draft,
      query: info.query,
      verifiers: verified.channels || [],
      findings: { channels: verified.findingCounts || {} },
      hasFindings: !!verified.hasFindings,
      latencyMs: info.totalMs,
      escalated: !!info.escalated,
      degraded: !!info.degraded,
      degradedReason: info.degradedReason,
    });
  } catch (e) {
    return null;
  }
}

// Resume el resultado de un CROSSCHECK a la forma compacta que guarda el
// historial de calidad: cuantos desacuerdos reales hubo y con que voces.
// `found` es la señal que de verdad justifica el camino caro -- true solo
// si alguna de las tres deteciones (contradicciones del arbitraje,
// desacuerdo factual, desacuerdo numerico) encontro algo.
function summarizeCrosscheck(cc) {
  if (!cc) return { ran: false, error: 'sin_resultado', latencyMs: null };
  if (!cc.ok) return { ran: false, error: cc.error || 'desconocido', latencyMs: cc.latencyMs || null };
  var contradictions = (cc.contradictions || []).length;
  var factDis = (cc.factDisagreements || []).length;
  var numDis = (cc.numericDisagreements || []).length;
  return {
    ran: true,
    voices: cc.localVoicesConsulted || [],
    contradictions: contradictions,
    factDis: factDis,
    numDis: numDis,
    found: (contradictions + factDis + numDis) > 0,
    latencyMs: typeof cc.latencyMs === 'number' ? cc.latencyMs : null,
  };
}

export async function runVNPUInstruction(opcode, payload, options) {
  var startTime = Date.now();
  options = options || {};

  switch (opcode) {
    case VNPU_OPCODES.ROUTE: {
      // Bug real, preexistente (encontrado en vivo 2026-08-13, primera vez
      // que este opcode se ejecutaba de verdad): importaba
      // pickBestOpenSourceModel de backend.js, una funcion sin `export` --
      // TypeError inmediato, "pickBestOpenSourceModel is not a function".
      // Corregido para usar intermediateOllama() de ollama-catalog.js, la
      // funcion PUBLICA y ya verificada que la intermediacion real usa
      // (capacidad + sesgo aprendido + residencia en RAM, todo conectado
      // hoy mismo) -- no una funcion privada de otro modulo.
      var ollamaMod = await import('./ollama-catalog.js');
      var routeResult = await ollamaMod.intermediateOllama(payload.query, { size: 1, category: payload.category, preferCapability: true });
      var bestModel = routeResult.ok && routeResult.selected.length ? routeResult.selected[0] : null;
      var routeTime = Date.now() - startTime;
      recordTelemetry({ opcode: VNPU_OPCODES.ROUTE, model: bestModel?.id || 'none', latencyMs: routeTime, success: !!bestModel });
      return { ok: !!bestModel, model: bestModel, latencyMs: routeTime };
    }

    case VNPU_OPCODES.EXEC: {
      // Bug real, mismo patron ya visto dos veces en este proyecto
      // (mcp/linkcore-server.js 2026-08-07, src/index.js#handleAsk
      // 2026-08-02): este case llamaba a callAI(), el intento de UN
      // modelo sin orquestador/ensemble/work-ledger/G-STACK, en vez de
      // smartQuery(), el pipeline real. Corregido (2026-08-16) para que
      // vNPU.EXEC sea de verdad la via completa, la misma que usa
      // `linkcore ask`.
      var { smartQuery } = await import('../backend.js');
      var result = await smartQuery(payload.query, null, options);
      var execTime = Date.now() - startTime;
      var approxTokens = result && result.response ? Math.round(result.response.length / 4) : 0;
      recordTelemetry({ opcode: VNPU_OPCODES.EXEC, model: (result && result.model) || 'none', provider: result && result.provider, latencyMs: execTime, tokens: approxTokens, success: !!(result && result.response) });
      return result;
    }

    case VNPU_OPCODES.VERIFY: {
      var { applyDeterministicVerification } = await import('./verification-pipeline.js');
      var verified = await applyDeterministicVerification(payload.draft || '', payload.query || '');
      // Unidad de Puntuacion de Confianza (2026-08-18): decide si el
      // silencio de VERIFY es una señal real o solo "aqui no hay ningun
      // chequeo que aplique", usando la tasa de aciertos MEDIDA por
      // categoria (no una intuicion) y comprobando RAM real antes de
      // recomendar CROSSCHECK -- nunca asume que el usuario tiene margen.
      var { assessConfidence } = await import('./confidence-unit.js');
      var confidence = await assessConfidence(payload.draft || '', { hasFindings: verified.hasFindings });
      var verifyTime = Date.now() - startTime;
      recordTelemetry({ opcode: VNPU_OPCODES.VERIFY, model: 'deterministic', provider: 'local', latencyMs: verifyTime, success: true });
      // Historial de calidad persistente (2026-08-18): recordTelemetry()
      // vive solo en memoria de este proceso, con tope de 500 y sin decir
      // que verificador disparo -- inutil para inteligencia ENTRE
      // ejecuciones. quality-engine.js persiste el evento rico (canales,
      // confianza, contenido) para poder agregar despues. Va en try/catch
      // y con import dinamico: si el modulo no esta o el disco falla, la
      // instruccion NO se cae por culpa de la telemetria.
      var verifyEventId = await recordQuality(options, {
        opcode: VNPU_OPCODES.VERIFY,
        draft: payload.draft,
        category: payload.category,
        verified: verified,
        confidence: confidence,
        verifyMs: verifyTime,
        totalMs: verifyTime,
      });
      await recordAudit(options, {
        opcode: VNPU_OPCODES.VERIFY,
        draft: payload.draft,
        query: payload.query,
        verified: verified,
        totalMs: verifyTime,
      });
      return {
        ok: true,
        hasFindings: verified.hasFindings,
        text: verified.text,
        confidence: confidence,
        channels: verified.channels || [],
        findingCounts: verified.findingCounts || {},
        channelErrors: verified.channelErrors || [],
        latencyMs: verifyTime,
        qualityEventId: verifyEventId,
      };
    }

    // Escalado automatico (2026-08-18): hasta ahora la Unidad de Confianza
    // solo RECOMENDABA escalar a CROSSCHECK -- una IA jefe tenia que leer
    // `confidence.recommendEscalation` y decidir llamar a CROSSCHECK ella
    // misma. Este opcode cierra ese hueco: corre VERIFY, y si la confianza
    // es baja Y hay RAM real disponible (la misma comprobacion que ya usa
    // la Unidad de Confianza, nunca una asuncion), llama a CROSSCHECK el
    // mismo y fusiona ambos resultados en una sola respuesta. Si VERIFY ya
    // encontro un problema, o si no hay RAM, o si el contenido no lo
    // justifica, se queda en VERIFY -- nunca gasta la latencia de
    // CROSSCHECK sin una razon medida para hacerlo.
    case VNPU_OPCODES.AUTOVERIFY: {
      // Un solo evento de calidad por instruccion AUTOVERIFY: los VERIFY/
      // CROSSCHECK internos se silencian (ver recordQuality) para no
      // contar tres veces la misma auditoria en los agregados.
      var innerOptions = Object.assign({}, options || {}, { _suppressQualityRecord: true, _suppressAuditRecord: true });
      var autoVerified = await runVNPUInstruction(VNPU_OPCODES.VERIFY, payload, innerOptions);
      if (!autoVerified.confidence || !autoVerified.confidence.recommendEscalation) {
        await recordQuality(options, {
          opcode: VNPU_OPCODES.AUTOVERIFY,
          draft: payload.draft,
          category: payload.category,
          verified: autoVerified,
          confidence: autoVerified.confidence,
          escalated: false,
          verifyMs: autoVerified.latencyMs,
          totalMs: Date.now() - startTime,
        });
        await recordAudit(options, {
          opcode: VNPU_OPCODES.AUTOVERIFY,
          draft: payload.draft,
          query: payload.query,
          verified: autoVerified,
          escalated: false,
          totalMs: Date.now() - startTime,
        });
        return Object.assign({}, autoVerified, { escalated: false });
      }
      var autoCC = await runVNPUInstruction(VNPU_OPCODES.CROSSCHECK, {
        query: payload.query,
        draft: payload.draft,
        agentName: payload.agentName,
        category: payload.category,
        size: payload.size,
      }, innerOptions);
      var autoTime = Date.now() - startTime;
      await recordQuality(options, {
        opcode: VNPU_OPCODES.AUTOVERIFY,
        draft: payload.draft,
        category: payload.category,
        verified: autoVerified,
        confidence: autoVerified.confidence,
        escalated: true,
        cc: summarizeCrosscheck(autoCC),
        verifyMs: autoVerified.latencyMs,
        totalMs: autoTime,
      });
      await recordAudit(options, {
        opcode: VNPU_OPCODES.AUTOVERIFY,
        draft: payload.draft,
        query: payload.query,
        verified: autoVerified,
        escalated: true,
        degraded: !(autoCC && autoCC.ok),
        degradedReason: (autoCC && !autoCC.ok) ? autoCC.error : null,
        totalMs: autoTime,
      });
      recordTelemetry({
        opcode: VNPU_OPCODES.AUTOVERIFY,
        model: 'deterministic+crosscheck',
        provider: 'auto-escalation',
        latencyMs: autoTime,
        success: !!(autoCC && autoCC.ok),
      });
      return Object.assign({}, autoVerified, {
        escalated: true,
        crosscheck: autoCC,
        latencyMs: autoTime,
      });
    }

    case VNPU_OPCODES.CRITIQUE: {
      var { ensembleCritique } = await import('../backend.js');
      var critResult = await ensembleCritique(payload.draft || '', payload.query || '');
      var critTime = Date.now() - startTime;
      recordTelemetry({ opcode: VNPU_OPCODES.CRITIQUE, model: (critResult && critResult.model) || 'none', provider: critResult && critResult.provider, latencyMs: critTime, success: !!(critResult && critResult.ok) });
      // Trazabilidad de CRITIQUE (2026-08-18, hueco real encontrado por
      // grep: este case no llamaba a recordQuality ni recordAudit, asi que
      // la capa 2 -- segunda opinion real de una pieza local -- no dejaba
      // NINGUN rastro persistente cuando se invoca de forma standalone
      // (fuera de AUTOVERIFY, que si la registra via CROSSCHECK). Adaptacion
      // de payload: ensembleCritique() no devuelve `channels`/
      // `findingCounts` al estilo VERIFY (no corre canales deterministas),
      // asi que se sintetiza un unico canal 'critique' con 1 hallazgo si
      // `foundIssue` es true -- es la unica señal real que este opcode
      // produce, no una tabla de canales inventada. `escalated: true`
      // porque CRITIQUE ES la capa 2 (segunda opinion de una IA), no un
      // paso previo a ella.
      var critVerified = {
        channels: critResult && critResult.ok ? ['critique'] : [],
        channelErrors: critResult && !critResult.ok ? ['critique'] : [],
        findingCounts: critResult && critResult.ok && critResult.foundIssue ? { critique: 1 } : {},
        hasFindings: !!(critResult && critResult.foundIssue),
      };
      await recordQuality(options, {
        opcode: VNPU_OPCODES.CRITIQUE,
        draft: payload.draft,
        category: payload.category,
        verified: critVerified,
        confidence: null,
        escalated: true,
        verifyMs: critTime,
        totalMs: critTime,
      });
      await recordAudit(options, {
        opcode: VNPU_OPCODES.CRITIQUE,
        draft: payload.draft,
        query: payload.query,
        verified: critVerified,
        totalMs: critTime,
        escalated: true,
        degraded: !(critResult && critResult.ok),
        degradedReason: (critResult && !critResult.ok) ? critResult.error : null,
      });
      return critResult;
    }

    // Verificacion de anclaje/atribucion (2026-08-18): a diferencia de
    // VERIFY/CROSSCHECK (comparan la respuesta contra si misma o contra
    // otras voces generadas), GROUND comprueba la respuesta contra FUENTES
    // EXTERNAS que dice citar -- citas fabricadas, cifras/fechas/entidades
    // sin respaldo, referencias a documentos que no existen, afirmaciones
    // que contradicen la fuente. Es el gap real que RAG/agentes
    // empresariales necesitan cerrar y que ningun otro opcode cubre.
    // Determinista, sin generacion (src/engine/grounding-verify.js).
    case VNPU_OPCODES.GROUND: {
      // payload: { answer, sources: [{id,text}]|[string], question?, channels?, opts? }
      // Mismo criterio de guarda que CROSSCHECK arriba: un payload
      // malformado degrada con {ok:false,error} ANTES de tocar el motor de
      // verificacion, nunca una excepcion sin capturar.
      if (payload.answer == null || typeof payload.answer !== 'string') {
        return { ok: false, error: 'answer_requerido' };
      }
      if (payload.sources !== undefined && !Array.isArray(payload.sources)) {
        return { ok: false, error: 'sources_debe_ser_array' };
      }
      var groundMod = await import('./grounding-verify.js');
      var groundOpts = Object.assign({}, payload.opts || {}, {
        channels: payload.channels,
        question: payload.question,
      });
      var groundResult;
      try {
        groundResult = groundMod.verifyGrounding(payload.answer, payload.sources || [], groundOpts);
      } catch (e) {
        return { ok: false, error: 'error_interno: ' + e.message };
      }
      // Catalogos de referencia (2026-08-18): unico hueco que las fuentes
      // aportadas no cierran -- una respuesta puede citar el articulo o el
      // CWE equivocado sin contradecir ninguna fuente, simplemente porque la
      // fuente correcta no viene en el payload. Se compone AQUI en vez de
      // dentro de grounding-verify.js porque es una entrada distinta (un
      // catalogo que instala la empresa, versionado, no un documento del
      // caso) y porque ese modulo ya tiene su contrato de canales cerrado.
      // Sin `catalogs` en el payload no corre nada: el procesador no lleva
      // conocimiento normativo propio y no debe fingir tenerlo.
      if (payload.catalogs !== undefined && !Array.isArray(payload.catalogs)) {
        return { ok: false, error: 'catalogs_debe_ser_array' };
      }
      if (payload.catalogs && payload.catalogs.length > 0) {
        var catalogMod = await import('./reference-catalog.js');
        var catalogFindings = [];
        var catalogErrors = [];
        payload.catalogs.forEach(function (cat) {
          try {
            catalogMod.verifyReferenceCatalog(payload.answer, cat).forEach(function (f) {
              if (f.tipo === 'catalogo_invalido') {
                catalogErrors.push((cat && cat.id ? cat.id : 'sin_id') + ': ' + f.detalle);
                return;
              }
              catalogFindings.push(Object.assign({ channel: 'REFERENCE_CATALOG' }, f));
            });
          } catch (e) {
            catalogErrors.push((cat && cat.id ? cat.id : 'sin_id') + ': ' + e.message);
          }
        });
        groundResult.findings = (groundResult.findings || []).concat(catalogFindings);
        groundResult.channelsRun = (groundResult.channelsRun || []).concat(['REFERENCE_CATALOG']);
        groundResult.catalogsRun = payload.catalogs.map(function (c) {
          return (c && c.id ? c.id : 'sin_id') + '@' + (c && c.version ? c.version : 'sin_version');
        });
        if (catalogErrors.length > 0) groundResult.catalogErrors = catalogErrors;
      }
      var groundTime = Date.now() - startTime;
      recordTelemetry({
        opcode: VNPU_OPCODES.GROUND,
        model: 'deterministic',
        provider: 'local',
        latencyMs: groundTime,
        success: true,
      });
      // Trazabilidad de GROUND (2026-08-18, mismo hueco que CRITIQUE: grep
      // confirmo que este case nunca llamaba a recordQuality ni recordAudit
      // pese a ser determinista y barato, igual que VERIFY). Adaptacion de
      // payload (GROUND no tiene "verified.channels" de la misma forma que
      // VERIFY, ver instruccion del encargo): `verified.channels` se llena
      // con `groundResult.channelsRun` (los canales de anclaje que de
      // verdad corrieron: QUOTE/NUMBER/DATE/ENTITY/CITATION/CONTRADICTION),
      // y `findingCounts` se deriva agregando `groundResult.findings` por
      // su campo `channel` -- no se inventa un desglose, se cuenta el que
      // ya devuelve verifyGrounding(). GROUND tampoco tiene `query` en su
      // payload (tiene `answer` + `question` opcional): se usa
      // `payload.question || ''` para el hash de auditoria, documentado
      // porque no es obvio a partir del nombre del campo.
      var groundFindingCounts = {};
      (groundResult.findings || []).forEach(function (f) {
        var ch = f && f.channel ? f.channel : 'desconocido';
        groundFindingCounts[ch] = (groundFindingCounts[ch] || 0) + 1;
      });
      var groundVerified = {
        channels: groundResult.channelsRun || [],
        // Un catalogo mal formado es un error de canal, no un silencio: si no
        // se propaga aqui, la puerta de calidad da por bueno un lote que en
        // realidad no comprobo las referencias.
        channelErrors: groundResult.catalogErrors ? ['REFERENCE_CATALOG'] : [],
        findingCounts: groundFindingCounts,
        hasFindings: !!(groundResult.findings && groundResult.findings.length),
      };
      await recordQuality(options, {
        opcode: VNPU_OPCODES.GROUND,
        draft: payload.answer,
        category: payload.category,
        verified: groundVerified,
        confidence: null,
        verifyMs: groundTime,
        totalMs: groundTime,
      });
      await recordAudit(options, {
        opcode: VNPU_OPCODES.GROUND,
        draft: payload.answer,
        query: payload.question || '',
        verified: groundVerified,
        totalMs: groundTime,
      });
      return Object.assign({ ok: true, latencyMs: groundTime }, groundResult);
    }

    case VNPU_OPCODES.CROSSCHECK: {
      // payload: { query, draft, agentName?, category?, size? }
      // `draft` es lo que la IA jefe ya escribio -- nunca se le pasa a los
      // modelos locales (ver comentario grande de arriba, "a ciegas").
      // Bug real, encontrado en vivo (2026-08-17, hunt adversarial): sin
      // esta guarda, un payload sin `query` (o con query vacia) llegaba
      // hasta arbitrateResponses() (neural-arbitrage.js), que hace
      // `query.slice(0, 200)` sin comprobar nada -- TypeError sin capturar
      // ("Cannot read properties of undefined (reading 'slice')") que tira
      // el opcode entero, DESPUES de haber gastado una inferencia local real
      // (callOllamaModel ya se habia ejecutado con query=undefined). Un
      // payload malformado debe degradar con {ok:false, error:...} como el
      // resto de casos de esta funcion, nunca tirar una excepcion sin
      // capturar ni desperdiciar una inferencia antes de detectarlo.
      if (!payload.query || !String(payload.query).trim()) {
        return { ok: false, error: 'query_requerido' };
      }
      var ollamaModCC = await import('./ollama-catalog.js');
      var backendModCC = await import('../backend.js');
      var arbitrageModCC = await import('./neural-arbitrage.js');
      var structuralModCC = await import('./structural-verify.js');

      var routeResultCC = await ollamaModCC.intermediateOllama(payload.query, {
        size: payload.size || 2,
        category: payload.category || null,
        preferCapability: true,
      });
      if (!routeResultCC.ok || !routeResultCC.selected.length) {
        return { ok: false, error: 'sin_modelos_locales_disponibles' };
      }

      var localVoices = [];
      for (var vi = 0; vi < routeResultCC.selected.length; vi++) {
        var mCC = routeResultCC.selected[vi];
        var localResult = await backendModCC.callOllamaModel(mCC.id, payload.query, { maxTokens: 400 });
        if (localResult && localResult.ok && localResult.text) {
          localVoices.push({ model: mCC.id, family: mCC.family, text: localResult.text });
        }
      }

      if (!localVoices.length) {
        return { ok: false, error: 'ningun_modelo_local_respondio', consultados: routeResultCC.selected.map(function (m) { return m.id; }) };
      }

      var agentNameCC = payload.agentName || 'claude';
      var allVoicesCC = [{ model: agentNameCC, family: agentNameCC, text: payload.draft || '' }].concat(localVoices);

      var report = arbitrageModCC.arbitrateResponses(payload.query, allVoicesCC, {});
      // Hallazgo real (2026-08-17), encontrado probando este mismo opcode
      // en vivo: "la capital de Australia es Sidney" vs "...es Canberra"
      // NO lo detectaba arbitrateResponses -- el solapamiento lexico
      // compartido ("la capital de australia es") es tan alto que la
      // similitud GLOBAL de la frase queda por encima del umbral de
      // contradiccion, aunque la unica palabra que de verdad importa sea
      // distinta. verifyCrossVoiceFacts() (structural-verify.js) cubre
      // exactamente ese hueco: mismo sujeto, valor nuclear distinto.
      var factDisagreements = structuralModCC.verifyCrossVoiceFacts(allVoicesCC);
      // Mismo hueco que arriba, pero para numeros en vez de prosa
      // (2026-08-17): "el total es 42" vs "el total es 45" no lo detecta
      // ni arbitrateResponses (misma razon, solapamiento lexico global
      // demasiado alto) ni factDisagreements (solo extrae "X es/son Y",
      // no cifras). verifyCrossVoiceNumbers() cubre ese caso reutilizando
      // extractFinalNumericClaimWithIndex/compareNumericClaims de
      // math-verify.js -- ver comentario grande junto a esa funcion en
      // structural-verify.js.
      var numericDisagreements = structuralModCC.verifyCrossVoiceNumbers(allVoicesCC);

      var crossCheckTime = Date.now() - startTime;
      recordTelemetry({
        opcode: VNPU_OPCODES.CROSSCHECK,
        model: agentNameCC + '+' + localVoices.length,
        provider: 'crosscheck',
        latencyMs: crossCheckTime,
        success: true,
      });

      var ccResult = {
        ok: true,
        agentName: agentNameCC,
        localVoicesConsulted: localVoices.map(function (v) { return v.model; }),
        consensus: report.consensus,
        contradictions: report.contradictions,
        factDisagreements: factDisagreements,
        numericDisagreements: numericDisagreements,
        bestResponse: report.bestResponse,
        rankings: report.rankings,
        signature: report.signature,
        latencyMs: crossCheckTime,
      };
      // Un CROSSCHECK invocado directamente (no desde AUTOVERIFY) tambien
      // es historial de calidad: es el unico camino que produce una señal
      // de resultado INDEPENDIENTE del verificador determinista, y sin el
      // la calibracion de la Unidad de Confianza no tiene con que
      // contrastarse (ver computeCalibration en quality-engine.js).
      await recordQuality(options, {
        opcode: VNPU_OPCODES.CROSSCHECK,
        draft: payload.draft,
        category: payload.category,
        verified: {},
        confidence: null,
        escalated: true,
        cc: summarizeCrosscheck(ccResult),
        totalMs: crossCheckTime,
      });
      // Hueco real de trazabilidad (2026-08-18, confirmado por grep antes
      // de tocar este archivo): un CROSSCHECK invocado de forma DIRECTA (no
      // desde dentro de AUTOVERIFY) ya llamaba a recordQuality justo
      // arriba, pero nunca a recordAudit -- la pieza mas cara de verificar
      // (voces locales generadas a ciegas + arbitraje + deteccion de
      // desacuerdo factual/numerico) era la unica que no dejaba rastro en
      // el libro de auditoria encadenado y firmado. Adaptacion de payload:
      // CROSSCHECK no corre canales deterministas tipo VERIFY (math/code/
      // coherencia), asi que `verified.channels` se llena con los TRES
      // detectores reales que si corrieron aqui (arbitraje de
      // contradicciones, desacuerdo factual cruzado, desacuerdo numerico
      // cruzado) y `findingCounts` cuenta lo que cada uno encontro de
      // verdad -- no se inventa una tabla de canales que no existen para
      // este opcode.
      var crossCheckVerified = {
        channels: ['crosscheck_contradictions', 'crosscheck_fact_disagreements', 'crosscheck_numeric_disagreements'],
        channelErrors: [],
        findingCounts: {
          crosscheck_contradictions: (ccResult.contradictions || []).length,
          crosscheck_fact_disagreements: (factDisagreements || []).length,
          crosscheck_numeric_disagreements: (numericDisagreements || []).length,
        },
        hasFindings: summarizeCrosscheck(ccResult).found,
      };
      await recordAudit(options, {
        opcode: VNPU_OPCODES.CROSSCHECK,
        draft: payload.draft,
        query: payload.query,
        verified: crossCheckVerified,
        totalMs: crossCheckTime,
        escalated: true,
      });
      return ccResult;
    }

    case VNPU_OPCODES.AUDIT: {
      var { runBatchAudit } = await import('./batch-audit.js');
      var auditResult = await runBatchAudit(payload);
      var auditMs = Date.now() - startTime;
      if (!auditResult.ok) return auditResult;
      recordTelemetry({ opcode: VNPU_OPCODES.AUDIT, model: 'deterministic', provider: 'local', latencyMs: auditMs, success: true });
      // Un solo evento por LOTE, no uno por elemento: el historial de
      // calidad mide instrucciones, y un lote de mil elementos que generara
      // mil eventos falsearia cualquier agregado posterior. El detalle por
      // elemento ya viaja en la respuesta.
      await recordQuality(options, {
        opcode: VNPU_OPCODES.AUDIT,
        draft: '',
        verified: {
          channels: Object.keys(auditResult.summary.channelHits),
          channelErrors: Object.keys(auditResult.summary.channelErrors),
          findingCounts: auditResult.summary.channelHits,
          hasFindings: auditResult.summary.withFindings > 0,
        },
        verifyMs: auditMs,
        totalMs: auditMs,
      });
      await recordAudit(options, {
        opcode: VNPU_OPCODES.AUDIT,
        // Lo que se firma de un lote es su resultado agregado y el veredicto:
        // es lo que la empresa va a enseñar como evidencia de que ese
        // despliegue paso la puerta.
        draft: JSON.stringify(auditResult.summary),
        query: 'gate=' + JSON.stringify(auditResult.gate),
        verified: {
          channels: Object.keys(auditResult.summary.channelHits),
          channelErrors: Object.keys(auditResult.summary.channelErrors),
          findingCounts: auditResult.summary.channelHits,
          hasFindings: !auditResult.passed,
        },
        totalMs: auditMs,
      });
      auditResult.latencyMs = auditMs;
      return auditResult;
    }

    case VNPU_OPCODES.TELEMETRY: {
      return getVNPUStats();
    }

    case VNPU_OPCODES.ENSEMBLE: {
      // 100% local de verdad (2026-08-09): este caso llamaba a
      // callOpenSourceEnsemble (repos HF como servicio remoto). Nunca se
      // invoca en la practica (ningun caller real pasa VNPU_OPCODES.ENSEMBLE
      // -- solo ROUTE/EXEC se usan, desde el benchmark del CLI), pero
      // dejarlo apuntando a un camino remoto era una mina para el futuro.
      // El ensemble real y local vive en ensemble-v2.js (ensembleRun),
      // usado por backend.js#smartQuery y orchestrator.js -- este opcode
      // no tiene un caller real que lo necesite, asi que se retira en vez
      // de mantener una segunda implementacion sin usar.
      // Nota (2026-08-18, encargo de cablear recordQuality/recordAudit en
      // los opcodes que faltaban): el encargo original asumia que este case
      // produce "su propio resultado real (draft/respuesta, query,
      // hallazgos si los tiene, latencia, modelos consultados)" como
      // ROUTE/CRITIQUE/GROUND/CROSSCHECK. Comprobado en vivo leyendo este
      // mismo archivo: NO es asi. El case entero es un stub retirado (ver
      // el comentario de arriba, 2026-08-09) que no genera nada, no
      // consulta ningun modelo, y devuelve el mismo `{ok:false, error:...}`
      // sin tocar `payload` en absoluto -- no hay draft, query, canales ni
      // latencia real que registrar. Añadir recordQuality/recordAudit aqui
      // significaria escribir en el historial de calidad y en el libro de
      // auditoria encadenado un evento con `draft`/`query` fabricados (o
      // vacios) que aparentaria ser una verificacion real cuando no ocurrio
      // ningun trabajo -- exactamente lo que CLAUDE.md §4 prohibe ("Nunca
      // inventar/fingir un ensemble o consenso que no ocurrio"). Se deja
      // sin instrumentar a proposito hasta que este opcode tenga una
      // implementacion real detras (o se retire del todo).
      return { ok: false, error: 'opcode_ensemble_retirado: usa ensembleRun() de ensemble-v2.js' };
    }

    default:
      return { ok: false, error: 'Opcode vNPU no soportado: ' + opcode };
  }
}
