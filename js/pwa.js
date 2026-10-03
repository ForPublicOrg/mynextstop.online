// Install as an app. Two halves: the service worker (sw.js) that lets the
// installed app open on a weak signal, and the "Install app" controls a
// phone sees while the site runs in a browser tab. Chromium hands over its
// own install prompt; Safari and the in-app browsers only install by hand,
// so those get the steps instead.
//
// Where the controls live: a pill on the home screen that stays, and a
// round button under the map's theme toggle that says "Install app" for a
// few seconds on arrival. Closing the prompt or the steps rests the map
// button for SNOOZE_MS; the home pill is always there for later.
import { icon } from './icons.js?v=e5';

const $ = id => document.getElementById(id);
const ua = navigator.userAgent;
// iPadOS reports itself as a Mac; the touch points give it away
const IOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PHONE = IOS || /Android|Mobi/i.test(ua);
// Instagram, Facebook and friends open links in their own browser, which
// cannot add to the home screen: the steps lead out of it first
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Snapchat|Line\/|MicroMessenger|GSA\/|; wv\)/i.test(ua);
const SNOOZE_KEY = 'mns-install-snooze';
const SNOOZE_MS = 21 * 864e5;
const LABEL_MS = 5000;

let deferred = null;     // Chromium's install prompt, held until a tap
let installed = false;
let labelled = false;    // the map button has had its moment this visit
let toast = () => {};
let openDlg = dlg => dlg.showModal();

const standalone = () => navigator.standalone === true ||
  ['standalone', 'fullscreen', 'minimal-ui'].some(m => matchMedia(`(display-mode: ${m})`).matches);

const snoozed = () => {
  try { return Date.now() - (+localStorage.getItem(SNOOZE_KEY) || 0) < SNOOZE_MS; } catch { return false; }
};
function snooze() {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch {}
  paint();
}

// Registered at import, ahead of the app's own boot: Chromium can fire this
// early on a repeat visit, and a missed event means no prompt this visit.
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();      // our button, not the browser's mini bar
  deferred = e;
  paint();
});
addEventListener('appinstalled', () => {
  deferred = null;
  installed = true;
  paint();
  toast('Installed. Open my next stop from your home screen.');
});

export function initInstall(opts) {
  toast = opts.toast;
  openDlg = opts.openDlg;
  registerWorker();
  $('installBtn').onclick = install;
  $('installBtnMap').onclick = install;
  // ✕, Got it and Escape all end here; the steps were seen, rest the nudge
  $('installDlg').addEventListener('submit', snooze);
  $('installDlg').addEventListener('cancel', snooze);
  // Chrome on Android can say the app is already on this phone (it reads
  // related_applications in the manifest), so a browser tab stops offering it
  navigator.getInstalledRelatedApps?.()
    .then(apps => { if (apps.length) { installed = true; paint(); } })
    .catch(() => {});
  // a tab can be dragged into the installed app's window on desktop and
  // Android: follow the display mode instead of reading it once
  matchMedia('(display-mode: standalone)').addEventListener?.('change', paint);
  paint();
}

// The map screen is on show. The button says what it is for a moment, once
// a visit, then folds to an icon beside the theme toggle.
export function mapShown() {
  const btn = $('installBtnMap');
  if (labelled || btn.hidden) return;
  labelled = true;
  btn.classList.add('is-labelled');
  setTimeout(() => btn.classList.remove('is-labelled'), LABEL_MS);
}

function paint() {
  const offer = PHONE && !installed && !standalone();
  $('installBtn').hidden = !offer;
  $('installBtnMap').hidden = !offer || snoozed();
}

async function install() {
  if (deferred) {
    // a prompt is good for one showing; Chromium sends a fresh one later
    const e = deferred;
    deferred = null;
    try {
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome !== 'accepted') snooze();
      return;
    } catch { /* the prompt went stale: the steps still work */ }
  }
  $('installSteps').innerHTML = steps()
    .map(([glyph, text]) => `<li><span class="step-ic">${icon(glyph)}</span><span>${text}</span></li>`)
    .join('');
  openDlg($('installDlg'));
}

function steps() {
  if (IN_APP) return [
    ['moreHoriz', 'Tap the <b>menu</b> in the corner of this screen.'],
    ['external', 'Choose <b>Open in browser</b>. It may say Open in Safari or Open in Chrome.'],
    ['install', 'Tap <b>Install app</b> again there.'],
  ];
  if (IOS) return [
    ['shareIos', 'Tap <b>Share</b>. If it isn’t in the toolbar, it’s in the <b>⋯</b> menu.'],
    ['addSquare', 'Scroll down and tap <b>Add to Home Screen</b>.'],
    ['check', 'Tap <b>Add</b>. The app is on your home screen.'],
  ];
  return [
    ['moreVert', 'Open the browser menu, <b>⋮</b> or <b>≡</b>.'],
    ['install', 'Tap <b>Install app</b> or <b>Add to Home screen</b>.'],
    ['check', 'Confirm with <b>Install</b>. The app is on your home screen.'],
  ];
}

// Local dev edits files without bumping the ?v= tags, so a cache-first
// worker there would serve yesterday's code. Opt in with ?sw=1 to test it;
// a plain local load clears it again.
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const dev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (dev && !/[?&]sw=1\b/.test(location.search)) {
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister()))
      .catch(() => {});
    return;
  }
  // after load, so the worker's precache never competes with the first paint
  const go = () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  if (document.readyState === 'complete') go();
  else addEventListener('load', go, { once: true });
}
