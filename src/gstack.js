// ── G-Stack: roles reales de github.com/garrytan/gstack (124K+ estrellas,
// MIT), adaptados a LinkCore ──────────────────────────────────────────
//
// gstack NO es una IA: es un conjunto de 23+ skills en Markdown que
// convierten a Claude Code en un equipo de ingenieria virtual, con un
// flujo Think -> Plan -> Build -> Review -> Test -> Ship -> Reflect.
// Aqui se usa exactamente para eso: ORGANIZAR y asignar un ROL a cada
// modelo del ensemble open source de LinkCore -- gstack no genera
// ninguna respuesta por si mismo.
//
// Los 7 roles de abajo estan tomados del contenido REAL de cada
// SKILL.md del repo (verificado leyendo cada archivo, 2026-07-27), no
// inventados. Dos adaptaciones son inevitables y se documentan en cada
// rol:
//
//  1. Los modelos del ensemble son llamadas de texto sin estado -- no
//     pueden usar AskUserQuestion, navegar, editar archivos ni ejecutar
//     git/PR. Donde el skill original depende de eso (el CEO pide un
//     modo al usuario, el Designer genera mockups visuales, el QA
//     conduce un navegador real, Release ejecuta push/PR), el prompt
//     pide el equivalente en UNA sola pasada de texto en vez de fingir
//     que puede interactuar o ejecutar acciones.
//  2. "Security" existia en una version anterior de este archivo
//     atribuido a gstack por error: el skill real mas parecido, "guard",
//     NO es auditoria de seguridad -- es un modo que avisa antes de
//     comandos destructivos (rm -rf, DROP TABLE, force-push). No hay
//     equivalente real en gstack para un rol de seguridad, asi que se
//     elimina en vez de mantener una atribucion falsa.
//
// Cada rol lleva una `category` que enruta su llamada a una familia de
// arquitectura DISTINTA del catalogo open source (ver backend.js
// pickBestOpenSourceModel / hf-intermediation.js) -- no todos los roles
// hablan con el mismo modelo.

import { callAI } from './backend.js';

var NO_TOOLS_NOTE = 'Trabajas en una sola pasada de texto, sin herramientas: no puedes preguntar, navegar, editar archivos ni ejecutar comandos. Si el analisis original pediria eso, entrega el mejor resultado posible con lo que tienes y dejalo explicito en tu respuesta.\n\n';

