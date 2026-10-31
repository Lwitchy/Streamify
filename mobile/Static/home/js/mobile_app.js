/*
 * Streamify - phone sheet gestures.
 *
 * On phones every small modal is presented as a bottom sheet
 * (css/mobile_app.css). This adds the iOS gesture to go with it: drag the
 * sheet down to dismiss. Dismissal reuses the modal's own close control so
 * whatever cleanup that handler does (resetting forms, cancelling uploads...)
 * still runs.
 */
(function () {
    'use strict';

    var PHONE = window.matchMedia ? window.matchMedia('(max-width: 768px)') : { matches: false };
    var EXCLUDED = { 'settings-modal': 1, 'ai-metadata-modal': 1, 'oobe-modal': 1, 'crop-modal': 1 };
    var INTERACTIVE = 'input, textarea, select, button, a, [contenteditable="true"], .cropper-container, input[type="range"]';

    function sheetOf(overlay) {
        return overlay && overlay.querySelector(':scope > .modal-box, :scope > .modal-box-user');
    }

    function closeOverlay(overlay) {
        var closer = overlay.querySelector(
            '.modal-header .modal-close-button, .modal-header > i.bx-x, [id^="close-"][id$="-btn"], [id^="cancel-"][id$="-btn"]'
        );
        if (closer) closer.click();
        // Fallback for modals without a close control, or a handler that refused.
        if (!overlay.classList.contains('hidden') && overlay.dataset.busy !== 'true') {
            overlay.classList.add('hidden');
        }
    }

    function findScrollableAncestor(node, stop) {
        while (node && node !== stop) {
            if (node.nodeType === 1 && node.scrollHeight > node.clientHeight + 2) {
                var oy = getComputedStyle(node).overflowY;
                if (oy === 'auto' || oy === 'scroll') return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    var drag = null;

    document.addEventListener('touchstart', function (e) {
        if (!PHONE.matches || e.touches.length !== 1) return;
        var overlay = e.target.closest && e.target.closest('.modal-overlay:not(.hidden)');
        if (!overlay || EXCLUDED[overlay.id] || overlay.dataset.busy === 'true') return;
        var sheet = sheetOf(overlay);
        if (!sheet || !sheet.contains(e.target)) return;

        var t = e.touches[0];
        var rect = sheet.getBoundingClientRect();
        var inHandleZone = (t.clientY - rect.top) < 64; // grabber + header
        if (!inHandleZone) {
            if (e.target.closest(INTERACTIVE)) return;
            if (sheet.scrollTop > 0) return;
            var inner = findScrollableAncestor(e.target, sheet);
            if (inner && inner.scrollTop > 0) return;
        }

        drag = { overlay: overlay, sheet: sheet, startY: t.clientY, lastY: t.clientY, lastT: Date.now(), v: 0, active: false };
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
        if (!drag) return;
        var y = e.touches[0].clientY;
        var dy = y - drag.startY;
        if (!drag.active) {
            if (dy < -6) { drag = null; return; } // scrolling up: let the sheet scroll
            if (dy < 8) return;
            drag.active = true;
            drag.overlay.classList.add('sheet-dragging');
        }
        if (e.cancelable) e.preventDefault();
        var now = Date.now();
        if (now > drag.lastT) {
            drag.v = (y - drag.lastY) / (now - drag.lastT);
            drag.lastT = now;
            drag.lastY = y;
        }
        var offset = Math.max(0, dy);
        drag.sheet.style.transform = 'translate3d(0,' + offset + 'px,0)';
        var fade = Math.max(0, 1 - offset / Math.max(1, drag.sheet.offsetHeight));
        drag.overlay.style.backgroundColor = 'rgba(0,0,0,' + (0.5 * fade).toFixed(3) + ')';
    }, { passive: false });

    function endDrag() {
        if (!drag) return;
        var d = drag;
        drag = null;
        if (!d.active) return;
        var offset = Math.max(0, d.lastY - d.startY);
        var shouldClose = offset > Math.min(140, d.sheet.offsetHeight * 0.35) || (offset > 24 && d.v > 0.5);
        d.overlay.classList.remove('sheet-dragging');

        if (shouldClose) {
            d.sheet.style.transition = 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1)';
            d.sheet.style.transform = 'translate3d(0,' + (d.sheet.offsetHeight + 20) + 'px,0)';
            d.overlay.style.transition = 'background-color 0.24s ease';
            d.overlay.style.backgroundColor = 'rgba(0,0,0,0)';
            setTimeout(function () {
                closeOverlay(d.overlay);
                d.sheet.style.transition = '';
                d.sheet.style.transform = '';
                d.overlay.style.transition = '';
                d.overlay.style.backgroundColor = '';
            }, 240);
        } else {
            d.sheet.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
            d.sheet.style.transform = '';
            d.overlay.style.backgroundColor = '';
            setTimeout(function () { d.sheet.style.transition = ''; }, 300);
        }
    }

    document.addEventListener('touchend', endDrag, { passive: true });
    document.addEventListener('touchcancel', endDrag, { passive: true });
})();

/*
 * Edge swipe back (iOS "interactive pop").
 *
 * Drag from the left edge of the screen to the right: the current page
 * follows the finger and, if released past ~35% of the width (or flicked),
 * slides off and the page's own Back button is pressed. That reuses each
 * page's existing back logic (StreamifyNav.goBack, the profile handler...),
 * so history and highlights behave exactly as if Back had been tapped.
 *
 * On top-level pages (Home, Library, ...) there is nothing to go back to, so
 * the same gesture opens the side menu instead.
 */
(function () {
    'use strict';

    var PHONE = window.matchMedia ? window.matchMedia('(max-width: 768px)') : { matches: false };
    var EDGE = 28;               // px from the left edge where the gesture may start
    var BACK_SELECTOR = '.playlist-back-btn, #back-from-profile-btn';

    function activeSection() {
        return document.querySelector('.content-container > section:not(.hidden):not(#player-section)');
    }

    function visibleBackButton(section) {
        if (!section) return null;
        var buttons = section.querySelectorAll(BACK_SELECTOR);
        for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            if (!b.disabled && b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden') return b;
        }
        return null;
    }

    function blocked() {
        var body = document.body;
        if (!body) return true;
        if (body.classList.contains('player-section-active') || body.classList.contains('player-is-dismissing')) return true;
        if (document.querySelector('.modal-overlay:not(.hidden)')) return true;
        var sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('mobile-active')) return true;
        return false;
    }

    /* A finished `forwards` entrance animation would override the inline
       drag transform. Turning it off and back on later would replay it (the
       old "page refreshes" bug), so it stays off until the page is next
       hidden or re-animated by real navigation. */
    function freezeEntrance(section) {
        section.style.animation = 'none';
        if (section._edgeFreeze) return;
        var obs = new MutationObserver(function () {
            if (section.classList.contains('hidden') || section.classList.contains('fade-in-animate')) {
                obs.disconnect();
                section._edgeFreeze = null;
                section.style.animation = '';
            }
        });
        section._edgeFreeze = obs;
        obs.observe(section, { attributes: true, attributeFilter: ['class'] });
    }

    var g = null;

    document.addEventListener('touchstart', function (e) {
        if (!PHONE.matches || e.touches.length !== 1) return;
        var t = e.touches[0];
        var inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0;
        if (t.clientX > EDGE + inset || blocked()) return;
        var section = activeSection();
        if (!section) return;
        var back = visibleBackButton(section);
        g = { x0: t.clientX, y0: t.clientY, lastX: t.clientX, lastT: Date.now(), v: 0,
              section: section, back: back, mode: back ? 'back' : 'menu', active: false };
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
        if (!g) return;
        var t = e.touches[0];
        var dx = t.clientX - g.x0;
        var dy = t.clientY - g.y0;
        if (!g.active) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; } // vertical scroll
            if (dx < 8) return;
            g.active = true;
            if (g.mode === 'back') {
                freezeEntrance(g.section);
                g.section.style.willChange = 'transform';
                g.section.style.transition = 'none';
                g.section.classList.add('edge-swipe-active');
            }
        }
        if (e.cancelable) e.preventDefault();
        var now = Date.now();
        if (now > g.lastT) { g.v = (t.clientX - g.lastX) / (now - g.lastT); g.lastT = now; g.lastX = t.clientX; }
        if (g.mode === 'back') {
            var x = Math.max(0, dx);
            g.section.style.transform = 'translate3d(' + x + 'px,0,0)';
            g.section.style.opacity = String(1 - Math.min(0.35, x / window.innerWidth * 0.5));
        }
    }, { passive: false });

    function finish() {
        if (!g) return;
        var s = g;
        g = null;
        if (!s.active) return;
        var dx = s.lastX - s.x0;
        var width = window.innerWidth || 1;
        var commit = dx > width * 0.35 || (dx > 40 && s.v > 0.45);

        if (s.mode === 'menu') {
            if (commit || dx > 60) {
                var menu = document.getElementById('menu-btn');
                if (menu) menu.click();
            }
            return;
        }

        var el = s.section;
        var clear = function () {
            el.style.transition = '';
            el.style.transform = '';
            el.style.opacity = '';
            el.style.willChange = '';
            el.classList.remove('edge-swipe-active');
        };

        if (commit) {
            el.style.transition = 'transform 0.22s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.22s ease';
            el.style.transform = 'translate3d(' + width + 'px,0,0)';
            el.style.opacity = '0.4';
            setTimeout(function () {
                s.back.click();
                // The page we left is hidden by now; reset it for next time.
                requestAnimationFrame(clear);
            }, 200);
        } else {
            el.style.transition = 'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.28s ease';
            el.style.transform = 'translate3d(0,0,0)';
            el.style.opacity = '1';
            setTimeout(clear, 300);
        }
    }

    document.addEventListener('touchend', finish, { passive: true });
    document.addEventListener('touchcancel', finish, { passive: true });
})();

