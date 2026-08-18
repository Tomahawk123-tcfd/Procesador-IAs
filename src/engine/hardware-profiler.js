// ═══════════════════════════════════════════════════════════════
// LINKCORE vNPU — HARDWARE PROFILER & RESOURCE MANAGER
// Detects system capabilities (CPU, RAM) y calcula presupuestos
// dinamicos de tokens, limites de contexto y tier de hardware.
//
// GPU real (2026-08-16): getHardwareProfile() es solo CPU/RAM -- su
// unico consumidor historico, getVNPUStats() (mas abajo en
// vnpu-core.js), no tiene NINGUN caller real en todo el repo (verificado
// via grep repo-wide), asi que la falta de deteccion de GPU ahi nunca
// fue un bug en vivo. detectGpu() es la funcion nueva y real: usa
// node-llama-cpp#getLlama() (.gpu / .getGpuDeviceNames() /
// .getVramState(), API verificada en node_modules/node-llama-cpp/dist/
// bindings/Llama.d.ts, no adivinada) para reportar la GPU que Ollama
// puede estar ignorando -- exactamente lo que se descubrio esta noche
// (iGPU AMD via Vulkan, descartada por Ollama sin OLLAMA_IGPU_ENABLE=1).
// Conectada al camino real: linkcore benchmark --vnpu.
// ═══════════════════════════════════════════════════════════════

import os from 'node:os';

export function getHardwareProfile() {
  var totalRamMB = Math.round(os.totalmem() / (1024 * 1024));
  var freeRamMB = Math.round(os.freemem() / (1024 * 1024));
  var cpuCores = os.cpus().length;
  var cpuModel = os.cpus()[0]?.model || 'Generic CPU';

  // Determinación de Tier de Hardware Virtual
  var tier = 'entry';
  if (totalRamMB >= 32768 && cpuCores >= 16) {
    tier = 'ultra';
  } else if (totalRamMB >= 16384 && cpuCores >= 8) {
    tier = 'pro';
  } else if (totalRamMB >= 8192) {
    tier = 'standard';
  }

  // Presupuesto dinámico de tokens según hardware
  var recommendedMaxTokens = tier === 'ultra' ? 2000 : tier === 'pro' ? 1200 : tier === 'standard' ? 800 : 500;
  var recommendedContextChars = tier === 'ultra' ? 12000 : tier === 'pro' ? 8000 : tier === 'standard' ? 5000 : 3000;

  return {
    tier: tier,
    totalRamMB: totalRamMB,
    freeRamMB: freeRamMB,
    cpuCores: cpuCores,
    cpuModel: cpuModel,
    platform: process.platform,
    arch: process.arch,
    recommendedMaxTokens: recommendedMaxTokens,
    recommendedContextChars: recommendedContextChars,
  };
}

export async function detectGpu() {
  try {
    var { getLlama } = await import('node-llama-cpp');
    var llama = await getLlama();
    var vram = await llama.getVramState();
    var deviceNames = await llama.getGpuDeviceNames();
    return {
      available: !!llama.gpu,
      type: llama.gpu || 'none',
      deviceNames: deviceNames,
      vramTotalMB: Math.round(vram.total / (1024 * 1024)),
      vramFreeMB: Math.round(vram.free / (1024 * 1024)),
      vramUsedMB: Math.round(vram.used / (1024 * 1024)),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

export async function inspectOllamaHardware() {
  try {
    var res = await fetch('http://localhost:11434/api/ps');
    if (!res.ok) return { online: false, loadedModels: [] };
    var data = await res.json();
    var loaded = (data.models || []).map(function (m) {
      return {
        name: m.name,
        sizeMB: Math.round((m.size || 0) / (1024 * 1024)),
        vramSizeMB: Math.round((m.size_vram || 0) / (1024 * 1024)),
        digest: m.digest ? m.digest.slice(0, 12) : null,
      };
    });
    return { online: true, loadedModels: loaded };
  } catch (e) {
    return { online: false, loadedModels: [] };
  }
}