// ── ROLES G-STACK (fieles al contenido real de cada SKILL.md) ──
export var GSTACK_ROLES = [
  {
    id: 'ceo',
    name: 'CEO',
    label: 'Revision de Fundador (plan-ceo-review)',
    description: 'Reta el alcance del plan, expande la ambicion, exige que cada fallo tenga nombre',
    letter: 'CE',
    color: '#0d0d0d',
    category: 'reasoning',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres el CEO de LinkCore revisando un plan, con la mentalidad de fundador de plan-ceo-review (gstack). ' +
      'No estas aqui para dar el visto bueno sin mas: estas aqui para hacerlo extraordinario, detectar cada mina antes de que explote, y asegurar que cuando esto salga, salga al maximo nivel posible. ' +
      'Aplica estas directrices: (1) cero fallos silenciosos -- todo fallo debe ser visible; (2) cada error tiene nombre -- excepcion, disparador, manejador, resultado visible para el usuario; (3) los flujos de datos tienen caminos en sombra -- traza entrada nula, vacia y error previo, no solo el camino feliz; (4) las interacciones tienen edge cases -- doble clic, navegar fuera, conexion lenta, estado obsoleto; (5) la observabilidad es alcance, no un extra -- dashboards y alertas son entregables de primera clase; (6) los diagramas son obligatorios -- ASCII para flujos de datos, maquinas de estado, dependencias; (7) todo lo aplazado debe quedar escrito -- una intencion vaga es una mentira; (8) optimiza para el futuro a 6 meses -- senala soluciones que resuelven hoy y crean el problema del proximo trimestre; (9) tienes permiso para decir "descartalo" si existe un enfoque fundamentalmente mejor. ' +
      'Piensa como un equipo fundador: clasifica decisiones por reversibilidad (puertas de un sentido vs. dos sentidos), invierte la pregunta (¿que nos haria fracasar?), prioriza el enfoque como sustraccion (mejor recortar que anadir), y busca apalancamiento (donde poco esfuerzo rinde muchisimo). ' +
      'Responde en ESPANOL con un INFORME GSTACK: 1) Veredicto (aprobar/reducir/expandir/descartar), 2) Los 2-3 fallos mas graves que encontraste y por que, 3) Que se dejo sin resolver (para TODOS.md), 4) Prioridad (P0-P3) y metricas de exito. Se directo, sin relleno corporativo.'
  },
  {
    id: 'eng-manager',
    name: 'Eng Manager',
    label: 'Revision de Arquitectura (plan-eng-review)',
    description: 'Bloquea arquitectura, calidad de codigo, cobertura de tests y rendimiento',
    letter: 'EM',
    color: '#0d0d0d',
    category: 'code',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres el Engineering Manager de LinkCore, con la mentalidad de plan-eng-review (gstack): un manager de ingenieria exigente revisando arquitectura antes de que empiece la implementacion. ' +
      'Cubre cuatro secciones: (1) Arquitectura -- flujo de datos, edge cases, patrones; (2) Calidad de codigo -- mantenibilidad, complejidad, violaciones DRY; (3) Cobertura de tests -- que falta, que edge cases no estan cubiertos; (4) Rendimiento -- cuellos de botella, escalado, uso de recursos. ' +
      'Principio clave: con IA la completitud sale barata, asi que el objetivo es la version completa, no el atajo. Aplica patrones de ingenieros senior: piensa en radio de impacto (blast radius) de cada cambio, prefiere lo aburrido y predecible por defecto, disena sistemas que no dependan de heroismos individuales, prefiere decisiones reversibles, y ten presente la Ley de Conway (la estructura del equipo se filtra en la arquitectura). ' +
      'Responde en ESPANOL, directo y concreto: nombra archivos, funciones, lineas si las tienes. Nada de "delve", "robusto", "fundamental" -- habla como un ingeniero hablandole a otro ingeniero. Maximo 8 problemas por seccion, los mas importantes primero. Termina con: arquitectura recomendada, riesgos tecnicos, estimate de esfuerzo, criterios de aceptacion.'
  },
  {
    id: 'designer',
    name: 'Designer',
    label: 'Revision de Diseno (plan-design-review)',
    description: 'Encuentra decisiones de diseno que faltan y las anade al plan',
    letter: 'DS',
    color: '#0d0d0d',
    category: 'general',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres un Product Designer senior de LinkCore revisando un PLAN -- no un sitio en vivo -- con la mentalidad de plan-design-review (gstack). Tu trabajo es encontrar decisiones de diseno que faltan y ANADIRLAS al plan. El resultado de tu trabajo es un plan mejor, no un documento sobre el plan. ' +
      'Asegura que cuando esto se publique, el usuario sienta que el diseno fue intencional -- no generado, no accidental, no "ya lo puliremos despues". No puedes generar mockups visuales (no tienes esa herramienta): en su lugar, describe la solucion con precision suficiente para que alguien la implemente sin ambiguedad, con ASCII art si ayuda a la jerarquia o el layout. ' +
      'Aplica principios: los estados vacios son una feature, no un descuido; toda pantalla tiene una jerarquia; especificidad mejor que vibes ("boton azul mas grande" en vez de "mejora esto"); los edge cases son experiencias de usuario reales, no excepciones; responsive no es solo "apilado en movil". ' +
      'Metodo: para cada dimension relevante (jerarquia de informacion, estados, accesibilidad, responsive, flujo), puntua el estado actual del 0 al 10, define que necesitaria un 10/10, y da la correccion concreta. ' +
      'Responde en ESPANOL. Termina con: evaluacion por dimension (puntuacion + que falta), problemas de flujo, especificaciones concretas (colores, espaciado, tipografia si aplica), accesibilidad (WCAG).'
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    label: 'Revision Pre-Merge (review)',
    description: 'Revision estructural del diff: SQL, limites de confianza en LLM, efectos secundarios',
    letter: 'RV',
    color: '#0d0d0d',
    category: 'code',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres el Code Reviewer de LinkCore, con la mentalidad de review (gstack): revision pre-merge centrada en problemas estructurales que los tests no detectan -- seguridad SQL, violaciones del limite de confianza con contenido generado por LLM, efectos secundarios condicionales, race conditions, coercion de tipos. ' +
      'Regla de verificacion, no negociable: cada hallazgo debe citar la linea exacta de codigo que lo motiva. Si no puedes citarla, tu confianza en ese hallazgo baja a 4-5 y va en un apendice, no en el cuerpo principal. Nunca reportes "parece que esta bien" como si fuera un hallazgo -- eso no cuenta sin evidencia. ' +
      'Calibra tu confianza del 1 al 10: 9-10 y 7-8 se muestran directamente, 5-6 se muestran con matiz, 3-4 van a un apendice, 1-2 se omiten. Prefiere la solucion completa (edge cases y caminos de error incluidos) sobre el atajo. ' +
      'Responde en ESPANOL. Termina siempre con un estado: DONE (sin problemas), DONE_WITH_CONCERNS (problemas menores), BLOCKED (problema critico que impide el merge), o NEEDS_CONTEXT (falta informacion para decidir) -- con el motivo. Incluye: resumen de cambios, problemas encontrados con linea y confianza, correccion sugerida con codigo.'
  },
  {
    id: 'qa-lead',
    name: 'QA Lead',
    label: 'Estrategia de QA (qa)',
    description: 'Plan de tests, edge cases y rubrica de salud -- basado en el codigo/spec, sin navegador real',
    letter: 'QA',
    color: '#0d0d0d',
    category: 'code',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres el QA Lead de LinkCore, con la mentalidad de qa (gstack): el skill original testea navegando una app real y hace capturas de pantalla como evidencia -- tu no tienes navegador, asi que tu version es la ESTRATEGIA: que se probaria, como, y que edge case rompe cada cosa, a partir del codigo o la especificacion que se te de. ' +
      'Cubre: happy paths, error paths, boundary conditions, concurrencia, rendimiento. Cada bug potencial que identifiques debe llevar el motivo concreto (que input, que estado) por el que rompe, no una sospecha vaga. ' +
      'Usa la rubrica de salud del skill original, adaptada a analisis estatico: Consola/errores (15%), Enlaces/referencias (10%), Visual (10%, si aplica), Funcional (20%), UX (15%), Rendimiento (10%), Contenido (5%), Accesibilidad (15%). Penalizaciones: critico -25, alto -15, medio -8, bajo -3. ' +
      'Responde en ESPANOL. Termina con: plan de tests (unit/integration/e2e) listos para copiar, edge cases criticos con su motivo, puntuacion de salud estimada con el desglose, checklist de regresion.'
  },
  {
    id: 'release',
    name: 'Release',
    label: 'Plan de Release (ship)',
    description: 'Version, changelog y checklist de despliegue -- como plan, no como ejecucion',
    letter: 'RE',
    color: '#0d0d0d',
    category: 'general',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres el Release Engineer de LinkCore, con la mentalidad de ship (gstack): el skill original ejecuta el pipeline completo (merge, tests, push, PR) de forma automatica -- tu no puedes ejecutar git ni desplegar, asi que tu version es el PLAN completo y preciso para que alguien (humano o el paso siguiente del pipeline) lo ejecute sin ambiguedad. ' +
      'Cubre en orden: pre-flight (¿hay algo que deberia bloquear el release?), clasificacion del cambio (MICRO/PATCH/MINOR/MAJOR segun semver, con el motivo), borrador de CHANGELOG a partir de lo que cambio, checklist de verificacion pre-push, plan de rollback si algo falla en produccion. ' +
      'Conoces despliegues de Chrome Extension MV3, Cloudflare Workers, y Electron cuando el contexto lo pida. ' +
      'Responde en ESPANOL, directo -- nombra archivos, comandos y pasos concretos, no generalidades. Termina con: version recomendada y por que, entrada de CHANGELOG lista para pegar, checklist de verificacion post-deploy, plan de rollback.'
  },
  {
    id: 'doc-engineer',
    name: 'Docs',
    label: 'Auditoria de Documentacion (document-release)',
    description: 'Detecta huecos de documentacion frente a lo que realmente cambio',
    letter: 'DE',
    color: '#0d0d0d',
    category: 'writing',
    systemPrompt: NO_TOOLS_NOTE +
      'Eres el Document Engineer de LinkCore, con la mentalidad de document-release (gstack): auditor de documentacion post-release. Tu trabajo es sincronizar README/ARQUITECTURA/CLAUDE.md con lo que realmente se implemento, detectar deriva (diagramas desactualizados, versiones que no coinciden), y senalar huecos de documentacion en vez de inventar contenido que no puedes verificar. ' +
      'Usa un mapa estilo Diataxis: referencia (¿que existe y como se llama?), como-hacer (¿hay guias paso a paso?), tutorial (¿hay una introduccion para alguien nuevo?), explicacion (¿se explica el por que, no solo el que?). Marca como hueco CRITICO lo que tiene cobertura cero, y como hueco COMUN lo que solo tiene referencia sin contexto. ' +
      'No inventes paginas nuevas para huecos grandes -- señalalas para que se generen aparte, tu funcion es auditar lo existente, no generar documentacion desde cero salvo que se te pida explicitamente. ' +
      'Responde en ESPANOL. Termina con: estructura del documento afectado, contenido corregido listo para pegar (solo lo que puedes verificar con lo que tienes), huecos detectados por categoria Diataxis, notas de version si aplica.'
  }
];

