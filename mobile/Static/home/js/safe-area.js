/*
 * Streamify safe-area guard (loaded synchronously in <head>).
 *
 * WKWebView (Capacitor iOS, home-screen PWA) frequently reports
 * env(safe-area-inset-top / bottom) as 0px on launch until something forces a
 * relayout. Anything that relied on env() alone - the full-screen player's
 * Back button, the settings header, sheets - then slid under the clock /
 * Dynamic Island or the home indicator.
 *
 * This script publishes two floors on <html>:
 *     --safe-top-min, --safe-bottom-min
 * CSS uses them via
 *     --safe-top:    max(env(safe-area-inset-top), var(--safe-top-min))
 *     --safe-bottom: max(env(safe-area-inset-bottom), var(--safe-bottom-min))
 * so the real env() value always wins once WebKit reports it, and until then
 * the last value we ever measured on this device (or a model-based estimate)
 * keeps the UI clear of the hardware.
 */
(function () {
    'use strict';
    var root = document.documentElement;
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isPhone = /iPhone|iPod/.test(ua);
    var isNative = !!window.Capacitor || /^(capacitor|ionic):$/.test(location.protocol);

    if (isIOS) root.classList.add('is-ios');
    if (isNative) {
        root.classList.add('is-capacitor');
        if (isIOS) root.classList.add('is-capacitor-ios');
    }

    if (!isIOS) return; // env() is reliable everywhere else.

    var KEY_TOP = 'streamify_safe_top_portrait';
    var KEY_BOTTOM = 'streamify_safe_bottom_portrait';

    function read(key) {
        try { return parseFloat(localStorage.getItem(key)) || 0; } catch (e) { return 0; }
    }
    function write(key, value) {
        try { localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ }
    }
    function isPortrait() {
        return (window.innerHeight || 0) >= (window.innerWidth || 0);
    }

    // Estimate from the screen's long edge (points) when nothing was measured yet.
    function estimate() {
        if (!isPhone) return { top: 24, bottom: 20 }; // iPad: status bar + home indicator
        var longEdge = Math.max(screen.width || 0, screen.height || 0);
        if (longEdge >= 874) return { top: 62, bottom: 34 }; // 16 Pro / Pro Max
        if (longEdge >= 852) return { top: 59, bottom: 34 }; // Dynamic Island models
        if (longEdge >= 812) return { top: 47, bottom: 34 }; // notch models
        return { top: 20, bottom: 0 };                       // SE / 8 (home button)
    }

    function apply() {
        if (!isPortrait()) {
            // Landscape: notch moves to the side, env() handles left/right.
            root.style.setProperty('--safe-top-min', '0px');
            root.style.setProperty('--safe-bottom-min', '0px');
            return;
        }
        var guess = estimate();
        var top = read(KEY_TOP) || guess.top;
        var bottom = read(KEY_BOTTOM) || guess.bottom;
        root.style.setProperty('--safe-top-min', top + 'px');
        root.style.setProperty('--safe-bottom-min', bottom + 'px');
    }

    var probe = null;
    function measure() {
        if (!document.body) return;
        if (!probe) {
            probe = document.createElement('div');
            probe.setAttribute('aria-hidden', 'true');
            probe.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;' +
                'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);';
            document.body.appendChild(probe);
        }
        var cs = getComputedStyle(probe);
        var top = parseFloat(cs.paddingTop) || 0;
        var bottom = parseFloat(cs.paddingBottom) || 0;
        if (isPortrait()) {
            // Only remember real (non-zero) readings; 0 is exactly the bug we guard against.
            if (top > 0) write(KEY_TOP, top);
            if (bottom > 0) write(KEY_BOTTOM, bottom);
        }
        apply();
    }

    apply();
    var later = function () { measure(); setTimeout(measure, 400); setTimeout(measure, 1500); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later);
    else later();
    window.addEventListener('pageshow', measure);
    window.addEventListener('orientationchange', function () { setTimeout(measure, 250); });
    window.addEventListener('resize', measure);
})();
