// ═══ TASK DECOMPOSER ═══
// Descompone peticiones del usuario en subtareas concretas, cada una
// mapeada a una IA real del ecosistema. LinkCore decide que IA usar
// segun el sector, el usuario nunca elige.

// Bug real reportado en vivo (2026-07-28): estas regexes usaban palabras
// sueltas SIN limite de palabra (\b), asi que coincidian como SUBSTRING
// dentro de palabras normales sin relacion -- "funciona" contiene
// "funcion", "explicacion" contiene "explica", "rapido"/"terapia"
// contienen "api", "deseo" contiene "seo", "pico" contiene "pic",
// "codigo postal" disparaba Proyecto de Codigo. El resultado: frases
// cotidianas se clasificaban como tareas complejas y se mandaban al
// pipeline de orquestacion completo (minutos de duracion) en vez de una
// respuesta directa -- la causa real detras de "el proceso se queda a
// medias siempre". Cada palabra suelta (no frase con .*) lleva ahora \b
// en los dos lados; las frases con comodin (ej. "genera.*codigo") no lo
// necesitan, ya son especificas por construccion.
export var TASK_PATTERNS = [
  // ── VOZ / AUDIO ──
  {
    id: 'voice-over', sector: 'Audio',
    trigger: /voz en off|voice.?over|\bnarracion\b|\blocucion\b|grabar[^.:;!?\n]{0,40}voz|generar[^.:;!?\n]{0,40}audio|texto[^.:;!?\n]{0,40}audio|\btts\b|leer[^.:;!?\n]{0,40}texto|\bleeme\b|lee[^.:;!?\n]{0,40}esto|convertir[^.:;!?\n]{0,40}texto[^.:;!?\n]{0,40}audio|sintesis[^.:;!?\n]{0,40}vocal|audio[^.:;!?\n]{0,40}generado|\bpodcast\b|\blocutor\b/i,
    label: 'Voz en off / Locucion',
    narrative: 'Para crear una voz en off profesional, LinkCore orquesta un pipeline de 3 especialistas: primero un LLM redacta el guion optimizado para locucion, luego un modelo de razonamiento evalua el tono y ritmo, y finalmente un editor de contenido genera el guion final listo para TTS con pausas y entonacion marcadas.',
    steps: [
      { label: 'Redactar guion para locucion', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'El LLM optimiza el texto para ritmo, pausas y entonacion natural.' },
      { label: 'Evaluar tono y ritmo', ai: 'Claude Sonnet 4.5 / Gemini 3.1 Pro', category: 'reasoning', desc: 'Analiza la audiencia objetivo y ajusta el tono, velocidad y estilo de narracion.' },
      { label: 'Generar guion final para TTS', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'Entrega el guion formateado para TTS con indicaciones de pausa [...], entonacion y ritmo.' },
    ],
  },

  // ── CODIGO / DESARROLLO ──
  // Bug real reportado en vivo (2026-07-29): aunque ya llevaban \b, varias
  // de estas eran palabras sueltas de vocabulario tecnico comun (codigo,
  // programa, funcion, componente, react, api, html, css, bug, error,
  // deploy, github, vercel, debug, script) -- cualquier mencion incidental
  // ("dame un bloque de codigo de ejemplo", "tengo un error en mi
  // funcion", "que es una api") disparaba el pipeline COMPLETO de crear un
  // proyecto (planificar arquitectura + estructura + implementar +
  // testear, 4 pasos) y ademas activaba runCrew() por tener mas de 2
  // subtareas -- 6+ pasos y minutos de espera para lo que era una
  // pregunta o un snippet de ejemplo. Acotado a que el verbo de
  // creacion/construccion aparezca junto a un sustantivo de escala de
  // proyecto (app, proyecto, sistema, plataforma) -- igual que ya exige
  // isAppBuildRequest() en build-pipeline-planner.js para su propio
  // trigger, en vez de bastar con mencionar tecnologia.
  // Bug real, severo, encontrado en vivo (2026-08-12) -- mismo patron que
  // APP_TRIGGER en build-pipeline-planner.js: el `.*` sin limite cruzaba
  // frases enteras separadas por "." o ":". Reproducido con "Crea un plan
  // de dos pasos: primero resume que es una red neuronal, despues explica
  // una aplicacion practica" -- un resumen, sin proyecto de por medio --
  // clasificado como 'code-project' (4 pasos: arquitectura+codigo+
  // implementacion+testing) por tener "crea" al principio y "aplicacion"
  // en OTRA frase, tras los dos puntos. Mismo fix: la coincidencia no
  // cruza puntuacion de fin de frase, y exige articulo justo antes del
  // sustantivo de escala de proyecto sin que le siga un adjetivo que lo
  // delate como abstracto ("aplicacion PRACTICA" = el concepto, no un
  // proyecto de software).
  {
    id: 'code-project', sector: 'Desarrollo',
    trigger: /\b(crea|programa|desarrolla|construye|implementa|monta|lanza)\b[^.:;!?\n]{0,40}\b(?:una?|el|la|mi|esta|nuestro|nuestra)\s+(app|aplicaci[oó]n|proyecto|sistema|plataforma|producto)\b(?!\s+(pr[aá]ctica|te[oó]rica|conceptual))|\bnuevo\s+proyecto\b|\b(create|build)\b[^.:;!?\n]{0,40}\b(?:an?|the|my)\s+(app|project)\b/i,
    label: 'Proyecto de Codigo',
    narrative: 'LinkCore actua como un equipo de desarrollo completo: un arquitecto planifica la estructura, un programador genera el codigo, un revisor auditara la calidad, y un DevOps prepara el despliegue. Cada paso usa la IA mas adecuada para ese rol.',
    steps: [
      { label: 'Planificar arquitectura y estructura', ai: 'Claude Opus 4.8 / o3', category: 'reasoning', desc: 'Analiza requisitos, define stack tecnologico, estructura de archivos y dependencias.' },
      { label: 'Generar estructura del proyecto', ai: 'Qwen3 Coder 480B / StarCoder2', category: 'code', desc: 'Crea archivos base, configuracion, layout y componentes fundamentales.' },
      { label: 'Implementar logica principal', ai: 'DeepSeek Coder V2 / CodeLlama 70B', category: 'code', desc: 'Desarrolla la funcionalidad core, integraciones y flujo de datos.' },
      { label: 'Revisar y testear codigo', ai: 'SWE-agent / Aider', category: 'code', desc: 'Ejecuta tests, detecta bugs, sugiere mejoras y verifica seguridad.' },
    ],
  },

  // Bug real, sistemico, confirmado en vivo (2026-08-13): el fix de arriba
  // (code-project, `.*` -> `[^.:;!?\n]{0,40}`) se aplico ese dia solo a ESE
  // trigger -- una auditoria completa del resto del archivo hoy encontro el
  // MISMO `.*` sin limite, vivo, en las otras 12 plantillas de abajo
  // (voice-over, design-project, document-creation, data-analysis,
  // translation, image-generation, video-creation, email-draft,
  // seo-analysis, music-generation, website-audit, summarization).
  // Reproducido: "Revisa mi agenda de reuniones de esta semana, y de paso
  // dime que opinas sobre el diseno de una web moderna en general" disparaba
  // 'website-audit' (trigger `mi.*web` cruzando la coma hasta la otra
  // frase). Mismo fix en las 12: `X.*Y` -> `X[^.:;!?\n]{0,40}Y`, no cruza
  // puntuacion de fin de frase.

  // ── INVESTIGACION ──
  {
    id: 'deep-research', sector: 'Investigación',
    // "explica" se queda con \b en los dos lados a proposito (no solo a la
    // izquierda como investiga/estudia): "explicacion" -- muy comun en
    // conversacion normal -- empieza igual que "explicar"/"explicando", asi
    // que soltar el limite derecho volvia a capturarla por error. Coste
    // aceptado: "estoy explicando X" no dispara esta plantilla; ese caso es
    // mucho menos frecuente que el falso positivo que evita.
    // Bug real reportado en vivo (2026-07-29): "que es" sin limites disparaba
    // con CUALQUIER pregunta de la forma "que es X" -- el patron de pregunta
    // mas comun en español, la inmensa mayoria trivial (una definicion de una
    // frase), no una investigación de 4 pasos con busqueda+multimodal+
    // razonamiento+reporte. Eliminado: una pregunta "que es" real que
    // necesite investigación profunda sigue cubierta por \binvestiga,
    // \bestudia, deep.*dive, etc. si el usuario la pide como tal.
    //
    // Bug real, severo, encontrado en vivo (2026-08-12): explica/define/
    // encuentra/mejores/recomienda solos ya bastaban para disparar este
    // pipeline de 4 pasos CON BUSQUEDA WEB REAL -- "explica" es uno de los
    // verbos mas comunes del español, asi que cualquier explicacion
    // conceptual simple ("explica que es una red neuronal") se trataba como
    // investigacion de mercado. Reproducido en vivo con una query real que
    // tardo 47 minutos por esto (entre otros bugs de la misma familia).
    // Se dividen en dos niveles: las senales fuertes (investiga, estudia,
    // deep dive...) siguen dispiertando el pipeline solas; las debiles
    // (explica/define/encuentra/mejores/recomienda) solo lo hacen si la
    // query TAMBIEN tiene una señal real de que necesita informacion externa
    // actual (reciente, mercado, tendencias, precios, comparar, fuentes...).
    // "explica que es X" -> camino simple. "explica las tendencias mas
    // recientes de X" -> investigacion real, con busqueda.
    trigger: {
      test: function (t) {
        var strong = /\binvestiga|\bresearch\b|busca informacion|analiza.*mercado|\bestudia|explora.*tema|deep.*dive|\breporte\b|informe.*detallado/i;
        var weakVerb = /\bdefine\b|\bexplica\b|\bencuentra\b|\bmejores\b|\brecomienda\b/i;
        var externalSignal = /\bactual(es|idad)?\b|\breciente(s)?\b|\b[uú]ltim[oa]s?\b|\bnoticias?\b|\bmercado\b|\bcompara(r|cion|ci[oó]n)?\b|\bfuentes?\b|\best[ao]d[ií]sticas?\b|\btendencias?\b|\bprecios?\b|\bdatos actualizados\b/i;
        return strong.test(t) || (weakVerb.test(t) && externalSignal.test(t));
      },
    },
    label: 'Investigación Profunda',
    narrative: 'Para una investigación completa, LinkCore coordina: un buscador web recopila fuentes actualizadas, un LLM analiza y clasifica la informacion, un razonador sintetiza hallazgos clave, y un escritor genera el reporte final estructurado.',
    steps: [
      { label: 'Buscar fuentes y datos relevantes', ai: 'Perplexica / Khoj', category: 'search', desc: 'Motor de busqueda AI recopila información actualizada de multiples fuentes.' },
      { label: 'Analizar y clasificar información', ai: 'Gemini 3.1 Pro / GPT-4o', category: 'multimodal', desc: 'Modelo multimodal procesa texto, imagenes y documentos para extraer datos clave.' },
      { label: 'Sintetizar hallazgos', ai: 'Claude Fable 5 / o3 Pro', category: 'reasoning', desc: 'Razonamiento profundo identifica patrones, contradicciones y conclusiones.' },
      { label: 'Generar reporte estructurado', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'Escritura profesional con intro, analisis, conclusiones y recomendaciones.' },
    ],
  },

  // ── DISENO UI/UX ──
  {
    id: 'design-project', sector: 'Diseño',
    trigger: /\bdisena|\bdiseno\b|crea[^.:;!?\n]{0,40}ui|disena[^.:;!?\n]{0,40}interfaz|disena[^.:;!?\n]{0,40}pantalla|\bux\b|ui[^.:;!?\n]{0,40}design|\bmockup\b|\bwireframe\b|\bprototipo\b|\blanding\b|pagina web|web app/i,
    label: 'Diseño UI/UX',
    narrative: 'El proceso de diseño combina: un investigador de tendencias, un planificador de interfaz, un generador de prompts visuales, y un iterador que refina hasta lograr la usabilidad perfecta.',
    steps: [
      { label: 'Investigar tendencias y benchmarks', ai: 'Perplexica / DSPy', category: 'search', desc: 'Analiza interfaces similares, tendencias actuales y mejores practicas del sector.' },
      { label: 'Planificar estructura y flujo', ai: 'Claude Opus 4.8 / o3', category: 'reasoning', desc: 'Define wireframe, navegacion, jerarquia de información y user flow.' },
      { label: 'Generar prompts de diseño visual', ai: 'Claude Sonnet 4.5 / GPT-4o', category: 'text', desc: 'Crea prompts detallados para generar mockups de alta fidelidad.' },
      { label: 'Refinar y iterar diseño', ai: 'Gemini 3.1 Pro / Claude Sonnet 4.5', category: 'text', desc: 'Analiza el diseño propuesto, sugiere mejoras de usabilidad y consistencia visual.' },
    ],
  },

  // ── DOCUMENTOS / ESCRITURA ──
  {
    // Bug real, confirmado en vivo (2026-08-13), encontrado verificando el
    // fix sistemico de arriba: `\bredacta\b` y `\barticulo\b` sueltos
    // ganaban SIEMPRE frente a plantillas mas especificas que aparecen
    // despues en el array (email-draft, summarization), porque
    // detectTaskType() usa "primera coincidencia gana" sobre un array
    // plano. Reproducido: "redacta un email profesional de seguimiento"
    // clasificaba como Documento/Contenido en vez de Email Profesional
    // (email-draft SI tenia el trigger correcto, `email.*profesional`, pero
    // nunca llegaba a evaluarse); "resume este articulo en 3 puntos clave"
    // clasificaba igual en vez de Resumen/Sintesis, por \barticulo\b solo.
    // `\bredacta\b` se quita por ser redundante ademas de daniño: contrato/
    // propuesta ya cubren "redacta un contrato/una propuesta" sin la
    // palabra generica. `\barticulo\b` se acota a que un verbo de creacion
    // lo preceda (igual que code-project exige verbo+sustantivo) -- "crea/
    // escribe/redacta/genera un articulo" sigue siendo Documento/Contenido,
    // pero "resume este articulo" ya no lo intercepta antes de sumarization.
    id: 'document-creation', sector: 'Documentos',
    trigger: /escribe[^.:;!?\n]{0,40}documento|crea[^.:;!?\n]{0,40}doc|genera[^.:;!?\n]{0,40}informe|\bpropuesta\b|\bcontrato\b|(?:escribe|crea|redacta|genera)[^.:;!?\n]{0,30}\barticulo\b|\bblog\b|\bcontenido\b|\bescritura\b|\bwriting\b|\bdraft\b|\bborrador\b|\bpresentacion\b|\bslides\b|\bdiapositiva\b|\bpitch\b|\bdeck\b/i,
    label: 'Documento / Contenido',
    narrative: 'LinkCore genera documentos profesionales usando: un planificador que estructura el contenido, un escritor especializado en el tipo de documento, un editor que pulsa gramatica y estilo, y un revisor final de calidad.',
    steps: [
      { label: 'Crear esquema y estructura', ai: 'Claude Fable 5 / o3', category: 'reasoning', desc: 'Define secciones, puntos clave, tono y formato segun el tipo de documento.' },
      { label: 'Redactar borrador completo', ai: 'DeepSeek V3 / Qwen3 235B', category: 'text', desc: 'Genera el contenido completo con argumentos, datos y narrativa coherente.' },
      { label: 'Revisar gramatica y estilo', ai: 'Claude Sonnet 4.5 / GPT-4o', category: 'text', desc: 'Corrige errores, mejora fluidez, ajusta tono y elimina redundancias.' },
      { label: 'Pulir formato y presentacion', ai: 'Gemini 3.1 Pro / Qwen3', category: 'text', desc: 'Aplica formato profesional, genera tablas, listas y estructura visual del documento.' },
    ],
  },

  // ── ANALISIS DE DATOS ──
  {
    id: 'data-analysis', sector: 'Datos',
    trigger: /analiza[^.:;!?\n]{0,40}datos|procesa[^.:;!?\n]{0,40}datos|\bgrafica\b|\bvisualiza\b|\bestadistica\b|data[^.:;!?\n]{0,40}analysis|\bdashboard\b|\bmetricas\b|\bkpi\b|\bexcel\b|\bcsv\b|hoja[^.:;!?\n]{0,40}calcul/i,
    label: 'Análisis de Datos',
    narrative: 'Para analizar datos, LinkCore coordina: un parser que extrae y limpia la informacion, un estadistico que calcula metricas clave, un visualizador que genera graficos, y un narrador que explica los insights encontrados.',
    steps: [
      { label: 'Extraer y limpiar datos', ai: 'SQLCoder / Pandas + Polars', category: 'data', desc: 'Parsea archivos, limpia valores nulos, normaliza formatos y prepara el dataset.' },
      { label: 'Calcular estadisticas y metricas', ai: 'DeepSeek R1 / o3-mini', category: 'reasoning', desc: 'Calcula distribuciones, correlaciones, tendencias y KPIs relevantes.' },
      { label: 'Generar visualizaciones', ai: 'CodeGemma / Matplotlib + Plotly', category: 'code', desc: 'Crea graficos de barras, lineas, scatter plots y dashboards interactivos.' },
      { label: 'Narrar insights y recomendaciones', ai: 'Claude Fable 5 / GPT-4o', category: 'text', desc: 'Interpreta los hallazgos en lenguaje claro con acciones concretas recomendadas.' },
    ],
  },

  // ── TRADUCCION ──
  // Bug real reportado en vivo (2026-07-29): "\bidioma\b" y "\blanguage\b"
  // sueltas disparaban con preguntas normales sobre el propio LinkCore
  // ("en que idioma respondes?", "what language do you speak") en vez de
  // una peticion real de traduccion. Eliminadas -- traduc/translate/
  // traduccion/al.*espanol etc. ya cubren la intencion real de traducir.
  {
    id: 'translation', sector: 'Multilingue',
    trigger: /\btraduc|\btranslate\b|\btraduccion\b|\btranslation\b|al[^.:;!?\n]{0,40}espanol|al[^.:;!?\n]{0,40}ingles|to[^.:;!?\n]{0,40}spanish|to[^.:;!?\n]{0,40}english/i,
    label: 'Traduccion',
    narrative: 'La traduccion usa un pipeline de precision: detección del idioma origen, traduccion contextual con LLM avanzado, revisión de coherencia cultural, y ajuste de terminologia tecnica si aplica.',
    steps: [
      { label: 'Detectar idioma y contexto', ai: 'Gemini 3.1 Pro / GPT-4o', category: 'multimodal', desc: 'Identifica idioma origen, destino, contexto cultural y dominio tecnico.' },
      { label: 'Traducir con contexto', ai: 'Claude Fable 5 / DeepSeek V3', category: 'text', desc: 'Traduce preservando tono, idiomaticos, matices culturales y terminologia.' },
      { label: 'Revisar coherencia', ai: 'Claude Sonnet 4.5 / Qwen3', category: 'text', desc: 'Verifica fluidez natural, gramatica correcta y consistencia terminologica.' },
    ],
  },

  // ── GENERACION DE IMAGEN ──
  {
    id: 'image-generation', sector: 'Visual',
    trigger: /genera[^.:;!?\n]{0,40}imagen|crea[^.:;!?\n]{0,40}imagen|\bdibuja\b|\billustra\b|image[^.:;!?\n]{0,40}generat|generat[^.:;!?\n]{0,40}image|\bpic\b|\bfoto\b|imagen[^.:;!?\n]{0,40}de|\bbanner\b|\blogo\b|\bicono\b/i,
    label: 'Generacion de Imagen',
    narrative: 'Para generar imagenes profesionales, LinkCore coordina: un LLM que optimiza el prompt visual con composicion, estilo e iluminacion detalladas, un analista que evalua la viabilidad tecnica, y un editor que genera el prompt final listo para usar en DALL-E, Midjourney o Flux.',
    steps: [
      { label: 'Optimizar prompt visual', ai: 'Claude Sonnet 4.5 / GPT-4o', category: 'text', desc: 'Transforma la descripcion en un prompt detallado optimizado para generacion de imagen.' },
      { label: 'Evaluar viabilidad tecnica', ai: 'Gemini 3.1 Pro / DeepSeek R1', category: 'reasoning', desc: 'Analiza si el prompt es viable, sugiere ajustes de composicion y estilo.' },
      { label: 'Generar prompt final', ai: 'Claude Sonnet 4.5 / Qwen3', category: 'text', desc: 'Entrega el prompt formateado y listo para copiar en tu generador de imagenes favorito.' },
    ],
  },

  // ── VIDEO ──
  {
    id: 'video-creation', sector: 'Video',
    trigger: /genera[^.:;!?\n]{0,40}video|crea[^.:;!?\n]{0,40}video|video[^.:;!?\n]{0,40}explicativo|\banimacion\b|\banimate\b|\bmotion\b|promo[^.:;!?\n]{0,40}video|\breel\b|\btiktok\b|\byoutube\b/i,
    label: 'Video / Animacion',
    narrative: 'Para crear videos profesionales, LinkCore coordina: un guionista que genera el contenido narrativo, un planificador visual que define storyboard y composiciones, y un editor que ensambla el brief de produccion final.',
    steps: [
      { label: 'Escribir guion del video', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'Genera guion con estructura narrativa, tiempos y indicaciones visuales.' },
      { label: 'Planificar storyboard visual', ai: 'Claude Sonnet 4.5 / Gemini 3.1 Pro', category: 'text', desc: 'Define frames clave, composiciones, transiciones y flujo visual.' },
      { label: 'Generar brief de produccion', ai: 'Claude Sonnet 4.5 / GPT-4o', category: 'text', desc: 'Entrega el brief completo con especificaciones tecnicas, tiempos y asset list.' },
    ],
  },

  // ── EMAIL ──
  {
    id: 'email-draft', sector: 'Comunicacion',
    trigger: /escribe[^.:;!?\n]{0,40}email|redacta[^.:;!?\n]{0,40}correo|email[^.:;!?\n]{0,40}profesional|correo[^.:;!?\n]{0,40}formal|email[^.:;!?\n]{0,40}seguimiento|draft[^.:;!?\n]{0,40}email|borrador[^.:;!?\n]{0,40}email|\bcorreo\b|\bemail\b/i,
    label: 'Email Profesional',
    narrative: 'Para redactar emails, LinkCore analiza el contexto de la comunicacion, genera un borrador con el tono adecuado, y revisa que la propuesta sea clara y profesional.',
    steps: [
      { label: 'Analizar contexto y audiencia', ai: 'Claude Fable 5 / Gemini 3.1 Pro', category: 'text', desc: 'Evalua la relacion con el destinatario, urgencia y objetivo del email.' },
      { label: 'Redactar email con tono adecuado', ai: 'DeepSeek V3 / Claude Sonnet 4.5', category: 'text', desc: 'Genera el borrador con saludo, cuerpo, CTA y cierre apropiados.' },
      { label: 'Revisar y pulir', ai: 'Claude Sonnet 4.5 / GPT-4o', category: 'text', desc: 'Corrige gramatica, ajusta longitud, verifica claridad y profesionalismo.' },
    ],
  },

  // ── SEO ──
  {
    id: 'seo-analysis', sector: 'Marketing',
    trigger: /\bseo\b|\bposicionamiento\b|search[^.:;!?\n]{0,40}engine|meta[^.:;!?\n]{0,40}tag|\bkeyword\b|\branking\b|trafico[^.:;!?\n]{0,40}web|optimiza[^.:;!?\n]{0,40}buscador|contenido[^.:;!?\n]{0,40}seo/i,
    label: 'Análisis SEO',
    narrative: 'El análisis SEO coordina: un auditor tecnico que revisa la web, un investigador de keywords, un estratega de contenido, y un optimizador que aplica las mejoras.',
    steps: [
      { label: 'Auditoria tecnica SEO', ai: 'Browser Use + Crawl4AI', category: 'browser', desc: 'Rastrea la web analizando meta tags, estructura, velocidad y problemas tecnicos.' },
      { label: 'Investigar keywords', ai: 'Perplexica + DSPy', category: 'search', desc: 'Identifica keywords de alto volumen, competencia y relevancia para el sector.' },
      { label: 'Estrategia de contenido', ai: 'Claude Fable 5 / o3', category: 'reasoning', desc: 'Planifica calendario editorial, tipos de contenido y estructura de paginas.' },
      { label: 'Generar contenido optimizado', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'Escribe contenido SEO-friendly con keywords naturales y estructura H1-H6.' },
    ],
  },

  // ── MUSICA ──
  {
    id: 'music-generation', sector: 'Musica',
    trigger: /genera[^.:;!?\n]{0,40}musica|crea[^.:;!?\n]{0,40}cancion|background[^.:;!?\n]{0,40}music|musica[^.:;!?\n]{0,40}de[^.:;!?\n]{0,40}fondo|\bsoundtrack\b|banda[^.:;!?\n]{0,40}sonora|\bjingle\b|\bbeat\b|\binstrumental\b/i,
    label: 'Musica / Audio',
    narrative: 'Para crear musica, LinkCore define el concepto musical con un LLM especializado, genera la composicion con especificaciones tecnicas detalladas, y entrega un brief listo para usar en herramientas de generacion como Suno o MusicGen.',
    steps: [
      { label: 'Definir concepto musical', ai: 'Claude Sonnet 4.5 / GPT-4o', category: 'text', desc: 'Establece genero, tempo, tono, instrumentacion y mood de la pieza.' },
      { label: 'Generar composicion detallada', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'Define estructura (intro, verso, coro, bridge), progresion de acordes y arreglo.' },
      { label: 'Crear brief para generacion', ai: 'Claude Sonnet 4.5 / Qwen3', category: 'text', desc: 'Entrega el brief formateado con prompt listo para Suno, MusicGen u otra herramienta.' },
    ],
  },

  // ── AUDITORIA WEB ──
  {
    id: 'website-audit', sector: 'Tecnologia',
    trigger: /analiza[^.:;!?\n]{0,40}sitio|audita[^.:;!?\n]{0,40}web|revisa[^.:;!?\n]{0,40}pagina|website[^.:;!?\n]{0,40}audit|check[^.:;!?\n]{0,40}site|mi[^.:;!?\n]{0,40}web|mi[^.:;!?\n]{0,40}pagina|\brendimiento\b|\bperformance\b/i,
    label: 'Auditoria Web',
    narrative: 'La auditoria web incluye: un rastreador que analiza la estructura, un evaluador de rendimiento, un revisor de accesibilidad, y un generador de recomendaciones.',
    steps: [
      { label: 'Rastrear y mapear la web', ai: 'Browser Use + Firecrawl', category: 'browser', desc: 'Recorre todas las paginas, captura estructura, enlaces y contenido.' },
      { label: 'Analizar rendimiento y SEO', ai: 'Lighthouse + PageSpeed', category: 'data', desc: 'Mide Core Web Vitals, velocidad, mobile-friendliness y SEO score.' },
      { label: 'Revisar accesibilidad', ai: 'axe-core + pa11y', category: 'data', desc: 'Verifica WCAG compliance, contraste de colores, ARIA labels y navegacion.' },
      { label: 'Generar recomendaciones', ai: 'Claude Fable 5 / o3', category: 'reasoning', desc: 'Prioriza hallazgos por impacto y genera plan de accion concreto.' },
    ],
  },

  // ── RESUMEN ──
  {
    id: 'summarization', sector: 'Productividad',
    // \bresumir\b (2026-08-13): "resume"/"resumen" no cubren el infinitivo
    // -- "puedes resumir el articulo que te pegue arriba" no coincidia con
    // ningun trigger del archivo (verificado en vivo), un hueco real de
    // conjugacion, no solo de "resume".
    trigger: /\bresume\b|\bresumir\b|\bresumen\b|\babstract\b|\bsintesis\b|\bsynth\b|que dice|contenid[^.:;!?\n]{0,40}de[^.:;!?\n]{0,40}esto|explica[^.:;!?\n]{0,40}esto|resume[^.:;!?\n]{0,40}esto|puntos clave/i,
    label: 'Resumen / Síntesis',
    narrative: 'Para resumir contenido, LinkCore extrae el texto, lo analiza con un LLM de razonamiento, genera un resumen jerarquico, y verifica la precision de los puntos clave.',
    steps: [
      { label: 'Extraer contenido completo', ai: 'Marker + Surya OCR', category: 'doc', desc: 'Extrae texto de PDFs, imagenes, web o documentos con OCR si es necesario.' },
      { label: 'Analizar y priorizar información', ai: 'Claude Fable 5 / o3', category: 'reasoning', desc: 'Identifica puntos clave, argumentos principales y conclusiones.' },
      { label: 'Generar resumen estructurado', ai: 'DeepSeek V3 / Qwen3', category: 'text', desc: 'Crea resumen con intro, puntos clave, detalles relevantes y conclusion.' },
    ],
  },
];

