import test from 'node:test';
import assert from 'node:assert/strict';

import { pruneUnsupportedLines, reinforceConsensusLines } from '../src/engine/ensemble-v2.js';

function response(model, text) {
  return { model: model, text: text };
}

test('pruneUnsupportedLines preserves lines supported by multiple voices', function () {
  var text = [
    'REST simplifica el cacheo HTTP y la observabilidad.',
    'GraphQL ofrece mas flexibilidad para que el cliente pida solo los campos necesarios.',
  ].join('\n');

  var responses = [
    response('model-a', text),
    response('model-b', [
      'REST simplifica el cacheo HTTP y la observabilidad en infraestructuras simples.',
      'GraphQL ofrece flexibilidad para que el cliente consulte solo los campos que necesita.',
    ].join('\n')),
  ];

  assert.equal(pruneUnsupportedLines(text, responses), text);
});

test('pruneUnsupportedLines removes a numerically contradicted line with only one supporting voice', function () {
  var text = [
    '12% de 340 = 52.',
    'Eso equivaldria a un descuento del 12 por ciento.',
  ].join('\n');

  var responses = [
    response('model-a', text),
    response('model-b', [
      '12% de 340 = 40.8.',
      'Eso equivale a multiplicar 340 por 0.12.',
    ].join('\n')),
  ];

  var pruned = pruneUnsupportedLines(text, responses);

  assert.doesNotMatch(pruned, /12% de 340 = 52/);
  assert.match(pruned, /descuento del 12 por ciento/i);
});

test('pruneUnsupportedLines does not touch single-voice outputs', function () {
  var text = 'La capital de Francia es Paris.';
  var responses = [response('model-a', text)];

  assert.equal(pruneUnsupportedLines(text, responses), text);
});

test('pruneUnsupportedLines avoids mutilating the answer when pruning would erase almost everything', function () {
  var text = [
    '12% de 340 = 52.',
    '15% de 200 = 20.',
  ].join('\n');

  var responses = [
    response('model-a', text),
    response('model-b', [
      '12% de 340 = 40.8.',
      '15% de 200 = 30.',
    ].join('\n')),
  ];

  assert.equal(pruneUnsupportedLines(text, responses), text);
});

test('reinforceConsensusLines appends multi-voice anchors missing from a generic base synthesis', function () {
  var text = 'REST y GraphQL tienen ventajas distintas.';
  var responses = [
    response('model-a', [
      'REST simplifica el cacheo HTTP y la observabilidad.',
      'GraphQL permite pedir solo los campos necesarios.',
    ].join('\n')),
    response('model-b', [
      'REST simplifica el cacheo HTTP y la observabilidad en arquitecturas sencillas.',
      'GraphQL permite que el cliente solicite solo los campos necesarios.',
    ].join('\n')),
  ];

  var reinforced = reinforceConsensusLines(text, responses);

  assert.match(reinforced, /cacheo HTTP/i);
  assert.match(reinforced, /campos necesarios/i);
});

test('reinforceConsensusLines does not append contradicted numeric anchors', function () {
  var text = 'El descuento debe revisarse.';
  var responses = [
    response('model-a', '12% de 340 = 52.'),
    response('model-b', '12% de 340 = 40.8.'),
  ];

  var reinforced = reinforceConsensusLines(text, responses);

  assert.equal(reinforced, text);
});
