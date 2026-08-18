// ═══════════════════════════════════════════════════════════════
// LINKCORE TOOLCHAIN REGISTRY
// Catalogo honesto de las herramientas reales que intervienen en
// crear y publicar una app: Figma, Xcode, Firebase, GitHub, Google
// Play Console, etc.
//
// La peticion original que motiva este modulo pedia "ensemble
// learning entre estas herramientas" -- pero la mayoria no son IAs:
// no razonan, no producen texto comparable sobre la misma pregunta,
// el teorema del ensemble no aplica. Lo real y construible: cada
// herramienta tiene un TIPO DE INTEGRACION distinto, y LinkCore debe
// saber cual es antes de prometer que "orquesta" nada. Este catalogo
// es esa verdad, explicita por herramienta, para que ni el
// planificador ni la UI finjan una capacidad que no existe.
//
// integrationType:
//   'api'             -- API real, remota, LinkCore puede ejecutar
//                         la accion de verdad (crear un repo, subir
//                         build, escribir en una tabla).
//   'api-partial'      -- API real pero con alcance limitado (lectura
//                         mas que escritura, o subconjunto de acciones).
//   'file-generation'  -- sin API remota de proposito general. LinkCore
//                         solo puede generar el archivo/proyecto para
//                         que el usuario lo abra en la herramienta.
//   'manual-handoff'   -- ni siquiera archivo generable de forma util;
//                         requiere accion humana directa en la
//                         herramienta (aceptar politicas, revision
//                         humana de Apple/Google, etc).
//
// authRequired: null si no hace falta credencial para lo que SI se
// puede hacer; si no, el tipo de secreto que haria falta -- y ese
// secreto SIEMPRE vive server-side en el Worker (wrangler secret),
// nunca en el cliente ni pedido al usuario en un prompt o formulario.
// Regla fija del proyecto, no negociable.
// ═══════════════════════════════════════════════════════════════

