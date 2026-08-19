const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const experimentsSource = fs.readFileSync(
    path.resolve(__dirname, '../Static/home/js/experiments.js'),
    'utf8'
);
const themeSource = fs.readFileSync(
    path.resolve(__dirname, '../Static/home/js/theme.js'),
    'utf8'
);

function createHarness({ appearance = null, experiments = null } = {}) {
    const properties = new Map();
    const storage = new Map();
    const events = [];
    const listeners = new Map();
    if (appearance !== null) storage.set('streamify:appearance:v1', appearance);
    if (experiments !== null) storage.set('streamify:experiments:v1', experiments);

    const root = {
        dataset: {},
        offsetWidth: 100,
        classList: { add() {}, remove() {} },
        style: {
            setProperty(name, value) { properties.set(name, value); },
            removeProperty(name) { properties.delete(name); },
            colorScheme: ''
        }
    };
    class CustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options.detail;
        }
    }

    const window = {
        CustomEvent,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatchEvent(event) {
            events.push(event);
            (listeners.get(event.type) || []).forEach(listener => listener(event));
        }
    };
    const context = {
        document: { documentElement: root },
        localStorage: {
            getItem(key) { return storage.get(key) || null; },
            setItem(key, value) { storage.set(key, value); }
        },
        window,
        console,
        setTimeout,
        clearTimeout
    };

    vm.runInNewContext(experimentsSource, context, { filename: 'experiments.js' });
    vm.runInNewContext(themeSource, context, { filename: 'theme.js' });
    return {
        api: window.StreamifyTheme,
        experiments: window.StreamifyExperiments,
        events,
        properties,
        root,
        storage,
        window
    };
}

test('keeps legacy styles when Themes has not been enabled', () => {
    const harness = createHarness();

    assert.equal(harness.experiments.isEnabled('themes'), false);
    assert.equal(harness.api.isEnabled(), false);
    assert.equal(harness.api.getState().preset, 'classic');
    assert.equal(harness.api.getState().scope, 'accent');
    assert.equal(harness.root.dataset.colorTheme, undefined);
    assert.equal(harness.root.dataset.colorScope, undefined);
    assert.equal(harness.properties.size, 0);
    assert.equal(harness.root.style.colorScheme, '');
});

test('enables Themes and applies the selected palette', () => {
    const harness = createHarness();
    harness.experiments.setEnabled('themes', true);

    assert.equal(harness.api.isEnabled(), true);
    assert.equal(harness.root.dataset.colorTheme, 'classic');
    assert.equal(harness.root.dataset.colorScope, 'accent');
    assert.equal(harness.properties.get('--accent'), '#1db954');
    assert.equal(harness.properties.get('--gradient-2'), '#8164d7');
    assert.equal(harness.properties.get('--bg-color'), '#121212');
    assert.deepEqual(
        JSON.parse(harness.storage.get(harness.experiments.storageKey)),
        { themes: true }
    );
    assert.equal(harness.events.at(-2).type, 'streamifyexperimentchange');
    assert.equal(harness.events.at(-1).type, 'streamifythemechange');
});

test('persists preset changes and publishes the applied palette', () => {
    const harness = createHarness({ experiments: JSON.stringify({ themes: true }) });
    const detail = harness.api.setTheme('pink');

    assert.equal(detail.name, 'Pink');
    assert.equal(detail.enabled, true);
    assert.equal(harness.properties.get('--accent'), '#ec4899');
    assert.deepEqual(
        JSON.parse(harness.storage.get(harness.api.storageKey)),
        { preset: 'pink', customColor: '#8b5cf6', scope: 'accent' }
    );
    assert.equal(harness.events.at(-1).type, 'streamifythemechange');
    assert.equal(harness.events.at(-1).detail.preset, 'pink');

    harness.api.setTheme('yellow');
    assert.equal(harness.properties.get('--on-accent'), '#0b0b0e');
    assert.equal(harness.properties.get('--on-gradient'), '#211a03');
});

