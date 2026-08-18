import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var MODEL_PATH = 'C:\\Users\\tomas\\.ollama\\models\\blobs\\sha256-f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57';

var child = fork(path.join(__dirname, 'debug-child-timing-test.mjs'), [], {
  env: Object.assign({}, process.env, { LC_MODEL_PATH: MODEL_PATH }),
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

child.on('message', function (msg) {
  console.log('[PARENT] got:', JSON.stringify(msg));
  if (msg.type === 'ready_for_ipc_test') {
    console.log('[PARENT] sending IPC prompt #1');
    child.send({ type: 'prompt', id: 1, prompt: 'Cuenta hasta tres.' });
  } else if (msg.type === 'result') {
    console.log('[PARENT] got result, id=' + msg.id + ', ok=' + msg.ok);
    if (msg.id < 3) {
      console.log('[PARENT] sending IPC prompt #' + (msg.id + 1));
      child.send({ type: 'prompt', id: msg.id + 1, prompt: 'Nombra un color.' });
    } else {
      console.log('ALL_DONE');
      child.kill();
      process.exit(0);
    }
  }
});

child.on('exit', function (code, signal) {
  console.log('[PARENT] child exit code=' + code + ' signal=' + signal);
  process.exit(0);
});

setTimeout(function () {
  console.log('[PARENT] GLOBAL TIMEOUT 3min');
  child.kill();
  process.exit(1);
}, 3 * 60 * 1000);
