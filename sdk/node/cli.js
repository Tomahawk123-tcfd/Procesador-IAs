#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// LINKCORE CLI — via SDK
// Usage: linkcore "hazme un login con JWT"
// ═══════════════════════════════════════════════════════════════

import { LinkCore } from './index.js';

var args = process.argv.slice(2);
var json = args.includes('--json');
var query = args.filter(a => a !== '--json').join(' ');

if (!query) {
  console.log('Usage: linkcore "tu pregunta" [--json]');
  process.exit(1);
}

var lc = new LinkCore();

try {
  var result = await lc.ask(query);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.text);
    console.log('');
    console.log('— ' + result.model + ' (' + result.provider + ') ' + result.latencyMs + 'ms');
  }
} catch (e) {
  if (e.message === 'linkcore_not_running') {
    console.error('LinkCore no está corriendo. Arranca con: linkcore start');
  } else {
    console.error('Error: ' + e.message);
  }
  process.exitCode = 1;
}
