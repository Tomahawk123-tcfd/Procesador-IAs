// ═══════════════════════════════════════════════════════════════
// LINKCORE BUILD PIPELINE PLANNER
// Descompone "crea una app" en las etapas reales de construirla:
// requisitos -> seleccion de herramientas -> diseno -> datos ->
// codigo -> control de versiones -> testing -> publicacion.
//
// Revisado por G-STACK (CEO + Eng Manager, 2026-07-28) antes de
// construirse. Veredicto de ambos, independiente: el ensemble son
// llamadas de texto sin estado -- no pueden editar archivos ni
// ejecutar git/PR/deploys de verdad. Forzar eso esta noche mezclaria
// pasos de texto con acciones de efecto lateral en el MISMO array de
// subtasks que `orchestrator.js` ya trata como texto puro
// (`results[step.id] = out.text`), corrompiendo el contexto que
// reciben los pasos siguientes. Y ninguna clave de GitHub/Firebase/
// Apple/Google puede vivir en `core-service/src` bajo ninguna
// circunstancia.
//
// Por eso CADA etapa de este planificador, incluidas control de
// versiones y publicacion, produce un ARTEFACTO DE TEXTO listo para
// usar (el comando `gh repo create` exacto, el `firebase.json`
// completo, el checklist real de revision de Apple) -- nunca una
// llamada API real. Es exactamente lo que ambos revisores marcaron
// como seguro y valioso para esta noche; conectar acciones reales
// (nuevo tipo de paso `tool-action`, endpoint nuevo en el Worker,
// OAuth server-side igual que ya existe para Gmail/Calendar) queda
// como trabajo futuro, deliberadamente fuera de esta pieza.
// ═══════════════════════════════════════════════════════════════

import { TOOLCHAIN, getByCategory } from './toolchain-registry.js';

// Bug real, severo, encontrado en vivo (2026-08-12): con `.*` sin limite,
// esto se disparaba con CUALQUIER "crea"/"construye"/etc en la query
// mientras "app"/"aplicacion"/"producto" apareciera en CUALQUIER punto
// posterior, cruzando frases enteras separadas por ":" o ".". Ejemplo real
// que lo reprodujo: "Crea un plan de dos pasos: primero resume que es una
// red neuronal, despues explica una aplicacion practica" -- una peticion de
// resumen, sin ninguna app de por medio -- metida en el plan de 7 pasos de
// "construir una app" (7 pasos, 6 fallaron, 47 minutos). Dos correcciones
// independientes: (1) la coincidencia no puede cruzar puntuacion de fin de
// frase (., :, ;, ?, !, salto de linea) -- se acota a 40 caracteres sin esa
// puntuacion, no toda la query; (2) app/aplicacion/producto debe llevar un
// articulo justo delante (una app, mi producto...) Y no puede ir seguido de
// un adjetivo que lo delate como sustantivo abstracto ("aplicacion
// PRACTICA/teorica/conceptual" = el concepto de aplicar algo, no una app).
var APP_TRIGGER = /\b(crea|desarrolla|construye|programa|lanza)\b[^.:;!?\n]{0,40}\b(?:una?|la|mi|esta|nuestra)\s+(app|aplicaci[oó]n(?:\s+(?:web|m[oó]vil))?|producto)\b(?!\s+(pr[aá]ctica|te[oó]rica|conceptual))/i;

function isAppBuildRequest(query) {
  if (!query) return false;
  return APP_TRIGGER.test(query);
}

// Resumen del catalogo para dar contexto real a la etapa de seleccion
// de herramientas -- el ensemble decide CUALES encajan, el catalogo
// solo informa que existe y que tipo de integracion tiene cada una,
// nunca decide por si solo (esa separacion la pidio explicitamente el
// Eng Manager de G-STACK: la decision de ejecucion no le corresponde
// al planificador).
function toolchainContext() {
  var byCategory = {};
  TOOLCHAIN.forEach(function (t) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t.name + ' (' + t.integrationType + (t.authRequired ? ', requiere ' + t.authRequired : '') + ')');
  });
  var lines = ['Catalogo real de herramientas disponibles, por categoria:'];
  Object.keys(byCategory).forEach(function (cat) {
    lines.push('- ' + cat + ': ' + byCategory[cat].join(', '));
  });
  lines.push('');
  lines.push('IMPORTANTE: hoy LinkCore no ejecuta llamadas API reales a estas herramientas. ' +
    'Para cada una, entrega el artefacto de texto listo para usar (comando, config, checklist) -- ' +
    'nunca simules que la accion ya se ejecuto.');
  return lines.join('\n');
}

