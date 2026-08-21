/**
 * Place search for the reel builder.
 *
 * Two sources, one popover: the site's own curated catalogue (fast, local,
 * carries a tagline) and Photon (everything else on earth). This module owns
 * the combobox DOM and keyboard behaviour; main.js only receives picked stops.
 *
 * All user text reaches the DOM through textContent.
 */

const CATALOGUE_URL = '/data/destinations.json';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const DEBOUNCE_MS = 220;
const MIN_CHARS = 2;
const CATALOGUE_MAX = 3;
const PHOTON_LIMIT = 8;
/** Two rows describe the same place when the names match and they sit this close. */
const SAME_PLACE_DEG = 0.15;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @type {Promise<Array<Object>>|null} */
let cataloguePromise = null;

/* ------------------------------------------------------------------ *
 * data
 * ------------------------------------------------------------------ */

/**
 * Fetch and cache the destinations catalogue. Never rejects: a failed load
 * resolves to an empty list and lets the next call try again.
 * @returns {Promise<Array<Object>>}
 */
export function loadCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = fetch(CATALOGUE_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('catalogue ' + res.status);
        return res.json();
      })
      .then(function (json) { return Array.isArray(json) ? json : []; })
      .catch(function () { cataloguePromise = null; return []; });
  }
  return cataloguePromise;
}

/**
 * Rank catalogue entries against a query: name prefix, then name substring,
 * then state prefix.
 * @param {string} q raw query text
 * @param {Array<Object>} entries catalogue rows
 * @returns {Array<Object>} partial stops, at most CATALOGUE_MAX
 */
export function searchCatalogue(q, entries) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < MIN_CHARS || !Array.isArray(entries)) return [];

  const prefix = [];
  const inside = [];
  const byState = [];

  for (let i = 0; i < entries.length; i++) {
    const d = entries[i];
    if (!d || typeof d.name !== 'string') continue;
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) continue;
    const name = d.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(d);
    else if (name.indexOf(needle) !== -1) inside.push(d);
    else if (typeof d.state === 'string' && d.state.toLowerCase().startsWith(needle)) byState.push(d);
    if (prefix.length >= CATALOGUE_MAX) break;
  }

  return prefix.concat(inside, byState).slice(0, CATALOGUE_MAX).map(toCatalogueStop);
}

/**
 * @param {Object} d catalogue entry
 * @returns {Object} partial Stop (main.js assigns id and label)
 */
function toCatalogueStop(d) {
  return {
    name: d.name,
    lat: d.lat,
    lng: d.lng,
    region: typeof d.state === 'string' ? d.state : '',
    country: 'India',
    source: 'catalogue',
    tagline: typeof d.tagline === 'string' ? d.tagline : ''
  };
}

/**
 * Only settlements, islands and admin areas make sense as trip stops.
 * @param {Object} f GeoJSON feature from Photon
 * @returns {boolean}
 */
function acceptFeature(f) {
  if (!f || !f.properties || !f.geometry) return false;
  const p = f.properties;
  const c = f.geometry.coordinates;
  if (typeof p.name !== 'string' || !p.name) return false;
  if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return false;
  if (p.osm_key === 'place') return true;
  if (p.osm_key === 'natural' && (p.osm_value === 'island' || p.osm_value === 'peninsula')) return true;
  if (p.osm_key === 'boundary' && p.osm_value === 'administrative') return true;
  return false;
}

/**
 * Query Photon for places.
 * @param {string} q query text
 * @param {AbortSignal} [signal] cancels the request
 * @returns {Promise<Array<Object>>} partial stops
 */
export async function searchPhoton(q, signal) {
  const needle = String(q || '').trim();
  if (needle.length < MIN_CHARS) return [];
  const url = PHOTON_URL + '?q=' + encodeURIComponent(needle) + '&limit=' + PHOTON_LIMIT + '&lang=en';
  const res = await fetch(url, { signal: signal });
  if (!res.ok) throw new Error('photon ' + res.status);
  const json = await res.json();
  const feats = json && Array.isArray(json.features) ? json.features : [];
  const out = [];
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (!acceptFeature(f)) continue;
    const p = f.properties;
    const stop = {
      name: p.name,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      region: p.state || p.county || '',
      country: p.country || '',
      source: 'photon',
      tagline: ''
    };
    // Photon often returns the settlement node and its admin boundary as two
    // rows. Same name, near enough coordinates, one row.
    if (isNear(out, stop)) continue;
    out.push(stop);
  }
  return out;
}

