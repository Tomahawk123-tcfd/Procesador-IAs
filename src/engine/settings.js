var LS_KEY = 'lc_settings';

var DEFAULTS = {
  autoMode: true,
  streaming: true,
  intentMemory: true,
  ensemble: true,
};

function load() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      return {
        autoMode: parsed.autoMode !== undefined ? parsed.autoMode : DEFAULTS.autoMode,
        streaming: parsed.streaming !== undefined ? parsed.streaming : DEFAULTS.streaming,
        intentMemory: parsed.intentMemory !== undefined ? parsed.intentMemory : DEFAULTS.intentMemory,
        ensemble: parsed.ensemble !== undefined ? parsed.ensemble : DEFAULTS.ensemble,
      };
    }
  } catch(e) {}
  return { autoMode: DEFAULTS.autoMode, streaming: DEFAULTS.streaming, intentMemory: DEFAULTS.intentMemory, ensemble: DEFAULTS.ensemble };
}

function save(settings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch(e) {}
}

function update(patch) {
  var current = load();
  var merged = {};
  for (var k in current) { merged[k] = current[k]; }
  for (var k2 in patch) { merged[k2] = patch[k2]; }
  save(merged);
  return merged;
}

export { load, save, update, DEFAULTS };
