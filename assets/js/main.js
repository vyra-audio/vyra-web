(function () {
  'use strict';

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  if (toggle && nav) {
    var setMenu = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      nav.classList.toggle('is-open', open);
    };

    toggle.addEventListener('click', function () {
      setMenu(toggle.getAttribute('aria-expanded') !== 'true');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        setMenu(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setMenu(false);
        toggle.focus();
      }
    });

    var wide = window.matchMedia('(min-width: 821px)');
    var onWide = function (event) {
      if (event.matches) {
        setMenu(false);
      }
    };
    if (typeof wide.addEventListener === 'function') {
      wide.addEventListener('change', onWide);
    } else if (typeof wide.addListener === 'function') {
      wide.addListener(onWide);
    }
  }

  var copyButtons = document.querySelectorAll('.codecopy[data-copy]');

  var legacyCopy = function (text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(area);
    return copied;
  };

  var flash = function (button, ok) {
    var label = button.querySelector('.codecopy__label');
    if (!label) {
      return;
    }
    if (!button.dataset.idleLabel) {
      button.dataset.idleLabel = label.textContent;
    }
    label.textContent = ok ? 'Copied' : 'Select and copy';
    button.classList.toggle('is-done', ok);
    button.classList.toggle('is-failed', !ok);
    window.clearTimeout(button._copyTimer);
    button._copyTimer = window.setTimeout(function () {
      label.textContent = button.dataset.idleLabel;
      button.classList.remove('is-done', 'is-failed');
    }, 2400);
  };

  Array.prototype.forEach.call(copyButtons, function (button) {
    button.addEventListener('click', function () {
      var target = document.getElementById(button.getAttribute('data-copy'));
      if (!target) {
        return;
      }
      var text = target.textContent.replace(/\s+$/, '');

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { flash(button, true); },
          function () { flash(button, legacyCopy(text)); }
        );
      } else {
        flash(button, legacyCopy(text));
      }
    });
  });

})();
