// iTender Monitor — light progressive enhancement (no framework).
(function () {
  // Mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Close the menu after tapping a link (single-page feel on mobile)
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Make wide tables scrollable on narrow screens (wrap once in a scroll container)
  document.querySelectorAll('table.t').forEach(function (table) {
    if (table.parentElement && table.parentElement.classList.contains('table-scroll')) return;
    var wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  // Collapsible filter panel on mobile
  var fToggle = document.querySelector('.filters-toggle');
  var fBody = document.getElementById('filtersBody');
  if (fToggle && fBody) {
    fToggle.addEventListener('click', function () {
      var open = fBody.classList.toggle('open');
      fToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Auto-submit filter form on select change
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () {
      var form = el.closest('form');
      if (form) form.submit();
    });
  });

  // Confirm before destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Auto-hide flash messages
  document.querySelectorAll('.flash').forEach(function (f) {
    setTimeout(function () { f.style.transition = 'opacity .4s'; f.style.opacity = '0'; }, 3500);
    setTimeout(function () { f.remove(); }, 4000);
  });

  // Cookie consent
  (function () {
    var banner = document.getElementById('cookieBanner');
    var NAME = 'itm_cookie_consent';
    function getConsent() {
      var m = document.cookie.match(/(?:^|;\s*)itm_cookie_consent=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }
    function setConsent(v) {
      var d = new Date(); d.setFullYear(d.getFullYear() + 1);
      document.cookie = NAME + '=' + encodeURIComponent(v) + ';path=/;expires=' +
        d.toUTCString() + ';SameSite=Lax';
    }
    function show() { if (banner) banner.hidden = false; }
    function hide() { if (banner) banner.hidden = true; }

    if (banner && !getConsent()) show();
    if (banner) {
      banner.querySelectorAll('[data-cookie]').forEach(function (b) {
        b.addEventListener('click', function () {
          setConsent(b.getAttribute('data-cookie') === 'accept' ? 'all' : 'necessary');
          hide();
          // Placeholder: load analytics here only when consent === 'all'.
        });
      });
    }
    // "Nastavenia cookies" links re-open the banner
    document.querySelectorAll('[data-cookie-settings]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); show(); });
    });
  })();
})();