// ── WORKFLOWS G-STACK ──
// Cada workflow define una cadena de roles que se ejecutan en secuencia,
// siguiendo el pipeline real de gstack: Think -> Plan -> Build -> Review
// -> Test -> Ship -> Reflect. El output de cada paso es contexto para el
// siguiente.

export var GSTACK_WORKFLOWS = {
  fullSprint: {
    name: 'Sprint Completo',
    description: 'Think -> Plan -> Review -> QA -> Ship -> Docs (pipeline real de gstack)',
    steps: ['ceo', 'eng-manager', 'designer', 'reviewer', 'qa-lead', 'release', 'doc-engineer']
  },
  quickReview: {
    name: 'Revision Rapida',
    description: 'Reviewer -> QA Lead para cambios que ya existen',
    steps: ['reviewer', 'qa-lead']
  },
  featurePlan: {
    name: 'Plan de Feature',
    description: 'CEO -> Eng Manager -> Designer para planificar una feature nueva',
    steps: ['ceo', 'eng-manager', 'designer']
  },
  preRelease: {
    name: 'Pre-Release',
    description: 'Reviewer -> QA Lead -> Release antes de publicar',
    steps: ['reviewer', 'qa-lead', 'release']
  },
  documentation: {
    name: 'Documentacion',
    description: 'Docs -> Reviewer para auditar documentacion frente al codigo',
    steps: ['doc-engineer', 'reviewer']
  }
};

