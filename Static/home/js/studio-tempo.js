/*
 * Streamify - tempo (BPM) from a decoded song, for Studio's Sound page.
 *
 *   window.StreamifyTempo.estimate(audioBuffer)
 *     -> Promise<{ bpm, confidence }>   (bpm 0 when there is no steady beat)
 *
 * 1. Onset strength ("spectral flux"): short FFT frames (1024 samples, ~86
 *    frames a second at 22.05 kHz) are grouped into 36 log-spaced bands from
 *    40 Hz to 10 kHz; every rise in a band's level (in dB) counts. A kick, a
 *    snare and a vocal entry each register, unlike one loudness curve.
 * 2. Periodicity: autocorrelation of that onset curve. Each candidate beat
 *    period scores its own autocorrelation plus a quarter of the one at twice
 *    the period (bars repeat too), times a prior centred on 140 BPM, one
 *    octave wide. The prior's centre matters: at 120 the detector read many
 *    fast pop songs (160-170) at half speed or at 2/3 (syncopated rhythms
 *    repeat every 1.5 beats).
 * 3. Confidence: how far ahead the winner is of its half, double, 2/3 and
 *    3/2 - the readings a tempo is usually confused with.
 *
 * Checked on 12 songs with published tempos (pop, 80-170 BPM): all within 2
 * BPM, including leave-one-out (settings chosen without the song being
 * tested). The first attempt - a beat-grid judge (Ellis-style DP) choosing
 * between candidates - got 0 of 12 and was dropped. A small, narrow test
 * set: other genres may fare worse, so Studio labels the result "measured"
 * and prefers a BPM tag when the file has one.
 *
 * Runs in small steps (awaits between stages) so playback stays smooth.
 */