export function detectTaskType(query) {
  var t = query.toLowerCase();
  for (var i = 0; i < TASK_PATTERNS.length; i++) {
    if (TASK_PATTERNS[i].trigger.test(t)) return TASK_PATTERNS[i];
  }
  return null;
}

export function decomposeTask(query) {
  var task = detectTaskType(query);
  if (!task) return null;
  return {
    taskType: task.id,
    sector: task.sector,
    label: task.label,
    narrative: task.narrative,
    originalQuery: query,
    subtasks: task.steps.map(function (step, i) {
      return {
        id: i,
        label: step.label,
        ai: step.ai,
        category: step.category,
        desc: step.desc,
        status: 'pending',
        result: null,
      };
    }),
  };
}

export function isComplexTask(query) {
  var t = query.toLowerCase();
  // Bug real reportado en vivo (2026-08-03): el patron exigia que la frase
  // EMPEZARA por el verbo ("^analiza"), asi que "haz un analisis de X" o
  // "quiero un analisis de X" -- formas perfectamente naturales de pedir
  // lo mismo -- nunca disparaban el orquestador. La peticion caia al
  // camino plano, que a su vez podia degradar a un solo modelo pequeño
  // (ver el bug de contencion de CPU ya documentado en ensemble-v2.js) --
  // resultado: una "analisis de mercado" respondida por un modelo de
  // 500M sin ensemble ni orquestacion real. Se añade \banalisis\b como
  // señal independiente del verbo, sin exigir que abra la frase.
  var complexIndicators = [/^genera|^crea|^programa|^desarrolla|^construye|^disena|^investiga|^analiza|\banalisis\b|\banálisis\b|^escribe.*informe|^prepara|^organiza|^planifica|^voz en off|^crea.*app|^genera.*video|^traduc/i];
  // Bug real reportado en vivo (2026-07-28): con 80 como umbral, CUALQUIER
  // frase normal de mas de una linea disparaba el pipeline de orquestacion
  // completo (multi-paso, multi-modelo, minutos de duracion) en vez de una
  // respuesta directa. "¿Puedes ayudarme a entender como funciona esto?"
  // ya supera 80 caracteres sin ser una tarea compleja. Subido a un umbral
  // que de verdad distingue una peticion sustancial (varias frases, un
  // encargo con partes) de una pregunta normal, aunque sea larga.
  return complexIndicators.some(function (r) { return r.test(t); }) || t.length > 200;
}