var TOOLCHAIN = [
  // ── DISEÑO ──
  {
    id: 'figma', name: 'Figma', category: 'design',
    integrationType: 'api-partial',
    authRequired: 'FIGMA_TOKEN',
    notes: 'REST API real: lee archivos, componentes, variables, comentarios. Escritura de diseno de alto nivel (crear frames/componentes complejos) es limitada -- pensada para plugins dentro de Figma, no para generacion remota completa desde cero.',
  },
  {
    id: 'adobe-xd', name: 'Adobe XD', category: 'design',
    integrationType: 'manual-handoff',
    authRequired: null,
    notes: 'Adobe discontinuo el desarrollo activo de XD (anunciado 2023, consolidado hacia otras herramientas de Adobe). Sin API publica de proposito general vigente. No prometer integracion.',
  },
  {
    id: 'sketch', name: 'Sketch', category: 'design',
    integrationType: 'file-generation',
    authRequired: null,
    notes: 'Solo macOS. API de plugins limitada al propio Sketch corriendo localmente, sin API remota de cuenta. LinkCore puede generar especificaciones de diseno (color, tipografia, layout) como texto/JSON, no un archivo .sketch real.',
  },

  // ── DESARROLLO MOVIL / IDEs ──
  {
    id: 'android-studio', name: 'Android Studio', category: 'mobile-ide',
    integrationType: 'file-generation',
    authRequired: null,
    notes: 'IDE de escritorio (IntelliJ). Sin API remota para control a distancia. LinkCore puede generar el proyecto Kotlin/Java completo para que el usuario lo abra.',
  },
  {
    id: 'xcode', name: 'Xcode', category: 'mobile-ide',
    integrationType: 'file-generation',
    authRequired: null,
    notes: 'IDE de escritorio, solo macOS. Sin API remota. `xcodebuild` existe como CLI pero requiere ejecutarse EN una maquina con Xcode instalado -- contradice el requisito de cero uso de disco/ejecucion remota de este proyecto salvo que el usuario lo corra el mismo localmente. LinkCore genera el proyecto Swift/SwiftUI, no lo compila.',
  },
  {
    id: 'vscode', name: 'Visual Studio Code', category: 'ide',
    integrationType: 'file-generation',
    authRequired: null,
    notes: 'Tiene extension API y CLI (`code`), pero eso opera SOBRE una instancia local abierta, no como servicio remoto invocable desde un Worker. LinkCore genera archivos de codigo listos para abrir.',
  },
  {
    id: 'cursor', name: 'Cursor', category: 'ide',
    integrationType: 'manual-handoff',
    authRequired: null,
    notes: 'Fork de VS Code con IA propia integrada -- es, de hecho, una de las herramientas que fragmenta el flujo de trabajo del usuario (el problema que motiva LinkCore). Sin API remota propia. LinkCore no "orquesta" Cursor, en todo caso le entrega contexto (ver engine/handoff.js) para reducir la friccion de usarlo aparte.',
  },
  {
    id: 'windsurf', name: 'Windsurf', category: 'ide',
    integrationType: 'manual-handoff',
    authRequired: null,
    notes: 'Mismo caso que Cursor: editor con IA propia, sin API remota. Mismo tratamiento -- handoff de contexto, no orquestacion remota.',
  },

  // ── CONSTRUCTORES NO-CODE ──
  {
    id: 'bubble', name: 'Bubble', category: 'no-code',
    integrationType: 'api-partial',
    authRequired: 'BUBBLE_API_TOKEN',
    notes: 'Data API real por app (CRUD sobre "Data Types" del usuario). No hay API para construir la logica visual/workflow completa desde cero -- eso es manual en su editor.',
  },
  {
    id: 'flutterflow', name: 'FlutterFlow', category: 'no-code',
    integrationType: 'api-partial',
    authRequired: 'FLUTTERFLOW_API_TOKEN',
    notes: 'FlutterFlow CLI/API cubre un subconjunto de acciones (exportar codigo, algunas operaciones de proyecto), no la construccion visual completa via API.',
  },
  {
    id: 'glide', name: 'Glide', category: 'no-code',
    integrationType: 'api',
    authRequired: 'GLIDE_API_TOKEN',
    notes: 'Glide Tables API: lectura/escritura real de datos de la app. La app en si se define en su editor visual, no via API.',
  },
  {
    id: 'adalo', name: 'Adalo', category: 'no-code',
    integrationType: 'api-partial',
    authRequired: 'ADALO_API_TOKEN',
    notes: 'API basica para colecciones de datos. Construccion visual de pantallas, manual en su editor.',
  },

  // ── BACKEND / DATOS ──
  {
    id: 'firebase', name: 'Firebase', category: 'backend',
    integrationType: 'api',
    authRequired: 'FIREBASE_SERVICE_ACCOUNT',
    notes: 'Admin SDK + REST APIs maduras: Firestore, Auth, Storage, Functions, Hosting -- automatizable de verdad con una service account.',
  },
  {
    id: 'supabase', name: 'Supabase', category: 'backend',
    integrationType: 'api',
    authRequired: 'SUPABASE_SERVICE_KEY',
    notes: 'REST/Postgres API completa, migraciones, Auth, Storage -- automatizable de verdad con la service key.',
  },
  {
    id: 'postgresql', name: 'PostgreSQL', category: 'database',
    integrationType: 'api',
    authRequired: 'DATABASE_URL',
    notes: 'Base de datos estandar. Automatizable via connection string -- LinkCore puede generar y (con credencial) ejecutar el esquema/migraciones.',
  },
  {
    id: 'mongodb', name: 'MongoDB', category: 'database',
    integrationType: 'api',
    authRequired: 'MONGODB_URI',
    notes: 'Igual que PostgreSQL: automatizable via driver/API con URI de conexion.',
  },

  // ── CONTROL DE VERSIONES ──
  {
    id: 'git', name: 'Git', category: 'vcs',
    integrationType: 'manual-handoff',
    authRequired: null,
    notes: 'Git en si es un CLI local, no un servicio remoto -- lo que se automatiza de verdad es el PROVEEDOR (GitHub/GitLab/Bitbucket), no Git como herramienta aislada.',
  },
  {
    id: 'github', name: 'GitHub', category: 'vcs',
    integrationType: 'api',
    authRequired: 'GITHUB_TOKEN',
    notes: 'REST/GraphQL API completa: crear repos, commits, PRs, releases, Actions -- automatizable de verdad con un Personal Access Token o GitHub App.',
  },
  {
    id: 'gitlab', name: 'GitLab', category: 'vcs',
    integrationType: 'api',
    authRequired: 'GITLAB_TOKEN',
    notes: 'API equivalente a GitHub: repos, MRs, pipelines CI/CD.',
  },
  {
    id: 'bitbucket', name: 'Bitbucket', category: 'vcs',
    integrationType: 'api',
    authRequired: 'BITBUCKET_APP_PASSWORD',
    notes: 'API equivalente, mas limitada en algunos endpoints que GitHub/GitLab.',
  },

  // ── TESTING Y DISTRIBUCION ──
  {
    id: 'testflight', name: 'TestFlight', category: 'mobile-testing',
    integrationType: 'api-partial',
    authRequired: 'APP_STORE_CONNECT_KEY',
    notes: 'Parte de la App Store Connect API de Apple. Subir un build y gestionar testers es automatizable; la REVISION de Apple (obligatoria antes de distribuir a testers externos) es un proceso humano de horas/dias, no una llamada sincrona.',
  },
  {
    id: 'google-play-beta', name: 'Google Play Beta Testing', category: 'mobile-testing',
    integrationType: 'api',
    authRequired: 'GOOGLE_PLAY_SERVICE_ACCOUNT',
    notes: 'Google Play Developer API: subir builds, gestionar tracks de testing. Automatizable, aunque tambien pasa por revision (mas rapida que Apple mas no instantanea).',
  },
  {
    id: 'postman', name: 'Postman', category: 'testing',
    integrationType: 'api',
    authRequired: 'POSTMAN_API_KEY',
    notes: 'API publica real para gestionar colecciones/entornos/mocks -- util para que LinkCore genere y mantenga la documentacion de API de lo que construye.',
  },

  // ── PUBLICACION ──
  {
    id: 'google-play-console', name: 'Google Play Console', category: 'publishing',
    integrationType: 'api',
    authRequired: 'GOOGLE_PLAY_SERVICE_ACCOUNT',
    notes: 'Google Play Developer API cubre publicacion real (subir APK/AAB, gestionar listado, releases por track). Sujeta a revision de Google antes de quedar publica.',
  },
  {
    id: 'apple-developer-program', name: 'Apple Developer Program', category: 'publishing',
    integrationType: 'manual-handoff',
    authRequired: 'APP_STORE_CONNECT_KEY',
    notes: 'No es una API en si -- es la membresia/cuenta que habilita App Store Connect API (donde SI vive la automatizacion real: certificados, provisioning, envio a revision). Alta de la membresia y aceptacion de terminos es 100% manual, una vez, fuera de cualquier automatizacion posible.',
  },
];

