// localStorage wrapper — prefs, saved places, been-there list. Fails soft.
const KEY = 'mns-v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

const state = load();
state.saved = state.saved || [];
state.been = state.been || [];

export const store = {
  get origin() { return state.origin || null; },
  set origin(v) { state.origin = v; save(state); },

  get dist() { return state.dist || 'weekend'; },
  set dist(v) { state.dist = v; save(state); },

  get moods() { return state.moods || []; },
  set moods(v) { state.moods = v; save(state); },

  get saved() { return state.saved; },
  get been() { return state.been; },

  toggleSaved(id) {
    const i = state.saved.indexOf(id);
    if (i === -1) state.saved.push(id); else state.saved.splice(i, 1);
    save(state);
    return i === -1;
  },
  toggleBeen(id) {
    const i = state.been.indexOf(id);
    if (i === -1) state.been.push(id); else state.been.splice(i, 1);
    save(state);
    return i === -1;
  },
  isSaved(id) { return state.saved.includes(id); },
  isBeen(id) { return state.been.includes(id); },

  get theme() { try { return localStorage.getItem('mns-theme'); } catch { return null; } },
  set theme(v) { try { v ? localStorage.setItem('mns-theme', v) : localStorage.removeItem('mns-theme'); } catch {} },
};
