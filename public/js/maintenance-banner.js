'use strict';
(function () {
  var POLL_MS = 60000; // re-check every 60 seconds

  function applyState(data) {
    var existing = document.getElementById('maint-site-banner');
    if (data && data.active) {
      if (!existing) {
        existing = document.createElement('div');
        existing.id = 'maint-site-banner';
        existing.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
          'background:#b8860b', 'color:#fff', 'font-size:.88rem',
          'font-family:Georgia,serif', 'font-weight:600',
          'text-align:center', 'padding:9px 48px 9px 16px',
          'box-shadow:0 2px 8px rgba(0,0,0,.4)', 'line-height:1.4'
        ].join(';');

        var close = document.createElement('button');
        close.textContent = '✕';
        close.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#fff;font-size:1rem;cursor:pointer;opacity:.8;line-height:1';
        close.onclick = function () { existing.remove(); };
        existing.appendChild(close);

        document.body.insertBefore(existing, document.body.firstChild);
      }
      // Update message text (node before the close button)
      var textNode = existing.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        textNode.textContent = data.message;
      } else {
        existing.insertBefore(document.createTextNode(data.message), close);
      }
    } else {
      if (existing) existing.remove();
    }
  }

  function check() {
    fetch('/api/maintenance')
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function () { /* network error — leave banner as-is */ });
  }

  // Run on DOMContentLoaded (or immediately if already loaded)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }

  setInterval(check, POLL_MS);

  // Also listen for real-time push via socket if available
  window.addEventListener('load', function () {
    var sock = window.tableSocket || window.adminSocket || window.lobbySocket;
    if (sock && sock.on) {
      sock.on('maintenance:update', applyState);
    }
  });
})();
