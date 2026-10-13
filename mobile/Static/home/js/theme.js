(function initStreamifyTheme() {
    'use strict';

    const STORAGE_KEY = 'streamify:appearance:v1';
    const DEFAULT_STATE = Object.freeze({
        preset: 'classic',
        customColor: '#8b5cf6',
        scope: 'accent'
    });
    const PRESETS = Object.freeze({
        classic: Object.freeze({
            name: 'Classic',
            accent: '#1db954',
            accentHover: '#1ed760',
            onGradient: '#ffffff',
            gradient1: '#4169e1',
            gradient2: '#8164d7',
            gradient3: '#ec4899'
        }),
        pink: Object.freeze({
            name: 'Pink',
            accent: '#ec4899',
            accentHover: '#f472b6',
            onGradient: '#ffffff',
            gradient1: '#fb7185',
            gradient2: '#c026d3',
            gradient3: '#f9a8d4'
        }),
        red: Object.freeze({
            name: 'Red',
            accent: '#ef4444',
            accentHover: '#f87171',
            onGradient: '#ffffff',
            gradient1: '#fb7185',
            gradient2: '#dc2626',
            gradient3: '#f97316'
        }),
        yellow: Object.freeze({
            name: 'Yellow',
            accent: '#facc15',
            accentHover: '#fde047',
            onGradient: '#211a03',
            gradient1: '#f59e0b',
            gradient2: '#facc15',
            gradient3: '#fef08a'
        })
    });
    const THEME_PROPERTIES = Object.freeze([
        '--accent',
        '--accent-hover',
        '--accent-rgb',
        '--on-accent',
        '--on-gradient',
        '--gradient-1',
        '--gradient-2',
        '--gradient-3',
        '--gradient-1-rgb',
        '--gradient-2-rgb',
        '--bg-color',
        '--sidebar-bg',
        '--card-bg',
        '--card-hover',
        '--glass-border',
        '--settings-sidebar-bg',
        '--settings-content-bg',
        '--theme-gradient-alpha-1',
        '--theme-gradient-alpha-2'
    ]);

    const root = document.documentElement;
    let currentState;
    let currentDetail;
    let themesEnabled = Boolean(
        window.StreamifyExperiments && window.StreamifyExperiments.isEnabled('themes')
    );

    function normalizeHex(value) {
        const input = String(value || '').trim();
        if (/^#[0-9a-f]{6}$/i.test(input)) return input.toLowerCase();
        if (/^#[0-9a-f]{3}$/i.test(input)) {
            return `#${input.slice(1).split('').map(character => character + character).join('')}`.toLowerCase();
        }
        return null;
    }

    function hexToRgb(hex) {
        const value = parseInt(hex.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    function rgbToHsl(red, green, blue) {
        const r = red / 255;
        const g = green / 255;
        const b = blue / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        let hue = 0;

        if (delta) {
            if (max === r) hue = ((g - b) / delta) % 6;
            else if (max === g) hue = ((b - r) / delta) + 2;
            else hue = ((r - g) / delta) + 4;
            hue = Math.round(hue * 60);
            if (hue < 0) hue += 360;
        }

        const lightness = (max + min) / 2;
        const saturation = delta ? delta / (1 - Math.abs((2 * lightness) - 1)) : 0;
        return [hue, saturation * 100, lightness * 100];
    }

    function hslToHex(hue, saturation, lightness) {
        const h = ((hue % 360) + 360) % 360;
        const s = Math.max(0, Math.min(100, saturation)) / 100;
        const l = Math.max(0, Math.min(100, lightness)) / 100;
        const chroma = (1 - Math.abs((2 * l) - 1)) * s;
        const segment = h / 60;
        const x = chroma * (1 - Math.abs((segment % 2) - 1));
        const offset = l - (chroma / 2);
        let channels;

        if (segment < 1) channels = [chroma, x, 0];
        else if (segment < 2) channels = [x, chroma, 0];
        else if (segment < 3) channels = [0, chroma, x];
        else if (segment < 4) channels = [0, x, chroma];
        else if (segment < 5) channels = [x, 0, chroma];
        else channels = [chroma, 0, x];

        return `#${channels.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
    }

    function readableTextColor(hex) {
        const luminance = hexToRgb(hex)
            .map(channel => channel / 255)
            .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
            .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const blackContrast = (luminance + 0.05) / 0.05;
        const whiteContrast = 1.05 / (luminance + 0.05);
        return blackContrast >= whiteContrast ? '#0b0b0e' : '#ffffff';
    }

    function mixHex(baseHex, tintHex, tintAmount) {
        const base = hexToRgb(baseHex);
        const tint = hexToRgb(tintHex);
        const mixed = base.map((channel, index) => Math.round(channel + ((tint[index] - channel) * tintAmount)));
        return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
    }

    function surfacePalette(scope, accent) {
        if (scope !== 'overall') {
            return {
                background: '#121212',
                sidebar: 'rgba(0, 0, 0, 0.2)',
                card: 'rgba(255, 255, 255, 0.02)',
                cardHover: 'rgba(255, 255, 255, 0.12)',
                border: 'rgba(255, 255, 255, 0.08)',
                settingsSidebar: 'rgba(255, 255, 255, 0.02)',
                settingsContent: 'rgba(0, 0, 0, 0.1)',
                gradientAlpha1: '0.11',
                gradientAlpha2: '0.09'
            };
        }

        const rgb = hexToRgb(accent).join(', ');
        return {
            background: mixHex('#0d0d10', accent, 0.18),
            sidebar: `rgba(${rgb}, 0.08)`,
            card: `rgba(${rgb}, 0.065)`,
            cardHover: `rgba(${rgb}, 0.16)`,
            border: `rgba(${rgb}, 0.15)`,
            settingsSidebar: `rgba(${rgb}, 0.055)`,
            settingsContent: `rgba(${rgb}, 0.035)`,
            gradientAlpha1: '0.22',
            gradientAlpha2: '0.17'
        };
    }

    function customPalette(hex) {
        const [hue, saturation, lightness] = rgbToHsl(...hexToRgb(hex));
        const vividSaturation = Math.max(62, saturation);
        const vividLightness = Math.max(46, Math.min(64, lightness));
        return {
            name: 'Custom',
            accent: hex,
            accentHover: hslToHex(hue, vividSaturation, Math.min(72, vividLightness + 9)),
            gradient1: hslToHex(hue - 28, vividSaturation, vividLightness),
            gradient2: hslToHex(hue + 24, vividSaturation, Math.max(42, vividLightness - 4)),
            gradient3: hslToHex(hue + 58, Math.max(55, vividSaturation - 8), Math.min(72, vividLightness + 7))
        };
    }

    function normalizeState(candidate) {
        const preset = candidate && (candidate.preset === 'custom' || PRESETS[candidate.preset])
            ? candidate.preset
            : DEFAULT_STATE.preset;
        return {
            preset,
            customColor: normalizeHex(candidate && candidate.customColor) || DEFAULT_STATE.customColor,
            scope: candidate && candidate.scope === 'overall' ? 'overall' : DEFAULT_STATE.scope
        };
    }

    function readState() {
        try {
            return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
        } catch (error) {
            return { ...DEFAULT_STATE };
        }
    }

    function writeState(state) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            // Appearance still works for this page when storage is unavailable.
        }
    }

    function createDetail(state) {
        const palette = state.preset === 'custom' ? customPalette(state.customColor) : PRESETS[state.preset];
        return {
            ...state,
            enabled: themesEnabled,
            name: palette.name,
            palette: { ...palette }
        };
    }

    function copyDetail(detail) {
        return { ...detail, palette: { ...detail.palette } };
    }

    function applyPalette(state) {
        const detail = createDetail(state);
        const palette = detail.palette;
        const accentRgb = hexToRgb(palette.accent);
        const gradient1Rgb = hexToRgb(palette.gradient1);
        const gradient2Rgb = hexToRgb(palette.gradient2);
        const surfaces = surfacePalette(state.scope, palette.accent);

        root.dataset.colorTheme = state.preset;
        root.dataset.colorScope = state.scope;
        root.style.setProperty('--accent', palette.accent);
        root.style.setProperty('--accent-hover', palette.accentHover);
        root.style.setProperty('--accent-rgb', accentRgb.join(', '));
        root.style.setProperty('--on-accent', readableTextColor(palette.accent));
        root.style.setProperty('--on-gradient', palette.onGradient || readableTextColor(palette.gradient2));
        root.style.setProperty('--gradient-1', palette.gradient1);
        root.style.setProperty('--gradient-2', palette.gradient2);
        root.style.setProperty('--gradient-3', palette.gradient3);
        root.style.setProperty('--gradient-1-rgb', gradient1Rgb.join(', '));
        root.style.setProperty('--gradient-2-rgb', gradient2Rgb.join(', '));
        root.style.setProperty('--bg-color', surfaces.background);
        root.style.setProperty('--sidebar-bg', surfaces.sidebar);
        root.style.setProperty('--card-bg', surfaces.card);
        root.style.setProperty('--card-hover', surfaces.cardHover);
        root.style.setProperty('--glass-border', surfaces.border);
        root.style.setProperty('--settings-sidebar-bg', surfaces.settingsSidebar);
        root.style.setProperty('--settings-content-bg', surfaces.settingsContent);
        root.style.setProperty('--theme-gradient-alpha-1', surfaces.gradientAlpha1);
        root.style.setProperty('--theme-gradient-alpha-2', surfaces.gradientAlpha2);
        root.style.colorScheme = 'dark';

        currentState = { ...state };
        currentDetail = detail;
        return copyDetail(currentDetail);
    }

    function clearPalette() {
        delete root.dataset.colorTheme;
        delete root.dataset.colorScope;
        THEME_PROPERTIES.forEach(property => root.style.removeProperty(property));
        root.style.colorScheme = '';
        currentDetail = createDetail(currentState);
        return copyDetail(currentDetail);
    }

    function announceTheme(detail) {
        if (typeof window.CustomEvent !== 'function') return;
        window.dispatchEvent(new window.CustomEvent('streamifythemechange', { detail }));
    }

    function setTheme(preset, customColor, options = {}) {
        const nextState = normalizeState({
            preset,
            customColor: customColor || (currentState && currentState.customColor),
            scope: options.scope || (currentState && currentState.scope)
        });
        currentState = { ...nextState };
        if (!themesEnabled) currentDetail = createDetail(nextState);
        const detail = themesEnabled ? applyPalette(nextState) : copyDetail(currentDetail);
        if (options.persist !== false) writeState(nextState);
        announceTheme(detail);
        return detail;
    }

    currentState = readState();
    if (themesEnabled) applyPalette(currentState);
    else clearPalette();

    window.addEventListener('streamifyexperimentchange', event => {
        if (!event.detail || event.detail.feature !== 'themes') return;
        themesEnabled = event.detail.enabled === true;
        const detail = themesEnabled ? applyPalette(currentState) : clearPalette();
        announceTheme(detail);
    });

    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        currentState = readState();
        const detail = themesEnabled ? applyPalette(currentState) : clearPalette();
        announceTheme(detail);
    });

    window.StreamifyTheme = Object.freeze({
        presets: PRESETS,
        storageKey: STORAGE_KEY,
        normalizeHex,
        isEnabled: () => themesEnabled,
        getState: () => ({ ...currentState }),
        getTheme: () => copyDetail(currentDetail),
        setTheme
    });
}());
