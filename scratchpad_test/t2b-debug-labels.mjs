// Access internals by re-implementing extraction inline via a copy of regexes (since not exported).
// Instead, monkeypatch: require the file text and eval label logic manually by importing verifyCalculations
// and adding console logging isn't possible without editing source. Let's just reproduce labelFor logic here
// to confirm hypothesis, using the exact same regex source copied from the file.

var EXPR_AFTER_EQUALS = /[=≈]\s*(\(?-?[0-9][0-9.,\s+\-−*/^×x÷()]*[0-9)])/g;

function labelFor(text, matchIndex) {
  var lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  var before = text.slice(lineStart, matchIndex).trim();
  return before.toLowerCase().replace(/\s+/g, ' ');
}

var text = '100 = 50 + 50 = 20 + 80 = 10 + 91 = 40 + 60';
var m;
EXPR_AFTER_EQUALS.lastIndex = 0;
while ((m = EXPR_AFTER_EQUALS.exec(text)) !== null) {
  console.log('match:', JSON.stringify(m[1]), 'index:', m.index, 'label:', JSON.stringify(labelFor(text, m.index)));
}
