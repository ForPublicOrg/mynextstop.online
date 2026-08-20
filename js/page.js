// The content pages (destination, state, month, theme guides) need exactly
// one interactive thing: the theme toggle. app.js can't do it, that boots
// the whole map. Kept plain script, not a module, so it costs nothing.
(function () {
  var btn = document.getElementById('themeBtn');
  if (!btn) return;

  var SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>';
  var MOON = '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10z"/>';

  function effective() {
    return document.documentElement.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  // the button shows the theme you'd switch to, same as the app
  function paint() {
    var p = effective() === 'dark' ? SUN : MOON;
    btn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  btn.addEventListener('click', function () {
    var next = effective() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem('mns-theme', next); } catch (e) {}
    paint();
  });

  // follow OS flips while the reader hasn't made an explicit choice
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (!document.documentElement.getAttribute('data-theme')) paint();
  });

  paint();
})();
