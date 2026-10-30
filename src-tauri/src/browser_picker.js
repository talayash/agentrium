// Element picker injected into one browser tab by `browser_pick_element`
// (browser.rs). Tabs have no IPC: the picker reports only by navigating to
// agentrium-pick://pick?n=<nonce>&d=<json> (or ://cancel?n=<nonce>), which the
// tab's on_navigation hook intercepts, checks against the armed nonce and
// cancels. `__NONCE__` is replaced with a fresh nonce on every arm.
(function () {
  'use strict';
  var NONCE = '__NONCE__';
  // browser.rs refuses pick URLs over 32 KiB; stay a little under it.
  var MAX_URL = 32 * 1024 - 256;

  if (window.__agentriumPick) window.__agentriumPick.cancel();

  function setStyles(el, styles) {
    for (var k in styles) el.style.setProperty(k, styles[k], 'important');
  }

  var box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  setStyles(box, {
    position: 'fixed',
    'z-index': '2147483647',
    'pointer-events': 'none',
    'box-sizing': 'border-box',
    border: '2px solid #3574F0',
    background: 'rgba(53, 116, 240, 0.12)',
    'border-radius': '2px',
    margin: '0',
    padding: '0',
    display: 'none',
  });
  var cursor = document.createElement('style');
  cursor.textContent = '* { cursor: crosshair !important; }';
  var root = document.documentElement;
  root.appendChild(cursor);
  root.appendChild(box);

  function targetOf(e) {
    var path = e.composedPath ? e.composedPath() : [];
    var el = path.length ? path[0] : e.target;
    while (el && el.nodeType !== 1) el = el.parentNode;
    return el && el !== box ? el : null;
  }

  function onMove(e) {
    var el = targetOf(e);
    if (!el) return;
    var r = el.getBoundingClientRect();
    setStyles(box, {
      display: 'block',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });
  }

  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function uniqueId(el) {
    if (!el.id) return null;
    var sel = '#' + esc(el.id);
    try {
      return document.querySelectorAll(sel).length === 1 ? sel : null;
    } catch (_) {
      return null;
    }
  }

  // `#id` when unique, else a tag:nth-of-type chain up to the first ancestor
  // with a unique id, at most 6 levels.
  function selectorFor(el) {
    var parts = [];
    for (var node = el, depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      var anchor = uniqueId(node);
      if (anchor) {
        parts.unshift(anchor);
        break;
      }
      var n = 1;
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) n++;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // Slice without leaving a lone high surrogate (encodeURIComponent throws on it).
  function cut(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    var out = s.slice(0, n);
    var last = out.charCodeAt(out.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
  }

  function pickUrl(data) {
    return 'agentrium-pick://pick?n=' + NONCE + '&d=' + encodeURIComponent(JSON.stringify(data));
  }

  function pick(el) {
    var data = {
      url: cut(location.href, 2048),
      title: cut(document.title, 300),
      selector: cut(selectorFor(el), 500),
      tag: cut(el.tagName.toLowerCase(), 64),
      text: cut((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 500),
      html: cut(el.outerHTML || '', 4000),
    };
    var url = pickUrl(data);
    while (url.length > MAX_URL && data.html) {
      data.html = cut(data.html, Math.floor(data.html.length * 0.75));
      url = pickUrl(data);
    }
    while (url.length > MAX_URL && data.text) {
      data.text = cut(data.text, Math.floor(data.text.length * 0.75));
      url = pickUrl(data);
    }
    go(url);
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    swallow(e);
    var el = targetOf(e);
    if (el) pick(el);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    swallow(e);
    go('agentrium-pick://cancel?n=' + NONCE);
  }

  var swallowed = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'];

  function teardown() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    for (var i = 0; i < swallowed.length; i++) window.removeEventListener(swallowed[i], swallow, true);
    if (box.parentNode) box.parentNode.removeChild(box);
    if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
    if (window.__agentriumPick === api) delete window.__agentriumPick;
  }

  function go(url) {
    teardown();
    window.location.href = url;
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  for (var i = 0; i < swallowed.length; i++) window.addEventListener(swallowed[i], swallow, true);

  // The app cancels by evaluating `__agentriumPick.cancel()`; it is already
  // disarmed on the Rust side, so this only removes the overlay.
  var api = { cancel: teardown };
  window.__agentriumPick = api;
})();
