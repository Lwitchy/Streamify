/*
 * Shared list motion (FLIP). Lists in Streamify are rebuilt from scratch
 * whenever they change, so rows used to jump into their new places and every
 * row replayed its entrance animation. captureList() records where the rows
 * are, the caller rebuilds the list as usual, then play():
 *   - rows that stay glide from their old spot to the new one,
 *   - rows that left fade and shrink away where they were,
 *   - rows that are new fade in.
 * Only rows near the screen are animated, so long lists stay cheap.
 */
(function initStreamifyMotion() {
    'use strict';

    const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const GLIDE_MS = 460;
    const OUT_MS = 320;
    const IN_MS = 380;

    function reducedMotion() {
        return (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
            document.documentElement.classList.contains('motion-reduced');
    }

    function nearViewport(rect, margin = 240) {
        return rect.bottom > -margin && rect.top < window.innerHeight + margin && rect.height > 0;
    }

    const defaultKey = el => (el.dataset && (el.dataset.id || el.dataset.motionKey)) || null;

    // Skip a row's CSS entrance animation by jumping it to its end state
    // (some rows are only visible at the end of it, e.g. opacity 0 -> 1).
    function finishEntrance(el) {
        if (typeof el.getAnimations !== 'function') return;
        el.getAnimations().forEach(animation => {
            if (typeof CSSAnimation !== 'undefined' && !(animation instanceof CSSAnimation)) return;
            try { animation.finish(); } catch (e) { /* infinite animations can't finish */ }
        });
    }

    /**
     * @param {Element} container
     * @param {object} [options]
     * @param {(el: Element) => string|null} [options.key]   identifies a row across renders
     * @param {(key: string) => boolean} [options.isRemoved] override "row left the list"
     *        (lists that render in batches pass the new data's ids, so rows not yet
     *        appended aren't mistaken for removed ones)
     */
    function captureList(container, options = {}) {
        const key = options.key || defaultKey;
        const before = new Map();
        if (container && !reducedMotion()) {
            for (const el of container.children) {
                const k = key(el);
                if (k == null || el.classList.contains('motion-ghost')) continue;
                const rect = el.getBoundingClientRect();
                if (!nearViewport(rect)) continue;
                before.set(String(k), { el, rect });
            }
        }
        const hadRows = before.size > 0;

        function play() {
            if (!container || !hadRows || reducedMotion()) return;
            const after = new Map();
            for (const el of container.children) {
                const k = key(el);
                if (k != null && !el.classList.contains('motion-ghost')) after.set(String(k), el);
            }
            const containerRect = container.getBoundingClientRect();
            const removed = [];

            before.forEach((old, k) => {
                const el = after.get(k);
                const gone = options.isRemoved ? options.isRemoved(k) : !el;
                if (!el) {
                    if (gone) removed.push(old);
                    return;
                }
                // It was on screen already: no entrance replay.
                finishEntrance(el);
                const rect = el.getBoundingClientRect();
                const dx = old.rect.left - rect.left;
                const dy = old.rect.top - rect.top;
                if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
                el.animate(
                    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
                    { duration: GLIDE_MS, easing: EASE }
                );
            });

            after.forEach((el, k) => {
                if (before.has(k)) return;
                const rect = el.getBoundingClientRect();
                if (!nearViewport(rect)) return;
                finishEntrance(el);
                el.animate(
                    [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'scale(1)' }],
                    { duration: IN_MS, easing: EASE, delay: 90 }
                );
            });

            if (removed.length) {
                if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
                removed.forEach(({ el, rect }) => {
                    const ghost = el.cloneNode(true);
                    ghost.classList.add('motion-ghost');
                    ghost.removeAttribute('id');
                    ghost.setAttribute('aria-hidden', 'true');
                    Object.assign(ghost.style, {
                        position: 'absolute',
                        left: `${rect.left - containerRect.left + container.scrollLeft - container.clientLeft}px`,
                        top: `${rect.top - containerRect.top + container.scrollTop - container.clientTop}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`,
                        margin: '0',
                        pointerEvents: 'none',
                        animation: 'none',
                        zIndex: '0'
                    });
                    container.appendChild(ghost);
                    const fade = ghost.animate(
                        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }],
                        { duration: OUT_MS, easing: EASE, fill: 'forwards' }
                    );
                    fade.finished.then(() => ghost.remove(), () => ghost.remove());
                });
            }
        }

        return { play };
    }

    // Keyframes that take a block from nothing (no height, and a negative
    // margin that cancels its flex/grid gap) to its natural size.
    function foldFrames(el) {
        const height = el.getBoundingClientRect().height;
        const style = getComputedStyle(el);
        const parent = el.parentElement;
        const gap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
        // Cancel the gap on whichever side has a neighbour.
        const side = el.previousElementSibling ? 'marginTop' : 'marginBottom';
        const closed = { height: '0px', paddingTop: '0px', paddingBottom: '0px', [side]: `${-gap}px`, opacity: 0, transform: 'scale(0.96)' };
        const open = { height: `${height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, [side]: style[side], opacity: 1, transform: 'scale(1)' };
        return { closed, open };
    }

    /** Unfold a newly added block (its height opens, so neighbours slide aside). */
    function foldIn(el, { duration = 420 } = {}) {
        if (!el || reducedMotion()) return;
        const { closed, open } = foldFrames(el);
        el.style.overflow = 'hidden';
        el.animate([closed, open], { duration, easing: EASE })
            .finished.then(() => { el.style.overflow = ''; }, () => {});
    }

    /** Fold a block shut before removing it. Resolves when it's done. */
    function foldOut(el, { duration = 360 } = {}) {
        if (!el || reducedMotion()) return Promise.resolve();
        const { closed, open } = foldFrames(el);
        el.style.overflow = 'hidden';
        return el.animate([open, closed], { duration, easing: EASE, fill: 'forwards' })
            .finished.then(() => undefined, () => undefined);
    }

    window.StreamifyMotion = Object.freeze({ captureList, foldIn, foldOut, reducedMotion });
})();
