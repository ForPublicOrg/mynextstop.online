// Runs blocking in <head> so the saved theme applies before first paint.
try {
  var m = localStorage.getItem('mns-theme');
  if (m === 'dark' || m === 'light') {
    document.documentElement.setAttribute('data-theme', m);
    document.documentElement.style.colorScheme = m;
  }
} catch (e) {}