// Clasificador simple-vs-compleja (2026-08-09), pedido explicitamente: usar
// LinkCore en TODAS las preguntas, pero que internamente decida si basta con
// una sola IA (pregunta corta de hecho puntual) o hace falta intermediacion +
// ensemble completo (todo lo demas). Deliberadamente estrecho y basado en
// una lista blanca, no en una lista negra -- lo contrario (intentar detectar
// "complejidad" con negaciones) es exactamente el tipo de regex fragil que
// ya causo falsos positivos/negativos reales hoy en coherence-verify.js. En
// caso de duda, NO es simple -- pasa por el ensemble completo, que es la
// norma pedida; "simple" es la excepcion, no al reves.
// Bug real, encontrado en vivo (2026-08-10) probando este clasificador con
// preguntas analiticas cortas: dos ramas dejaban el texto TRAS la palabra
// clave sin acotar (".*"), asi que cualquier frase que empezara igual que
// una consulta simple colaba una pregunta de fondo real como si fuera un
// hecho puntual -- mismo patron que ya causo 4 bugs reales hoy en otros
// clasificadores (crew.js, translation.js). Confirmado con isSimpleQuery()
// real: "¿Que significa la subida del dolar para la inflacion?" (una
// pregunta de implicacion economica, no una definicion de vocabulario) y
// "¿Cuantos electrones hay en un atomo con espin desapareado?" (fisica,
// no conversion de unidades) daban isSimpleQuery=true -- se habrian
// respondido con un solo modelo de 300 tokens en vez del ensemble
// completo. Se acota "que significa" a un termino corto (1-3 palabras,
// como una definicion de diccionario real) y "cuantos X hay en un Y" a
// una unidad corta (1-2 palabras), ambas ancladas al final de la frase
// ($) -- una pregunta con mas contenido despues ya no coincide.
var SIMPLE_INDICATORS = /^(qu[eé] hora es|qu[eé] d[ií]a es|en qu[eé] (fecha|d[ií]a|mes|a[ñn]o) estamos|cu[aá]l es la capital de|qu[eé] significa\s+(la palabra\s+|el t[eé]rmino\s+)?["']?[\wáéíóúñü-]+(\s+[\wáéíóúñü-]+){0,2}["']?\s*[?.!]*$|sin[oó]nimo(s)? de|ant[oó]nimo(s)? de|c[oó]mo se dice .* en (ingl[eé]s|espa[ñn]ol|franc[eé]s|alem[aá]n|italiano|portugu[eé]s)|traduce ".*" (a|al)|cu[aá]nto es \d|cu[aá]nto(s|as)?\s+[\wáéíóúñü-]+\s+hay\s+en\s+(un|una)\s+[\wáéíóúñü-]+(\s+[\wáéíóúñü-]+)?\s*[?.!]*$|convierte \d)/i;
export function isSimpleQuery(query) {
  var t = (query || '').trim();
  if (!t || t.length > 60) return false;
  if (isComplexTask(t)) return false; // los indicadores de complejidad ya existentes tienen prioridad sobre cualquier coincidencia simple
  // Bug real, encontrado probando este clasificador: SIMPLE_INDICATORS
  // ancla con ^ al inicio del texto, pero una pregunta real en español
  // casi siempre empieza con "¿" ANTES de la palabra clave ("¿Qué hora
  // es...") -- el ancla nunca coincidia con ninguna pregunta real,
  // solo con frases sin signo de apertura. Se quita el signo de apertura
  // (¿/¡) y espacios sueltos antes de comparar.
  var stripped = t.replace(/^[¿¡\s]+/, '');
  return SIMPLE_INDICATORS.test(stripped.toLowerCase());
}
