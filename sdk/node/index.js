// ═══════════════════════════════════════════════════════════════
// LINKCORE NODE.JS SDK
//
// Como NVIDIA CUDA para AI models.
// Una línea para usar 50 modelos como si fueran uno.
//
// Usage:
//   import { LinkCore } from 'linkcore';
//   const lc = new LinkCore();
//   const res = await lc.ask("hazme un login con JWT");
//   console.log(res.text, res.model, res.latencyMs);
// ═══════════════════════════════════════════════════════════════

import net from 'node:net';
import readline from 'node:readline';

var DEFAULT_PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\linkcore'
  : '/tmp/linkcore.sock';

export class LinkCore {
  constructor(opts) {
    opts = opts || {};
    this.pipe = opts.pipe || DEFAULT_PIPE;
    this.timeout = opts.timeout || 120000;
    this.retries = opts.retries || 2;
    this._connected = false;
  }

  async ask(query, opts) {
    opts = opts || {};
    if (!query || !String(query).trim()) {
      throw new Error('query_required');
    }

    var lastError = null;
    for (var attempt = 0; attempt <= this.retries; attempt++) {
      try {
        var result = await this._send({
          type: 'ask',
          query: String(query).trim(),
        }, opts.onProgress);

        if (result.type === 'error') {
          throw new Error(result.error);
        }

        return {
          text: result.data.response || result.data.text || '',
          model: result.data.model || null,
          provider: result.data.provider || null,
          latencyMs: result.data.latencyMs || 0,
          sector: result.data.sector || null,
          tools: result.data.tools || [],
          ensemble: result.data.ensemble || null,
          trace: result.data.trace || [],
        };
      } catch (e) {
        lastError = e;
        if (attempt < this.retries) {
          await this._sleep(1000 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  async status() {
    var result = await this._send({ type: 'status' });
    if (result.type === 'error') throw new Error(result.error);
    return result.data;
  }

  async chip() {
    var result = await this._send({ type: 'chip' });
    if (result.type === 'error') throw new Error(result.error);
    return result.data;
  }

  async health() {
    try {
      var status = await this.status();
      return {
        ok: true,
        service: status.service,
        version: status.version,
        uptime: status.uptimeSec,
        ollama: status.ollama ? status.ollama.corriendo : false,
        chip: status.chip || null,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async models() {
    var chip = await this.chip();
    var models = [];
    if (chip && chip.health && chip.health.ollama && chip.health.ollama.models) {
      models = chip.health.ollama.models;
    }
    return {
      installed: models,
      stats: chip ? chip.modelStats : {},
      learning: chip ? chip.learning : null,
    };
  }

  _send(request, onProgress) {
    return new Promise((resolve, reject) => {
      var socket = net.connect(this.pipe);
      var settled = false;
      var timer = null;

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error('timeout'));
        }
      }, this.timeout);

      socket.on('connect', () => {
        socket.write(JSON.stringify(request) + '\n');
      });

      socket.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (e.code === 'ENOENT') {
          reject(new Error('linkcore_not_running'));
        } else {
          reject(e);
        }
      });

      var rl = readline.createInterface({ input: socket });
      rl.on('line', (line) => {
        var msg;
        try { msg = JSON.parse(line); } catch (e) { return; }

        if (msg.type === 'progress' && onProgress) {
          onProgress(msg.event);
          return;
        }

        if (msg.type === 'done' || msg.type === 'status' || msg.type === 'chip' || msg.type === 'error') {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            socket.end();
            resolve(msg);
          }
        }
      });
    });
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export default LinkCore;
