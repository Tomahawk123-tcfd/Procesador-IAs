// ═══════════════════════════════════════════════════════════════
// LINKCORE PROXY — el ÚNICO camino real, accesible desde el puerto
// de Ollama (2026-08-11, unificado a petición explícita: "quiero que
// hagas solo un camino")
// ═══════════════════════════════════════════════════════════════
//
// Antes de esto había DOS caminos distintos: este proxy con su propio
// caché semántico aislado, y smartQuery() (CLI/MCP) con caché +
// verificación + escalado. Dos cachés separados para la misma pregunta
// es justo el tipo de duplicación que este proyecto lleva toda la
// noche cerrando en otros sitios. Se unifica: el proxy ya NO tiene su
// propio caché -- delega TODA la peticion a smartQuery(), el mismo
// camino que usa el CLI/MCP. Un solo caché, una sola logica de
// verificacion y escalado.
//
// Bug real, grave, encontrado en vivo (2026-08-12): el diseño original
// ocupaba el puerto por defecto de Ollama (11434) y movia Ollama real a
// 11435 via OLLAMA_HOST=127.0.0.1:11435 -- pero esa variable de entorno
// solo se puso en la sesion de terminal que arranco Ollama esa vez,
// nunca de forma persistente. En cuanto ese proceso de Ollama se
// reinicio (a saber cuando -- se descubrio dias despues), Ollama volvio
// a su puerto por defecto (11434) SIN AVISO, y todo el codigo de
// LinkCore (que ya apuntaba a 11435) se quedo hablando con un puerto
// muerto -- el procesador entero desconectado de sus propias piezas de
// calculo, en silencio, durante un tiempo indeterminado. Revertido todo
// el codigo real (backend.js, index.js, mcp server, etc.) a 11434, el
// puerto real y fiable de Ollama en cualquier reinicio, sin depender de
// ninguna variable de entorno externa.
//
// Este proxy ya NO puede ocupar 11434 (ahi vive Ollama real otra vez).
// Se cambia a un puerto propio: pierde la propiedad de "transparente,
// nadie necesita saber que existe" -- ese diseño era justo la parte
// fragil que acaba de romperse. Se prioriza que funcione de verdad
// sobre que sea invisible.

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { smartQuery } from './src/backend.js';

var OLLAMA_REAL = 'http://localhost:11434';
var PROXY_PORT = 11436;

var app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/api/chat', async function (req, res) {
  try {
    var body = req.body || {};
    var messages = body.messages || [];
    var lastUserMsg = messages.slice().reverse().find(function (m) { return m.role === 'user'; });
    var query = lastUserMsg ? lastUserMsg.content : null;

    // El streaming no pasa por smartQuery() todavia (devuelve el texto
    // completo de una vez, no token a token) -- se reenvia directo a
    // Ollama real sin acelerar, en vez de fingir un streaming que no
    // hace. Igual para peticiones sin un mensaje de usuario reconocible.
    if (!query || body.stream !== false) {
      var passthrough = await fetch(OLLAMA_REAL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var passData = await passthrough.json().catch(function () { return null; });
      if (passData) return res.status(passthrough.status).json(passData);
      return res.status(passthrough.status).end();
    }

    console.log('[LinkCore Proxy] "' + query.slice(0, 60) + '" -> smartQuery()');
    var result = await smartQuery(query, null, {});

    res.json({
      model: body.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: result.response },
      done: true,
      linkcore_accelerated: !!result.fromCache,
      linkcore_judge_reason: result.judgeReason,
    });
  } catch (e) {
    console.error('[LinkCore Proxy] error:', e.message);
    res.status(502).json({ error: 'linkcore_proxy_error: ' + e.message });
  }
});

// Todo lo demás (streaming, /api/tags, /api/embeddings, /api/ps, /api/pull...)
// pasa directo sin tocar.
app.use('/', createProxyMiddleware({ target: OLLAMA_REAL, changeOrigin: true }));

app.listen(PROXY_PORT, function () {
  console.log('[LinkCore Proxy] activo en puerto ' + PROXY_PORT + ' -> smartQuery() -> ' + OLLAMA_REAL + ' (apuntar clientes aqui explicitamente, ya no es transparente)');
});
