// ═══════════════════════════════════════════════════════════════
// CATALOGO FUNDACIONAL DE LINKCORE
//
// Base: https://github.com/Hannibal046/Awesome-LLM
// Fuente de verdad para la intermediacion de modelos open-source.
//
// Cada entrada representa un modelo que puede ejecutarse via Ollama
// (local) o via HuggingFace Inference API (remoto). El sistema de
// intermediacion (selectDiverseOllama) elige el mejor candidato
// segun: categoria de la tarea, familias excluidas (para diversidad
// en ensemble), y tier.
//
// hfId: ID del repo en HuggingFace. Se usa cuando el modelo NO
//       esta instalado en Ollama para ejecutarlo remotamente.
//       Si es null, solo funciona localmente.
//
// Tier meanings:
//   tiny  — <=500MB, respuesta ~1-5s en CPU
//   small — <=2GB, respuesta ~5-30s en CPU
//   medium — <=7GB, respuesta ~30-120s en CPU
//   large — >7GB, requiere GPU para ser pratico
// ═══════════════════════════════════════════════════════════════

import os from 'node:os';
import { getLearnedBias } from './learning-loop.js';

// Bug real, encontrado en vivo (2026-08-10): la exclusion de tamano ya
// aplicada en selectDiverseOllama()/routeQuery() (smart-router.js) confiaba
// en `tier === 'large'` para descartar candidatos que no caben en RAM --
// pero el propio catalogo tiene 7 entradas puestas a mano con el tier
// EQUIVOCADO (medium en vez de large), la mas grave `gemma4:latest`
// (9.6GB, YA INSTALADO de verdad en esta maquina), que sigue superando
// incluso el techo de "medium" que este mismo archivo documenta arriba
// (<=7GB). Confiar en una etiqueta escrita a mano, quando ya hay un
// numero real (`sizeMB`) y un numero real de la maquina (`os.totalmem()`),
// es fragil por diseño -- basta que una entrada nueva se cataloge mal
// (como estas 7) para reabrir el mismo cuelgue de minutos que ya se
// demostro en vivo (3m21s) para un modelo que sí llevaba el tier correcto.
// Se calcula un techo real a partir de la RAM total de ESTA instalacion
// (no un numero fijo -- LinkCore se instala en maquinas distintas, cada
// una con su propia RAM), con margen de seguridad: el sistema operativo,
// Node y el propio Ollama ya consumen una parte fija solo por existir
// (medido en vivo en esta maquina: 5.83GB totales, 0,49GB libres en
// reposo -- casi todo el resto ya esta ocupado antes de cargar ningun
// modelo). El 60% del total deja margen real sin ser tan conservador que
// excluya los modelos 'medium' que SI funcionan hoy (llama3.1:8b, 4.9GB,
// ~84% del total, ya usado con exito).
export var MAX_SAFE_MODEL_SIZE_MB = Math.floor((os.totalmem() / (1024 * 1024)) * 0.6);

