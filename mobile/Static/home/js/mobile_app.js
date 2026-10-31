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
