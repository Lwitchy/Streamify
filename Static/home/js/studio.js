/*
 * Streamify Studio - the equalizer (desktop browsers and the desktop app).
 *
 * Signal chain, plugged into player.js through StreamifyAudio.setProcessor():
 *
 *   music -> preamp -> 8 filters -> clip guard (limiter) -> speakers
 *                                                 \-> analyser (spectrum)
 *
 *  - 8 bands, each low shelf / bell / high shelf / low cut / high cut /
 *    notch, with frequency, gain and width (Q).
 *  - Auto preamp lowers the level by the curve's highest boost, so boosting
 *    doesn't clip; the limiter catches whatever is left and the clip light
 *    shows when it had to.
 *  - Hold "Compare" to hear the original (no EQ, no preamp, no limiter).
 *  - The curve is the filters' real combined response (getFrequencyResponse),
 *    drawn over a live spectrum of what is playing.
 *
 * Not on iPhone / iPad: routing audio through Web Audio there stops music
 * when the screen locks (StreamifyAudio.supported()). Settings are per device
 * (localStorage).
 *
 * In the full player the Studio button sits at the end of the volume row:
 * green while Studio is changing the sound, a red flash when the clip guard
 * catches a peak. Opening Studio slides the cover and controls to the left
 * (they are measured before and after, then animated between) and the panel
 * comes in on the right.
 */