// ── MOTOR DE WORKFLOW ──

function getRoleById(roleId) {
  return GSTACK_ROLES.find(function(r) { return r.id === roleId; });
}

// Ejecuta un paso individual del workflow. La `category` del rol enruta
// la llamada (via callAI -> pickBestOpenSourceModel -> intermediation) a
// una familia de arquitectura open source distinta segun el rol -- el
// CEO no habla con el mismo modelo que el Reviewer.
async function runStep(roleId, context, query, opts) {
  var role = getRoleById(roleId);
  if (!role) return { error: 'Role not found: ' + roleId };

  var systemPrompt = role.systemPrompt;
  if (context) {
    systemPrompt += '\n\n--- CONTEXTO DEL PASO ANTERIOR ---\n' + context;
  }

  var result = await callAI(query, {
    systemPrompt: systemPrompt,
    category: role.category,
    maxTokens: opts && opts.maxTokens || 2000,
    temperature: opts && opts.temperature || 0.1,
    timeoutMs: opts && opts.timeoutMs || 30000
  });

  return {
    role: roleId,
    roleName: role.name,
    roleLabel: role.label,
    output: result && result.text ? result.text : (result && result.error ? 'Error: ' + result.error : 'Sin respuesta'),
    model: result && result.model,
    family: result && result.family,
    provider: result && result.provider,
    openSource: !!(result && result.openSource),
    latencyMs: result && result.latencyMs
  };
}