test('restores and derives a valid custom palette', () => {
    const harness = createHarness({
        appearance: JSON.stringify({ preset: 'custom', customColor: '#0ea5e9' }),
        experiments: JSON.stringify({ themes: true })
    });
    const theme = harness.api.getTheme();

    assert.equal(theme.preset, 'custom');
    assert.equal(theme.palette.accent, '#0ea5e9');
    assert.match(theme.palette.accentHover, /^#[0-9a-f]{6}$/);
    assert.match(theme.palette.gradient1, /^#[0-9a-f]{6}$/);
    assert.equal(harness.properties.get('--accent-rgb'), '14, 165, 233');
});

test('can apply the selected color to the whole app', () => {
    const harness = createHarness({ experiments: JSON.stringify({ themes: true }) });
    harness.api.setTheme('red', null, { scope: 'overall' });

    assert.equal(harness.api.getState().scope, 'overall');
    assert.equal(harness.root.dataset.colorScope, 'overall');
    assert.notEqual(harness.properties.get('--bg-color'), '#121212');
    assert.match(harness.properties.get('--card-bg'), /^rgba\(239, 68, 68,/);
});

test('disabling Themes restores legacy styles without forgetting the selection', () => {
    const harness = createHarness({ experiments: JSON.stringify({ themes: true }) });
    harness.api.setTheme('pink', null, { scope: 'overall' });

    harness.experiments.setEnabled('themes', false);

    assert.equal(harness.api.isEnabled(), false);
    assert.equal(harness.root.dataset.colorTheme, undefined);
    assert.equal(harness.root.dataset.colorScope, undefined);
    assert.equal(harness.properties.size, 0);
    assert.equal(harness.root.style.colorScheme, '');
    assert.deepEqual(
        JSON.parse(harness.storage.get(harness.api.storageKey)),
        { preset: 'pink', customColor: '#8b5cf6', scope: 'overall' }
    );

    harness.experiments.setEnabled('themes', true);
    assert.equal(harness.properties.get('--accent'), '#ec4899');
    assert.equal(harness.root.dataset.colorScope, 'overall');
});

test('remembers theme changes made while the feature is disabled', () => {
    const harness = createHarness();
    const detail = harness.api.setTheme('red');

    assert.equal(detail.enabled, false);
    assert.equal(harness.properties.size, 0);
    assert.equal(harness.api.getState().preset, 'red');

    harness.experiments.setEnabled('themes', true);
    assert.equal(harness.properties.get('--accent'), '#ef4444');
});

test('rejects malformed stored appearance preferences', () => {
    const harness = createHarness({
        appearance: '{not-json',
        experiments: JSON.stringify({ themes: true })
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(harness.api.getState())),
        { preset: 'classic', customColor: '#8b5cf6', scope: 'accent' }
    );
    assert.equal(harness.properties.get('--accent'), '#1db954');
});

test('fails closed for malformed experimental-feature preferences', () => {
    const malformed = createHarness({ experiments: '{not-json' });
    const nonBoolean = createHarness({ experiments: JSON.stringify({ themes: 'true' }) });

    assert.equal(malformed.experiments.isEnabled('themes'), false);
    assert.equal(malformed.properties.size, 0);
    assert.equal(nonBoolean.experiments.isEnabled('themes'), false);
    assert.equal(nonBoolean.properties.size, 0);
});

test('synchronizes appearance and experiment changes from another tab', () => {
    const harness = createHarness({ experiments: JSON.stringify({ themes: true }) });
    harness.storage.set(harness.api.storageKey, JSON.stringify({
        preset: 'red',
        customColor: '#8b5cf6',
        scope: 'overall'
    }));
    harness.window.dispatchEvent({ type: 'storage', key: harness.api.storageKey });

    assert.equal(harness.properties.get('--accent'), '#ef4444');
    assert.equal(harness.root.dataset.colorScope, 'overall');

    harness.storage.set(harness.experiments.storageKey, JSON.stringify({ themes: false }));
    harness.window.dispatchEvent({ type: 'storage', key: harness.experiments.storageKey });
    assert.equal(harness.api.isEnabled(), false);
    assert.equal(harness.properties.size, 0);
});
