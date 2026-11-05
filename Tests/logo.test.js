const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const logoSource = fs.readFileSync(path.resolve(__dirname, '../Static/home/js/logo.js'), 'utf8');

function createHarness(saved = null) {
    const properties = new Map();
    const storage = new Map();
    const classes = new Set();
    if (saved !== null) storage.set('streamify:logo:v1', typeof saved === 'string' ? saved : JSON.stringify(saved));

    const root = {
        dataset: {},
        classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
        style: {
            setProperty(name, value) { properties.set(name, value); },
            removeProperty(name) { properties.delete(name); }
        }
    };
    const window = { addEventListener() {} };
    const context = {
        document: {
            documentElement: root,
            readyState: 'complete',
            querySelectorAll: () => [],
            querySelector: () => null,
            getElementById: () => null,
            addEventListener() {}
        },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, value); }
        },
        window,
        console
    };
    vm.runInNewContext(logoSource, context);
    return { root, properties, storage, classes, api: window.StreamifyLogo };
}

test('defaults keep the original wordmark look', () => {
    const { root, properties, classes, api } = createHarness();
    assert.ok(classes.has('logo-custom'));
    assert.equal(api.state.font, 'jakarta');
    assert.equal(root.dataset.logoEffect, 'none');
    assert.match(properties.get('--logo-gradient'), /var\(--gradient-1\).*var\(--gradient-1\)\)$/);
    assert.equal(properties.get('--logo-shadow'), 'none');
    assert.equal(properties.get('--logo-scale'), '1');
    assert.match(properties.get('--logo-flow'), /^gradient-anim 5s/);
});

test('invalid saved values fall back to defaults', () => {
    const { api } = createHarness({ font: 'comic-sans', color: 'nope', customFrom: 'red', effect: 42, size: 'huge' });
    const state = api.state;
    assert.equal(state.font, 'jakarta');
    assert.equal(state.color, 'theme');
    assert.equal(state.customFrom, '#ec4899');
    assert.equal(state.effect, 'none');
    assert.equal(state.size, 'default');
});

test('corrupt storage does not throw', () => {
    const { api } = createHarness('{not json');
    assert.equal(api.state.font, 'jakarta');
});

test('choices are saved and turned into CSS variables', () => {
    const { properties, storage, api, root } = createHarness();
    api.set({ font: 'insta', color: 'custom', customFrom: '#112233', customTo: '#445566', effect: 'neon', size: 'large', flow: 'off', textCase: 'lower' });

    const saved = JSON.parse(storage.get('streamify:logo:v1'));
    assert.equal(saved.font, 'insta');
    assert.equal(root.dataset.logoFont, 'insta');
    assert.equal(properties.get('--logo-gradient'), 'linear-gradient(90deg, #112233, #445566, #112233)');
    assert.match(properties.get('--logo-family'), /Grand Hotel/);
    assert.match(properties.get('--logo-shadow'), /0 0 10px/);
    assert.equal(properties.get('--logo-flow'), 'none 0s');
    assert.equal(properties.get('--logo-case'), 'lowercase');
    assert.equal(Number(properties.get('--logo-scale')), +(1.15 * api.FONTS.insta.scale).toFixed(3));
});

test('single-color presets still produce a valid gradient', () => {
    const { properties, api } = createHarness();
    api.set({ color: 'white' });
    assert.equal(properties.get('--logo-gradient'), 'linear-gradient(90deg, #ffffff, #ffffff)');
});

test('reset restores every default', () => {
    const { api } = createHarness({ font: 'pixel', effect: 'retro3d', motion: 'bounce' });
    api.reset();
    assert.deepEqual({ ...api.state }, {
        font: 'jakarta', color: 'theme', customFrom: '#ec4899', customTo: '#8b5cf6',
        effect: 'none', intro: 'morph', motion: 'none', flow: 'normal', size: 'default', textCase: 'none'
    });
});
