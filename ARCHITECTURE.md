# ═══════════════════════════════════════════════════════════════
# LINKCORE — Neural Inference Accelerator
# Unique Architecture — v2.0.0
# ═══════════════════════════════════════════════════════════════

## QUÉ ES LINKCORE

LinkCore es un **acelerador de inferencia distribuida**. No es un modelo de IA.
No es un framework. Es la capa que hace que MÚLTIPLES modelos de IA trabajen
juntos, aprendan juntos, y sean más rápidos juntos.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                    LINKCORE v2.0                                │
│           Neural Inference Accelerator                          │
│                                                                 │
│    ┌─────────────────────────────────────────────────────┐     │
│    │                                                     │     │
│    │              ┌─────────────────────┐                │     │
│    │              │                     │                │     │
│    │              │   NEURAL DECISION   │                │     │
│    │              │       ENGINE        │                │     │
│    │              │                     │                │     │
│    │              │  "Qué modelo usar   │                │     │
│    │              │   y cuándo"         │                │     │
│    │              │                     │                │     │
│    │              └──────────┬──────────┘                │     │
│    │                         │                           │     │
│    │                         │ decides                   │     │
│    │                         ▼                           │     │
│    │  ┌─────────────────────────────────────────────┐   │     │
│    │  │                                             │   │     │
│    │  │           INFERENCE FABRIC                  │   │     │
│    │  │                                             │   │     │
│    │  │  "Ejecuta modelos en paralelo y encuentra   │   │     │
│    │  │   consenso matemático"                      │   │     │
│    │  │                                             │   │     │
│    │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │   │     │
│    │  │  │ Model A │ │ Model B │ │ Model C │       │   │     │
│    │  │  │  135M   │ │  0.5B   │ │  1.5B   │       │   │     │
│    │  │  └────┬────┘ └────┬────┘ └────┬────┘       │   │     │
│    │  │       └───────────┼───────────┘             │   │     │
│    │  │                   ▼                         │   │     │
│    │  │         ┌─────────────────┐                 │   │     │
│    │  │         │    CONSENSUS    │                 │   │     │
│    │  │         │    ENGINE       │                 │   │     │
│    │  │         │                 │                 │   │     │
│    │  │         │  similarity: 73%│                 │   │     │
│    │  │         │  confidence: H  │                 │   │     │
│    │  │         └─────────────────┘                 │   │     │
│    │  │                                             │   │     │
│    │  └─────────────────────────────────────────────┘   │     │
│    │                         │                           │     │
│    │                         │ learns from               │     │
│    │                         ▼                           │     │
│    │  ┌─────────────────────────────────────────────┐   │     │
│    │  │                                             │   │     │
│    │  │            LEARNING LAYER                   │   │     │
│    │  │                                             │   │     │
│    │  │  "Recuerda qué funcionó y mejora            │   │     │
│    │  │   la próxima vez"                           │   │     │
│    │  │                                             │   │     │
│    │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │   │     │
│    │  │  │  MCTS   │ │Strategy │ │   EDR   │       │   │     │
│    │  │  │  Tree   │ │ Memory  │ │  Log    │       │   │     │
│    │  │  └─────────┘ └─────────┘ └─────────┘       │   │     │
│    │  │                                             │   │     │
│    │  └─────────────────────────────────────────────┘   │     │
│    │                                                     │     │
│    └─────────────────────────────────────────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## COMPONENTES

### 1. NEURAL DECISION ENGINE
**Qué hace:** Decide qué modelo ejecutar y cómo

```
┌─────────────────────────────────────────────┐
│           NEURAL DECISION ENGINE            │
│                                             │
│  Input: "cómo hacer una web moderna"        │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │ 1. CATEGORIZE                       │   │
│  │    → code                           │   │
│  └─────────────────────────────────────┘   │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐   │
│  │ 2. SELECT STRATEGY                  │   │
│  │    → ensemble (3 modelos)           │   │
│  └─────────────────────────────────────┘   │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐   │
│  │ 3. PICK MODELS                      │   │
│  │    → smollm2:135m (fastest)         │   │
│  │    → qwen2.5:0.5b (balanced)       │   │
│  │    → qwen2.5:1.5b (quality)        │   │
│  └─────────────────────────────────────┘   │
│                    │                        │
│                    ▼                        │
│  Output: Plan with 3 models + timeout      │
│                                             │
└─────────────────────────────────────────────┘
```

**Algoritmos:**
- **MCTS:** Aprende qué modelos funcionan para cada categoría
- **Strategy Router:** Selecciona turbo/balanced/deep/ensemble/cascade
- **Query Categorizer:** Clasifica en code/writing/reasoning/research/creative

---

