# LinkCore — AGENTS.md

LinkCore es un procesador virtual de intermediación + ensemble learning entre IAs instalado en este ordenador -- como un procesador AMD: se instala una vez, arranca solo, y cualquier IA jefe con acceso a terminal le manda instrucciones directamente. No es una API a la que se llama ni un servidor al que registrarse: es un componente de sistema.

## Cómo conectar: instrucciones vNPU sobre la tubería con nombre

No hay MCP, no hay HTTP, no hay "Base URL" que configurar (esas dos vías se probaron y se retiraron -- ver Historial abajo). La única vía real es mandarle una instrucción al procesador por terminal, con el opcode de la instrucción, igual que el software le manda una instrucción a un chip real:

```bash
# Arranca el servicio si no está corriendo (se arranca solo la primera vez que hace falta)
node bin/linkcore-cli.js start

# Instrucción EXEC: pipeline completo (orquestador + ensemble + verificación)
node bin/linkcore-cli.js vnpu EXEC '{"query":"tu tarea"}'

# Instrucción VERIFY: audita un borrador que TÚ ya escribiste, sin generar nada (milisegundos)
node bin/linkcore-cli.js vnpu VERIFY '{"draft":"tu borrador","query":"la pregunta original"}'

# Instrucción CRITIQUE: segunda opinión real de una pieza local (~20-30s)
node bin/linkcore-cli.js vnpu CRITIQUE '{"draft":"tu borrador","query":"la pregunta original"}'

# Instrucción ROUTE: decide qué pieza ejecutaría una tarea, sin ejecutarla
node bin/linkcore-cli.js vnpu ROUTE '{"query":"tu tarea","category":"code"}'

# Instrucción AUDIT: pasa un conjunto de evaluación entero por los mismos
# canales deterministas y devuelve veredicto contra una puerta de calidad.
# El payload puede ir en un fichero (@ruta) porque un conjunto no cabe inline.
# Sale con código 1 si la puerta no se supera: sirve para cortar un CI.
node bin/linkcore-cli.js vnpu AUDIT @conjunto.json

# Instrucción TELEMETRY: estado real del hardware + historial de instrucciones
node bin/linkcore-cli.js vnpu TELEMETRY
```

Formato del conjunto de AUDIT. `expectFindings` es opcional, pero sin él el
recall no es calculable y se informa como `null` en vez de inventarlo:

```json
{
  "items": [
    { "id": "caso-1", "query": "la pregunta original", "draft": "la respuesta a auditar", "expectFindings": true }
  ],
  "gate": { "minRecall": 0.9, "maxFalsePositiveRate": 0, "maxFindingRate": 0.05, "maxChannelErrors": 0 }
}
```

Si el comando `linkcore` está en el PATH (instalación normal vía `install/install.ps1`), se puede usar directamente sin `node bin/linkcore-cli.js`:

```bash
linkcore vnpu EXEC '{"query":"investiga las ventajas de TypeScript frente a Python"}'
```

Cuando el usuario pida algo que pueda beneficiarse de intermediación entre varias IAs, o quiera pasar una tarea por el procesador, usa `vnpu EXEC` (o el atajo `linkcore ask "tarea"`, equivalente). Antes de dar por buena una respuesta propia con cálculos, código, o una comparación, pásala por `vnpu VERIFY` primero.

**Importante:** esto SOLO funciona si LinkCore está instalado en este ordenador (el comando `linkcore` existe en la terminal, o `bin/linkcore-cli.js` existe en este repo). Si no está instalado, no hay nada a lo que conectarse -- no lo simules ni inventes una respuesta como si viniera de LinkCore.

## Comandos disponibles

```bash
# Estado del servicio
linkcore status

# Reporte del chip (cache, metrics, learning)
linkcore chip

# Knowledge Graph (Memory Bus)
linkcore graph

# Malla de nodos (Local-First AI Mesh)
linkcore mesh

# Diagnóstico de hardware virtual
linkcore sysinfo

# Benchmark de rendimiento
linkcore benchmark
```

## Historial de vías descartadas

- **Puente OpenAI-compatible en `127.0.0.1:17892`**: descartado (2026-08-03, decisión del fundador: "nada de localhost") y su código (`openai-bridge.js`) borrado (2026-08-12). No existe hoy.
- **MCP** (`mcp/linkcore-server.js`, tools `linkcore_verify`/`linkcore_accelerate`/`linkcore_status`/`linkcore_history`): fue la vía real entre 2026-08-12 y 2026-08-16. Retirada por decisión explícita del fundador: "no quiero que sea mediante MCP... no quiero nada de APIs... algo que haga referencia a un procesador de verdad". El archivo se borró y ya no se registra en `~/.claude/mcp.json`.