(function initStreamifyStudio() {
    'use strict';

    if (!window.StreamifyAudio || !window.StreamifyAudio.supported()) return;

    const STORAGE_KEY = 'streamify:studio:v1';
    const MIN_F = 20;
    const MAX_F = 20000;
    const RANGE_DB = 18;
    const TYPES = [
        { id: 'peaking', label: 'Bell' },
        { id: 'lowshelf', label: 'Low shelf' },
        { id: 'highshelf', label: 'High shelf' },
        { id: 'highpass', label: 'Low cut' },
        { id: 'lowpass', label: 'High cut' },
        { id: 'notch', label: 'Notch' }
    ];
    const HAS_GAIN = { peaking: true, lowshelf: true, highshelf: true };
    const COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#48dbfb', '#54a0ff', '#a29bfe', '#f368e0'];
    const DEFAULT_BANDS = [
        { type: 'lowshelf', freq: 60, gain: 0, q: 0.7 },
        { type: 'peaking', freq: 150, gain: 0, q: 1 },
        { type: 'peaking', freq: 400, gain: 0, q: 1 },
        { type: 'peaking', freq: 1000, gain: 0, q: 1 },
        { type: 'peaking', freq: 2500, gain: 0, q: 1 },
        { type: 'peaking', freq: 6000, gain: 0, q: 1 },
        { type: 'highshelf', freq: 10000, gain: 0, q: 0.7 },
        { type: 'peaking', freq: 15000, gain: 0, q: 1.4 }
    ];
    // Gains for the default bands (the old 3-band presets, spread over 8).
    const PRESETS = [
        { id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0] },
        { id: 'bass-boost', label: 'Bass boost', gains: [7, 4, 0, 0, 0, 0, 1, 0] },
        { id: 'warm', label: 'Warm', gains: [3, 2, 1, 0, -1, -2, -2, -1] },
        { id: 'vocal', label: 'Vocal', gains: [-2, -1, 1, 4, 4, 2, 1, 0] },
        { id: 'bright', label: 'Bright', gains: [-1, 0, 0, 0, 1, 3, 4, 3] },
        { id: 'electronic', label: 'Electronic', gains: [6, 3, -1, -2, 0, 2, 5, 3] },
        { id: 'rock', label: 'Rock', gains: [5, 3, -1, -2, 1, 3, 4, 2] },
        { id: 'loudness', label: 'Loudness', gains: [5, 2, 0, -1, 0, 1, 3, 2] }
    ];

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const dbToGain = db => Math.pow(10, db / 20);
    const $ = id => document.getElementById(id);

    /* --- State ------------------------------------------------------------ */

    function defaultState() {
        return {
            enabled: false,
            preset: 'flat',
            bands: DEFAULT_BANDS.map(b => ({ ...b, on: true })),
            preampAuto: true,
            preampDb: 0,
            limiter: true,
            normalize: false,
            viz: 'bars'
        };
    }

    function readState() {
        const base = defaultState();
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { stored = null; }
        if (!stored || typeof stored !== 'object') return base;
        const bands = Array.isArray(stored.bands) && stored.bands.length === DEFAULT_BANDS.length
            ? stored.bands.map((b, i) => ({
                type: TYPES.some(t => t.id === (b && b.type)) ? b.type : DEFAULT_BANDS[i].type,
                freq: clamp(Number(b && b.freq) || DEFAULT_BANDS[i].freq, MIN_F, MAX_F),
                gain: clamp(Number(b && b.gain) || 0, -RANGE_DB, RANGE_DB),
                q: clamp(Number(b && b.q) || DEFAULT_BANDS[i].q, 0.1, 18),
                on: !(b && b.on === false)
            }))
            : base.bands;
        return {
            enabled: stored.enabled === true,
            preset: typeof stored.preset === 'string' ? stored.preset : 'custom',
            bands,
            preampAuto: stored.preampAuto !== false,
            preampDb: clamp(Number(stored.preampDb) || 0, -RANGE_DB, 6),
            limiter: stored.limiter !== false,
            normalize: stored.normalize === true,
            viz: ['bars', 'line', 'mirror'].includes(stored.viz) ? stored.viz : 'bars'
        };
    }

    let state = readState();
    let saveTimer = null;

    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* this page only */ }
        }, 200);
    }

    /* --- Curve maths (independent of playback) ------------------------------
       An OfflineAudioContext is only used to build filters whose
       getFrequencyResponse() gives the exact curve, even before the music
       goes through Studio. */
    const CURVE_POINTS = 320;
    const curveFreqs = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) {
        curveFreqs[i] = MIN_F * Math.pow(MAX_F / MIN_F, i / (CURVE_POINTS - 1));
    }
    let calcFilters = null;
    try {
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const calc = new Offline(1, 128, 48000);
        calcFilters = DEFAULT_BANDS.map(() => calc.createBiquadFilter());
    } catch (e) { calcFilters = null; }

    const bandCurves = DEFAULT_BANDS.map(() => new Float32Array(CURVE_POINTS));
    const totalCurve = new Float32Array(CURVE_POINTS);
    const magScratch = new Float32Array(CURVE_POINTS);
    const phaseScratch = new Float32Array(CURVE_POINTS);

    function applyBandToFilter(filter, band, context) {
        const type = band.on ? band.type : 'peaking';
        filter.type = type;
        const t = context ? context.currentTime : 0;
        if (context) {
            filter.frequency.setTargetAtTime(band.freq, t, 0.012);
            filter.Q.setTargetAtTime(band.q, t, 0.012);
            filter.gain.setTargetAtTime(band.on && HAS_GAIN[type] ? band.gain : 0, t, 0.012);
        } else {
            filter.frequency.value = band.freq;
            filter.Q.value = band.q;
            filter.gain.value = band.on && HAS_GAIN[type] ? band.gain : 0;
        }
    }

    function recomputeCurve() {
        totalCurve.fill(0);
        if (!calcFilters) return;
        state.bands.forEach((band, i) => {
            const curve = bandCurves[i];
            if (!band.on) { curve.fill(0); return; }
            const filter = calcFilters[i];
            applyBandToFilter(filter, band, null);
            filter.getFrequencyResponse(curveFreqs, magScratch, phaseScratch);
            for (let k = 0; k < CURVE_POINTS; k++) {
                const db = 20 * Math.log10(Math.max(1e-6, magScratch[k]));
                curve[k] = db;
                totalCurve[k] += db;
            }
        });
    }

    function curvePeakDb() {
        let peak = -Infinity;
        for (let k = 0; k < CURVE_POINTS; k++) peak = Math.max(peak, totalCurve[k]);
        return peak;
    }

    function isFlat() {
        return state.bands.every(b => !b.on || (HAS_GAIN[b.type] && Math.abs(b.gain) < 0.05)) &&
            (state.preampAuto || Math.abs(state.preampDb) < 0.05);
    }

    function effectivePreampDb() {
        if (!state.preampAuto) return state.preampDb;
        return -Math.max(0, curvePeakDb());
    }

    /* --- Audio engine -------------------------------------------------------- */

    let engine = null;   // { context, input, level, filters, limiter, output }
    let comparing = false;
    let attaching = null;
    let levelDb = 0;     // "Even out loudness" gain for the playing song

    function buildEngine(context) {
        const input = context.createGain();
        // Loudness leveling sits after the preamp, before the EQ.
        const level = context.createGain();
        const filters = state.bands.map(() => context.createBiquadFilter());
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.12;
        const output = context.createGain();
        engine = { context, input, level, filters, limiter, output };
        wireEngine();
        applyAll();
        feedMonitor();
    }

    function wireEngine() {
        if (!engine) return;
        const { input, level, filters, limiter, output } = engine;
        input.disconnect();
        level.disconnect();
        filters.forEach(f => f.disconnect());
        limiter.disconnect();
        if (comparing) {
            input.connect(output);
            return;
        }
        input.connect(level);
        let node = level;
        filters.forEach(f => { node.connect(f); node = f; });
        if (state.limiter) { node.connect(limiter); node = limiter; }
        node.connect(output);
    }

    function applyAll() {
        recomputeCurve();
        if (!engine) return;
        state.bands.forEach((band, i) => applyBandToFilter(engine.filters[i], band, engine.context));
        const preamp = comparing ? 0 : effectivePreampDb();
        engine.input.gain.setTargetAtTime(dbToGain(preamp), engine.context.currentTime, 0.015);
        // Leveling glides (0.4 s) so a song settling in never jumps.
        const lvl = state.normalize && !comparing ? levelDb : 0;
        engine.level.gain.setTargetAtTime(dbToGain(lvl), engine.context.currentTime, 0.4);
    }

    /* --- Monitor: what the visualizer, meters and live loudness read ------
       One small chain per audio context. While Studio processes the music
       it listens after Studio (so you see your EQ); otherwise it taps the
       untouched music. Nothing here reaches the speakers. */
    let monitor = null; // { context, input, spectrum, left, right, kLeft, kRight }

    function buildMonitor(context) {
        const input = context.createGain();
        const spectrum = context.createAnalyser();
        spectrum.fftSize = 8192;
        spectrum.smoothingTimeConstant = 0.8;
        spectrum.minDecibels = -100;
        spectrum.maxDecibels = -10;
        input.connect(spectrum);
        const split = context.createChannelSplitter(2);
        input.connect(split);
        const left = context.createAnalyser();
        const right = context.createAnalyser();
        left.fftSize = right.fftSize = 2048;
        split.connect(left, 0);
        split.connect(right, 1);
        // K-weighting (BS.1770) for live loudness, then per channel.
        const shelf = context.createBiquadFilter();
        shelf.type = 'highshelf';
        shelf.frequency.value = 1681;
        shelf.gain.value = 4;
        const hp = context.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 38;
        hp.Q.value = 0.5;
        input.connect(shelf);
        shelf.connect(hp);
        const kSplit = context.createChannelSplitter(2);
        hp.connect(kSplit);
        const kLeft = context.createAnalyser();
        const kRight = context.createAnalyser();
        kLeft.fftSize = kRight.fftSize = 16384; // ~0.35 s: "momentary" loudness
        kSplit.connect(kLeft, 0);
        kSplit.connect(kRight, 1);
        monitor = { context, input, spectrum, left, right, kLeft, kRight, fed: null };
        feedMonitor();
    }

    function feedMonitor() {
        if (!monitor) return;
        const viaStudio = Boolean(engine && engine.context === monitor.context && state.enabled && !attaching &&
            window.StreamifyAudio.context === engine.context && processorAttached);
        const want = viaStudio ? 'studio' : 'tap';
        if (monitor.fed === want) return;
        if (monitor.fed === 'studio' && engine) { try { engine.output.disconnect(monitor.input); } catch (e) { /* not connected */ } }
        if (monitor.fed === 'tap') window.StreamifyAudio.removeTap(monitor.input);
        if (want === 'studio') engine.output.connect(monitor.input);
        else window.StreamifyAudio.addTap(monitor.input);
        monitor.fed = want;
    }

    /* Builds the monitor once the music runs through Web Audio (it needs a
       click to start, like Studio itself). */
    function ensureMonitor() {
        const context = window.StreamifyAudio.context;
        if (monitor && monitor.context === context) return Promise.resolve(monitor);
        return window.StreamifyAudio.ensureAnalyser().then(() => {
            const ctx = window.StreamifyAudio.context;
            if (!ctx || ctx.state !== 'running') return null;
            if (!monitor || monitor.context !== ctx) buildMonitor(ctx);
            return monitor;
        }).catch(() => null);
    }

    let processorAttached = false;

    /* Routes the music through Studio. Needs a running AudioContext, which
       browsers only start after a click - so this runs from the power
       switch, or on the next play when Studio was left on. */
    function attach() {
        if (!state.enabled) return Promise.resolve(false);
        if (engine && window.StreamifyAudio.context === engine.context) {
            window.StreamifyAudio.setProcessor({ input: engine.input, output: engine.output });
            processorAttached = true;
            feedMonitor();
            return Promise.resolve(true);
        }
        if (attaching) return attaching;
        attaching = window.StreamifyAudio.ensureAnalyser().then(() => {
            const context = window.StreamifyAudio.context;
            if (!context || context.state !== 'running' || !state.enabled) return false;
            if (!engine || engine.context !== context) buildEngine(context);
            window.StreamifyAudio.setProcessor({ input: engine.input, output: engine.output });
            processorAttached = true;
            return true;
        }).catch(() => false).finally(() => { attaching = null; feedMonitor(); refreshUi(); });
        return attaching;
    }

    function detach() {
        window.StreamifyAudio.setProcessor(null);
        processorAttached = false;
        feedMonitor();
    }

    function setEnabled(on) {
        state.enabled = Boolean(on);
        save();
        if (state.enabled) attach();
        else detach();
        refreshUi();
    }

    const audioEl = $('audio-player');
    if (audioEl) audioEl.addEventListener('play', () => { if (state.enabled) attach(); });

    /* --- Panel ------------------------------------------------------------- */

    let isOpen = false;
    let studioButton = null;
    let sectionsReady = false; // true once every part below is set up
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const rightPanel = document.querySelector('.dedicated-right-panel');
    const content = document.querySelector('.dedicated-player-content');
    const bottomActions = document.querySelector('.dedicated-bottom-actions');
    if (!rightPanel || !content) return;

    const panel = document.createElement('section');
    panel.className = 'studio-panel hidden';
    panel.id = 'studio-panel';
    panel.setAttribute('aria-label', 'Studio');
    panel.innerHTML = `
        <header class="studio-head">
            <div class="studio-title">
                <i class='bx bx-slider-alt' aria-hidden="true"></i>
                <h3>Studio</h3>
                <span class="studio-status" id="studio-status">Off</span>
            </div>
            <div class="studio-dots" role="tablist" aria-label="Studio pages">
                <button type="button" class="studio-dot" role="tab" data-go="eq" aria-label="Equalizer" title="Equalizer"></button>
                <button type="button" class="studio-dot" role="tab" data-go="sound" aria-label="Sound" title="Sound: visualizer and song details"></button>
            </div>
            <div class="studio-head-actions">
                <label class="switch studio-power" title="Studio on / off">
                    <input type="checkbox" id="studio-power" aria-label="Studio on">
                    <span class="slider"></span>
                </label>
                <button type="button" class="studio-icon-btn" id="studio-close" aria-label="Close Studio"><i class='bx bx-x'></i></button>
            </div>
        </header>
        <div class="studio-pages">
        <section class="studio-page is-active" data-page="eq" aria-label="Equalizer">
        <div class="studio-toolbar">
            <label class="studio-select">
                <span>Preset</span>
                <select id="studio-preset"></select>
            </label>
            <button type="button" class="studio-chip" id="studio-compare" title="Hold to hear the song without Studio">
                <i class='bx bx-transfer-alt' aria-hidden="true"></i><span>Hold to compare</span>
            </button>
            <button type="button" class="studio-chip" id="studio-reset"><i class='bx bx-reset' aria-hidden="true"></i><span>Reset</span></button>
        </div>
        <div class="studio-graph" id="studio-graph">
            <canvas id="studio-canvas" aria-label="Equalizer curve. Drag a point to change a band."
                title="Drag a point to move a band. Scroll to change its width. Double-click to turn it off."></canvas>
        </div>
        <div class="studio-editor" id="studio-editor">
            <div class="studio-band-picker" role="group" aria-label="Band">
                <button type="button" class="studio-band-step" id="studio-band-prev" aria-label="Previous band"><i class='bx bx-chevron-left'></i></button>
                <span class="studio-band-badge" id="studio-band-badge"><span class="studio-band-dot"></span><span id="studio-band-name">Band 4</span></span>
                <button type="button" class="studio-band-step" id="studio-band-next" aria-label="Next band"><i class='bx bx-chevron-right'></i></button>
            </div>
            <label><span>Type</span><select id="studio-band-type"></select></label>
            <label><span>Frequency</span><span class="studio-field"><input type="number" id="studio-band-freq" min="20" max="20000" step="1"><em>Hz</em></span></label>
            <label><span>Gain</span><span class="studio-field"><input type="number" id="studio-band-gain" min="-18" max="18" step="0.5"><em>dB</em></span></label>
            <label><span>Width (Q)</span><span class="studio-field"><input type="number" id="studio-band-q" min="0.1" max="18" step="0.1"></span></label>
            <label class="studio-check"><input type="checkbox" id="studio-band-on"><span>Band on</span></label>
        </div>
        <div class="studio-output">
            <div class="studio-preamp">
                <span class="studio-label">Preamp</span>
                <input type="range" id="studio-preamp" min="-18" max="6" step="0.5" aria-label="Preamp">
                <output id="studio-preamp-value">0.0 dB</output>
                <label class="studio-check"><input type="checkbox" id="studio-preamp-auto"><span>Auto</span></label>
            </div>
            <div class="studio-limiter">
                <label class="studio-check"><input type="checkbox" id="studio-limiter"><span>Clip guard</span></label>
                <span class="studio-clip-light" id="studio-clip-light" title="Lights up when the clip guard catches a peak"></span>
            </div>
        </div>
        </section>
        <section class="studio-page" data-page="sound" aria-label="Sound">
            <div class="studio-viz-head">
                <div class="studio-seg" role="radiogroup" aria-label="Visualizer style">
                    <button type="button" class="studio-seg-btn" role="radio" data-viz="bars">Bars</button>
                    <button type="button" class="studio-seg-btn" role="radio" data-viz="line">Line</button>
                    <button type="button" class="studio-seg-btn" role="radio" data-viz="mirror">Mirror</button>
                </div>
                <span class="studio-live" id="studio-live" title="Loudness of the last moment (K-weighted, ~0.4 s)"><span>Now</span><strong id="studio-live-lufs">&ndash;</strong><small>LUFS</small></span>
            </div>
            <canvas id="studio-viz" aria-label="Live spectrum"></canvas>
            <div class="studio-meters" aria-label="Output level">
                <div class="studio-meter"><span>L</span><div class="studio-meter-track"><i id="studio-meter-l"></i><b id="studio-hold-l"></b></div></div>
                <div class="studio-meter"><span>R</span><div class="studio-meter-track"><i id="studio-meter-r"></i><b id="studio-hold-r"></b></div></div>
            </div>
            <div class="studio-overview">
                <canvas id="studio-overview" aria-label="Whole song. Click to jump there." title="Click to jump there"></canvas>
                <p class="studio-overview-note" id="studio-overview-note"></p>
            </div>
            <div class="studio-track" id="studio-track" aria-label="About this track">
                <div class="studio-stat" data-stat="lufs" title="Integrated loudness (ITU-R BS.1770, K-weighted and gated). Streaming services level songs to about -14 LUFS."><span class="studio-stat-label">Loudness</span><strong>&ndash;</strong><small>LUFS</small></div>
                <div class="studio-stat" data-stat="peak" title="Highest sample level. Above 0 means the file itself clips."><span class="studio-stat-label">Peak</span><strong>&ndash;</strong><small>dBFS</small></div>
                <div class="studio-stat" data-stat="plr" title="Peak to loudness ratio: how much the loudest moments stand above the average. Low means heavily compressed."><span class="studio-stat-label">Dynamics</span><strong>&ndash;</strong><small>dB</small></div>
                <div class="studio-stat studio-stat-wide" data-stat="format"><span class="studio-stat-label">Format</span><strong>&ndash;</strong><small></small></div>
                <div class="studio-stat hidden" data-stat="bpm" title="From the file's BPM tag when it has one, otherwise measured from the song"><span class="studio-stat-label">Tempo</span><strong>&ndash;</strong><small>BPM</small></div>
            </div>
            <div class="studio-level">
                <label class="studio-check"><input type="checkbox" id="studio-normalize"><span>Even out loudness</span></label>
                <span class="studio-level-note" id="studio-level-note"></span>
            </div>
        </section>
            </div>`;
    rightPanel.appendChild(panel);

    const canvas = $('studio-canvas');
    const ctx2d = canvas.getContext('2d');
    const presetSelect = $('studio-preset');
    const typeSelect = $('studio-band-type');

    presetSelect.innerHTML = PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('') +
        '<option value="custom">Custom</option>';
    typeSelect.innerHTML = TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');

    let selected = 3;

    function formatFreq(f) {
        return f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : `${Math.round(f)}`;
    }

    function refreshEditor() {
        const band = state.bands[selected];
        typeSelect.value = band.type;
        $('studio-band-freq').value = String(Math.round(band.freq));
        $('studio-band-gain').value = String(Math.round(band.gain * 10) / 10);
        $('studio-band-gain').disabled = !HAS_GAIN[band.type];
        $('studio-band-q').value = String(Math.round(band.q * 100) / 100);
        $('studio-band-on').checked = band.on;
        const badge = $('studio-band-badge');
        badge.style.setProperty('--band', COLORS[selected]);
        badge.classList.toggle('is-off', !band.on);
        $('studio-band-name').textContent = `Band ${selected + 1} · ${formatFreq(band.freq)} Hz`;
    }

    function refreshUi() {
        const active = state.enabled && Boolean(engine) && (!isFlat() || (state.normalize && Math.abs(levelDb) > 0.05));
        $('studio-power').checked = state.enabled;
        presetSelect.value = PRESETS.some(p => p.id === state.preset) ? state.preset : 'custom';
        $('studio-preamp-auto').checked = state.preampAuto;
        $('studio-limiter').checked = state.limiter;
        const preamp = effectivePreampDb();
        const slider = $('studio-preamp');
        slider.value = String(preamp);
        slider.disabled = state.preampAuto;
        $('studio-preamp-value').textContent = `${preamp > 0 ? '+' : ''}${preamp.toFixed(1)} dB`;
        let status = 'Off';
        if (state.enabled && !engine) status = 'Starts with the music';
        else if (state.enabled) status = comparing ? 'Original' : (isFlat() ? 'On · flat' : 'On');
        $('studio-status').textContent = status;
        panel.classList.toggle('is-on', state.enabled);
        if (studioButton) {
            studioButton.classList.toggle('is-active', active);
            studioButton.setAttribute('aria-pressed', String(isOpen));
            studioButton.title = active ? 'Studio is on' : 'Studio';
        }
        const barButton = $('btn-eq');
        if (barButton) barButton.classList.toggle('studio-active', active);
        panel.querySelectorAll('.studio-seg-btn').forEach(btn => {
            const on = btn.dataset.viz === state.viz;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-checked', String(on));
        });
        if (typeof refreshLevelNote === 'function' && sectionsReady) refreshLevelNote();
        refreshEditor();
        draw();
    }

    function changed({ keepPreset = false } = {}) {
        if (!keepPreset) {
            state.preset = 'custom';
            if (presetTween) { cancelAnimationFrame(presetTween); presetTween = 0; }
        }
        applyAll();
        save();
        refreshUi();
    }

    /* Switching presets (or Reset) glides every band from where it is to
       its new place instead of jumping: frequency and width move on a log
       scale, gain linearly, with an ease-out. The sound follows the points
       (the filters are updated each frame and smooth their own changes). */
    let presetTween = 0;
    const easeOut = t => 1 - Math.pow(1 - t, 3);

    function applyPreset(id) {
        const preset = PRESETS.find(p => p.id === id);
        if (!preset) return;
        const target = DEFAULT_BANDS.map((b, i) => ({ ...b, gain: preset.gains[i], on: true }));
        state.preset = id;
        cancelAnimationFrame(presetTween);
        if (reduceMotion.matches) {
            state.bands = target;
            changed({ keepPreset: true });
            return;
        }
        const from = state.bands.map(b => ({ ...b, gain: HAS_GAIN[b.type] && b.on ? b.gain : 0 }));
        // Shape changes happen at the start, so the glide is in the new shape.
        state.bands = from.map((b, i) => ({ ...b, type: target[i].type, on: true }));
        const start = performance.now();
        const DURATION = 520;
        const step = now => {
            const t = Math.min(1, (now - start) / DURATION);
            const k = easeOut(t);
            state.bands.forEach((band, i) => {
                const a = from[i];
                const b = target[i];
                band.freq = Math.exp(Math.log(a.freq) + (Math.log(b.freq) - Math.log(a.freq)) * k);
                band.q = Math.exp(Math.log(a.q) + (Math.log(b.q) - Math.log(a.q)) * k);
                band.gain = a.gain + (b.gain - a.gain) * k;
            });
            if (t < 1) {
                applyAll();
                refreshUi();
                presetTween = requestAnimationFrame(step);
            } else {
                state.bands = target;
                presetTween = 0;
                changed({ keepPreset: true });
            }
        };
        presetTween = requestAnimationFrame(step);
    }

    /* Controls */
    $('studio-power').addEventListener('change', e => setEnabled(e.target.checked));
    presetSelect.addEventListener('change', () => {
        if (presetSelect.value !== 'custom') applyPreset(presetSelect.value);
    });
    $('studio-reset').addEventListener('click', () => {
        state.preampAuto = true;
        state.preampDb = 0;
        state.limiter = true;
        applyPreset('flat');
    });
    // Pick a band without the mouse: ‹ › step through the eight.
    $('studio-band-prev').addEventListener('click', () => {
        selected = (selected + state.bands.length - 1) % state.bands.length;
        refreshUi();
    });
    $('studio-band-next').addEventListener('click', () => {
        selected = (selected + 1) % state.bands.length;
        refreshUi();
    });
    typeSelect.addEventListener('change', () => { state.bands[selected].type = typeSelect.value; changed(); });
    $('studio-band-freq').addEventListener('change', e => {
        state.bands[selected].freq = clamp(Number(e.target.value) || state.bands[selected].freq, MIN_F, MAX_F);
        changed();
    });
    $('studio-band-gain').addEventListener('change', e => {
        state.bands[selected].gain = clamp(Number(e.target.value) || 0, -RANGE_DB, RANGE_DB);
        changed();
    });
    $('studio-band-q').addEventListener('change', e => {
        state.bands[selected].q = clamp(Number(e.target.value) || state.bands[selected].q, 0.1, 18);
        changed();
    });
    $('studio-band-on').addEventListener('change', e => { state.bands[selected].on = e.target.checked; changed(); });
    $('studio-preamp-auto').addEventListener('change', e => {
        state.preampAuto = e.target.checked;
        if (!state.preampAuto) state.preampDb = Math.round(effectivePreampDbAuto() * 2) / 2;
        changed({ keepPreset: true });
    });
    $('studio-preamp').addEventListener('input', e => {
        state.preampDb = clamp(Number(e.target.value) || 0, -RANGE_DB, 6);
        changed({ keepPreset: true });
    });
    $('studio-limiter').addEventListener('change', e => {
        state.limiter = e.target.checked;
        wireEngine();
        changed({ keepPreset: true });
    });

    function effectivePreampDbAuto() { return -Math.max(0, curvePeakDb()); }

    /* Hold to compare (mouse, touch or Space while the button is focused) */
    const compareBtn = $('studio-compare');
    function setComparing(on) {
        if (comparing === on) return;
        comparing = on;
        compareBtn.classList.toggle('is-holding', on);
        wireEngine();
        applyAll();
        refreshUi();
    }
    compareBtn.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        try { compareBtn.setPointerCapture(e.pointerId); } catch (err) { /* window listeners below still release */ }
        setComparing(true);
    });
    // Release however the press ends - on the button or anywhere else, or
    // when the window loses focus mid-press.
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type =>
        compareBtn.addEventListener(type, () => setComparing(false)));
    ['pointerup', 'pointercancel', 'mouseup', 'blur'].forEach(type =>
        window.addEventListener(type, () => setComparing(false)));
    document.addEventListener('visibilitychange', () => { if (document.hidden) setComparing(false); });
    compareBtn.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true); } });
    compareBtn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') setComparing(false); });

    /* --- Graph ------------------------------------------------------------- */

    let width = 0;
    let height = 0;
    const PAD = { left: 34, right: 10, top: 12, bottom: 22 };

    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        width = rect.width;
        height = rect.height;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
    }

    const plotW = () => Math.max(1, width - PAD.left - PAD.right);
    const plotH = () => Math.max(1, height - PAD.top - PAD.bottom);
    const xOf = f => PAD.left + plotW() * Math.log(f / MIN_F) / Math.log(MAX_F / MIN_F);
    const fOf = x => MIN_F * Math.pow(MAX_F / MIN_F, clamp((x - PAD.left) / plotW(), 0, 1));
    const yOf = db => PAD.top + plotH() * (0.5 - db / (2 * RANGE_DB));
    const dbOf = y => clamp((0.5 - (y - PAD.top) / plotH()) * 2 * RANGE_DB, -RANGE_DB, RANGE_DB);

    function bandPoint(band, i) {
        const k = Math.round((CURVE_POINTS - 1) * Math.log(band.freq / MIN_F) / Math.log(MAX_F / MIN_F));
        // Bells and shelves sit at their gain; cuts and notches on the curve.
        const db = HAS_GAIN[band.type] ? band.gain : bandCurves[i][clamp(k, 0, CURVE_POINTS - 1)];
        return { x: xOf(band.freq), y: yOf(clamp(db, -RANGE_DB, RANGE_DB)) };
    }

    let spectrum = null;

    function drawGrid() {
        ctx2d.lineWidth = 1;
        ctx2d.font = '10px system-ui, sans-serif';
        ctx2d.fillStyle = 'rgba(255,255,255,0.38)';
        [-12, -6, 0, 6, 12].forEach(db => {
            const y = Math.round(yOf(db)) + 0.5;
            ctx2d.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
            ctx2d.beginPath();
            ctx2d.moveTo(PAD.left, y);
            ctx2d.lineTo(width - PAD.right, y);
            ctx2d.stroke();
            ctx2d.textAlign = 'right';
            ctx2d.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.left - 6, y + 3);
        });
        [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
            const x = Math.round(xOf(f)) + 0.5;
            ctx2d.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx2d.beginPath();
            ctx2d.moveTo(x, PAD.top);
            ctx2d.lineTo(x, height - PAD.bottom);
            ctx2d.stroke();
            ctx2d.textAlign = 'center';
            ctx2d.fillText(formatFreq(f), x, height - 6);
        });
    }

    function drawSpectrum() {
        const analyser = monitor ? monitor.spectrum : window.StreamifyAudio.analyser;
        if (!analyser) return;
        const bins = analyser.frequencyBinCount;
        if (!spectrum || spectrum.length !== bins) spectrum = new Float32Array(bins);
        analyser.getFloatFrequencyData(spectrum);
        const nyquist = analyser.context.sampleRate / 2;
        const minDb = -100;
        const maxDb = -10;
        ctx2d.beginPath();
        ctx2d.moveTo(PAD.left, height - PAD.bottom);
        const steps = Math.max(64, Math.round(plotW() / 3));
        for (let s = 0; s <= steps; s++) {
            const f = MIN_F * Math.pow(MAX_F / MIN_F, s / steps);
            const bin = clamp(Math.round(f / nyquist * bins), 0, bins - 1);
            const level = clamp((spectrum[bin] - minDb) / (maxDb - minDb), 0, 1);
            ctx2d.lineTo(xOf(f), height - PAD.bottom - level * plotH());
        }
        ctx2d.lineTo(width - PAD.right, height - PAD.bottom);
        ctx2d.closePath();
        const gradient = ctx2d.createLinearGradient(0, PAD.top, 0, height - PAD.bottom);
        gradient.addColorStop(0, 'rgba(255,255,255,0.16)');
        gradient.addColorStop(1, 'rgba(255,255,255,0.02)');
        ctx2d.fillStyle = gradient;
        ctx2d.fill();
    }

    /* The player color (picked from the cover by default) - the same accent
       the progress bar and buttons use, so Studio matches the player. */
    let accentRgb = '48, 209, 88';
    let accentReadAt = 0;
    function accent() {
        const now = performance.now();
        if (now - accentReadAt > 500) {
            accentReadAt = now;
            const value = getComputedStyle(panel).getPropertyValue('--player-accent-rgb').trim();
            if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(value)) accentRgb = value;
        }
        return accentRgb;
    }

    function drawCurve() {
        const on = state.enabled && !comparing;
        const rgb = accent();
        // Selected band's own contribution, softly filled
        const sel = state.bands[selected];
        if (sel.on) {
            const curve = bandCurves[selected];
            ctx2d.beginPath();
            ctx2d.moveTo(xOf(curveFreqs[0]), yOf(0));
            for (let k = 0; k < CURVE_POINTS; k++) ctx2d.lineTo(xOf(curveFreqs[k]), yOf(clamp(curve[k], -RANGE_DB, RANGE_DB)));
            ctx2d.lineTo(xOf(curveFreqs[CURVE_POINTS - 1]), yOf(0));
            ctx2d.closePath();
            ctx2d.fillStyle = `${COLORS[selected]}2e`;
            ctx2d.fill();
        }
        // Combined curve
        ctx2d.beginPath();
        for (let k = 0; k < CURVE_POINTS; k++) {
            const x = xOf(curveFreqs[k]);
            const y = yOf(clamp(totalCurve[k], -RANGE_DB, RANGE_DB));
            if (k === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
        }
        ctx2d.lineWidth = 2.5;
        ctx2d.strokeStyle = on ? `rgb(${rgb})` : 'rgba(255,255,255,0.55)';
        ctx2d.shadowColor = on ? `rgba(${rgb},0.55)` : 'transparent';
        ctx2d.shadowBlur = on ? 10 : 0;
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
        // Band points
        state.bands.forEach((band, i) => {
            const p = bandPoint(band, i);
            ctx2d.beginPath();
            ctx2d.arc(p.x, p.y, i === selected ? 8 : 6, 0, Math.PI * 2);
            ctx2d.fillStyle = band.on ? COLORS[i] : 'rgba(255,255,255,0.15)';
            ctx2d.fill();
            ctx2d.lineWidth = i === selected ? 2.5 : 1.5;
            ctx2d.strokeStyle = i === selected ? '#fff' : 'rgba(0,0,0,0.45)';
            ctx2d.stroke();
        });
    }

    function draw() {
        if (!width || !height || panel.classList.contains('hidden')) return;
        ctx2d.clearRect(0, 0, width, height);
        drawGrid();
        drawSpectrum();
        drawCurve();
    }

    let raf = 0;
    function loop() {
        raf = 0;
        if (!isOpen) return;
        if (page === 'sound') drawSound();
        else draw();
        pollLimiter();
        raf = requestAnimationFrame(loop);
    }

    /* Clip light: the limiter reports how much it is turning down (dB). */
    let clipUntil = 0;
    function pollLimiter() {
        if (!engine || !state.limiter || comparing) return;
        const reduction = engine.limiter.reduction;
        const amount = typeof reduction === 'number' ? reduction : (reduction && reduction.value) || 0;
        const now = performance.now();
        // Only while music plays: an idle compressor can report a stale value.
        if (amount < -0.5 && audioEl && !audioEl.paused) clipUntil = now + 700;
        const clipping = now < clipUntil;
        $('studio-clip-light').classList.toggle('is-lit', clipping);
        if (studioButton) studioButton.classList.toggle('is-clipping', clipping);
    }
    // While the panel is closed the button's clip flash still needs a slow poll.
    setInterval(() => { if (!isOpen && state.enabled) pollLimiter(); }, 250);

    /* Dragging points */
    let drag = null;

    function pointerPos(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function nearestBand(pos, maxDist) {
        let best = -1;
        let bestDist = maxDist;
        state.bands.forEach((band, i) => {
            const p = bandPoint(band, i);
            const d = Math.hypot(p.x - pos.x, p.y - pos.y);
            if (d < bestDist) { bestDist = d; best = i; }
        });
        return best;
    }

    canvas.addEventListener('pointerdown', e => {
        const pos = pointerPos(e);
        const i = nearestBand(pos, 22);
        if (i < 0) return;
        selected = i;
        drag = { band: i };
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('is-dragging');
        refreshUi();
    });
    canvas.addEventListener('pointermove', e => {
        const pos = pointerPos(e);
        if (!drag) {
            canvas.classList.toggle('is-over-point', nearestBand(pos, 22) >= 0);
            return;
        }
        const band = state.bands[drag.band];
        band.freq = Math.round(clamp(fOf(pos.x), MIN_F, MAX_F));
        if (HAS_GAIN[band.type]) band.gain = Math.round(dbOf(pos.y) * 2) / 2;
        changed();
    });
    ['pointerup', 'pointercancel'].forEach(type => canvas.addEventListener(type, () => {
        drag = null;
        canvas.classList.remove('is-dragging');
    }));
    canvas.addEventListener('dblclick', e => {
        const i = nearestBand(pointerPos(e), 22);
        if (i < 0) return;
        selected = i;
        state.bands[i].on = !state.bands[i].on;
        changed();
    });
    canvas.addEventListener('wheel', e => {
        const pos = pointerPos(e);
        const near = nearestBand(pos, 40);
        const i = near >= 0 ? near : selected;
        e.preventDefault();
        selected = i;
        const band = state.bands[i];
        band.q = clamp(band.q * (e.deltaY > 0 ? 0.9 : 1.1), 0.1, 18);
        changed();
    }, { passive: false });

    if (typeof ResizeObserver === 'function') new ResizeObserver(resizeCanvas).observe(canvas);

    /* --- Opening / closing: cover and controls slide left ------------------- */

    const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const wide = window.matchMedia('(min-width: 901px)');

    function movers() {
        return [document.querySelector('.dedicated-art-wrapper'), $('dedicated-standard-container')].filter(Boolean);
    }

    const canAnimate = () => wide.matches && !reduceMotion.matches && typeof Element.prototype.animate === 'function';
    const artWrapper = () => document.querySelector('.dedicated-art-wrapper');

    /* FLIP: measure, change layout, measure again, then animate from the old
       place to the new one. The cover also scales; the controls only move,
       so their text never stretches. */
    function flip(el, first, { scale = true } = {}) {
        if (!el || !first || !first.width) return;
        const last = el.getBoundingClientRect();
        if (!last.width) return;
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        const s = scale ? first.width / last.width : 1;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01) return;
        el.animate([
            { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${s})` },
            { transformOrigin: 'top left', transform: 'none' }
        ], { duration: 620, easing: EASE });
    }

    function slideLayout(toggle) {
        const animate = canAnimate();
        const els = movers();
        const first = animate ? els.map(el => el.getBoundingClientRect()) : null;
        toggle();
        if (!animate) return;
        els.forEach((el, i) => flip(el, first[i], { scale: i === 0 }));
    }

    const fadeIn = (el, from, delay = 0) => el.animate([
        { opacity: 0, transform: from },
        { opacity: 1, transform: 'none' }
    ], { duration: 520, delay, easing: EASE, fill: 'backwards' });

    const fadeOut = (el, to) => el.animate([
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: to }
    ], { duration: 200, easing: 'ease-in', fill: 'forwards' });

    let opening = false;

    /* Runs `then` once a fade-out ends - or after a short timer, because a
       hidden or minimised window pauses animations and their finish events
       would otherwise never come (the handoff to lyrics just stalled). */
    function afterFade(animation, then) {
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            then();
        };
        const timer = setTimeout(run, 320);
        animation.onfinish = run;
    }

    function open() {
        if (isOpen || opening) return;
        const playerOpen = document.body.classList.contains('player-section-active');
        if (!playerOpen) {
            if (window.StreamifyPlayerView) window.StreamifyPlayerView.open();
            setTimeout(open, 420);
            return;
        }
        const view = window.StreamifyPlayerView;
        const lyricsBox = $('dedicated-lyrics-container');
        if (view && view.isLyricsActive() && lyricsBox && canAnimate()) {
            // Lyrics -> Studio: the lyrics fade out first, then the cover
            // glides on from where it is (not from the normal layout).
            opening = true;
            const out = fadeOut(lyricsBox, 'translateX(-24px)');
            afterFade(out, () => {
                opening = false;
                const artFirst = artWrapper() ? artWrapper().getBoundingClientRect() : null;
                view.closeLyrics();
                out.cancel();
                enterStudio({ artFirst, controlsFade: true });
            });
            return;
        }
        if (view) view.closeLyrics();
        enterStudio();
    }

    function enterStudio({ artFirst = null, controlsFade = false } = {}) {
        isOpen = true;
        const animate = canAnimate();
        const art = artWrapper();
        const controls = $('dedicated-standard-container');
        const firstArt = animate && art ? (artFirst || art.getBoundingClientRect()) : null;
        const firstControls = animate && controls && !controlsFade ? controls.getBoundingClientRect() : null;
        content.classList.add('studio-active');
        panel.classList.remove('hidden');
        if (animate) {
            flip(art, firstArt);
            // Coming from lyrics the controls were hidden: they rise in.
            if (controls) {
                if (controlsFade) fadeIn(controls, 'translateY(14px)', 120);
                else flip(controls, firstControls, { scale: false });
            }
            fadeIn(panel, 'translateX(56px)', 90);
        }
        resizeCanvas();
        onPageShown();
        refreshUi();
        if (!raf) raf = requestAnimationFrame(loop);
    }

    /* Leaving Studio mode would re-apply the controls' entrance animation
       (a 0.8s fade from blank) on top of the slide back. Keep it off until
       the controls are next hidden and shown for real (lyrics, song view). */
    function freezeControlsEntrance() {
        const el = $('dedicated-standard-container');
        if (!el || el._studioFreeze) return;
        el.style.animation = 'none';
        const obs = new MutationObserver(() => {
            if (!el.classList.contains('hidden')) return;
            obs.disconnect();
            el._studioFreeze = null;
            el.style.animation = '';
        });
        el._studioFreeze = obs;
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    }

    function close({ instant = false } = {}) {
        if (!isOpen) return;
        isOpen = false;
        setComparing(false);
        freezeControlsEntrance();
        const finish = () => slideLayout(() => {
            content.classList.remove('studio-active');
            panel.classList.add('hidden');
        });
        if (instant || !wide.matches || reduceMotion.matches || !panel.animate) {
            content.classList.remove('studio-active');
            panel.classList.add('hidden');
        } else {
            const out = panel.animate([
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'translateX(40px)' }
            ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
            afterFade(out, () => { finish(); out.cancel(); });
        }
        refreshUi();
    }

    /* The player view is overflow-x:hidden around a backdrop wider than the
       screen. Hidden overflow can still be scrolled - the browser did it to
       reveal a focused Studio control - which left the whole player shifted
       sideways after Studio closed. Sideways scroll is never wanted there. */
    const playerView = $('dedicated-player-view');
    if (playerView) {
        playerView.addEventListener('scroll', () => {
            if (playerView.scrollLeft !== 0) playerView.scrollLeft = 0;
        }, { passive: true });
    }

    $('studio-close').addEventListener('click', () => close());
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen && !e.defaultPrevented) close();
    });

    /* Lyrics and Studio share the right side: opening lyrics closes Studio.
       Studio -> Lyrics: the panel fades out, then the cover glides from the
       Studio column to its lyrics place while the lyrics fade in. The click
       is held back until then and replayed (so lyrics.js sees one click). */
    const lyricsBtn = $('dedicated-btn-lyrics');
    let handingToLyrics = false;
    if (lyricsBtn) lyricsBtn.addEventListener('click', event => {
        if (!isOpen || handingToLyrics) return;
        if (!canAnimate()) { close({ instant: true }); return; }
        event.stopImmediatePropagation();
        event.preventDefault();
        isOpen = false;
        setComparing(false);
        freezeControlsEntrance();
        const out = fadeOut(panel, 'translateX(40px)');
        afterFade(out, () => {
            const art = artWrapper();
            const first = art ? art.getBoundingClientRect() : null;
            content.classList.remove('studio-active');
            panel.classList.add('hidden');
            out.cancel();
            handingToLyrics = true;
            try { lyricsBtn.click(); } finally { handingToLyrics = false; }
            flip(art, first);
            refreshUi();
        });
    }, true);
    // The player closing takes Studio with it.
    new MutationObserver(() => {
        if (!document.body.classList.contains('player-section-active')) close({ instant: true });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    /* --- Buttons ----------------------------------------------------------- */

    if (bottomActions) {
        studioButton = document.createElement('button');
        studioButton.type = 'button';
        studioButton.className = 'control-btn studio-btn';
        studioButton.id = 'dedicated-btn-studio';
        studioButton.setAttribute('aria-label', 'Studio');
        studioButton.innerHTML = "<i class='bx bx-slider-alt' aria-hidden=\"true\"></i><span class=\"studio-btn-dot\" aria-hidden=\"true\"></span>";
        studioButton.addEventListener('click', () => (isOpen ? close() : open()));
        studioButton.addEventListener('contextmenu', e => {
            // Right-click: Studio on / off without opening the panel.
            e.preventDefault();
            setEnabled(!state.enabled);
        });
        // Left side, next to the lyrics button (before the volume slider).
        const volume = bottomActions.querySelector('.dedicated-volume-wrapper');
        bottomActions.insertBefore(studioButton, volume || null);
    }

    const barButton = $('btn-eq');
    if (barButton) barButton.addEventListener('click', e => { e.stopPropagation(); open(); });

    /* --- Track details (Sound page) ---------------------------------------
       Measured from the song itself the first time it is looked at (Sound
       page open, or "Even out loudness" on): the file is fetched once,
       decoded at 22.05 kHz, and analysed in small steps so the page stays
       smooth. Results are kept per song on this device.
         - Loudness: ITU-R BS.1770 integrated loudness - K-weighting filters,
           400 ms blocks, absolute (-70 LUFS) and relative (-10 LU) gates.
         - Peak: highest sample (at 22.05 kHz, so a touch under true peak).
         - Dynamics: peak-to-loudness ratio (PLR).
         - Overview: loudness of 240 slices of the song, for the song shape.
         - Tempo: the file's BPM tag when it has one ("from tag"), otherwise
           measured by js/studio-tempo.js ("measured"; within 2 BPM on 12 pop
           songs with published tempos - see that file).
         - Format: codec, bit depth and sample rate read from the file by the
           server (GET /api/songs/:id/tags). */
    const ANALYSIS_KEY = 'streamify:studio:analysis:v4';
    const ANALYSIS_LIMIT = 400;
    const ANALYSIS_RATE = 22050;
    const MAX_ANALYSIS_BYTES = 150 * 1024 * 1024;
    let currentSong = null;
    let currentUrl = '';
    let analysisJob = null; // { key, controller }

    function readAnalyses() {
        try { return JSON.parse(localStorage.getItem(ANALYSIS_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    function storeAnalysis(key, result) {
        const all = readAnalyses();
        all[key] = { ...result, at: Date.now() };
        const keys = Object.keys(all);
        if (keys.length > ANALYSIS_LIMIT) {
            keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
                .slice(0, keys.length - ANALYSIS_LIMIT)
                .forEach(k => { delete all[k]; });
        }
        try { localStorage.setItem(ANALYSIS_KEY, JSON.stringify(all)); } catch (e) { /* this page only */ }
    }

    function songKey(song) {
        if (!song) return '';
        if (song.id != null) return `id:${song.id}`;
        return song.url ? `url:${song.url}` : '';
    }

    function codecName(codec) {
        const c = String(codec || '').toLowerCase();
        if (!c) return '';
        if (c.includes('layer 3') || c === 'mp3') return 'MP3';
        if (c.includes('flac')) return 'FLAC';
        if (c.includes('alac')) return 'ALAC';
        if (c.includes('aac')) return 'AAC';
        if (c.includes('opus')) return 'Opus';
        if (c.includes('vorbis')) return 'Vorbis';
        if (c.includes('pcm') || c.includes('wav')) return 'WAV';
        return String(codec).split(/[\s/]/)[0].toUpperCase();
    }

    function formatInfo(song, tags) {
        if (tags && tags.codec) {
            const name = codecName(tags.codec);
            const rate = tags.sampleRate ? `${(tags.sampleRate / 1000).toFixed(tags.sampleRate % 1000 ? 1 : 0)} kHz` : '';
            if (tags.lossless) {
                return { value: name, sub: [tags.bitsPerSample ? `${tags.bitsPerSample}-bit` : '', rate].filter(Boolean).join(' · ') };
            }
            if (tags.bitrate) return { value: String(tags.bitrate), sub: ['kbps', name, rate].filter(Boolean).join(' · ') };
            return { value: name, sub: rate };
        }
        const ext = String(song && (song.extension || (song.filepath || song.url || '').split('?')[0].split('.').pop()) || '')
            .replace(/^\./, '').toLowerCase();
        const lossless = ['flac', 'wav', 'aiff', 'aif', 'alac'].includes(ext);
        let kbps = Number(song && song.bitrate);
        if (kbps > 1000) kbps = Math.round(kbps / 1000);
        if (lossless) return { value: ext.toUpperCase(), sub: 'Lossless' };
        if (kbps > 0) return { value: `${Math.round(kbps)}`, sub: `kbps${ext && ext.length <= 4 ? ` · ${ext.toUpperCase()}` : ''}` };
        return { value: ext ? ext.toUpperCase() : '–', sub: '' };
    }

    function setStat(name, value, sub, note) {
        const el = panel.querySelector(`[data-stat="${name}"]`);
        if (!el) return;
        el.querySelector('strong').textContent = value;
        if (sub != null) el.querySelector('small').textContent = sub;
        if (note !== undefined) el.dataset.note = note || '';
    }

    function renderTrack(result, measuring) {
        const track = $('studio-track');
        track.classList.toggle('is-measuring', Boolean(measuring));
        const tags = result && result.tags;
        const fmt = formatInfo(currentSong, tags);
        const channels = (tags && tags.channels) || (result && result.channels);
        const layout = channels ? (channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels} ch`) : '';
        setStat('format', fmt.value, [fmt.sub, layout].filter(Boolean).join(' · '));
        const dash = measuring ? '…' : '–';
        const bpmEl = panel.querySelector('[data-stat="bpm"]');
        const tagBpm = tags && tags.bpm;
        const measuredBpm = result && result.bpm;
        bpmEl.classList.toggle('hidden', !(tagBpm || measuredBpm || measuring));
        if (tagBpm) setStat('bpm', String(Math.round(tagBpm)), 'BPM · from tag');
        else if (measuredBpm) setStat('bpm', String(Math.round(measuredBpm)), 'BPM · measured');
        else if (measuring) setStat('bpm', '…', 'BPM');
        if (!result || !Number.isFinite(result.lufs)) {
            ['lufs', 'peak', 'plr'].forEach(n => setStat(n, dash, null, ''));
            return;
        }
        const sign = v => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)).replace('-', '−');
        setStat('lufs', Number.isFinite(result.lufs) ? sign(result.lufs) : '–', 'LUFS');
        setStat('peak', Number.isFinite(result.peak) ? sign(result.peak) : '–', result.peak > 0 ? 'dBFS · clips' : 'dBFS');
        const plr = result.plr;
        const feel = !Number.isFinite(plr) ? '' : plr < 7 ? 'Squashed' : plr < 10 ? 'Punchy' : plr < 14 ? 'Balanced' : 'Open';
        setStat('plr', Number.isFinite(plr) ? plr.toFixed(1) : '–', feel ? `dB · ${feel}` : 'dB');
    }

    const nextFrame = () => new Promise(r => setTimeout(r, 0));

    async function kWeighted(buffer) {
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const ctx = new Offline(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        // BS.1770 pre-filter (high shelf ~ +4 dB above 1.5 kHz) and RLB high-pass.
        const shelf = ctx.createBiquadFilter();
        shelf.type = 'highshelf';
        shelf.frequency.value = 1681;
        shelf.gain.value = 4;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 38;
        hp.Q.value = 0.5;
        src.connect(shelf);
        shelf.connect(hp);
        hp.connect(ctx.destination);
        src.start();
        return ctx.startRendering();
    }

    async function measureLoudness(buffer) {
        const weighted = await kWeighted(buffer);
        const rate = weighted.sampleRate;
        const block = Math.round(rate * 0.4);
        const hop = Math.round(rate * 0.1);
        const channels = [];
        for (let c = 0; c < weighted.numberOfChannels; c++) channels.push(weighted.getChannelData(c));
        const powers = [];
        for (let start = 0; start + block <= weighted.length; start += hop) {
            let sum = 0;
            for (let c = 0; c < channels.length; c++) {
                const d = channels[c];
                let s = 0;
                for (let i = start; i < start + block; i++) s += d[i] * d[i];
                sum += s / block;
            }
            powers.push(sum);
            if (powers.length % 400 === 0) await nextFrame();
        }
        const lufsOf = p => -0.691 + 10 * Math.log10(p);
        const abs = powers.filter(p => p > 0 && lufsOf(p) > -70);
        if (!abs.length) return -Infinity;
        const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
        const rel = lufsOf(mean) - 10;
        const gated = abs.filter(p => lufsOf(p) > rel);
        const gatedMean = gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length);
        return lufsOf(gatedMean);
    }

    function measurePeak(buffer) {
        let peak = 0;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const d = buffer.getChannelData(c);
            for (let i = 0; i < d.length; i++) {
                const v = d[i] < 0 ? -d[i] : d[i];
                if (v > peak) peak = v;
            }
        }
        return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    }

    function measureOverview(buffer) {
        const COLS = 240;
        const n = buffer.length;
        const per = Math.max(1, Math.floor(n / COLS));
        const channels = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
        const bytes = new Uint8Array(COLS);
        for (let col = 0; col < COLS; col++) {
            let sum = 0;
            let count = 0;
            const from = col * per;
            const to = Math.min(n, from + per);
            for (let i = from; i < to; i += 4) {
                for (let c = 0; c < channels.length; c++) sum += channels[c][i] * channels[c][i];
                count += channels.length;
            }
            const db = count ? 10 * Math.log10(sum / count + 1e-12) : -100;
            bytes[col] = Math.round(clamp((db + 48) / 48, 0, 1) * 255);
        }
        let text = '';
        for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return btoa(text);
    }

    async function analyzeCurrent() {
        const key = songKey(currentSong);
        if (!key || !currentUrl) { renderTrack(null, false); return; }
        const cached = readAnalyses()[key];
        if (cached) { useResult(cached); return; }
        if (analysisJob && analysisJob.key === key) return;
        if (analysisJob) analysisJob.controller.abort();
        const controller = new AbortController();
        const job = { key, controller };
        analysisJob = job;
        renderTrack(null, true);
        // The file's own tags (BPM, real format) arrive first and show at once.
        let tags = null;
        const tagsReady = fetchTags(currentSong, controller.signal).then(found => {
            tags = found;
            if (found && analysisJob === job && songKey(currentSong) === key) renderTrack({ tags: found }, true);
            return found;
        });
        try {
            const response = await fetch(currentUrl, { credentials: 'include', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const size = Number(response.headers.get('content-length')) || 0;
            if (size > MAX_ANALYSIS_BYTES) throw new Error('too large');
            const bytes = await response.arrayBuffer();
            if (analysisJob !== job) return;
            const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            const decoder = new Offline(2, ANALYSIS_RATE, ANALYSIS_RATE);
            const buffer = await decoder.decodeAudioData(bytes);
            if (analysisJob !== job) return;
            await nextFrame();
            const peak = measurePeak(buffer);
            const lufs = await measureLoudness(buffer);
            if (analysisJob !== job) return;
            const overview = measureOverview(buffer);
            await tagsReady;
            let bpm = 0;
            if (!(tags && tags.bpm) && window.StreamifyTempo) {
                try { bpm = (await window.StreamifyTempo.estimate(buffer)).bpm || 0; } catch (e) { bpm = 0; }
                if (analysisJob !== job) return;
            }
            const result = {
                tags,
                bpm,
                overview,
                lufs: Math.round(lufs * 10) / 10,
                peak: Math.round(peak * 10) / 10,
                plr: Math.round((peak - lufs) * 10) / 10,
                channels: buffer.numberOfChannels
            };
            storeAnalysis(key, result);
            if (songKey(currentSong) === key) useResult(result);
        } catch (error) {
            if (controller.signal.aborted) return;
            console.warn('[STUDIO] Could not measure this track:', error && error.message);
            if (songKey(currentSong) === key) renderTrack(tags ? { tags } : null, false);
        } finally {
            if (analysisJob === job) analysisJob = null;
        }
    }

    /* The file's tags from the server. Only for library songs: local
       downloads in the app (blob:, capacitor:) have no server row to read. */
    async function fetchTags(song, signal) {
        if (!song || song.id == null || /^(blob|data|capacitor|file):/i.test(currentUrl)) return null;
        const base = (window.API_BASE_URL || '').replace(/\/+$/, '');
        try {
            const response = await fetch(`${base}/api/songs/${encodeURIComponent(song.id)}/tags`, { credentials: 'include', signal });
            if (!response.ok) return null;
            const tags = await response.json();
            return tags && typeof tags === 'object' ? tags : null;
        } catch (e) {
            return null;
        }
    }

    window.addEventListener('streamifysongchange', event => {
        const detail = event.detail || {};
        currentSong = detail.song || null;
        currentUrl = detail.url || '';
        if (analysisJob && analysisJob.key !== songKey(currentSong)) {
            analysisJob.controller.abort();
            analysisJob = null;
        }
        useResult(readAnalyses()[songKey(currentSong)] || null);
        if ((isOpen && page === 'sound') || (state.enabled && state.normalize)) analyzeCurrent();
    });

    /* A song's measurements: details, overview, and its leveling gain. */
    function useResult(result) {
        currentResult = result;
        overviewData = result && result.overview ? decodeOverview(result.overview) : null;
        $('studio-overview-note').textContent = overviewData ? '' : (result ? '' : 'The song\'s shape appears once it has been measured');
        renderTrack(result, false);
        applyLeveling();
        refreshUi();
    }

    /* --- Pages: Equalizer / Sound -------------------------------------------
       Two pages share one fixed-size area under the header, so the panel
       never changes height. Switching uses the song-change motion: the old
       page fades down and blurs out, the new one rises in from a blur. The
       dots in the header, or the arrow keys, switch; the last page is
       remembered on this device. */
    const PAGE_KEY = 'streamify:studio:page:v1';
    let page = 'eq';
    try { if (localStorage.getItem(PAGE_KEY) === 'sound') page = 'sound'; } catch (e) { /* default */ }

    const pageEl = name => panel.querySelector(`.studio-page[data-page="${name}"]`);

    function markPage() {
        ['eq', 'sound'].forEach(name => pageEl(name).classList.toggle('is-active', name === page));
        panel.querySelectorAll('.studio-dot').forEach(dot => {
            const on = dot.dataset.go === page;
            dot.classList.toggle('is-active', on);
            dot.setAttribute('aria-selected', String(on));
        });
        panel.dataset.page = page;
    }

    function onPageShown() {
        if (page === 'sound') {
            resizeSound();
            ensureMonitor().then(() => refreshUi());
            if (isOpen) analyzeCurrent();
        } else {
            resizeCanvas();
        }
    }

    function setPage(next, { animate = true } = {}) {
        if (next === page || !pageEl(next)) return;
        const from = pageEl(page);
        const to = pageEl(next);
        page = next;
        try { localStorage.setItem(PAGE_KEY, page); } catch (e) { /* this page only */ }
        if (!animate || !canAnimate()) {
            markPage();
            onPageShown();
            return;
        }
        panel.querySelectorAll('.studio-dot').forEach(dot => dot.classList.toggle('is-active', dot.dataset.go === page));
        const out = from.animate([
            { opacity: 1, transform: 'none', filter: 'blur(0px)' },
            { opacity: 0, transform: 'translateY(-10px)', filter: 'blur(6px)' }
        ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
        afterFade(out, () => {
            markPage();
            out.cancel();
            onPageShown();
            to.animate([
                { opacity: 0, transform: 'translateY(15px)', filter: 'blur(8px)' },
                { opacity: 1, transform: 'none', filter: 'blur(0px)' }
            ], { duration: 640, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
        });
    }

    panel.querySelectorAll('.studio-dot').forEach(dot =>
        dot.addEventListener('click', () => setPage(dot.dataset.go)));
    panel.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.target.closest('input, select, textarea')) return;
        e.preventDefault();
        setPage(e.key === 'ArrowRight' ? 'sound' : 'eq');
    });

    /* --- Sound page: visualizer, meters, overview -------------------------- */
    const vizCanvas = $('studio-viz');
    const vizCtx = vizCanvas.getContext('2d');
    const overviewCanvas = $('studio-overview');
    const overviewCtx = overviewCanvas.getContext('2d');
    let vizW = 0;
    let vizH = 0;
    let ovW = 0;
    let ovH = 0;

    function sizeCanvas(cv, cx) {
        const rect = cv.getBoundingClientRect();
        if (!rect.width || !rect.height) return [0, 0];
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
        cx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return [rect.width, rect.height];
    }

    function resizeSound() {
        [vizW, vizH] = sizeCanvas(vizCanvas, vizCtx);
        [ovW, ovH] = sizeCanvas(overviewCanvas, overviewCtx);
    }
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => { if (page === 'sound') resizeSound(); });
        ro.observe(vizCanvas);
        ro.observe(overviewCanvas);
    }

    // Visualizer style
    /* Switching style: the old drawing fades down and blurs out, the new one
       rises in from a blur - the same motion as switching pages. */
    let vizSwitch = null;
    panel.querySelectorAll('.studio-seg-btn').forEach(btn => btn.addEventListener('click', () => {
        const next = btn.dataset.viz;
        if (next === state.viz && !vizSwitch) return;
        const apply = () => {
            state.viz = next;
            save();
            refreshUi();
        };
        if (!canAnimate()) { apply(); return; }
        // Mark the choice at once; the drawing follows the fade.
        panel.querySelectorAll('.studio-seg-btn').forEach(b => b.classList.toggle('is-active', b === btn));
        if (vizSwitch) vizSwitch.cancel();
        const out = vizCanvas.animate([
            { opacity: 1, transform: 'none', filter: 'blur(0px)' },
            { opacity: 0, transform: 'translateY(-8px)', filter: 'blur(6px)' }
        ], { duration: 180, easing: 'ease-in', fill: 'forwards' });
        vizSwitch = out;
        afterFade(out, () => {
            if (vizSwitch !== out) return;
            vizSwitch = null;
            apply();
            out.cancel();
            vizCanvas.animate([
                { opacity: 0, transform: 'translateY(12px)', filter: 'blur(8px)' },
                { opacity: 1, transform: 'none', filter: 'blur(0px)' }
            ], { duration: 560, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
        });
    }));

    const VIZ_BANDS = 56;
    const VIZ_LOW = 30;
    const VIZ_HIGH = 16000;
    const vizLevels = new Float32Array(VIZ_BANDS);
    const vizCaps = new Float32Array(VIZ_BANDS);
    let vizData = null;

    function readVizLevels() {
        const analyser = monitor ? monitor.spectrum : window.StreamifyAudio.analyser;
        const playing = audioEl && !audioEl.paused;
        if (analyser && (!vizData || vizData.length !== analyser.frequencyBinCount)) {
            vizData = new Float32Array(analyser.frequencyBinCount);
        }
        if (analyser) analyser.getFloatFrequencyData(vizData);
        const bins = vizData ? vizData.length : 0;
        const nyquist = analyser ? analyser.context.sampleRate / 2 : 22050;
        for (let b = 0; b < VIZ_BANDS; b++) {
            let v = 0;
            if (analyser && playing) {
                const f0 = VIZ_LOW * Math.pow(VIZ_HIGH / VIZ_LOW, b / VIZ_BANDS);
                const f1 = VIZ_LOW * Math.pow(VIZ_HIGH / VIZ_LOW, (b + 1) / VIZ_BANDS);
                const i0 = clamp(Math.floor(f0 / nyquist * bins), 0, bins - 1);
                const i1 = clamp(Math.max(i0 + 1, Math.ceil(f1 / nyquist * bins)), 1, bins);
                let peak = -Infinity;
                for (let i = i0; i < i1; i++) if (vizData[i] > peak) peak = vizData[i];
                // Gentle tilt: highs carry less energy, so lift them a little.
                const tilt = (b / VIZ_BANDS) * 9;
                v = clamp((peak + tilt + 92) / 78, 0, 1);
            }
            // Rise at once, fall smoothly; caps drift down slower.
            vizLevels[b] = Math.max(v, vizLevels[b] - 0.03);
            vizCaps[b] = Math.max(vizLevels[b], vizCaps[b] - 0.006);
        }
        return Boolean(analyser);
    }

    function drawViz() {
        if (!vizW || !vizH) return;
        const live = readVizLevels();
        const rgb = accent();
        const ctx = vizCtx;
        ctx.clearRect(0, 0, vizW, vizH);
        const style = state.viz;
        const gradient = ctx.createLinearGradient(0, 0, 0, vizH);
        gradient.addColorStop(0, `rgba(${rgb}, 0.95)`);
        gradient.addColorStop(1, `rgba(${rgb}, 0.25)`);
        const gap = 3;
        const barW = Math.max(2, (vizW - gap * (VIZ_BANDS - 1)) / VIZ_BANDS);
        if (style === 'line') {
            // Smooth curve through the band levels (midpoint quadratic curves).
            const pts = [];
            for (let b = 0; b < VIZ_BANDS; b++) {
                pts.push({ x: (b + 0.5) * (vizW / VIZ_BANDS), y: vizH - 2 - vizLevels[b] * (vizH - 10) });
            }
            const trace = () => {
                ctx.moveTo(0, pts[0].y);
                ctx.lineTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) {
                    const mx = (pts[i - 1].x + pts[i].x) / 2;
                    const my = (pts[i - 1].y + pts[i].y) / 2;
                    ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, mx, my);
                }
                ctx.lineTo(vizW, pts[pts.length - 1].y);
            };
            ctx.beginPath();
            trace();
            ctx.lineTo(vizW, vizH);
            ctx.lineTo(0, vizH);
            ctx.closePath();
            const fill = ctx.createLinearGradient(0, 0, 0, vizH);
            fill.addColorStop(0, `rgba(${rgb}, 0.45)`);
            fill.addColorStop(1, `rgba(${rgb}, 0.02)`);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.beginPath();
            trace();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = `rgb(${rgb})`;
            ctx.shadowColor = `rgba(${rgb}, 0.6)`;
            ctx.shadowBlur = 12;
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else {
            const mirror = style === 'mirror';
            const mid = vizH / 2;
            ctx.fillStyle = gradient;
            for (let b = 0; b < VIZ_BANDS; b++) {
                const x = b * (barW + gap);
                const h = Math.max(2, vizLevels[b] * (mirror ? mid - 4 : vizH - 6));
                const r = Math.min(barW / 2, 4);
                ctx.beginPath();
                if (mirror) {
                    ctx.roundRect ? ctx.roundRect(x, mid - h, barW, h * 2, r) : ctx.rect(x, mid - h, barW, h * 2);
                } else {
                    ctx.roundRect ? ctx.roundRect(x, vizH - h, barW, h, [r, r, 0, 0]) : ctx.rect(x, vizH - h, barW, h);
                }
                ctx.fill();
                if (!mirror && vizCaps[b] > 0.02) {
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
                    ctx.fillRect(x, vizH - vizCaps[b] * (vizH - 6) - 4, barW, 2);
                    ctx.fillStyle = gradient;
                }
            }
        }
        if (!live || !audioEl || audioEl.paused) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.font = '13px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(!live ? 'Play a song to see it live' : 'Paused', vizW / 2, vizH / 2 + 4);
        }
    }

    // L / R meters with a short peak hold, and live (momentary) loudness.
    const meterBuf = new Float32Array(2048);
    let kBuf = null;
    const holds = { l: { pos: 0, at: 0 }, r: { pos: 0, at: 0 } };
    let liveAt = 0;
    let liveShown = null;
    const meterPos = db => clamp((db + 60) / 63, 0, 1); // -60 .. +3 dBFS

    function channelPeakDb(analyser) {
        analyser.getFloatTimeDomainData(meterBuf);
        let peak = 0;
        for (let i = 0; i < meterBuf.length; i++) {
            const v = meterBuf[i] < 0 ? -meterBuf[i] : meterBuf[i];
            if (v > peak) peak = v;
        }
        return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    }

    function drawMeters() {
        const now = performance.now();
        const playing = audioEl && !audioEl.paused && monitor;
        ['l', 'r'].forEach(side => {
            const db = playing ? channelPeakDb(side === 'l' ? monitor.left : monitor.right) : -Infinity;
            const pos = meterPos(db);
            const fill = $(`studio-meter-${side}`);
            const hold = $(`studio-hold-${side}`);
            fill.style.clipPath = `inset(0 ${(100 - pos * 100).toFixed(2)}% 0 0)`;
            const h = holds[side];
            if (pos >= h.pos || now - h.at > 1400) { h.pos = pos; h.at = now; }
            hold.style.left = `${(h.pos * 100).toFixed(2)}%`;
            hold.classList.toggle('is-over', h.pos > meterPos(0));
        });
        if (now - liveAt < 120) return;
        liveAt = now;
        let lufs = -Infinity;
        if (playing) {
            if (!kBuf || kBuf.length !== monitor.kLeft.fftSize) kBuf = new Float32Array(monitor.kLeft.fftSize);
            let sum = 0;
            [monitor.kLeft, monitor.kRight].forEach(an => {
                an.getFloatTimeDomainData(kBuf);
                let s = 0;
                for (let i = 0; i < kBuf.length; i++) s += kBuf[i] * kBuf[i];
                sum += s / kBuf.length;
            });
            lufs = sum > 0 ? -0.691 + 10 * Math.log10(sum) : -Infinity;
        }
        if (!Number.isFinite(lufs) || lufs < -70) {
            liveShown = null;
            $('studio-live-lufs').textContent = '–';
            return;
        }
        liveShown = liveShown == null ? lufs : liveShown + (lufs - liveShown) * 0.35;
        $('studio-live-lufs').textContent = liveShown.toFixed(1).replace('-', '−');
    }

    // Whole-song overview: loudness over time, played part in the player color.
    let overviewData = null;
    let overviewHover = -1;

    function decodeOverview(text) {
        try {
            const raw = atob(text || '');
            const out = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
            return out.length ? out : null;
        } catch (e) { return null; }
    }

    function drawOverview() {
        if (!ovW || !ovH) return;
        const ctx = overviewCtx;
        ctx.clearRect(0, 0, ovW, ovH);
        if (!overviewData) return;
        const rgb = accent();
        const n = overviewData.length;
        const step = ovW / n;
        const barW = Math.max(1, step - 1.5);
        const mid = ovH / 2;
        const duration = audioEl && Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
        const played = duration ? clamp(audioEl.currentTime / duration, 0, 1) : 0;
        for (let i = 0; i < n; i++) {
            const v = overviewData[i] / 255;
            const h = Math.max(1.5, Math.pow(v, 1.3) * (mid - 2));
            const x = i * step;
            const isPlayed = (i + 0.5) / n <= played;
            const hovered = overviewHover >= 0 && Math.abs(x - overviewHover) < step;
            ctx.fillStyle = hovered ? '#fff' : isPlayed ? `rgb(${rgb})` : 'rgba(255, 255, 255, 0.26)';
            ctx.fillRect(x, mid - h, barW, h * 2);
        }
        if (duration) {
            const x = played * ovW;
            ctx.fillStyle = '#fff';
            ctx.fillRect(Math.round(x) - 1, 0, 2, ovH);
        }
        if (overviewHover >= 0 && duration) {
            const t = clamp(overviewHover / ovW, 0, 1) * duration;
            const label = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
            ctx.font = '600 11px system-ui, sans-serif';
            ctx.textAlign = overviewHover > ovW - 40 ? 'right' : 'left';
            ctx.fillStyle = '#fff';
            ctx.fillText(label, overviewHover + (overviewHover > ovW - 40 ? -6 : 6), 12);
        }
    }

    overviewCanvas.addEventListener('pointermove', e => {
        overviewHover = e.clientX - overviewCanvas.getBoundingClientRect().left;
    });
    overviewCanvas.addEventListener('pointerleave', () => { overviewHover = -1; });
    overviewCanvas.addEventListener('click', e => {
        if (!audioEl || !Number.isFinite(audioEl.duration) || !overviewData) return;
        const frac = clamp((e.clientX - overviewCanvas.getBoundingClientRect().left) / ovW, 0, 1);
        audioEl.currentTime = frac * audioEl.duration;
    });

    function drawSound() {
        drawViz();
        drawMeters();
        drawOverview();
    }

    /* --- Even out loudness -------------------------------------------------
       Every song plays at about -14 LUFS (where streaming services level
       them), using this song's measured loudness. Quiet songs are only
       raised as far as their peak allows (stays 1 dB under full scale, and
       at most +9 dB); loud ones are turned down. Needs Studio on, and the
       song measured once (the first time it plays with this switched on). */
    const LEVEL_TARGET = -14;
    let currentResult = null;

    function levelFor(result) {
        if (!result || !Number.isFinite(result.lufs)) return null;
        let gain = LEVEL_TARGET - result.lufs;
        if (gain > 0) {
            const headroom = Number.isFinite(result.peak) ? Math.max(0, -1 - result.peak) : 0;
            gain = Math.min(gain, headroom, 9);
        } else {
            gain = Math.max(gain, -20);
        }
        return Math.round(gain * 10) / 10;
    }

    function applyLeveling() {
        const gain = levelFor(currentResult);
        levelDb = gain == null ? 0 : gain;
        applyAll();
        refreshLevelNote();
    }

    function refreshLevelNote() {
        const note = $('studio-level-note');
        $('studio-normalize').checked = state.normalize;
        if (!state.normalize) {
            note.textContent = `Plays every song at about ${LEVEL_TARGET} LUFS`;
        } else if (!state.enabled) {
            note.textContent = 'Turn Studio on to use this';
        } else if (!currentResult || !Number.isFinite(currentResult.lufs)) {
            note.textContent = 'Measuring this song…';
        } else {
            const gain = levelFor(currentResult);
            const sign = gain > 0 ? '+' : '';
            const capped = currentResult.lufs + gain < LEVEL_TARGET - 0.5;
            note.textContent = `This song ${sign}${gain.toFixed(1)} dB${capped ? ' (peak limits the boost)' : ''}`.replace('-', '−');
        }
    }

    $('studio-normalize').addEventListener('change', e => {
        state.normalize = e.target.checked;
        save();
        if (state.normalize) analyzeCurrent();
        applyLeveling();
        refreshUi();
    });

    window.StreamifyStudio = Object.freeze({
        open,
        close,
        isOpen: () => isOpen,
        isEnabled: () => state.enabled,
        setEnabled
    });

    sectionsReady = true;
    markPage();
    recomputeCurve();
    useResult(null);
})();