/**
 * @param {Array<Object>} list stops already accepted
 * @param {Object} stop candidate
 * @returns {boolean} true when the list already holds this place
 */
function isNear(list, stop) {
  const name = stop.name.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    if (list[i].name.toLowerCase() !== name) continue;
    if (Math.abs(list[i].lat - stop.lat) <= SAME_PLACE_DEG
      && Math.abs(list[i].lng - stop.lng) <= SAME_PLACE_DEG) return true;
  }
  return false;
}

/**
 * Drop Photon rows that repeat a catalogue row.
 * @param {Array<Object>} catalogue catalogue stops
 * @param {Array<Object>} photon photon stops
 * @returns {Array<Object>} filtered photon stops
 */
export function dedupe(catalogue, photon) {
  if (!catalogue.length) return photon;
  return photon.filter(function (p) {
    const pn = p.name.toLowerCase();
    for (let i = 0; i < catalogue.length; i++) {
      const c = catalogue[i];
      if (c.name.toLowerCase() !== pn) continue;
      if (Math.abs(c.lat - p.lat) <= SAME_PLACE_DEG && Math.abs(c.lng - p.lng) <= SAME_PLACE_DEG) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

/**
 * @param {Array<string>} paths path d attributes
 * @param {string} cls class name
 * @returns {SVGSVGElement}
 */
function icon(paths, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (let i = 0; i < paths.length; i++) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', paths[i]);
    svg.appendChild(p);
  }
  return svg;
}

const PIN_PATHS = [
  'M12 21.2c4.2-4.4 6.4-7.7 6.4-10.4a6.4 6.4 0 1 0-12.8 0c0 2.7 2.2 6 6.4 10.4z',
  'M12 10.8m-2.1 0a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0-4.2 0'
];

/**
 * Wire the combobox. Owns rendering, keyboard flow and network calls.
 *
 * @param {Object} opts
 * @param {HTMLInputElement} opts.input the combobox input
 * @param {HTMLElement} opts.listbox the popover, role="listbox"
 * @param {(stop: Object) => void} opts.onPick called with a partial Stop
 * @param {(message: string) => void} [opts.announce] page level status announcer
 * @returns {{ focus: () => void, close: () => void, destroy: () => void }}
 */
export function createSearch(opts) {
  const input = opts.input;
  const listbox = opts.listbox;
  const onPick = typeof opts.onPick === 'function' ? opts.onPick : function () {};
  const announceHook = typeof opts.announce === 'function' ? opts.announce : null;

  let entries = null;          // catalogue rows once loaded
  let catalogueLoading = false;
  let open = false;
  let activeIndex = -1;
  /** @type {Array<{ stop: Object, el: HTMLElement }>} */
  let options = [];
  let debounceId = 0;
  let controller = null;
  let requestSeq = 0;
  let photonState = 'idle';    // 'idle' | 'pending' | 'ok' | 'error'
  let photonRows = [];
  let catalogueRows = [];
  let optionSeq = 0;
  let lastSpoken = '';
  /** @type {HTMLElement|null} */
  let liveEl = null;

  function clearTimer() {
    if (debounceId) { clearTimeout(debounceId); debounceId = 0; }
  }

  function abortInFlight() {
    if (controller) { controller.abort(); controller = null; }
  }

  /**
   * Say a status line out loud. Uses the page announcer when the host handed
   * one in, otherwise a live region this module owns. Repeats stay silent.
   * @param {string} text
   */
  function speak(text) {
    if (!text || text === lastSpoken) return;
    lastSpoken = text;
    if (announceHook) { announceHook(text); return; }
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.className = 'vh';
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      liveEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;'
        + 'clip:rect(0 0 0 0);white-space:nowrap;';
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = text;
  }

  /** Drop the active row decoration without touching the option list. */
  function clearActive() {
    const cur = activeIndex >= 0 ? options[activeIndex] : null;
    if (cur) {
      cur.el.classList.remove('is-active');
      cur.el.setAttribute('aria-selected', 'false');
    }
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
  }

  /** Empty the popover: a closed list must hold nothing resurrectable. */
  function clearOptions() {
    clearActive();
    options = [];
    listbox.textContent = '';
  }

  /** Hide the popover. Cancels nothing, so render() can use it safely. */
  function hide() {
    clearActive();
    if (!open) return;
    open = false;
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  /**
   * Dismiss the popover: hide it, forget the rows, and invalidate every
   * pending response so a slow Photon or catalogue reply cannot reopen a
   * list the user just closed.
   */
  function close() {
    requestSeq++;
    clearTimer();
    abortInFlight();
    catalogueRows = [];
    photonRows = [];
    photonState = 'idle';
    lastSpoken = '';
    clearOptions();
    hide();
  }

  function show() {
    if (open) return;
    open = true;
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function setActive(next) {
    if (options.length === 0) { clearActive(); return; }
    let i = next;
    if (i < 0) i = options.length - 1;
    if (i >= options.length) i = 0;
    const prev = activeIndex >= 0 ? options[activeIndex] : null;
    if (prev) {
      prev.el.classList.remove('is-active');
      prev.el.setAttribute('aria-selected', 'false');
    }
    activeIndex = i;
    const el = options[activeIndex].el;
    el.classList.add('is-active');
    el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', el.id);
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  /**
   * @param {string} title group heading
   * @returns {HTMLElement}
   */
  function groupEl(title) {
    const g = document.createElement('div');
    g.className = 'rs-group';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', title);
    const h = document.createElement('div');
    h.className = 'rs-head';
    h.textContent = title;
    g.appendChild(h);
    return g;
  }

  /**
   * @param {Object} stop partial stop
   * @returns {HTMLElement}
   */
  function optionEl(stop) {
    const el = document.createElement('div');
    el.className = 'rs-item';
    el.id = 'reel-opt-' + (optionSeq++);
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');

    if (stop.source === 'catalogue') {
      const dot = document.createElement('span');
      dot.className = 'rs-dot';
      el.appendChild(dot);
    } else {
      el.appendChild(icon(PIN_PATHS, 'rs-pin'));
    }

    const main = document.createElement('div');
    main.className = 'rs-main';
    const name = document.createElement('div');
    name.className = 'rs-name';
    name.textContent = stop.name;
    main.appendChild(name);

    const subText = stop.source === 'catalogue'
      ? (stop.tagline || stop.region || '')
      : [stop.region, stop.country].filter(Boolean).join(', ');
    if (subText) {
      const sub = document.createElement('div');
      sub.className = 'rs-sub';
      sub.textContent = subText;
      main.appendChild(sub);
    }
    el.appendChild(main);

    el.addEventListener('click', function () { pick(stop); });
    return el;
  }

  /**
   * A status row inside the listbox. role="option" keeps the listbox children
   * legal; aria-disabled keeps it out of the arrow key rotation.
   * @param {string} text
   * @returns {HTMLElement}
   */
  function messageEl(text) {
    const el = document.createElement('div');
    el.className = 'rs-msg';
    el.setAttribute('role', 'option');
    el.setAttribute('aria-disabled', 'true');
    el.setAttribute('aria-selected', 'false');
    el.textContent = text;
    return el;
  }

  function render() {
    clearOptions();

    const cat = catalogueRows;
    const pho = dedupe(cat, photonRows);

    if (cat.length) {
      const g = groupEl('From our catalogue');
      for (let i = 0; i < cat.length; i++) {
        const el = optionEl(cat[i]);
        g.appendChild(el);
        options.push({ stop: cat[i], el: el });
      }
      listbox.appendChild(g);
    }

    if (pho.length) {
      const g = groupEl('Places');
      for (let i = 0; i < pho.length; i++) {
        const el = optionEl(pho[i]);
        g.appendChild(el);
        options.push({ stop: pho[i], el: el });
      }
      listbox.appendChild(g);
    }

    let message = '';
    if (photonState === 'error') message = 'Search is offline, try again in a moment';
    else if (!options.length) message = photonState === 'pending' ? 'Searching' : 'No places found, try another spelling';
    if (message) listbox.appendChild(messageEl(message));

    // Screen readers see the same state as the eye: the status row, or a
    // count once the network has settled.
    if (message) speak(message);
    else if (photonState !== 'pending') speak(options.length === 1 ? '1 result' : options.length + ' results');

    if (listbox.childNodes.length) show(); else hide();
  }

  /**
   * @param {Object} stop partial stop
   */
  function pick(stop) {
    close();
    input.value = '';
    input.focus();
    onPick(stop);
  }

  /**
   * A response may repaint only while it is still the newest request, the
   * popover is still open, and the input still holds the query it asked for.
   * @param {number} seq token taken when the request went out
   * @param {string} q query the request asked for
   * @returns {boolean}
   */
  function isCurrent(seq, q) {
    return seq === requestSeq && open && input.value.trim() === q;
  }

  /**
   * Pull the catalogue once, then repaint if the user is still mid-query.
   * A failed load leaves entries null so the next keystroke retries.
   */
  function ensureCatalogue() {
    if (entries !== null || catalogueLoading) return;
    catalogueLoading = true;
    loadCatalogue().then(function (rows) {
      catalogueLoading = false;
      if (!rows.length) return;
      entries = rows;
      // A late catalogue must never reopen a popover the user dismissed.
      if (!open) return;
      const q = input.value.trim();
      if (q.length < MIN_CHARS) return;
      catalogueRows = searchCatalogue(q, entries);
      render();
    });
  }

  function runQuery() {
    ensureCatalogue();
    const q = input.value.trim();
    if (q.length < MIN_CHARS) {
      close();
      return;
    }

    // Catalogue answers instantly once loaded, so paint it before the network.
    catalogueRows = entries ? searchCatalogue(q, entries) : [];
    photonRows = [];
    photonState = 'pending';
    render();

    clearTimer();
    const seq = ++requestSeq;
    debounceId = setTimeout(function () {
      debounceId = 0;
      abortInFlight();
      controller = new AbortController();
      searchPhoton(q, controller.signal).then(function (rows) {
        if (!isCurrent(seq, q)) return;
        photonRows = rows;
        photonState = 'ok';
        render();
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (!isCurrent(seq, q)) return;
        photonRows = [];
        photonState = 'error';
        render();
      });
    }, DEBOUNCE_MS);
  }

  function onInput() { runQuery(); }

  function onFocus() {
    ensureCatalogue();
    if (input.value.trim().length < MIN_CHARS) return;
    // Rows survive a refocus; a dismissed list is re-earned, never resurrected.
    if (options.length) show();
    else runQuery();
  }

  function onKeyDown(ev) {
    const key = ev.key;
    if (key === 'ArrowDown') {
      ev.preventDefault();
      if (!open && options.length) { show(); setActive(0); return; }
      setActive(activeIndex + 1);
      return;
    }
    if (key === 'ArrowUp') {
      ev.preventDefault();
      if (!open && options.length) { show(); setActive(options.length - 1); return; }
      setActive(activeIndex - 1);
      return;
    }
    if (key === 'Home' && open && options.length) { ev.preventDefault(); setActive(0); return; }
    if (key === 'End' && open && options.length) { ev.preventDefault(); setActive(options.length - 1); return; }
    if (key === 'Enter') {
      if (open && options.length) {
        ev.preventDefault();
        pick(options[activeIndex >= 0 ? activeIndex : 0].stop);
      }
      return;
    }
    if (key === 'Escape') {
      if (open) { ev.preventDefault(); close(); }
      else if (input.value) { ev.preventDefault(); input.value = ''; runQuery(); }
      return;
    }
    if (key === 'Tab') close();
  }

  // Pointer down inside the popover must not steal focus from the input,
  // otherwise blur closes the list before the click lands.
  function onListPointerDown(ev) { ev.preventDefault(); }

  function onDocPointerDown(ev) {
    if (ev.target === input || listbox.contains(ev.target)) return;
    close();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('focus', onFocus);
  input.addEventListener('keydown', onKeyDown);
  listbox.addEventListener('pointerdown', onListPointerDown);
  document.addEventListener('pointerdown', onDocPointerDown);

  return {
    focus: function () { input.focus(); },
    close: close,
    destroy: function () {
      clearTimer();
      abortInFlight();
      if (liveEl && liveEl.parentNode) liveEl.parentNode.removeChild(liveEl);
      liveEl = null;
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('keydown', onKeyDown);
      listbox.removeEventListener('pointerdown', onListPointerDown);
      document.removeEventListener('pointerdown', onDocPointerDown);
    }
  };
}
