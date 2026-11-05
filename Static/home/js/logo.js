/*
 * Customizable Streamify wordmark (Settings > Appearance > Logo).
 *
 * Loaded in <head> right after theme.js so the saved look is on <html> before
 * the boot screen paints. Everything is driven by CSS custom properties and a
 * few data attributes on <html>; customize.css does the rendering. Saved per
 * device in localStorage, like the other appearance settings.
 */
(function initStreamifyLogo() {
    'use strict';

    const STORAGE_KEY = 'streamify:logo:v1';
    const root = document.documentElement;

    // scale: keeps every face roughly the width of the default wordmark so
    // it fits the sidebar and the top bar.
    const FONTS = Object.freeze({
        jakarta: { name: 'Default', family: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", weight: 760, style: 'normal', tracking: '-0.055em', scale: 1, variable: true },
        insta: { name: 'Insta', family: "'Grand Hotel', 'Brush Script MT', cursive", weight: 400, style: 'normal', tracking: '0', scale: 1.42 },
        brush: { name: 'Brush', family: "'Malvides', 'Brush Script MT', cursive", weight: 400, style: 'normal', tracking: '0', scale: 1.22 },
        pacifico: { name: 'Pacifico', family: "'Pacifico', cursive", weight: 400, style: 'normal', tracking: '0', scale: 0.98 },
        lobster: { name: 'Lobster', family: "'Lobster', cursive", weight: 400, style: 'normal', tracking: '0', scale: 1.08 },
        signature: { name: 'Signature', family: "'Sacramento', cursive", weight: 400, style: 'normal', tracking: '0', scale: 1.4 },
        serif: { name: 'Editorial', family: "'Playfair Display', Georgia, serif", weight: 800, style: 'italic', tracking: '-0.02em', scale: 0.98 },
        outfit: { name: 'Clean', family: "'Outfit', -apple-system, 'Segoe UI', sans-serif", weight: 700, style: 'normal', tracking: '-0.04em', scale: 1.05 },
        retro: { name: 'Retro', family: "'Righteous', sans-serif", weight: 400, style: 'normal', tracking: '0', scale: 0.95 },
        wide: { name: 'Wide', family: "'Unbounded', sans-serif", weight: 700, style: 'normal', tracking: '-0.04em', scale: 0.74 },
        marker: { name: 'Marker', family: "'Permanent Marker', cursive", weight: 400, style: 'normal', tracking: '0', scale: 0.92 },
        gothic: { name: 'Gothic', family: "'UnifrakturMaguntia', serif", weight: 400, style: 'normal', tracking: '0', scale: 1.1 },
        neon: { name: 'Neon tube', family: "'Monoton', sans-serif", weight: 400, style: 'normal', tracking: '0', scale: 0.7 },
        pixel: { name: 'Pixel', family: "'Press Start 2P', monospace", weight: 400, style: 'normal', tracking: '0', scale: 0.5 }
    });

    // null stops = follow the app theme gradient.
    const COLORS = Object.freeze({
        theme: { name: 'Theme', stops: null },
        instagram: { name: 'Insta', stops: ['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5'] },
        sunset: { name: 'Sunset', stops: ['#ff9a8b', '#ff6a88', '#ff99ac', '#fcb69f'] },
        ocean: { name: 'Ocean', stops: ['#00c6ff', '#0072ff', '#7f5af0'] },
        aurora: { name: 'Aurora', stops: ['#43e97b', '#38f9d7', '#7f7fd5'] },
        fire: { name: 'Fire', stops: ['#f12711', '#f5af19', '#ff6b00'] },
        candy: { name: 'Candy', stops: ['#ff9ff3', '#feca57', '#48dbfb'] },
        gold: { name: 'Gold', stops: ['#bf953f', '#fcf6ba', '#b38728', '#fbf5b7'] },
        chrome: { name: 'Chrome', stops: ['#ffffff', '#9ca3af', '#f3f4f6', '#6b7280'] },
        rainbow: { name: 'Rainbow', stops: ['#ff3d71', '#ff8a00', '#ffe600', '#00d26a', '#00a3ff', '#a100ff'] },
        white: { name: 'White', stops: ['#ffffff'] },
        custom: { name: 'Custom', stops: null }
    });

    const EFFECTS = Object.freeze({
        none: 'None',
        glow: 'Glow',
        neon: 'Neon',
        shadow: 'Shadow',
        retro3d: '3D',
        outline: 'Outline'
    });

    // Entrance animations (played once when the app opens).
    const INTROS = Object.freeze({
        morph: { name: 'Morph', anim: 'logoIntroMorph 1.9s cubic-bezier(0.22, 1, 0.36, 1)' },
        fade: { name: 'Fade', anim: 'logoIntroFade 1.2s ease-out' },
        pop: { name: 'Pop', anim: 'logoIntroPop 0.9s cubic-bezier(0.34, 1.56, 0.64, 1)' },
        drop: { name: 'Drop', anim: 'logoIntroDrop 1.1s cubic-bezier(0.34, 1.4, 0.64, 1)' },
        wipe: { name: 'Write on', anim: 'logoIntroWipe 1.4s cubic-bezier(0.65, 0, 0.35, 1)' },
        none: { name: 'None', anim: 'none 0s' }
    });

    // Looping motion after the entrance.
    const MOTIONS = Object.freeze({
        none: { name: 'None', anim: 'none 0s' },
        pulse: { name: 'Pulse', anim: 'logoMotionPulse 2.8s ease-in-out' },
        float: { name: 'Float', anim: 'logoMotionFloat 3.6s ease-in-out' },
        swing: { name: 'Swing', anim: 'logoMotionSwing 3.2s ease-in-out' },
        bounce: { name: 'Bounce', anim: 'logoMotionBounce 2.4s cubic-bezier(0.28, 0.84, 0.42, 1)' },
        flicker: { name: 'Flicker', anim: 'logoMotionFlicker 5s linear' }
    });

    const FLOWS = Object.freeze({ off: 0, slow: 12, normal: 5, fast: 2 });
    const SIZES = Object.freeze({ small: 0.86, default: 1, large: 1.15 });
    const CASES = Object.freeze({ none: 'none', lower: 'lowercase', upper: 'uppercase' });

    const DEFAULTS = Object.freeze({
        font: 'jakarta',
        color: 'theme',
        customFrom: '#ec4899',
        customTo: '#8b5cf6',
        effect: 'none',
        intro: 'morph',
        motion: 'none',
        flow: 'normal',
        size: 'default',
        textCase: 'none'
    });

    const isHex = value => /^#[0-9a-f]{6}$/i.test(String(value || ''));
    const pick = (value, table, fallback) => (Object.prototype.hasOwnProperty.call(table, value) ? value : fallback);

    function normalize(input) {
        const raw = input && typeof input === 'object' ? input : {};
        return {
            font: pick(raw.font, FONTS, DEFAULTS.font),
            color: pick(raw.color, COLORS, DEFAULTS.color),
            customFrom: isHex(raw.customFrom) ? raw.customFrom.toLowerCase() : DEFAULTS.customFrom,
            customTo: isHex(raw.customTo) ? raw.customTo.toLowerCase() : DEFAULTS.customTo,
            effect: pick(raw.effect, EFFECTS, DEFAULTS.effect),
            intro: pick(raw.intro, INTROS, DEFAULTS.intro),
            motion: pick(raw.motion, MOTIONS, DEFAULTS.motion),
            flow: pick(raw.flow, FLOWS, DEFAULTS.flow),
            size: pick(raw.size, SIZES, DEFAULTS.size),
            textCase: pick(raw.textCase, CASES, DEFAULTS.textCase)
        };
    }

    function read() {
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { stored = null; }
        return normalize(stored);
    }

    function colorStops(state) {
        if (state.color === 'theme') return ['var(--gradient-1)', 'var(--gradient-2)', 'var(--gradient-3)'];
        if (state.color === 'custom') return [state.customFrom, state.customTo];
        return COLORS[state.color].stops.slice();
    }

    // Repeats the first stop at the end so the flowing gradient loops seamlessly.
    function gradientFor(stops) {
        const list = stops.length === 1 ? [stops[0], stops[0]] : stops.concat(stops[0]);
        return `linear-gradient(90deg, ${list.join(', ')})`;
    }

    // The color used for glows, outlines and 3D depth.
    function accentFor(state, stops) {
        if (state.color === 'theme') return 'var(--gradient-2)';
        if (state.color === 'white' || state.color === 'chrome') return '#ffffff';
        return stops[Math.floor((stops.length - 1) / 2)];
    }

    // Drawn by a text-shadow copy behind the letters (customize.css). A CSS
    // filter would do too, but inside the sidebar's backdrop blur it paints a
    // dark box around the glow.
    function shadowFor(effect) {
        const glow = 'var(--logo-accent)';
        const mix = (pct, base = glow) => `color-mix(in srgb, ${base} ${pct}%, transparent)`;
        switch (effect) {
            case 'glow':
                return `0 0 6px ${mix(75)}, 0 0 16px ${mix(50)}, 0 0 28px ${mix(25)}`;
            case 'neon':
                return `0 0 1px rgba(255, 255, 255, 0.9), 0 0 4px ${mix(100)}, 0 0 10px ${mix(90)}, 0 0 22px ${mix(75)}, 0 0 40px ${mix(50)}`;
            case 'shadow':
                return '0 3px 3px rgba(0, 0, 0, 0.45), 0 8px 16px rgba(0, 0, 0, 0.55)';
            case 'retro3d': {
                const depth = `color-mix(in srgb, ${glow} 45%, #000)`;
                return `1px 1px 0 ${depth}, 2px 2px 0 ${depth}, 3px 3px 0 ${depth}, 4px 4px 0 ${depth}, 5px 7px 10px rgba(0, 0, 0, 0.5)`;
            }
            default:
                return 'none';
        }
    }

    // The shadow layer copies the text through attr(data-text).
    function tagLogos() {
        document.querySelectorAll('.streamify-logo').forEach(el => {
            if (!el.dataset.text) el.dataset.text = el.textContent.trim();
        });
    }

    let state = read();

    function apply() {
        const font = FONTS[state.font];
        const stops = colorStops(state);
        const style = root.style;

        root.classList.add('logo-custom');
        root.dataset.logoEffect = state.effect;
        root.dataset.logoFont = state.font;

        style.setProperty('--logo-family', font.family);
        style.setProperty('--logo-weight', String(font.weight));
        style.setProperty('--logo-style', font.style);
        style.setProperty('--logo-tracking', font.tracking);
        style.setProperty('--logo-variation', font.variable ? `'wght' ${font.weight}` : 'normal');
        style.setProperty('--logo-size-scale', String(SIZES[state.size]));
        style.setProperty('--logo-scale', String(+(SIZES[state.size] * font.scale).toFixed(3)));
        style.setProperty('--logo-case', CASES[state.textCase]);
        style.setProperty('--logo-gradient', gradientFor(stops));
        style.setProperty('--logo-accent', accentFor(state, stops));
        style.setProperty('--logo-shadow', shadowFor(state.effect));
        style.setProperty('--logo-intro', INTROS[state.intro].anim);
        style.setProperty('--logo-motion', MOTIONS[state.motion].anim);
        style.setProperty('--logo-flow', FLOWS[state.flow] ? `gradient-anim ${FLOWS[state.flow]}s linear infinite` : 'none 0s');

        syncControls();
    }

    function save(changes) {
        state = normalize({ ...state, ...changes });
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* this page only */ }
        apply();
    }

    // Restarts the entrance animation on every visible wordmark.
    function replay() {
        document.querySelectorAll('.streamify-logo').forEach(el => {
            el.style.animation = 'none';
            void el.offsetWidth;
            el.style.animation = '';
        });
    }

    /* --- Settings UI --- */

    function optionTile(group, value, label, extraClass, inner) {
        const tile = document.createElement('label');
        tile.className = `theme-option ${extraClass}`.trim();
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = group;
        input.value = value;
        tile.append(input);
        if (inner) tile.append(inner);
        const text = document.createElement('span');
        text.className = 'logo-option-name';
        text.textContent = label;
        tile.append(text);
        return tile;
    }

    function buildControls() {
        const fontGrid = document.getElementById('logo-font-grid');
        if (fontGrid && !fontGrid.childElementCount) {
            Object.entries(FONTS).forEach(([key, font]) => {
                const sample = document.createElement('span');
                sample.className = 'logo-font-sample';
                sample.textContent = 'Streamify';
                sample.style.fontFamily = font.family;
                sample.style.fontWeight = String(font.weight);
                sample.style.fontStyle = font.style;
                sample.style.letterSpacing = font.tracking;
                sample.style.fontSize = `${Math.round(19 * font.scale)}px`;
                fontGrid.append(optionTile('logo-font', key, font.name, 'logo-font-option', sample));
            });
        }

        const colorGrid = document.getElementById('logo-color-grid');
        if (colorGrid && !colorGrid.childElementCount) {
            Object.entries(COLORS).forEach(([key, color]) => {
                const swatch = document.createElement('span');
                swatch.className = 'theme-swatch logo-color-swatch';
                swatch.dataset.logoSwatch = key;
                if (color.stops) swatch.style.background = `linear-gradient(135deg, ${color.stops.join(', ')})`;
                colorGrid.append(optionTile('logo-color', key, color.name, '', swatch));
            });
        }

        [['logo-effect-grid', 'logo-effect', EFFECTS], ['logo-intro-grid', 'logo-intro', INTROS], ['logo-motion-grid', 'logo-motion', MOTIONS]]
            .forEach(([id, group, table]) => {
                const grid = document.getElementById(id);
                if (!grid || grid.childElementCount) return;
                Object.entries(table).forEach(([key, entry]) => {
                    grid.append(optionTile(group, key, typeof entry === 'string' ? entry : entry.name, 'logo-chip'));
                });
            });
    }

    function syncControls() {
        const checks = {
            'logo-font': state.font,
            'logo-color': state.color,
            'logo-effect': state.effect,
            'logo-intro': state.intro,
            'logo-motion': state.motion,
            'logo-flow': state.flow,
            'logo-size': state.size,
            'logo-case': state.textCase
        };
        Object.entries(checks).forEach(([name, value]) => {
            document.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = input.value === value; });
        });

        const from = document.getElementById('logo-custom-from');
        const to = document.getElementById('logo-custom-to');
        if (from) from.value = state.customFrom;
        if (to) to.value = state.customTo;
        const customRow = document.getElementById('logo-custom-colors');
        if (customRow) customRow.classList.toggle('is-disabled', state.color !== 'custom');
        const customSwatch = document.querySelector('[data-logo-swatch="custom"]');
        if (customSwatch) customSwatch.style.background = `linear-gradient(135deg, ${state.customFrom}, ${state.customTo})`;
    }

    function wireControls() {
        tagLogos();
        const pane = document.getElementById('logo-appearance');
        if (!pane) return;
        buildControls();

        const fields = {
            'logo-font': 'font',
            'logo-color': 'color',
            'logo-effect': 'effect',
            'logo-intro': 'intro',
            'logo-motion': 'motion',
            'logo-flow': 'flow',
            'logo-size': 'size',
            'logo-case': 'textCase'
        };
        pane.addEventListener('change', event => {
            const input = event.target;
            if (input.type === 'radio' && fields[input.name] && input.checked) {
                save({ [fields[input.name]]: input.value });
                if (input.name === 'logo-intro') replay();
                return;
            }
            if (input.id === 'logo-custom-from' || input.id === 'logo-custom-to') {
                save({ color: 'custom', [input.id === 'logo-custom-from' ? 'customFrom' : 'customTo']: input.value });
            }
        });
        // Live update while dragging the color picker.
        pane.addEventListener('input', event => {
            const input = event.target;
            if (input.id !== 'logo-custom-from' && input.id !== 'logo-custom-to') return;
            state = normalize({ ...state, color: 'custom', [input.id === 'logo-custom-from' ? 'customFrom' : 'customTo']: input.value });
            apply();
        });

        const replayBtn = document.getElementById('logo-replay-btn');
        if (replayBtn) replayBtn.addEventListener('click', replay);
        const resetBtn = document.getElementById('logo-reset-btn');
        if (resetBtn) resetBtn.addEventListener('click', () => { save({ ...DEFAULTS }); replay(); });

        syncControls();
    }

    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY) return;
        state = read();
        apply();
    });

    apply();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireControls, { once: true });
    else wireControls();

    window.StreamifyLogo = Object.freeze({
        get state() { return { ...state }; },
        set: save,
        replay,
        reset: () => save({ ...DEFAULTS }),
        FONTS, COLORS, EFFECTS, INTROS, MOTIONS
    });
})();
