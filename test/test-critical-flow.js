import { installGlobalShim } from '../src/memory-bus.js';
installGlobalShim();

import { addMemory, getMemoryContext, clearMemory } from '../src/tools.js';
import { selectDiverseOllama } from '../src/engine/ollama-catalog.js';

console.log('=== TEST LINKCORE CRITICAL FLOW & MEMORY SANITIZATION ===\n');

// 1. Probando Sanitización de Memoria
clearMemory();

console.log('1. Probando desinfección de eco en memoria...');
addMemory('user', '¿Qué es un semáforo en programación?');
addMemory('assistant', 'Un semáforo es una variable o tipo abstracto de datos...\n---\nConversaciones futuras:\nUsuario: hola');
addMemory('assistant', 'Un semáforo es un mecanismo de sincronización que controla el acceso a recursos compartidos.');

var ctx = getMemoryContext();
console.log('  [Contexto de memoria resultante]:');
console.log(ctx ? ctx : '(vacío)');

if (ctx && ctx.indexOf('Conversaciones futuras') === -1 && ctx.indexOf('---') === -1) {
  console.log('  ✅ ÉXITO: El eco del system prompt fue bloqueado correctamente.\n');
} else {
  console.error('  ❌ ERROR: El eco del prompt no se bloqueó.\n');
}

// 2. Probando Selección Inteligente de Modelos (Awesome-LLM & Tier Preference)
console.log('2. Probando selección inteligente de modelos (preferCapability)...');
var selCapable = selectDiverseOllama('code', 1, [], { preferCapability: true });
console.log('  Modelos seleccionados (capacidad priorizada):', selCapable.selected.map(m => m.id + ' (' + m.params + ', ' + m.lab + ')'));

if (selCapable.selected.length && selCapable.selected[0].id !== 'smollm2:135m') {
  console.log('  ✅ ÉXITO: Se priorizó un modelo de mayor capacidad (' + selCapable.selected[0].id + ') para código.\n');
} else {
  console.warn('  ⚠️ AVISO: Se seleccionó un modelo ligero:', selCapable.selected[0]?.id, '\n');
}

console.log('=== PRUEBAS COMPLETADAS ===');