function buildPipelinePlan(query) {
  var ctx = toolchainContext();

  var subtasks = [
    {
      label: 'Requisitos y selección de herramientas',
      category: 'reasoning',
      ai: 'Ensemble (requisitos)',
      ensemble: true,
      desc: 'Analiza la petición y define: tipo de app (móvil/web/híbrida), funcionalidades core, y qué herramientas del catálogo encajan mejor con justificación concreta (no elijas todas, elige las que de verdad aplican). ' + ctx,
    },
    {
      label: 'Brief de diseño (Figma / Sketch)',
      category: 'reasoning',
      ai: 'Ensemble (diseño)',
      ensemble: true,
      desc: 'Con las herramientas de diseño elegidas en el paso anterior, produce un brief completo: paleta de colores, tipografía, wireframes descritos con precisión suficiente para implementarse sin ambigüedad (ASCII si ayuda a la jerarquía), y estados vacíos/error. Listo para pegar en Figma o entregar a un diseñador.',
    },
    {
      label: 'Arquitectura de datos',
      category: 'reasoning',
      ai: 'Ensemble (datos)',
      ensemble: true,
      desc: 'Diseña el esquema de datos completo (tablas/colecciones, relaciones, índices) para la base de datos elegida en requisitos (Firebase/Supabase/PostgreSQL/MongoDB). Entrega el esquema en el formato nativo de esa herramienta (SQL para Postgres, definición de colecciones para Firestore/Mongo) listo para ejecutar.',
    },
    {
      label: 'Scaffolding de código',
      category: 'code',
      ai: 'Ensemble (código)',
      ensemble: true,
      desc: 'Genera la estructura inicial completa del proyecto según el stack elegido (Flutter/React Native/nativo Swift-Kotlin/web), con los archivos base, dependencias, y la integración con la base de datos del paso anterior ya cableada.',
    },
    {
      label: 'Control de versiones (Git / GitHub / GitLab / Bitbucket)',
      category: 'text',
      ai: 'Generador de artefactos',
      ensemble: false,
      desc: 'Genera, LISTOS PARA COPIAR Y EJECUTAR: el `.gitignore` correcto para el stack elegido, la secuencia exacta de comandos git (`git init`, primer commit, remote), y el comando del proveedor elegido para crear el repositorio (ej. `gh repo create` si es GitHub). Deja explícito que estos comandos no se ejecutan automáticamente -- el usuario los corre él mismo, o se conectan más adelante a una integración real con credenciales server-side.',
    },
    {
      label: 'Plan de testing (TestFlight / Google Play Beta / Postman)',
      category: 'text',
      ai: 'Generador de artefactos',
      ensemble: false,
      desc: 'Genera el checklist de qué probar (happy paths, edge cases, dispositivos objetivo) y, si aplica, la colección de Postman (JSON) para probar la API del backend. Indica qué credenciales harían falta (APP_STORE_CONNECT_KEY, GOOGLE_PLAY_SERVICE_ACCOUNT, POSTMAN_API_KEY) para automatizar la subida de builds en el futuro -- hoy no se sube nada automáticamente.',
    },
    {
      label: 'Checklist de publicación (Google Play Console / Apple Developer Program)',
      category: 'text',
      ai: 'Generador de artefactos',
      ensemble: false,
      desc: 'Genera el checklist REAL de publicación: requisitos de cada tienda (capturas, descripción, política de privacidad, clasificación de contenido), tiempos de revisión esperados (Apple: horas-días con revisión humana; Google: más rápido pero no instantáneo), y qué pasos son inevitablemente manuales (alta en Apple Developer Program, aceptación de políticas). No presentes esto como "publicado" -- es un plan de publicación, no una publicación real.',
    },
  ];

  return {
    taskType: 'build-pipeline',
    sector: 'Creación de App',
    label: 'Pipeline de creación de app',
    narrative: 'LinkCore descompone la creación de la app en ' + subtasks.length + ' etapas reales: requisitos, diseño, datos, código, control de versiones, testing y publicación. Cada etapa de razonamiento/generación usa ensemble; las etapas que tocan herramientas externas (Git/GitHub, TestFlight, Google Play) entregan el artefacto exacto listo para usar -- ningún paso ejecuta una acción real sobre una cuenta externa esta noche.',
    originalQuery: query,
    subtasks: subtasks,
  };
}

export {
  isAppBuildRequest,
  buildPipelinePlan,
  toolchainContext,
};
