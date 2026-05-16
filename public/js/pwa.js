'use strict';

(function () {
  // Register the service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function (err) {
      console.warn('[PWA] Service worker registration failed:', err);
    });
  }

  var DISMISS_KEY  = 'pwa-banner-dismissed';
  var VISIT_KEY    = 'pwa-visit-count';
  var INSTALLED_KEY = 'pwa-installed';

  // Count this visit
  var visits = parseInt(localStorage.getItem(VISIT_KEY) || '0', 10) + 1;
  localStorage.setItem(VISIT_KEY, String(visits));

  // Don't show banner if already dismissed or installed
  if (localStorage.getItem(DISMISS_KEY) || localStorage.getItem(INSTALLED_KEY)) return;

  // Only show after the second visit
  if (visits < 2) return;

  // Already in standalone mode = already installed
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;
  if (isStandalone) {
    localStorage.setItem(INSTALLED_KEY, '1');
    return;
  }

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  var deferredPrompt = null;

  function injectStyles() {
    if (document.getElementById('pwa-styles')) return;
    var style = document.createElement('style');
    style.id = 'pwa-styles';
    style.textContent = [
      '@keyframes pwa-slide-up{from{transform:translateY(100%)}to{transform:translateY(0)}}',
      '#pwa-banner{',
        'position:fixed;bottom:0;left:0;right:0;z-index:99999;',
        'background:linear-gradient(135deg,#0b2416 0%,#163d25 100%);',
        'border-top:2px solid #c8a84b;',
        'padding:14px 16px 16px;',
        'display:flex;align-items:center;gap:12px;',
        'box-shadow:0 -4px 24px rgba(0,0,0,.7);',
        'animation:pwa-slide-up .28s ease;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      '}',
      '#pwa-banner .pwa-icon{font-size:2.2rem;flex-shrink:0;line-height:1}',
      '#pwa-banner .pwa-text{flex:1;min-width:0}',
      '#pwa-banner .pwa-text strong{display:block;color:#c8a84b;font-size:.88rem;font-weight:700;margin-bottom:3px}',
      '#pwa-banner .pwa-text span{color:#bbb;font-size:.76rem;line-height:1.45;display:block}',
      '#pwa-banner .pwa-text .pwa-highlight{color:#c8a84b;font-weight:600}',
      '#pwa-banner .pwa-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0}',
      '#pwa-banner .pwa-install-btn{',
        'background:#c8a84b;color:#040e07;border:none;border-radius:8px;',
        'padding:9px 18px;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap;',
      '}',
      '#pwa-banner .pwa-dismiss-btn{',
        'background:rgba(255,255,255,.1);color:#999;border:none;border-radius:8px;',
        'padding:6px 10px;font-size:.78rem;cursor:pointer;white-space:nowrap;',
      '}',
      '#pwa-banner .pwa-install-btn:active{opacity:.85}',
      '#pwa-banner .pwa-dismiss-btn:active{opacity:.7}',
    ].join('');
    document.head.appendChild(style);
  }

  function showBanner(isIOSDevice) {
    injectStyles();

    var banner = document.createElement('div');
    banner.id = 'pwa-banner';

    var actionsHtml = isIOSDevice
      ? '<button class="pwa-dismiss-btn" id="pwa-dismiss">Got it</button>'
      : '<button class="pwa-install-btn" id="pwa-install">Install App</button>' +
        '<button class="pwa-dismiss-btn" id="pwa-dismiss">Not now</button>';

    var messageHtml = isIOSDevice
      ? 'Tap <span class="pwa-highlight">Share</span> then ' +
        '<span class="pwa-highlight">Add to Home Screen</span> to install'
      : 'Install on your home screen for the best experience';

    banner.innerHTML =
      '<div class="pwa-icon">🐇</div>' +
      '<div class="pwa-text">' +
        '<strong>Boston Poker Club</strong>' +
        '<span>' + messageHtml + '</span>' +
      '</div>' +
      '<div class="pwa-actions">' + actionsHtml + '</div>';

    document.body.appendChild(banner);

    document.getElementById('pwa-dismiss').addEventListener('click', function () {
      localStorage.setItem(DISMISS_KEY, '1');
      banner.remove();
    });

    if (!isIOSDevice) {
      var installBtn = document.getElementById('pwa-install');
      if (installBtn) {
        installBtn.addEventListener('click', function () {
          if (deferredPrompt) {
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(function (result) {
              deferredPrompt = null;
              if (result.outcome === 'accepted') {
                localStorage.setItem(INSTALLED_KEY, '1');
              }
            });
          }
          banner.remove();
        });
      }
    }
  }

  if (isIOS) {
    // iOS has no beforeinstallprompt — show instructions banner directly
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { showBanner(true); });
    } else {
      showBanner(true);
    }
  } else {
    // Chrome/Android: wait for the browser's install prompt event
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { showBanner(false); });
      } else {
        showBanner(false);
      }
    });
  }

  // Hide banner if the user installs via OS prompt
  window.addEventListener('appinstalled', function () {
    localStorage.setItem(INSTALLED_KEY, '1');
    var banner = document.getElementById('pwa-banner');
    if (banner) banner.remove();
  });
})();
