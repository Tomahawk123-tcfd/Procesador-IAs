// ── WORKER PYTHON PERSISTENTE (2026-08-18) ──
// Cuello de botella real, MEDIDO en vivo antes de escribir una linea de
// este archivo (12 cores, AMD Ryzen 5 6600HS, misma maquina):
//
//   verificacion solo texto ............. 0.03ms   ->  29.798/seg
//   verificacion con bloque JavaScript ... 0.02ms   ->  59.242/seg
//   verificacion con bloque Python ..... 740.54ms   ->       1/seg
//
// Un factor de ~25.000x. La causa no es el analisis en si (ast.parse es
// instantaneo): es que code-verify.js arranca DOS interpretes de Python
// completos por cada verificacion -- uno en checkPythonSyntax() y otro en
// checkPythonApiExistence() -- y en Windows el arranque en frio de Python
// domina por completo el coste. A eso se suma escribir y borrar un archivo
// temporal por llamada.
//
// Para un procesador que aspira a verificar salidas de IA a escala real,
// 1 verificacion/segundo no es una limitacion menor: es inviable. Se aplica
// el mismo patron ya probado esta misma noche en local-inference-child.js
// (proceso persistente reutilizado en vez de spawn por llamada), que alli
// convirtio ~8s de arranque por llamada en un arranque unico.
//
// Protocolo: JSON por lineas sobre stdin/stdout. El codigo viaja en base64
// para que ningun salto de linea, comilla o caracter fuera de ASCII pueda
// romper el encuadre de mensajes -- Windows con cp1252 por defecto hace
// esto un riesgo real, no teorico.
//
// Garantia de seguridad, identica a la del codigo que sustituye: el codigo
// del usuario NUNCA se ejecuta. Solo ast.parse() (analiza gramatica) e
// importlib sobre modulos de la libreria estandar (filtrado por
// sys.stdlib_module_names), exactamente como hacia code-verify.js.

import { spawn } from 'node:child_process';

var PYTHON_SERVER = [
  'import sys, json, base64, ast, importlib',
  '',
  'stdlib = set(getattr(sys, "stdlib_module_names", []))',
  '',
  'def check_syntax(code):',
  '  try:',
  '    ast.parse(code)',
  '    return {"ok": True, "error": None}',
  '  except SyntaxError as e:',
  '    return {"ok": False, "error": str(e)}',
  '  except Exception:',
  '    return {"ok": None, "error": None}',
  '',
  'def check_api(code):',
  '  try:',
  '    tree = ast.parse(code)',
  '  except SyntaxError:',
  '    return []',
  '  except Exception:',
  '    return []',
  '  for node in ast.walk(tree):',
  '    for child in ast.iter_child_nodes(node):',
  '      child._parent = node',
  '  imported = {}',
  '  for node in ast.walk(tree):',
  '    if isinstance(node, ast.Import):',
  '      for alias in node.names:',
  '        imported[alias.asname or alias.name] = alias.name',
  '  def dotted(node):',
  '    if isinstance(node, ast.Name): return [node.id]',
  '    if isinstance(node, ast.Attribute):',
  '      base = dotted(node.value)',
  '      return (base + [node.attr]) if base else None',
  '    return None',
  '  findings = set()',
  '  for node in ast.walk(tree):',
  '    if not isinstance(node, ast.Attribute): continue',
  '    if isinstance(getattr(node, "_parent", None), ast.Attribute): continue',
  '    parts = dotted(node)',
  '    if not parts or len(parts) < 2: continue',
  '    base = parts[0]',
  '    if base not in imported: continue',
  '    modname = imported[base]',
  '    if modname.split(".")[0] not in stdlib: continue',
  '    try:',
  '      obj = importlib.import_module(modname)',
  '    except Exception:',
  '      continue',
  '    ok = True',
  '    resolved = modname',
  '    for p in parts[1:-1]:',
  '      if hasattr(obj, p):',
  '        obj = getattr(obj, p); resolved += "." + p',
  '      else:',
  '        try:',
  '          resolved += "." + p; obj = importlib.import_module(resolved)',
  '        except Exception:',
  '          ok = False; break',
  '    if not ok: continue',
  '    if not hasattr(obj, parts[-1]):',
  '      findings.add(".".join(parts))',
  '  return sorted(findings)',
  '',
  'sys.stdout.write(json.dumps({"ready": True}) + "\\n")',
  'sys.stdout.flush()',
  '',
  'while True:',
  '  line = sys.stdin.readline()',
  '  if not line: break',
  '  line = line.strip()',
  '  if not line: continue',
  '  try:',
  '    req = json.loads(line)',
  '  except Exception:',
  '    continue',
  '  rid = req.get("id")',
  '  op = req.get("op")',
  '  try:',
  '    code = base64.b64decode(req.get("code", "")).decode("utf-8", "replace")',
  '  except Exception:',
  '    code = ""',
  '  try:',
  '    if op == "syntax":',
  '      result = check_syntax(code)',
  '    elif op == "api":',
  '      result = check_api(code)',
  '    else:',
  '      result = None',
  '  except Exception:',
  '    result = None',
  '  sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\\n")',
  '  sys.stdout.flush()',
].join('\n');