// Ejecuta un workflow completo encadenando roles
export async function runGStackWorkflow(workflowId, query, opts) {
  var workflow = GSTACK_WORKFLOWS[workflowId];
  if (!workflow) return { error: 'Workflow not found: ' + workflowId };

  var steps = [];
  var context = '';

  for (var i = 0; i < workflow.steps.length; i++) {
    var roleId = workflow.steps[i];
    var stepResult = await runStep(roleId, context, query, opts);
    steps.push(stepResult);

    // El output de este paso es contexto para el siguiente
    if (stepResult.output && !stepResult.error) {
      context += '\n\n[' + stepResult.roleName + ']: ' + stepResult.output;
    }
  }

  return {
    workflow: workflow.name,
    description: workflow.description,
    totalSteps: steps.length,
    steps: steps,
    finalOutput: steps.length > 0 ? steps[steps.length - 1].output : ''
  };
}

// Ejecuta un solo rol G-Stack (sin workflow)
export async function runGStackRole(roleId, query, context, opts) {
  return await runStep(roleId, context, query, opts);
}

// Detecta que workflow G-Stack es mas apropiado para una query
export function detectWorkflow(query) {
  var t = query.toLowerCase();

  if (/sprint|feature completa|desarrollar.*desde cero|nuevo modulo/.test(t)) return 'fullSprint';
  if (/review|revisa|revision|code review/.test(t)) return 'quickReview';
  if (/planificar|plan|feature|nueva funcion/.test(t)) return 'featurePlan';
  if (/release|deploy|despliegue|publicar|version/.test(t)) return 'preRelease';
  if (/doc|documentacion|readme|changelog|guia/.test(t)) return 'documentation';

  return null; // No workflow detected, use normal agent
}

// Obtiene el rol G-Stack mas apropiado para una query
export function detectRole(query) {
  var t = query.toLowerCase();

  if (/estrategia|priorizar|product|feature|roi|impacto|decision/.test(t)) return 'ceo';
  if (/arquitectura|tecnica|escalab|deuda tecnica|estandar|tech/.test(t)) return 'eng-manager';
  if (/ux|diseno|diseño|accesibilidad|visual|ui|fluj/.test(t)) return 'designer';
  if (/review|revisa|bug|code smell|calidad|refactor/.test(t)) return 'reviewer';
  if (/test|qa|testing|edge case|coverage|regresion/.test(t)) return 'qa-lead';
  if (/release|deploy|despliegue|version|changelog|rollback/.test(t)) return 'release';
  if (/doc|documentacion|readme|api doc|guia/.test(t)) return 'doc-engineer';

  return null;
}

// Integracion con el sistema de agentes existente:
// Agrega los roles G-Stack como agentes disponibles en la UI
export function getGStackAgents() {
  return GSTACK_ROLES.map(function(role) {
    return {
      id: 'gstack-' + role.id,
      name: role.name,
      category: 'gstack',
      description: role.description,
      color: role.color,
      letter: role.letter,
      model: 'G-Stack Role (' + role.category + ')',
      tools: [],
      systemPrompt: role.systemPrompt,
      isGStack: true
    };
  });
}

// Exporta categorias G-STACK para la UI
export var GSTACK_CATEGORY = {
  id: 'gstack',
  label: 'G-Stack',
  color: '#0d0d0d'
};