export var OLLAMA_MODELS = [
  // ── HuggingFace / SmolLM ──────────────────────────────────
  { id: 'smollm2:135m', family: 'smollm2', lab: 'HuggingFace', arch: 'smollm2', categories: ['general', 'text', 'code'], tier: 'tiny', installed: true, params: '135M', sizeMB: 271, hfId: 'HuggingFaceTB/SmolLM2-135M-Instruct' },
  { id: 'smollm2:360m', family: 'smollm2', lab: 'HuggingFace', arch: 'smollm2', categories: ['general', 'text', 'code'], tier: 'tiny', installed: true, params: '360M', sizeMB: 726, hfId: 'HuggingFaceTB/SmolLM2-360M-Instruct' },
  { id: 'smollm2:1.7b', family: 'smollm2', lab: 'HuggingFace', arch: 'smollm2', categories: ['general', 'text', 'code'], tier: 'small', installed: false, params: '1.7B', sizeMB: 1800, hfId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct' },

  // ── Meta / Llama ──────────────────────────────────────────
  // Cambiado de 'llama3.2:1b' (Q8_0, 1.3GB) a esta variante Q4_K_M
  // (2026-08-11): la instalada por defecto usaba el doble de precision de
  // la que el resto del catalogo (todo Q4_K_M) necesita. Comparado en vivo,
  // misma pregunta, mismas condiciones: 14.64s (Q8_0) vs 9.22s (Q4_K_M) --
  // 37% mas rapido real, no teorico. De paso baja el tamano en RAM (807MB
  // vs 1321MB), lo que ayuda directamente al problema de contencion de
  // memoria ya documentado esta noche (varios modelos cargados a la vez
  // compitiendo por los 5.8GB totales de esta maquina).
  { id: 'llama3.2:1b-instruct-q4_K_M', family: 'llama', lab: 'Meta', arch: 'llama', categories: ['general', 'text'], tier: 'small', installed: true, params: '1.2B', sizeMB: 807, hfId: 'meta-llama/Llama-3.2-1B-Instruct' },
  { id: 'llama3.2:3b', family: 'llama', lab: 'Meta', arch: 'llama', categories: ['general', 'reasoning', 'text', 'code'], tier: 'small', installed: true, params: '3.2B', sizeMB: 2019, hfId: 'meta-llama/Llama-3.2-3B-Instruct' },
  { id: 'llama3.2:latest', family: 'llama', lab: 'Meta', arch: 'llama', categories: ['general', 'reasoning', 'text', 'code'], tier: 'small', installed: true, params: '3.2B', sizeMB: 2019, hfId: 'meta-llama/Llama-3.2-3B-Instruct' },
  { id: 'llama3.2:11b', family: 'llama', lab: 'Meta', arch: 'llama', categories: ['general', 'reasoning', 'text', 'code', 'vision'], tier: 'medium', installed: false, params: '11B', sizeMB: 6800, hfId: 'meta-llama/Llama-3.2-11B-Vision-Instruct' },
  { id: 'llama3.2:90b', family: 'llama', lab: 'Meta', arch: 'llama', categories: ['general', 'reasoning', 'text', 'code', 'vision'], tier: 'large', installed: false, params: '90B', sizeMB: 55000, hfId: 'meta-llama/Llama-3.2-90B-Vision-Instruct' },
  // MEDIDO EN VIVO, RESULTADO DEFINITIVO (2026-08-12): este modelo NO es
  // usable en esta maquina, y el dato cierra el debate de "saltar de 3B a 8B
  // por software" que se planteo varias veces esta sesion.
  //
  // Prueba real: 8.0B parametros, Q4_K_M, 4693MB (confirmado via /api/tags,
  // ya cuantizado agresivamente -- no son los 16GB de FP16 que se suponian).
  // Con desalojo previo de todos los demas modelos (295MB libres) se le pidio
  // generar 120 tokens con 900s de margen. Resultado: CARGO de verdad (visto
  // residente en /api/ps con 5318MB, el 91% de los 5829MB fisicos, gracias al
  // mmap de llama.cpp) pero agoto los 900 SEGUNDOS sin devolver ni un token.
  //
  // Causa: el mmap consigue que ARRANQUE sin caber en RAM, paginando pesos
  // desde el SSD -- pero entonces cada token necesita leer disco, y el coste
  // por token se vuelve inviable. mmap resuelve "cargar", no "ejecutar".
  //
  // Conclusion: MAX_SAFE_MODEL_SIZE_MB (60% de la RAM fisica = 3497MB aqui)
  // hace bien excluyendolo. No es una limitacion conservadora de mas: es la
  // frontera real entre un modelo que responde y uno que se cuelga 15
  // minutos. Se deja installed:true (esta descargado de verdad) pero el
  // filtro de tamaño lo mantiene fuera de la seleccion automatica. En una
  // maquina con 16GB+ entraria solo, sin cambiar codigo.
  { id: 'llama3.1:8b', family: 'llama', lab: 'Meta', arch: 'llama', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: true, params: '8B', sizeMB: 4920, hfId: 'meta-llama/Llama-3.1-8B-Instruct' },

  // ── Alibaba / Qwen ────────────────────────────────────────
  { id: 'qwen2.5:0.5b', family: 'qwen', lab: 'Alibaba', arch: 'qwen', categories: ['general', 'text'], tier: 'small', installed: true, params: '0.5B', sizeMB: 397, hfId: 'Qwen/Qwen2.5-0.5B-Instruct' },
  { id: 'qwen2.5:1.5b', family: 'qwen', lab: 'Alibaba', arch: 'qwen', categories: ['general', 'reasoning', 'text', 'code'], tier: 'small', installed: true, params: '1.5B', sizeMB: 986, hfId: 'Qwen/Qwen2.5-1.5B-Instruct' },
  // Probado en vivo (2026-08-10): descarga y ejecuta bien (1m11s, sin
  // timeout), pero se deja installed:false a proposito -- no es un
  // problema de rendimiento, es de calidad, igual que deepseek-r1:1.5b
  // mas arriba. Dos fallos reales encontrados con el mismo caso de
  // interes compuesto de siempre: (1) responde en formato LaTeX
  // (`\[ \text{...} \]`), que este sistema no renderiza -- saldria como
  // texto crudo sin sentido; (2) error matematico real: para el
  // Proyecto A calculo sobre los 12000 completos y luego dividio el
  // resultado entre 2 (llega al numero correcto por casualidad, porque
  // el interes simple es lineal), pero para el Proyecto B (compuesto,
  // NO lineal) uso los 12000 completos SIN dividir -- duplico el
  // resultado real (23858,71 en vez de ~15829,35, error del 50%). Si se
  // retoma, hay que resolver el formato LaTeX antes de evaluar calidad.
  { id: 'qwen2.5:3b', family: 'qwen', lab: 'Alibaba', arch: 'qwen', categories: ['general', 'reasoning', 'text', 'code'], tier: 'small', installed: false, params: '3B', sizeMB: 2000, hfId: 'Qwen/Qwen2.5-3B-Instruct' },
  { id: 'qwen2.5:14b', family: 'qwen', lab: 'Alibaba', arch: 'qwen', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '14B', sizeMB: 9000, hfId: 'Qwen/Qwen2.5-14B-Instruct' },
  { id: 'qwen2.5:32b', family: 'qwen', lab: 'Alibaba', arch: 'qwen', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '32B', sizeMB: 20000, hfId: 'Qwen/Qwen2.5-32B-Instruct' },
  { id: 'qwen2.5:72b', family: 'qwen', lab: 'Alibaba', arch: 'qwen', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '72B', sizeMB: 45000, hfId: 'Qwen/Qwen2.5-72B-Instruct' },
  // Bug real, encontrado en vivo (2026-08-05): `ollama list` real muestra
  // `qwen2.5-coder:1.5b-base` (un modelo BASE, sin ajuste de instrucciones
  // -- no sirve para chat, mismo problema ya documentado en STATUS.md con
  // codellama/CodeLlama-7b-hf), no `qwen2.5-coder:1.5b` (instruct). El
  // catalogo decia installed:true y cada seleccion fallaba con "model not
  // found", gastando un intento del ensemble en cada ronda. installed:false
  // hasta que se instale de verdad la variante instruct.
  { id: 'qwen2.5-coder:1.5b', family: 'qwen-coder', lab: 'Alibaba', arch: 'qwen', categories: ['code', 'text'], tier: 'small', installed: false, params: '1.5B', sizeMB: 986, hfId: 'Qwen/Qwen2.5-Coder-1.5B-Instruct' },
  { id: 'qwen2.5-coder:7b', family: 'qwen-coder', lab: 'Alibaba', arch: 'qwen', categories: ['code', 'reasoning', 'text'], tier: 'medium', installed: true, params: '7B', sizeMB: 4683, hfId: 'Qwen/Qwen2.5-Coder-7B-Instruct' },
  // id corregido: `ollama list` real muestra `qwen2.5-coder:32b-instruct-q4_K_M`
  // (cuantizado, si es instruct), no `qwen2.5-coder:32b` a secas -- mismo
  // fallo "model not found" que el de 1.5b, encontrado en vivo (2026-08-05).
  { id: 'qwen2.5-coder:32b-instruct-q4_K_M', family: 'qwen-coder', lab: 'Alibaba', arch: 'qwen', categories: ['code', 'reasoning', 'text'], tier: 'large', installed: true, params: '32B', sizeMB: 19851, hfId: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
  // Dato corregido (2026-08-10), verificado con `ollama show qwen3.6:latest`
  // en vivo: NO es Qwen3-235B-A22B (params/hfId anteriores, puestos a mano
  // sin verificar) -- es un MoE real de 36B, arquitectura `qwen35moe`,
  // Q4_K_M, 23.9GB en disco. La conclusion practica no cambia (tier
  // 'large' sigue excluido de toda seleccion automatica: MoE ahorra
  // computo por token, no memoria -- los 36B de pesos hay que cargarlos
  // igual, y 23.9GB no cabe en 5.83GB de RAM total de esta maquina), pero
  // un catalogo con datos inventados no es algo presentable.
  // hfId a null a proposito: no se ha verificado el repo real de HuggingFace
  // para esta variante concreta (el anterior, Qwen/Qwen3-235B-A22B, era del
  // modelo equivocado). Sin impacto funcional -- este campo solo se lee
  // para modelos con installed:false (fallback remoto), y este es
  // installed:true, pero mejor null que un dato inventado sin comprobar.
  { id: 'qwen3.6:latest', family: 'qwen3', lab: 'Alibaba', arch: 'qwen3moe', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: true, params: '36B', sizeMB: 23938, hfId: null },

  // ── Google / Gemma ────────────────────────────────────────
  { id: 'gemma2:2b', family: 'gemma', lab: 'Google', arch: 'gemma', categories: ['general', 'text'], tier: 'small', installed: false, params: '2B', sizeMB: 1700, hfId: 'google/gemma-2-2b-it' },
  { id: 'gemma2:9b', family: 'gemma', lab: 'Google', arch: 'gemma', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '9B', sizeMB: 5500, hfId: 'google/gemma-2-9b-it' },
  { id: 'gemma2:27b', family: 'gemma', lab: 'Google', arch: 'gemma', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '27B', sizeMB: 17000, hfId: 'google/gemma-2-27b-it' },
  { id: 'gemma4:latest', family: 'gemma', lab: 'Google', arch: 'gemma4', categories: ['general', 'reasoning', 'text', 'code', 'vision'], tier: 'medium', installed: true, params: '8B', sizeMB: 9608, hfId: 'google/gemma-4-12b-it' },

  // ── Microsoft / Phi-3 ─────────────────────────────────────
  { id: 'phi3:mini', family: 'phi', lab: 'Microsoft', arch: 'phi', categories: ['general', 'reasoning', 'text', 'code'], tier: 'small', installed: false, params: '3.8B', sizeMB: 2200, hfId: 'microsoft/Phi-3-mini-4k-instruct' },
  { id: 'phi3:medium', family: 'phi', lab: 'Microsoft', arch: 'phi', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '7B', sizeMB: 4000, hfId: 'microsoft/Phi-3-medium-4k-instruct' },
  { id: 'phi3:14b', family: 'phi', lab: 'Microsoft', arch: 'phi', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '14B', sizeMB: 8000, hfId: 'microsoft/Phi-3.5-mini-instruct' },

  // ── Mistral AI ────────────────────────────────────────────
  { id: 'mistral:7b', family: 'mistral', lab: 'Mistral', arch: 'mistral', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '7B', sizeMB: 4100, hfId: 'mistralai/Mistral-7B-Instruct-v0.3' },
  { id: 'mixtral:8x7b', family: 'mixtral', lab: 'Mistral', arch: 'mixtral', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '46.7B', sizeMB: 26000, hfId: 'mistralai/Mixtral-8x7B-Instruct-v0.1' },
  { id: 'codestral:7b', family: 'codestral', lab: 'Mistral', arch: 'mistral', categories: ['code', 'text'], tier: 'medium', installed: false, params: '7B', sizeMB: 4100, hfId: 'mistralai/codestral-2405' },

  // ── DeepSeek ──────────────────────────────────────────────
  // Probado en vivo (2026-08-09): descarga y ejecuta bien en esta maquina
  // (19.5s, sin timeout, cabe en el tier 'small'). Se deja installed:false
  // a proposito -- no fue un problema de rendimiento, fue de calidad: a
  // "que es SQLite?" respondio que "SQLite significa Smalltext" y que usa
  // "el protocolo Smalltext" (inventado, ninguno de los dos existe), peor
  // que los modelos ya instalados. Ademas, al ser un modelo de razonamiento,
  // emite un bloque largo de <think>...</think> crudo que ningun punto del
  // pipeline (ensemble-v2.js, translation.js) sabe recortar -- se colaria
  // sin editar en "IAs consultadas". Si se retoma, hay que resolver el
  // recorte del bloque de pensamiento ANTES de evaluar la calidad real.
  { id: 'deepseek-r1:1.5b', family: 'deepseek', lab: 'DeepSeek', arch: 'deepseek', categories: ['general', 'reasoning', 'text', 'code'], tier: 'small', installed: false, params: '1.5B', sizeMB: 1100, hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B' },
  { id: 'deepseek-r1:7b', family: 'deepseek', lab: 'DeepSeek', arch: 'deepseek', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '7B', sizeMB: 4700, hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B' },
  { id: 'deepseek-r1:14b', family: 'deepseek', lab: 'DeepSeek', arch: 'deepseek', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '14B', sizeMB: 9000, hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B' },
  { id: 'deepseek-r1:32b', family: 'deepseek', lab: 'DeepSeek', arch: 'deepseek', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '32B', sizeMB: 20000, hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B' },
  { id: 'deepseek-r1:70b', family: 'deepseek', lab: 'DeepSeek', arch: 'deepseek', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '70B', sizeMB: 43000, hfId: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B' },
  { id: 'deepseek-coder:1.3b', family: 'deepseek-coder', lab: 'DeepSeek', arch: 'deepseek', categories: ['code', 'text'], tier: 'small', installed: false, params: '1.3B', sizeMB: 800, hfId: 'deepseek-ai/deepseek-coder-1.3b-instruct' },
  { id: 'deepseek-coder:6.7b', family: 'deepseek-coder', lab: 'DeepSeek', arch: 'deepseek', categories: ['code', 'reasoning', 'text'], tier: 'medium', installed: false, params: '6.7B', sizeMB: 3800, hfId: 'deepseek-ai/deepseek-coder-6.7b-instruct' },

  // ── 01-ai / Yi ────────────────────────────────────────────
  { id: 'yi:6b', family: 'yi', lab: '01-ai', arch: 'yi', categories: ['general', 'text'], tier: 'medium', installed: false, params: '6B', sizeMB: 3500, hfId: '01-ai/Yi-6B-Chat' },
  { id: 'yi:9b', family: 'yi', lab: '01-ai', arch: 'yi', categories: ['general', 'reasoning', 'text'], tier: 'medium', installed: false, params: '9B', sizeMB: 5500, hfId: '01-ai/Yi-1.5-9B-Chat-16K' },
  { id: 'yi:34b', family: 'yi', lab: '01-ai', arch: 'yi', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '34B', sizeMB: 21000, hfId: '01-ai/Yi-34B-Chat' },

  // ── Cohere / Command R ────────────────────────────────────
  { id: 'command-r:35b', family: 'command-r', lab: 'Cohere', arch: 'command-r', categories: ['general', 'reasoning', 'text'], tier: 'large', installed: false, params: '35B', sizeMB: 19000, hfId: 'CohereForAI/c4ai-command-r-v01' },

  // ── AllenAI / OLMo ────────────────────────────────────────
  { id: 'olmo:7b', family: 'olmo', lab: 'AllenAI', arch: 'olmo', categories: ['general', 'reasoning', 'text'], tier: 'medium', installed: false, params: '7B', sizeMB: 4000, hfId: 'allenai/OLMo-7B-Instruct' },

  // ── BigCode / StarCoder2 ──────────────────────────────────
  { id: 'starcoder2:3b', family: 'starcoder', lab: 'BigCode', arch: 'starcoder', categories: ['code', 'text'], tier: 'small', installed: false, params: '3B', sizeMB: 1800, hfId: 'bigcode/starcoder2-3b' },
  { id: 'starcoder2:7b', family: 'starcoder', lab: 'BigCode', arch: 'starcoder', categories: ['code', 'text'], tier: 'medium', installed: false, params: '7B', sizeMB: 4000, hfId: 'bigcode/starcoder2-7b' },
  { id: 'starcoder2:15b', family: 'starcoder', lab: 'BigCode', arch: 'starcoder', categories: ['code', 'text'], tier: 'medium', installed: false, params: '15B', sizeMB: 9000, hfId: 'bigcode/starcoder2-15b' },

  // ── Stability AI / StableLM ───────────────────────────────
  { id: 'stablelm:3b', family: 'stablelm', lab: 'Stability AI', arch: 'stablelm', categories: ['general', 'text', 'code'], tier: 'small', installed: false, params: '3B', sizeMB: 1900, hfId: 'stabilityai/stablelm-3b-4e1t' },
  { id: 'stablelm2:1.6b', family: 'stablelm', lab: 'Stability AI', arch: 'stablelm', categories: ['general', 'text'], tier: 'small', installed: false, params: '1.6B', sizeMB: 1000, hfId: 'stabilityai/stablelm-2-1_6b' },
  { id: 'stablelm2:12b', family: 'stablelm', lab: 'Stability AI', arch: 'stablelm', categories: ['general', 'reasoning', 'text'], tier: 'medium', installed: false, params: '12B', sizeMB: 7500, hfId: 'stabilityai/stablelm-2-12b-chat' },

  // ── EleutherAI / Pythia ───────────────────────────────────
  { id: 'pythia:1b', family: 'pythia', lab: 'EleutherAI', arch: 'pythia', categories: ['general', 'text'], tier: 'small', installed: false, params: '1B', sizeMB: 800, hfId: 'EleutherAI/pythia-1b' },
  { id: 'pythia:2.8b', family: 'pythia', lab: 'EleutherAI', arch: 'pythia', categories: ['general', 'text'], tier: 'small', installed: false, params: '2.8B', sizeMB: 1800, hfId: 'EleutherAI/pythia-2.8b' },

  // ── Apple / OpenELM ───────────────────────────────────────
  { id: 'openelm:1.1b', family: 'openelm', lab: 'Apple', arch: 'openelm', categories: ['general', 'text'], tier: 'small', installed: false, params: '1.1B', sizeMB: 700, hfId: 'apple/OpenELM-1_1B' },
  { id: 'openelm:3b', family: 'openelm', lab: 'Apple', arch: 'openelm', categories: ['general', 'text'], tier: 'small', installed: false, params: '3B', sizeMB: 1800, hfId: 'apple/OpenELM-3B' },

  // ── OpenBMB / MiniCPM ─────────────────────────────────────
  { id: 'minicpm:2b', family: 'minicpm', lab: 'OpenBMB', arch: 'minicpm', categories: ['general', 'text'], tier: 'small', installed: false, params: '2B', sizeMB: 1200, hfId: 'openbmb/MiniCPM-2B-sft-bf16' },

  // ── Shanghai AI Lab / InternLM ────────────────────────────
  { id: 'internlm2:1.8b', family: 'internlm', lab: 'Shanghai AI Lab', arch: 'internlm', categories: ['general', 'reasoning', 'text'], tier: 'small', installed: false, params: '1.8B', sizeMB: 1100, hfId: 'internlm/internlm2_5-1_8b-chat' },
  { id: 'internlm2:7b', family: 'internlm', lab: 'Shanghai AI Lab', arch: 'internlm', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '7B', sizeMB: 4000, hfId: 'internlm/internlm2_5-7b-chat' },
  { id: 'internlm2:20b', family: 'internlm', lab: 'Shanghai AI Lab', arch: 'internlm', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '20B', sizeMB: 12000, hfId: 'internlm/internlm2-chat-20b' },

  // ── RWKV Foundation ───────────────────────────────────────
  { id: 'rwkv:1b', family: 'rwkv', lab: 'RWKV Foundation', arch: 'rwkv', categories: ['general', 'text'], tier: 'small', installed: false, params: '1B', sizeMB: 800, hfId: 'BlinkDL/RWKV-L-1B5' },

  // ── NVIDIA / Nemotron ─────────────────────────────────────
  { id: 'nemotron:8b', family: 'nemotron', lab: 'NVIDIA', arch: 'nemotron', categories: ['general', 'reasoning', 'text', 'code'], tier: 'medium', installed: false, params: '8B', sizeMB: 5000, hfId: 'nvidia/Llama-3.1-Nemotron-8B-Instruct-HD' },

  // ── Moonshot AI / Kimi ────────────────────────────────────
  { id: 'kimi-k2:1t', family: 'kimi', lab: 'Moonshot AI', arch: 'kimi', categories: ['general', 'reasoning', 'text', 'code'], tier: 'large', installed: false, params: '1T', sizeMB: 600000, hfId: 'moonshotai/Kimi-K2-Instruct' },
  { id: 'kimi-k3:2.8t', family: 'kimi', lab: 'Moonshot AI', arch: 'kimi', categories: ['general', 'reasoning', 'text', 'code', 'vision'], tier: 'large', installed: false, params: '2.8T', sizeMB: 1800000, hfId: 'moonshotai/Kimi-K3-Instruct', isOrchestrator: true },

  // ── Embeddings ────────────────────────────────────────────
  { id: 'nomic-embed-text:latest', family: 'nomic', lab: 'Nomic', arch: 'nomic-bert', categories: ['embedding'], tier: 'tiny', installed: true, params: '137M', sizeMB: 274, hfId: 'nomic-ai/nomic-embed-text-v1.5' },
];

function effectiveFamily(m) {
  return m.distilledFrom || m.family;
}

export function selectDiverseOllama(category, size, excludeFamilies, opts) {
  opts = opts || {};
  var excluded = {};
  (excludeFamilies || []).forEach(function (f) { excluded[f] = true; });

  // Bug real, RAIZ del problema del dia (encontrado en vivo, 2026-08-05):
  // orchestrator.js le pasa aqui `workerCategory` -- el vocabulario del
  // Worker remoto (fast/general/code/writing/reasoning) -- pero
  // OLLAMA_MODELS usa un vocabulario DISTINTO (code/embedding/general/
  // reasoning/text/vision). 'writing' no existe en el catalogo Ollama, asi
  // que CUALQUIER paso de tipo texto/documento (el caso mas comun: "haz un
  // analisis de...") filtraba a CERO candidatos locales, siempre, sin
  // excepcion -- forzando a callOpenSourceEnsemble() a depender 100% de
  // Hugging Face (sin token valido, "unauthorized" en los 6 intentos) y
  // caer en cascada hasta el fallback de un solo modelo. Esto explica por
  // que el ensemble nunca aterrizaba en ningun test de hoy, con o sin las
  // otras correcciones (serie vs paralelo, tiers, timeouts). En vez de
  // perseguir cada vocabulario nuevo que un llamador pueda inventar, un
  // filtro de categoria que elimina a TODOS los candidatos no es una
  // exclusion valida -- es casi siempre un vocabulario que no coincide.
  // Se ignora el filtro en ese caso en vez de devolver una seleccion vacia.
  // 100% local de verdad (2026-08-09): antes esta funcion podia devolver
  // candidatos con installed:false -- el orden por installed en el sort de
  // mas abajo solo los EMPUJABA al final, no los excluia, asi que en
  // cuanto se agotaban las familias instaladas de una categoria/tier, el
  // hueco lo rellenaba un modelo no descargado, que el llamador (p.ej.
  // pickBestOpenSourceModel() en backend.js) enviaba a Hugging Face remoto
  // via callHFModel() -- un camino real hacia fuera desde callAI(), la
  // funcion mas usada de todo el sistema. Se filtra a installed:true salvo
  // que el llamador pida explicitamente lo contrario con opts.allowRemote.
  var allowRemote = opts.allowRemote === true;
  // Bug real, grave, encontrado en vivo (2026-08-12): MAX_SAFE_MODEL_SIZE_MB
  // se definia (linea 48, con el comentario explicando exactamente este
  // riesgo) pero nunca se usaba en este filtro -- exactamente el mismo
  // patron que preferCapability antes de conectarla. Consecuencia medida:
  // gemma4:latest (9608MB, etiquetado a mano como tier 'medium' cuando por
  // tamaño es 'large') salio elegido como "el mas capaz" para una tarea de
  // critica en ESTA maquina de 5.83GB -- mas grande que toda la RAM total.
  // El propio comentario de MAX_SAFE_MODEL_SIZE_MB ya lo decía: confiar en
  // una etiqueta de tier escrita a mano es fragil, hace falta el numero
  // real. Se aplica aqui, sobre sizeMB, como red de seguridad que no
  // depende de que cada entrada del catalogo tenga el tier correcto.
  var eligible = OLLAMA_MODELS.filter(function (m) {
    if (!allowRemote && !m.installed) return false;
    if (excluded[effectiveFamily(m)]) return false;
    if (category && m.categories.indexOf(category) === -1) return false;
    if (m.categories.indexOf('embedding') !== -1) return false;
    if ((m.sizeMB || 0) > MAX_SAFE_MODEL_SIZE_MB) return false;
    return true;
  });
  if (category && eligible.length === 0) {
    eligible = OLLAMA_MODELS.filter(function (m) {
      if (!allowRemote && !m.installed) return false;
      if ((m.sizeMB || 0) > MAX_SAFE_MODEL_SIZE_MB) return false;
      return !excluded[effectiveFamily(m)] && m.categories.indexOf('embedding') === -1;
    });
  }

  // Bug real, encontrado en vivo (2026-08-05): el orden por defecto
  // empezaba por 'tiny' (smollm2:135m/360m) -- exactamente los modelos
  // que hoy mismo, en callOllamaModel()/ensemble-v2.js, se confirmaron
  // como la fuente sistematica de alucinaciones de tema y ecos mutados
  // que ningun detector pilla siempre. Esta funcion es la que usa
  // callOpenSourceEnsemble() (backend.js) para elegir candidatos locales
  // -- con 'tiny' primero, el PRIMER intento de ensemble (el que deberia
  // funcionar mas a menudo, antes de degradar a nada) arrancaba con la
  // selección menos fiable del catalogo. 'small' primero por defecto,
  // igual que ya se aplico en el resto del pipeline.
  // Bug real, encontrado en vivo (2026-08-10) simulando la exclusion
  // progresiva de familias que crew.js acumula paso a paso (usedFamilies):
  // con solo 5-6 familias ya usadas -- alcanzable si sube el tope de pasos,
  // si un paso reintenta con mas de una familia, o simplemente con mas
  // diversidad de la tipica -- esta funcion devolvia qwen3.6:latest (235B,
  // 23.9GB) o qwen2.5-coder:32b (19.8GB) como candidato "instalado" mas.
  // Backend.js YA vivio esto en otro camino (el fallback final antes de
  // "IA offline") y lo documento en vivo: un modelo 'large' en frio, sin
  // GPU, tarda minutos SOLO en cargar pesos -- 3m21s medidos, en una
  // maquina con 5.8GB de RAM total (ni siquiera cabe: 19-24GB no entra en
  // 5.8GB, no es "lento", es imposible sin swapping masivo). Ese fix
  // (excluir 'large' del fallback) nunca se replico aqui, la funcion que
  // SI se usa en cada paso real de crew.js via pickBestOpenSourceModel().
  // Mismo criterio, aplicado donde faltaba: 'large' nunca es candidato
  // automatico en este hardware, ni siquiera como ultimo recurso.
  var tierOrder = ['small', 'medium', 'tiny'];
  if (opts.minTier === 'medium') {
    tierOrder = ['medium', 'small', 'tiny'];
  } else if (opts.allowTiny === false) {
    tierOrder = ['small', 'medium'];
  }

  var selected = [];
  var seenFamilies = {};

  for (var t = 0; t < tierOrder.length && (!size || selected.length < size); t++) {
    var tierModels = eligible.filter(function (m) { return m.tier === tierOrder[t]; });
    // Bug real, de fondo, encontrado en vivo (2026-08-12): este sort SOLO
    // miraba `installed` y luego sizeMB ASCENDENTE -- el modelo mas pequeño
    // del tier ganaba siempre, sin mirar su historial. LinkCore lleva
    // registrando el rendimiento real de cada modelo desde el principio
    // (learning-loop.js, 182 consultas acumuladas al encontrar esto) y
    // getLearnedBias() ya calculaba un score honesto por (modelo,
    // categoria) -- pero NADIE lo consultaba en la seleccion de modelos
    // Ollama: solo hf-intermediation.js lo usaba, y encima por familia, no
    // por modelo. Consecuencia medida en vivo con `linkcore ask` real: una
    // pregunta de comparacion se resolvio con llama3.2:1b-instruct-q4_K_M
    // (807MB, el mas pequeño del tier 'small') que tenia un 14.3% de exito
    // historico, en vez de llama3.2:latest (48.8%) -- y devolvio una
    // respuesta con datos inventados (GFLOPS de GPU para lenguajes de
    // programacion, y la misma afirmacion copiada para dos cosas
    // distintas). El procesador tenia el dato de que esa pieza falla el
    // 86% de las veces y la eligio igual.
    //
    // Se usa el sesgo aprendido como criterio PRINCIPAL y el tamaño como
    // desempate. Sin datos suficientes (< MIN_SAMPLES) getLearnedBias()
    // devuelve 0 para todos, asi que el orden queda EXACTAMENTE como antes
    // (mas pequeño primero) -- cero regresion para un catalogo sin
    // historial.
    // Bug real, de alto impacto, encontrado en vivo (2026-08-12):
    // backend.js#pickBestOpenSourceModel() lleva pasando
    // `preferCapability: true` (lineas 288 y 303) desde siempre -- pero
    // esta funcion NUNCA leia esa opcion. Era una intencion muerta: el
    // llamador pedia "prefiere el modelo mas capaz" y el selector seguia
    // ordenando del mas pequeño al mas grande, asi que el camino rapido
    // elegia SIEMPRE el modelo mas debil del tier. Medido con una consulta
    // real de comparacion tecnica: respondio qwen2.5:0.5b (397MB, el mas
    // pequeño del catalogo instalado) en vez de llama3.2:3b o
    // llama3.2:latest (2019MB), y produjo la alucinacion sistematica de
    // afirmar lo mismo de las dos cosas comparadas. Un procesador no manda
    // una operacion dificil a su unidad mas lenta: con preferCapability se
    // ordena por tamaño DESCENDENTE (dentro del mismo tier, mas grande =
    // mas capaz), manteniendo el sesgo aprendido como criterio principal.
    //
    // Segundo hallazgo, mas de fondo (2026-08-12): el sesgo aprendido esta
    // CIEGO A LA CALIDAD. getLearnedBias() pondera calidad al 40%, pero
    // backend.js#learningRecord() nunca pasa `quality` (solo ok/latencyMs/
    // tokens), asi que ese termino vale siempre 0.5 (neutro) y el sesgo
    // acaba midiendo "no fallo y fue rapido" -- que favorece precisamente
    // al modelo mas pequeño y debil. Medido: qwen2.5:0.5b (397MB, 27.3% de
    // exito real) puntua el maximo (0.15) en 'general'. Por eso, cuando el
    // llamador pide capacidad EXPLICITAMENTE, esa preferencia debe pesar
    // mas que un sesgo que no sabe medir si la respuesta era buena: el
    // termino de tamaño se escala para poder superar el tope del sesgo
    // (LEARNED_BIAS_CAP = 0.15). Sin preferCapability todo sigue igual que
    // antes (sesgo manda, tamaño solo desempata).
    // RESIDENCIA EN RAM = LOCALIDAD DE CACHE (2026-08-12). Un procesador
    // real nunca manda trabajo a un core frio si uno con la cache caliente
    // sirve igual. LinkCore ignoraba esto por completo: elegia sin mirar
    // que modelos estan YA cargados en RAM. En esta maquina (5.83GB, sin
    // GPU) la diferencia no es matiz: un modelo residente contesta en
    // segundos, uno frio tiene que leer sus pesos de disco -- minutos
    // medidos. Es literalmente un fallo de cache, y hasta ahora el
    // selector no lo veia.
    //
    // El bonus se pone por encima del tope del sesgo aprendido
    // (LEARNED_BIAS_CAP = 0.15) a proposito: entre dos modelos de calidad
    // parecida, el que ya esta caliente gana siempre. No es suficiente
    // para imponerse a preferCapability con una diferencia grande de
    // tamaño (ahi el termino de tamaño llega a ~0.2), que es lo correcto:
    // si de verdad hace falta una pieza mas capaz, se paga la carga.
    var loaded = getLoadedModelIds();
    var RESIDENCY_BONUS = 0.18;
    var preferBigger = opts.preferCapability === true;
    var SIZE_DIVISOR = preferBigger ? 10000 : 100000;
    tierModels.sort(function (a, b) {
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      var sizeTermA = (a.sizeMB || 0) / SIZE_DIVISOR;
      var sizeTermB = (b.sizeMB || 0) / SIZE_DIVISOR;
      var scoreA = getLearnedBias(a.id, category) + (preferBigger ? sizeTermA : -sizeTermA) + (loaded[a.id] ? RESIDENCY_BONUS : 0);
      var scoreB = getLearnedBias(b.id, category) + (preferBigger ? sizeTermB : -sizeTermB) + (loaded[b.id] ? RESIDENCY_BONUS : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return preferBigger
        ? (b.sizeMB || 0) - (a.sizeMB || 0)
        : (a.sizeMB || 0) - (b.sizeMB || 0);
    });
    for (var i = 0; i < tierModels.length && (!size || selected.length < size); i++) {
      var fam = effectiveFamily(tierModels[i]);
      if (seenFamilies[fam]) continue;
      seenFamilies[fam] = true;
      selected.push(tierModels[i]);
    }
  }

  return {
    ok: true,
    selected: selected,
    considered: OLLAMA_MODELS.length,
    eligible: eligible.length,
    families: Object.keys(seenFamilies),
  };
}

// ── ESTADO DE RESIDENCIA (que piezas tienen la "cache caliente") ──
// Ollama expone en /api/ps que modelos tiene cargados en RAM ahora mismo.
// selectDiverseOllama() es sincrona (la llaman muchos sitios sin await),
// asi que el estado se cachea aqui y se refresca desde intermediateOllama(),
// que si es async. TTL corto: la residencia cambia sola (Ollama descarga
// modelos por keep_alive), un dato viejo llevaria a elegir un modelo que
// ya no esta caliente.
var _loadedModelIds = {};
var _loadedAt = 0;
var LOADED_TTL_MS = 10000;

export function getLoadedModelIds() {
  return _loadedModelIds;
}

export async function refreshLoadedModelIds(force) {
  if (!force && Date.now() - _loadedAt < LOADED_TTL_MS) return _loadedModelIds;
  try {
    var res = await fetch('http://localhost:11434/api/ps', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return _loadedModelIds;
    var data = await res.json();
    var next = {};
    (data.models || []).forEach(function (m) {
      if (m && m.name) next[m.name] = true;
    });
    _loadedModelIds = next;
    _loadedAt = Date.now();
  } catch (e) {
    // Ollama caido o lento: se conserva el ultimo estado conocido y se
    // sigue. Nunca bloquea la seleccion por no poder leer /api/ps.
  }
  return _loadedModelIds;
}

// ── CONTROLADOR DE MEMORIA: DESALOJO BAJO PRESION ──
// Pieza que faltaba, identificada a partir de la especificacion del usuario
// ("gestion de memoria unificada: evitar el cuello de botella") y confirmada
// con datos reales (2026-08-12): callOllamaModel() pide keep_alive:'30m' en
// CADA llamada, asi que todo modelo que LinkCore ejecuta se queda media hora
// residente. Como la intermediacion elige piezas distintas segun la
// categoria (llama3.2:3b para razonamiento, qwen2.5:1.5b para codigo...),
// se ACUMULAN: medido en esta maquina, 337MB libres de 5829MB totales. No
// habia ninguna politica de desalojo -- LinkCore cargaba y dejaba que Ollama
// retuviera, sin coordinar. Es exactamente el cuello de botella de memoria
// que un procesador real resuelve con su controlador de memoria.
//
// Mecanismo de descarga verificado empiricamente antes de usarlo (no
// supuesto): POST /api/generate con keep_alive:0 sobre un modelo residente
// lo saca de RAM -- comprobado pasando de 1 modelo cargado a 0 en /api/ps.
//
// Politica deliberadamente conservadora:
//  - Si el modelo objetivo YA esta residente, no se toca nada (es justo el
//    acierto de cache que el bonus de residencia premia en la seleccion).
//  - Nunca se desaloja el modelo de embeddings: lo necesita la cache
//    semantica en cada consulta y es pequeño (274MB).
//  - Solo actua si la RAM libre real esta por debajo de lo que el objetivo
//    necesita; con memoria de sobra no se desaloja nada.
var EMBED_MARKER = 'embed';

// Comprobacion de RAM real, ANTES de intentar cargar un modelo -- factorizada
// de la logica que ya usaba evictForModel() (freeMB/needMB/margen), para
// poder consultarla desde otros caminos sin duplicar el calculo. Hallazgo
// real (2026-08-18): backend.js#tryPersistentInferenceFastPath nunca
// comprobaba esto antes de intentar fork()+cargar el modelo en node-llama-
// cpp -- bajo presion real de RAM, el intento fallaba con Vulkan
// ErrorOutOfDeviceMemory o un timeout de hasta 60s+ ANTES de caer a HTTP
// Ollama, malgastando ese tiempo entero en un intento condenado desde el
// principio (medido en vivo: llamadas de 100-165s dominadas por este
// patron, no por inferencia real). Esta funcion permite saltarse el
// intento por completo cuando ya se sabe que no va a caber.
export function hasSufficientRamFor(modelId, marginMB) {
  var target = OLLAMA_MODELS.find(function (m) { return m.id === modelId; });
  var needMB = (target && target.sizeMB) || 0;
  if (!needMB) return { ok: true, freeMB: null, needMB: 0 }; // tamaño desconocido: no bloquear por algo que no se puede medir
  var freeMB = Math.round(os.freemem() / 1024 / 1024);
  var margin = typeof marginMB === 'number' ? marginMB : 300;
  return { ok: freeMB >= needMB + margin, freeMB: freeMB, needMB: needMB };
}

export async function evictForModel(targetModelId) {
  var target = OLLAMA_MODELS.find(function (m) { return m.id === targetModelId; });
  var needMB = (target && target.sizeMB) || 0;
  if (!needMB) return { evicted: [], reason: 'tamaño del objetivo desconocido' };

  // Bug real, grave, confirmado en vivo (2026-08-14): MAX_SAFE_MODEL_SIZE_MB
  // solo se comprobaba dentro del filtro `eligible` de selectDiverseOllama()
  // -- cualquier otro camino que eligiera un modelo por su id directamente
  // (G-STACK, la decision de Kimi K3, ai-registry.js) llegaba aqui sin pasar
  // por ese filtro. Reproducido: gemma4:latest (9608MB, mas grande que toda
  // la RAM de esta maquina) llego a evictForModel(), que desalojo TODO lo
  // desalojable sin conseguir nunca los MB necesarios (imposible por
  // definicion), y la carga en Ollama se quedo colgada 475s hasta fallar. El
  // guardia vive ahora en la funcion que de verdad pide la memoria, no solo
  // en un selector que se puede rodear -- si needMB no cabe ni vaciando la
  // maquina entera, se rechaza al instante con un error honesto en vez de
  // intentar un desalojo que nunca puede bastar.
  if (needMB > MAX_SAFE_MODEL_SIZE_MB) {
    return {
      evicted: [],
      error: 'modelo_demasiado_grande',
      reason: targetModelId + ' necesita ' + needMB + 'MB, mas de lo que esta maquina puede dar sin colgarse (limite: ' + MAX_SAFE_MODEL_SIZE_MB + 'MB, 60% de ' + Math.round(os.totalmem() / 1024 / 1024) + 'MB totales). Ningun desalojo lo arregla.',
    };
  }

  await refreshLoadedModelIds(true);
  if (_loadedModelIds[targetModelId]) {
    return { evicted: [], reason: 'el objetivo ya esta residente (acierto de cache)' };
  }

  var freeMB = Math.round(os.freemem() / 1024 / 1024);
  // Margen real: el propio Ollama, Node y el SO necesitan aire por encima
  // del tamaño del modelo. 300MB medido como el minimo por debajo del cual
  // esta maquina empieza a paginar.
  if (freeMB >= needMB + 300) {
    return { evicted: [], reason: 'RAM suficiente (' + freeMB + 'MB libres, ' + needMB + 'MB necesarios)' };
  }

  var evicted = [];
  var residentes = Object.keys(_loadedModelIds);
  for (var i = 0; i < residentes.length; i++) {
    var id = residentes[i];
    if (id === targetModelId) continue;
    if (id.indexOf(EMBED_MARKER) !== -1) continue;
    try {
      await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: id, keep_alive: 0 }),
        signal: AbortSignal.timeout(10000),
      });
      evicted.push(id);
      delete _loadedModelIds[id];
    } catch (e) {
      // Un fallo al desalojar no debe impedir la consulta: se sigue y que
      // Ollama gestione la presion como pueda.
    }
  }

  return {
    evicted: evicted,
    reason: evicted.length
      ? 'desalojados ' + evicted.length + ' modelo(s) por presion de RAM (' + freeMB + 'MB libres, ' + needMB + 'MB necesarios)'
      : 'nada desalojable',
  };
}

export async function intermediateOllama(query, opts) {
  opts = opts || {};
  await refreshLoadedModelIds();
  var result = selectDiverseOllama(opts.category, opts.size, opts.excludeFamilies, opts);
  return {
    ok: true,
    category: opts.category || null,
    selected: result.selected,
    considered: result.considered,
    eligible: result.eligible,
    families: result.families,
    independent: result.families.length,
  };
}

export async function detectInstalledModels() {
  try {
    var res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: 'ollama_unreachable' };
    var data = await res.json();
    var installedNames = (data.models || []).map(function(m) { return m.name; });
    var detected = 0;
    // Bug real, critico para distribucion multiusuario, encontrado en vivo
    // (2026-08-07): esta funcion SOLO ponia installed=true cuando
    // encontraba el modelo -- nunca lo ponia a false para lo que NO
    // encontraba. El catalogo estatico trae 13 modelos marcados
    // installed:true de fabrica (los que hay en ESTA maquina, editados a
    // mano durante la sesion) -- para cualquier otro usuario que instale
    // LinkCore, esos 13 seguirian marcados como instalados aunque nunca
    // hayan tocado Ollama, porque nada los desmarcaba nunca. Ahora se
    // reinicia el catalogo entero a false antes de re-detectar, asi que
    // el resultado refleja SIEMPRE la maquina real donde corre, no la
    // maquina donde se desarrollo.
    for (var i = 0; i < OLLAMA_MODELS.length; i++) {
      OLLAMA_MODELS[i].installed = false;
    }
    for (var j = 0; j < OLLAMA_MODELS.length; j++) {
      var m = OLLAMA_MODELS[j];
      if (installedNames.indexOf(m.id) !== -1) {
        m.installed = true;
        detected++;
      }
    }
    return { ok: true, installed: installedNames, detected: detected, total: OLLAMA_MODELS.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