function getTool(id) {
  return TOOLCHAIN.find(function (t) { return t.id === id; }) || null;
}

function getByCategory(category) {
  return TOOLCHAIN.filter(function (t) { return t.category === category; });
}

function getByIntegrationType(type) {
  return TOOLCHAIN.filter(function (t) { return t.integrationType === type; });
}

// Resumen honesto para mostrar antes de prometer nada: cuantas
// herramientas son de verdad automatizables hoy (con secreto
// configurado) vs. cuantas solo pueden recibir archivos generados o
// requieren accion humana directa.
function summarize() {
  var byType = {};
  TOOLCHAIN.forEach(function (t) {
    byType[t.integrationType] = (byType[t.integrationType] || 0) + 1;
  });
  return {
    total: TOOLCHAIN.length,
    byIntegrationType: byType,
    needsSecret: TOOLCHAIN.filter(function (t) { return !!t.authRequired; }).map(function (t) { return { id: t.id, secret: t.authRequired }; }),
    // Automatizable de verdad HOY significa: tiene tipo 'api' o
    // 'api-partial' Y su secreto ya esta configurado como wrangler
    // secret en el Worker. Este modulo no sabe que secretos existen
    // de verdad en el Worker -- esa comprobacion vive en el lado del
    // Worker, nunca aqui, para no filtrar ni insinuar su presencia
    // desde el cliente.
  };
}

export {
  TOOLCHAIN,
  getTool,
  getByCategory,
  getByIntegrationType,
  summarize,
};