/*
 * No sticky hover on touch screens.
 *
 * iOS applies :hover to whatever was last touched and keeps it there, so
 * after scrolling a song row (or a card, button...) stayed highlighted as if
 * the mouse were on it. On devices with no hover-capable pointer, the
 * :hover parts of every stylesheet rule are removed once at startup:
 *   ".row:hover"                       -> rule removed
 *   ".btn:hover, .btn:focus-visible"   -> ".btn:focus-visible"
 * Desktop (and iPad with a trackpad/mouse) keeps hover untouched.
 */
(function () {
    'use strict';
    var touchOnly = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (!touchOnly) return;

    // Lets iOS show :active (tap feedback) on any element.
    document.addEventListener('touchstart', function () {}, { passive: true });

    function splitSelectors(text) {
        // Split on top-level commas only (not inside :is()/:not()/[attr]).
        var out = [], depth = 0, cur = '';
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }

    function prune(list) {
        for (var i = list.length - 1; i >= 0; i--) {
            var rule = list[i];
            if (rule.cssRules && rule.type !== 1) {      // @media, @supports, @layer...
                prune(rule.cssRules);
                continue;
            }
            if (rule.type !== 1 || !rule.selectorText || rule.selectorText.indexOf(':hover') === -1) continue;
            var keep = splitSelectors(rule.selectorText).filter(function (sel) { return sel.indexOf(':hover') === -1; });
            try {
                if (keep.length) rule.selectorText = keep.join(', ');
                else if (rule.parentRule) rule.parentRule.deleteRule(i);
                else rule.parentStyleSheet.deleteRule(i);
            } catch (e) { /* leave rule as is */ }
        }
    }

    var done = typeof WeakSet === 'function' ? new WeakSet() : null;
    function run() {
        var sheets = document.styleSheets;
        for (var i = 0; i < sheets.length; i++) {
            var sheet = sheets[i];
            if (done && done.has(sheet)) continue;
            var rules;
            try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin sheet
            if (!rules) continue;
            prune(rules);
            if (done) done.add(sheet);
        }
    }

    run();
    window.addEventListener('load', run);
})();