var READY_TIMEOUT_MS = 10000;
var REQUEST_TIMEOUT_MS = 5000;
// Si el interprete muere repetidamente (Python roto, antivirus matando el
// proceso, etc.) no se reintenta indefinidamente: tras agotar los intentos
// se marca como no disponible y code-verify.js cae a su comportamiento
// historico de "no verificar" en vez de reintentar en cada llamada.
var MAX_SPAWN_ATTEMPTS = 3;

var worker = null;
var spawnAttempts = 0;
var permanentlyUnavailable = false;
var pending = new Map();
var nextId = 1;
var readyPromise = null;

function cleanupWorker(err) {
  var dead = worker;
  worker = null;
  readyPromise = null;
  // Toda peticion en vuelo se resuelve como "no verificado" (null), NUNCA
  // como "verificado y limpio" -- fingir un resultado limpio porque el
  // worker murio seria exactamente la fabricacion que este proyecto
  // prohibe.
  pending.forEach(function (entry) {
    clearTimeout(entry.timer);
    entry.resolve({ unavailable: true, reason: (err && err.message) || 'worker_terminado' });
  });
  pending.clear();
  if (dead) {
    try { dead.kill(); } catch (e) {}
  }
}

function startWorker() {
  if (permanentlyUnavailable) return Promise.resolve(false);
  if (readyPromise) return readyPromise;

  spawnAttempts++;
  if (spawnAttempts > MAX_SPAWN_ATTEMPTS) {
    permanentlyUnavailable = true;
    return Promise.resolve(false);
  }

  readyPromise = new Promise(function (resolve) {
    var proc;
    try {
      proc = spawn('python', ['-u', '-c', PYTHON_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      permanentlyUnavailable = spawnAttempts >= MAX_SPAWN_ATTEMPTS;
      resolve(false);
      return;
    }

    var settled = false;
    var buffer = '';
    var readyTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (e) {}
      resolve(false);
    }, READY_TIMEOUT_MS);

    proc.stdout.on('data', function (chunk) {
      buffer += chunk.toString('utf8');
      var idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        var line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        var msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.ready) {
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            worker = proc;
            resolve(true);
          }
          continue;
        }
        var entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve({ unavailable: false, result: msg.result });
        }
      }
    });

    // stderr se consume para que el buffer del SO no se llene y bloquee al
    // proceso hijo; no se trata como error (Python puede escribir avisos).
    proc.stderr.on('data', function () {});

    proc.on('error', function (err) {
      if (!settled) {
        settled = true;
        clearTimeout(readyTimer);
        resolve(false);
      }
      cleanupWorker(err);
    });

    proc.on('exit', function () {
      if (!settled) {
        settled = true;
        clearTimeout(readyTimer);
        resolve(false);
      }
      cleanupWorker(new Error('python_worker_exit'));
    });
  });

  return readyPromise;
}

// Envia una peticion al worker. Devuelve {unavailable:true} cuando no se
// pudo verificar por cualquier motivo (Python ausente, worker caido,
// timeout) -- el llamador debe tratar eso como "no verificado", nunca como
// "verificado y correcto".
async function request(op, code) {
  var up = await startWorker();
  if (!up || !worker) return { unavailable: true, reason: 'python_no_disponible' };

  var id = nextId++;
  var payload = JSON.stringify({
    id: id,
    op: op,
    code: Buffer.from(code || '', 'utf8').toString('base64'),
  }) + '\n';

  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      pending.delete(id);
      // Un timeout deja al worker en estado desconocido (podria responder
      // tarde y descuadrar respuestas futuras): se recicla el proceso.
      cleanupWorker(new Error('timeout'));
      resolve({ unavailable: true, reason: 'timeout' });
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve: resolve, timer: timer });

    try {
      worker.stdin.write(payload);
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      cleanupWorker(e);
      resolve({ unavailable: true, reason: 'escritura_fallida' });
    }
  });
}

export async function pythonSyntaxCheck(code) {
  var res = await request('syntax', code);
  if (res.unavailable || !res.result) return { ok: null, error: null };
  return { ok: res.result.ok, error: res.result.error };
}

export async function pythonApiCheck(code) {
  var res = await request('api', code);
  if (res.unavailable || !Array.isArray(res.result)) return [];
  return res.result;
}

export function isPythonWorkerAvailable() {
  return !permanentlyUnavailable;
}

export function shutdownPythonWorker() {
  permanentlyUnavailable = false;
  spawnAttempts = 0;
  var had = !!worker;
  cleanupWorker(new Error('shutdown_solicitado'));
  return had;
}