### 2. INFERENCE FABRIC
**Qué hace:** Ejecuta modelos en paralelo y encuentra consenso

```
┌─────────────────────────────────────────────────────────────┐
│                    INFERENCE FABRIC                         │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ROUND 1: PARALLEL EXECUTION                        │   │
│  │                                                     │   │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐          │   │
│  │  │smollm2  │   │qwen2.5  │   │qwen2.5  │          │   │
│  │  │135M     │   │0.5B     │   │1.5B     │          │   │
│  │  │         │   │         │   │         │          │   │
│  │  │ query ──┤   │ query ──┤   │ query ──┤          │   │
│  │  │  ↓      │   │  ↓      │   │  ↓      │          │   │
│  │  │answer A │   │answer B │   │answer C │          │   │
│  │  └────┬────┘   └────┬────┘   └────┬────┘          │   │
│  │       │             │             │                │   │
│  │       └─────────────┼─────────────┘                │   │
│  │                     ▼                              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ROUND 2: COMMUNICATION                             │   │
│  │                                                     │   │
│  │  A ←→ B ←→ C                                        │   │
│  │                                                     │   │
│  │  "Hey B, I said X. What did you say?"               │   │
│  │  "I said Y, but you might be right about X"         │   │
│  │                                                     │   │
│  │  Result: Revised answers with cross-model input     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  CONSENSUS: MATHEMATICAL AGREEMENT                  │   │
│  │                                                     │   │
│  │  similarity(A,B) = 0.72                             │   │
│  │  similarity(A,C) = 0.68                             │   │
│  │  similarity(B,C) = 0.81                             │   │
│  │                                                     │   │
│  │  average = 73% → HIGH CONFIDENCE                    │   │
│  │                                                     │   │
│  │  If contradiction detected:                         │   │
│  │  → Flag for human review                            │   │
│  │  → Use majority vote                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Métricas:**
- **Parallelism:** 3-5 modelos simultáneos
- **Round 1:** ≤10s por modelo
- **Round 2:** ≤5s total
- **Consensus:** 70%+ = high confidence

---

### 3. LEARNING LAYER
**Qué hace:** Aprende de cada interacción y mejora

```
┌─────────────────────────────────────────────────────────────┐
│                     LEARNING LAYER                          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MCTS TREE                                          │   │
│  │                                                     │   │
│  │  "Qué modelos funcionan mejor para cada cosa"       │   │
│  │                                                     │   │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐          │   │
│  │  │  code   │   │writing  │   │reasoning│          │   │
│  │  └────┬────┘   └────┬────┘   └────┬────┘          │   │
│  │       │             │             │                │   │
│  │       ▼             ▼             ▼                │   │
│  │  smollm2:0.87  qwen2.5:0.72  llama3:0.65          │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  STRATEGY MEMORY                                    │   │
│  │                                                     │   │
│  │  "Qué estrategias funcionan mejor"                  │   │
│  │                                                     │   │
│  │  turbo:    95% success, 6.2s avg                    │   │
│  │  ensemble: 88% success, 22.1s avg                   │   │
│  │  cascade:  92% success, 45.3s avg                   │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ENTERPRISE DECISION RECORD (EDR)                   │   │
│  │                                                     │   │
│  │  "Trazabilidad completa de cada decisión"           │   │
│  │                                                     │   │
│  │  edr_1785598699179_8znx                             │   │
│  │  ├─ query: "cómo hacer una web"                     │   │
│  │  ├─ models: [smollm2, qwen2.5, qwen2.5]            │   │
│  │  ├─ strategy: ensemble                              │   │
│  │  ├─ consensus: 73%                                  │   │
│  │  ├─ latency: 22.1s                                  │   │
│  │  ├─ quality: 92%                                    │   │
│  │  └─ timestamp: 2026-08-01T17:44:59                  │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Capacidades:**
- **MCTS Tree:** 10,000 nodos máximo
- **Strategy Memory:** 5 estrategias × 10 categorías
- **EDR:** 1,000 decisiones con trazabilidad completa
- **Pattern Detection:** Automático

---

### 4. MODEL MESH
**Qué hace:** Conecta con múltiples proveedores de IA

