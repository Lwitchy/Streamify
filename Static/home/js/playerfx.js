/*
 * Player effects (Settings > Appearance > Player).
 *
 *  - Pulse with the music: a soft glow in the player color behind the app and
 *    the full-screen player gets brighter and a touch bigger on every bass hit.
 *  - Glowing progress bar: the tip of the played part glows, following how
 *    loud the song is right now.
 *  - Player color: the accent used across the player, the playing row and the
 *    volume bar - picked from the cover (default), the theme, or the lyrics
 *    highlight color.
 *
 * Audio comes from window.StreamifyAudio (player.js), a passive analyser on
 * the same graph as the equalizer. Where analysis isn't available (iPhone /
 * iPad) the glows stay still instead of reacting. Only opacity, transform and
 * one custom property on the two progress bars change per frame.
 */
(function initStreamifyPlayerFx() {
    'use strict';

    const STORAGE_KEY = 'streamify:player-fx:v1';
    const DEFAULTS = Object.freeze({ pulse: true, progressGlow: true, color: 'cover' });
    const COLORS = ['cover', 'theme', 'lyrics'];
    const root = document.documentElement;
    const audioEl = document.getElementById('audio-player');

    function read() {
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { stored = null; }
        const prefs = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
        prefs.pulse = prefs.pulse !== false;
        prefs.progressGlow = prefs.progressGlow !== false;
        if (!COLORS.includes(prefs.color)) prefs.color = DEFAULTS.color;
        return prefs;
    }

    let prefs = read();

    /* --- Glow layers ---------------------------------------------------- */

    function makeGlow(className) {
        const el = document.createElement('div');
        el.className = `beat-glow ${className}`;
        el.setAttribute('aria-hidden', 'true');
        return el;
    }

    const appGlow = makeGlow('beat-glow--app');
    const playerGlow = makeGlow('beat-glow--player');
    document.body.prepend(appGlow);
    const backdrop = document.getElementById('dedicated-player-backdrop');
    if (backdrop) backdrop.after(playerGlow);

    const bars = [document.getElementById('progress-bar'), document.getElementById('dedicated-progress-bar')].filter(Boolean);

    /* --- Apply preferences ---------------------------------------------- */

    function apply() {
        root.dataset.playerColor = prefs.color;
        root.classList.toggle('fx-pulse', prefs.pulse);
        root.classList.toggle('fx-progress-glow', prefs.progressGlow);
        syncControls();
        updateLoopState();
    }

    function save(changes) {
        prefs = { ...prefs, ...changes };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) { /* this page only */ }
        apply();
    }

    function syncControls() {
        const pulse = document.getElementById('fx-pulse-toggle');
        const glow = document.getElementById('fx-progress-glow-toggle');
        if (pulse) pulse.checked = prefs.pulse;
        if (glow) glow.checked = prefs.progressGlow;
        document.querySelectorAll('input[name="player-color"]').forEach(input => { input.checked = input.value === prefs.color; });
        const note = document.getElementById('fx-pulse-note');
        if (note && window.StreamifyAudio && !window.StreamifyAudio.supported()) {
            note.textContent = 'Not available on iPhone or iPad: it would stop music when the screen locks. The glow stays still instead.';
        }
    }

    function wireControls() {
        const pulse = document.getElementById('fx-pulse-toggle');
        const glow = document.getElementById('fx-progress-glow-toggle');
        if (pulse) pulse.addEventListener('change', () => save({ pulse: pulse.checked }));
        if (glow) glow.addEventListener('change', () => save({ progressGlow: glow.checked }));
        document.querySelectorAll('input[name="player-color"]').forEach(input => {
            input.addEventListener('change', () => { if (input.checked) save({ color: input.value }); });
        });
        const reset = document.getElementById('fx-reset-btn');
        if (reset) reset.addEventListener('click', () => save({ ...DEFAULTS }));
    }

    /* --- Beat + loudness analysis --------------------------------------- */

    let analyser = null;
    let freq = null;
    let wave = null;
    let raf = null;
    let lastTime = 0;
    // Envelopes
    let bassAvg = 0.2, bassPeak = 0.4, beat = 0;
    let levelAvg = 0.1, levelPeak = 0.25, level = 0;
    let presence = 0; // fades the whole glow in while playing, out when paused
    let shownBeat = -1, shownLevel = -1;

    function reducedMotion() {
        return window.StreamifyMotion ? window.StreamifyMotion.reducedMotion()
            : (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function wantsLoop() {
        return (prefs.pulse || prefs.progressGlow) && audioEl && !audioEl.paused && !document.hidden && !reducedMotion();
    }

    function updateLoopState() {
        if (wantsLoop()) {
            if (!analyser && window.StreamifyAudio) {
                window.StreamifyAudio.ensureAnalyser().then(node => {
                    if (!node) return;
                    analyser = node;
                    freq = new Uint8Array(analyser.frequencyBinCount);
                    wave = new Uint8Array(analyser.fftSize);
                    start();
                });
            }
            start();
        } else if (raf === null) {
            settle();
        }
    }

    function start() {
        if (raf !== null) return;
        lastTime = performance.now();
        raf = requestAnimationFrame(tick);
    }

    // Glide back to rest when paused (the loop keeps running until it's there).
    function settle() {
        if (raf === null) raf = requestAnimationFrame(tick);
    }

    function measure() {
        if (!analyser) return null;
        analyser.getByteFrequencyData(freq);
        const binHz = analyser.context.sampleRate / analyser.fftSize;
        const lo = Math.max(1, Math.floor(35 / binHz));
        const hi = Math.max(lo + 1, Math.ceil(150 / binHz));
        let sum = 0;
        for (let i = lo; i <= hi; i++) sum += freq[i];
        const bass = sum / ((hi - lo + 1) * 255);

        analyser.getByteTimeDomainData(wave);
        let sq = 0;
        for (let i = 0; i < wave.length; i += 2) {
            const v = (wave[i] - 128) / 128;
            sq += v * v;
        }
        const rms = Math.sqrt(sq / (wave.length / 2));
        return { bass, rms };
    }

    function tick(now) {
        raf = null;
        const dt = Math.min(0.1, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;
        const playing = wantsLoop();
        let targetBeat = 0;
        let targetLevel = 0;

        const m = playing ? measure() : null;
        if (m) {
            // Adapt to each song: a slow average and a decaying peak define
            // what counts as a hit, so quiet and loud tracks both pulse.
            bassAvg += (m.bass - bassAvg) * Math.min(1, dt / 1.6);
            bassPeak = Math.max(m.bass, bassPeak - dt * 0.12);
            const floor = bassAvg * 0.92;
            targetBeat = Math.max(0, Math.min(1, (m.bass - floor) / Math.max(0.06, bassPeak - floor)));
            targetBeat = Math.pow(targetBeat, 1.4);

            levelAvg += (m.rms - levelAvg) * Math.min(1, dt / 2.5);
            levelPeak = Math.max(m.rms, levelPeak - dt * 0.05);
            targetLevel = Math.max(0, Math.min(1, m.rms / Math.max(0.05, levelPeak)));
        } else if (playing) {
            // No analyser: hold a gentle steady glow.
            targetLevel = 0.45;
        }

        // Fast attack, slower release, like a VU meter.
        beat += (targetBeat - beat) * Math.min(1, dt * (targetBeat > beat ? 28 : 6));
        level += (targetLevel - level) * Math.min(1, dt * (targetLevel > level ? 18 : 5));
        presence += ((playing ? 1 : 0) - presence) * Math.min(1, dt * 2.2);

        paint();

        const resting = !playing && beat < 0.002 && level < 0.002 && presence < 0.002;
        if (!resting) raf = requestAnimationFrame(tick);
        else { beat = 0; level = 0; presence = 0; shownBeat = -1; paint(); }
    }

    function paint() {
        const b = Math.round(beat * 1000) / 1000;
        const p = Math.round(presence * 1000) / 1000;
        const key = b * 10 + p;
        if (key !== shownBeat) {
            shownBeat = key;
            const on = prefs.pulse ? p : 0;
            appGlow.style.opacity = String(on * (0.25 + b * 0.75));
            appGlow.style.transform = `scale(${1 + b * 0.05})`;
            playerGlow.style.opacity = String(on * (0.32 + b * 0.68));
            playerGlow.style.transform = `scale(${1 + b * 0.07})`;
        }
        const l = Math.round(level * 100) / 100;
        if (l !== shownLevel) {
            shownLevel = l;
            bars.forEach(bar => bar.style.setProperty('--level', String(l)));
        }
    }

    ['play', 'playing', 'pause', 'ended', 'emptied'].forEach(type => audioEl && audioEl.addEventListener(type, updateLoopState));
    document.addEventListener('visibilitychange', updateLoopState);

    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY) return;
        prefs = read();
        apply();
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { wireControls(); apply(); }, { once: true });
    else { wireControls(); apply(); }

    window.StreamifyPlayerFx = Object.freeze({
        get prefs() { return { ...prefs }; },
        set: save,
        get levels() { return { beat, level, analyser: Boolean(analyser) }; }
    });
})();
