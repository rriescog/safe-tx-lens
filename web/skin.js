// Design switch (retro by default) and the small landing-page behaviours.
// The choice is kept in this browser's localStorage only; nothing is sent
// to the server. Loaded synchronously after the two skin stylesheets so the
// right one applies before first paint.
(function () {
  var SKINS = ['retro', 'modern'];
  var root = document.documentElement;
  function stored() { try { var value = localStorage.getItem('skin'); return SKINS.indexOf(value) === -1 ? null : value; } catch (error) { return null; } }
  function apply(skin) {
    root.dataset.skin = skin;
    SKINS.forEach(function (name) { var link = document.getElementById('skin-' + name); if (link) link.media = name === skin ? 'all' : 'not all'; });
  }
  apply(stored() || 'retro');

  var loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise(function (resolve, reject) { var script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
    return loaded[src];
  }
  function webgl() { try { var canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl')); } catch (error) { return false; } }
  // The 3D scene is decoration: load it only where WebGL exists, and leave
  // the static fallback in place if anything fails.
  function loadHero(skin) {
    if (!webgl()) return;
    loadScript('/web/vendor/three.min.js').then(function () { return loadScript('/web/hero-' + skin + '.js'); }).then(function () { if (window.__heroRepaint) window.__heroRepaint(); }).catch(function () {});
  }
  function sync(skin) {
    document.querySelectorAll('[data-skin-pick]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.skinPick === skin)); });
  }
  function tabs(container) {
    var buttons = Array.prototype.slice.call(container.querySelectorAll('[role=tab]'));
    var panels = Array.prototype.slice.call(container.querySelectorAll('[role=tabpanel]'));
    function select(index) { buttons.forEach(function (button, i) { button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; }); panels.forEach(function (panel, i) { panel.hidden = i !== index; }); }
    buttons.forEach(function (button, index) {
      button.addEventListener('click', function () { select(index); });
      button.addEventListener('keydown', function (event) { if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return; var next = (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length; select(next); buttons[next].focus(); });
    });
    select(0);
  }
  document.addEventListener('DOMContentLoaded', function () {
    var skin = root.dataset.skin;
    sync(skin);
    loadHero(skin);
    document.querySelectorAll('[data-skin-pick]').forEach(function (button) {
      button.addEventListener('click', function () {
        var next = button.dataset.skinPick;
        apply(next); sync(next);
        try { localStorage.setItem('skin', next); } catch (error) {}
        loadHero(next);
        // Let the stylesheet apply before canvases re-read their colours.
        requestAnimationFrame(function () { document.dispatchEvent(new Event('skinchange')); window.dispatchEvent(new Event('resize')); });
      });
    });
    document.querySelectorAll('.lp-tabs').forEach(tabs);
    var scanlines = document.getElementById('scanlines');
    if (scanlines) scanlines.addEventListener('click', function () { var off = root.classList.toggle('lp-no-crt'); scanlines.setAttribute('aria-pressed', String(!off)); scanlines.textContent = 'Scanlines: ' + (off ? 'off' : 'on'); });
    document.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-copy]') : null;
      if (!button) return;
      var box = button.parentElement.querySelector('pre');
      if (!box) return;
      var done = function (label) { button.textContent = label; setTimeout(function () { button.textContent = 'Copy'; }, 1800); };
      var select = function () { var range = document.createRange(); range.selectNodeContents(box); var selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); done('Selected'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.textContent).then(function () { done('Copied'); }, select); else select();
    });
  });
})();