(function initStreamifyTempo() {
    'use strict';

    const FFT_SIZE = 1024;
    const HOP = 256;
    const BANDS = 36;
    const LOW = 40;
    const HIGH = 10000;
    const MIN_BPM = 60;
    const MAX_BPM = 200;

    const tick = () => new Promise(r => setTimeout(r, 0));

    /* In-place radix-2 FFT. */
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang);
            const wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1;
                let ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const a = i + k;
                    const b = a + len / 2;
                    const tr = re[b] * cr - im[b] * ci;
                    const ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    const nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = nr;
                }
            }
        }
    }

    async function onsetEnvelope(mono, rate) {
        const frames = Math.floor((mono.length - FFT_SIZE) / HOP);
        if (frames < 64) return null;
        const hann = new Float32Array(FFT_SIZE);
        for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
        // FFT bin ranges of each log band
        const binHz = rate / FFT_SIZE;
        const edges = [];
        for (let b = 0; b <= BANDS; b++) edges.push(LOW * Math.pow(HIGH / LOW, b / BANDS));
        const bandFrom = [];
        const bandTo = [];
        for (let b = 0; b < BANDS; b++) {
            const from = Math.max(1, Math.floor(edges[b] / binHz));
            bandFrom.push(from);
            bandTo.push(Math.max(from + 1, Math.ceil(edges[b + 1] / binHz)));
        }
        const re = new Float32Array(FFT_SIZE);
        const im = new Float32Array(FFT_SIZE);
        const prev = new Float32Array(BANDS).fill(-100);
        const cur = new Float32Array(BANDS);
        const flux = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            const start = f * HOP;
            for (let i = 0; i < FFT_SIZE; i++) { re[i] = mono[start + i] * hann[i]; im[i] = 0; }
            fft(re, im);
            let sum = 0;
            for (let b = 0; b < BANDS; b++) {
                let power = 0;
                for (let k = bandFrom[b]; k < bandTo[b]; k++) power += re[k] * re[k] + im[k] * im[k];
                // dB with a floor, so silence never turns a tiny change into a hit
                const db = Math.max(-80, 10 * Math.log10(power / (bandTo[b] - bandFrom[b]) + 1e-10));
                cur[b] = db;
                const rise = db - prev[b];
                if (rise > 0 && f > 0) sum += rise;
            }
            prev.set(cur);
            flux[f] = sum / BANDS;
            if (f % 1500 === 0) await tick();
        }
        // Remove the slow trend (local mean over ~0.5 s), keep the rises.
        const fps = rate / HOP;
        const half = Math.round(fps * 0.25);
        const env = new Float32Array(frames);
        let acc = 0;
        for (let f = 0; f < Math.min(frames, half); f++) acc += flux[f];
        for (let f = 0; f < frames; f++) {
            const add = f + half;
            const drop = f - half - 1;
            if (add < frames) acc += flux[add];
            if (drop >= 0) acc -= flux[drop];
            const count = Math.min(frames - 1, add) - Math.max(0, drop + 1) + 1;
            env[f] = Math.max(0, flux[f] - acc / count);
        }
        // Normalise to unit standard deviation
        let mean = 0;
        for (let f = 0; f < frames; f++) mean += env[f];
        mean /= frames;
        let variance = 0;
        for (let f = 0; f < frames; f++) variance += (env[f] - mean) * (env[f] - mean);
        const sd = Math.sqrt(variance / frames) || 1;
        for (let f = 0; f < frames; f++) env[f] /= sd;
        return { env, fps };
    }

    async function autocorrelation(env, minLag, maxLag) {
        const n = env.length;
        const ac = new Float32Array(maxLag + 2);
        for (let lag = minLag; lag <= maxLag + 1; lag++) {
            let s = 0;
            for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
            ac[lag] = s / (n - lag);
            if (lag % 32 === 0) await tick();
        }
        return ac;
    }

    const PRIOR_CENTER = 140;
    const PRIOR_WIDTH = 1.0; // octaves
    const BAR_WEIGHT = 0.25; // share of the twice-the-period autocorrelation

    async function estimate(buffer) {
        const rate = buffer.sampleRate;
        // Mono mix of up to ~2.5 minutes from 10% in (skips quiet intros).
        const total = buffer.length;
        const from = Math.floor(total * 0.1);
        const length = Math.min(total - from, Math.floor(rate * 150));
        if (length < rate * 15) return { bpm: 0, confidence: 0 };
        const mono = new Float32Array(length);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const d = buffer.getChannelData(c);
            for (let i = 0; i < length; i++) mono[i] += d[from + i] / buffer.numberOfChannels;
        }
        await tick();
        const onset = await onsetEnvelope(mono, rate);
        if (!onset) return { bpm: 0, confidence: 0 };
        const { env, fps } = onset;

        const lagOf = bpm => 60 * fps / bpm;
        const minLag = Math.floor(lagOf(MAX_BPM * 2));
        const maxLag = Math.min(env.length - 2, Math.ceil(lagOf(MIN_BPM / 2)) + 2);
        const ac = await autocorrelation(env, minLag, maxLag);
        const at = x => {
            const i = Math.floor(x);
            if (i < minLag || i + 1 > maxLag) return 0;
            return ac[i] + (ac[i + 1] - ac[i]) * (x - i);
        };
        const score = bpm => {
            const lag = lagOf(bpm);
            const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PRIOR_CENTER) / PRIOR_WIDTH, 2));
            return (at(lag) + BAR_WEIGHT * at(lag * 2)) * prior;
        };
        // Coarse scan, then a fine one around the winner.
        let best = MIN_BPM;
        for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) if (score(bpm) > score(best)) best = bpm;
        for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.05) if (score(bpm) > score(best)) best = bpm;
        const top = score(best);
        if (!(top > 0)) return { bpm: 0, confidence: 0 };
        let rival = 0;
        [0.5, 2, 2 / 3, 1.5].forEach(r => {
            const c = best * r;
            if (c >= MIN_BPM && c <= MAX_BPM) rival = Math.max(rival, score(c));
        });
        const confidence = Math.max(0, Math.min(1, 1 - rival / top));
        return { bpm: Math.round(best * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
    }

    window.StreamifyTempo = Object.freeze({ estimate });
})();