```
┌─────────────────────────────────────────────────────────────┐
│                       MODEL MESH                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  LOCAL (Ollama)                                     │   │
│  │                                                     │   │
│  │  smollm2:135m    271MB    ≤3s                       │   │
│  │  smollm2:360m    726MB    ≤5s                       │   │
│  │  llama3.2:1b     1.3GB    ≤8s                       │   │
│  │  llama3.2:3b     2.0GB    ≤12s                      │   │
│  │  qwen2.5:0.5b    395MB    ≤4s                       │   │
│  │  qwen2.5:1.5b    986MB    ≤6s                       │   │
│  │  qwen2.5-coder   4.6GB    ≤15s                      │   │
│  │  gemma4:latest   9.6GB    ≤20s                      │   │
│  │                                                     │   │
│  │  14 modelos instalados | $0 | ≤20s                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  SERVERLESS (HuggingFace)                           │   │
│  │                                                     │   │
│  │  45+ modelos | $0.001/M tokens | ≤15s               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  CLOUD (APIs)                                       │   │
│  │                                                     │   │
│  │  OpenAI    $0.15-5/M tokens   ≤20s                  │   │
│  │  Gemini    $0.075/M tokens    ≤20s                  │   │
│  │  Groq      $0.59/M tokens     ≤5s                   │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  TOTAL: 60+ modelos | Auto-detect | Circuit breaker        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Estado real (2026-08-09), no solo el diagrama de arriba:** hoy LinkCore es
100% local (Ollama) — decisión explícita del usuario (2026-08-06), ver
`STATUS.md`/`README.md` para el registro completo. Las cajas SERVERLESS
(HuggingFace) y CLOUD (OpenAI/Gemini/Groq) de este diagrama describen la
arquitectura del Model Mesh tal como está diseñada para soportar múltiples
proveedores, no proveedores conectados ahora mismo — ninguna clave de API
remota está configurada en esta instalación. Se probó un ensemble híbrido
real con Groq (verificado funcionando) y se revirtió a petición explícita;
el código correspondiente ya no existe en `ensemble-v2.js` (se borró, no
quedó apagado tras un flag).

---

### 5. IO LAYER
**Qué hace:** Interfaz con el mundo exterior

```
┌─────────────────────────────────────────────────────────────┐
│                       IO LAYER                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  NAMED PIPE (Local IPC)                             │   │
│  │                                                     │   │
│  │  \\\\.\\pipe\\linkcore                               │   │
│  │                                                     │   │
│  │  Protocolo: NDJSON                                  │   │
│  │  Latencia: ≤1ms                                     │   │
│  │  Uso: Comunicación con IA jefe                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TCP MESH (LAN Network)                             │   │
│  │                                                     │   │
│  │  Puerto: 17890 (TCP) | 17891 (UDP discovery)        │   │
│  │                                                     │   │
│  │  Nodos: ≤256                                        │   │
│  │  Latencia: ≤5ms LAN                                 │   │
│  │  Uso: Multi-dispositivo                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MCP SERVER (AI Integration)                        │   │
│  │                                                     │   │
│  │  Protocolo: stdio JSON-RPC                          │   │
│  │  Herramientas: 5                                    │   │
│  │  - linkcore_neural_decide                           │   │
│  │  - linkcore_brain_status                            │   │
│  │  - linkcore_decision_history                        │   │
│  │  - linkcore_learning_insights                       │   │
│  │  - linkcore_arbitrate_neural                        │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## FLUJO DE DATOS

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  User: "cómo hacer una web moderna"                        │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  NEURAL DECISION ENGINE                             │   │
│  │  - Categorize: code                                 │   │
│  │  - Strategy: ensemble                               │   │
│  │  - Models: [smollm2, qwen2.5, qwen2.5]             │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  INFERENCE FABRIC                                   │   │
│  │  - Execute 3 models in parallel (22s)               │   │
│  │  - Round 2 communication (5s)                       │   │
│  │  - Consensus: 73% (high confidence)                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  LEARNING LAYER                                     │   │
│  │  - MCTS: update smollm2 visits++                    │   │
│  │  - Strategy: ensemble success++                     │   │
│  │  - EDR: record decision                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  RESPONSE                                           │   │
│  │  - text: "Para hacer una web moderna..."            │   │
│  │  - neural: { strategy, models, consensus }          │   │
│  │  - decisionId: edr_1785598699179_8znx               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## ESPECIFICACIONES

| Componente | Capacidad | Latencia |
|------------|-----------|----------|
| Neural Decision Engine | 1,000 decisions/s | ≤1ms |
| Inference Fabric | 5 modelos parallel | ≤10s/model |
| Learning Layer | 10,000 nodos MCTS | ≤100ms |
| Model Mesh | 60+ modelos | ≤20s |
| IO Layer | 256 nodos | ≤5ms |

---

## VENTAJA COMPETITIVA

| Feature | Basic MCP | LinkCore |
|---------|-----------|----------|
| Models | 1 | 3-5 parallel |
| Learning | None | MCTS autonomous |
| Consensus | None | Mathematical |
| Audit | None | Enterprise Decision Record |
| Failover | None | Circuit Breaker |

---

*LinkCore — Acelerador de inferencia distribuida.*
