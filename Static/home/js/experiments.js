(function initStreamifyExperiments() {
    'use strict';

    const STORAGE_KEY = 'streamify:experiments:v1';
    const DEFINITIONS = Object.freeze({
        themes: Object.freeze({
            name: 'Themes',
            stage: 'Beta'
        })
    });

    function normalizeState(candidate) {
        return Object.keys(DEFINITIONS).reduce((state, feature) => {
            state[feature] = Boolean(candidate && candidate[feature] === true);
            return state;
        }, {});
    }

    function readState() {
        try {
            return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
        } catch (error) {
            return normalizeState(null);
        }
    }

    function writeState(state) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            // Feature switches still work for this page when storage is unavailable.
        }
    }

    function announceChange(feature, enabled) {
        if (typeof window.CustomEvent !== 'function') return;
        window.dispatchEvent(new window.CustomEvent('streamifyexperimentchange', {
            detail: { feature, enabled, state: { ...currentState } }
        }));
    }

    let currentState = readState();

    function setEnabled(feature, enabled, options = {}) {
        if (!DEFINITIONS[feature]) throw new Error(`Unknown experimental feature: ${feature}`);

        const nextEnabled = Boolean(enabled);
        if (currentState[feature] === nextEnabled) return nextEnabled;

        currentState = { ...currentState, [feature]: nextEnabled };
        if (options.persist !== false) writeState(currentState);
        announceChange(feature, nextEnabled);
        return nextEnabled;
    }

    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const nextState = readState();
        const changes = Object.keys(DEFINITIONS)
            .filter(feature => currentState[feature] !== nextState[feature])
            .map(feature => ({ feature, enabled: nextState[feature] }));
        currentState = nextState;
        changes.forEach(change => announceChange(change.feature, change.enabled));
    });

    window.StreamifyExperiments = Object.freeze({
        definitions: DEFINITIONS,
        storageKey: STORAGE_KEY,
        getState: () => ({ ...currentState }),
        isEnabled: feature => Boolean(DEFINITIONS[feature] && currentState[feature]),
        setEnabled
    });
}());
