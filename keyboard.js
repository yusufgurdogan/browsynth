'use strict';

// Notes follow physical positions, never aliases for printed characters.
// On Turkish Q, Period is ç, Slash is . and Semicolon is ş: three keys,
// three notes. The same fingering also works on QWERTZ, AZERTY and Turkish F.
const KeyboardMapping = {
    chromatic: {
        KeyZ:'C3', KeyS:'C#3', KeyX:'D3', KeyD:'D#3', KeyC:'E3', KeyV:'F3',
        KeyG:'F#3', KeyB:'G3', KeyH:'G#3', KeyN:'A3', KeyJ:'A#3', KeyM:'B3',
        KeyQ:'C4', Digit2:'C#4', KeyW:'D4', Digit3:'D#4', KeyE:'E4', KeyR:'F4',
        Digit5:'F#4', KeyT:'G4', Digit6:'G#4', KeyY:'A4', Digit7:'A#4', KeyU:'B4',
        KeyI:'C5', Digit9:'C#5', KeyO:'D5', Digit0:'D#5', KeyP:'E5', BracketLeft:'F5',
        Minus:'F#5', BracketRight:'G5', Equal:'G#5', Backslash:'A5',
        Comma:'C4', KeyL:'C#4', Period:'D4', Semicolon:'D#4', Slash:'E4', Quote:'F4'
    },
    white: {},
    auxiliary: {
        Numpad0:'G3', NumpadDecimal:'A3', NumpadEnter:'B3',
        Numpad1:'C4', Numpad2:'D4', Numpad3:'E4', Numpad4:'F4', Numpad5:'G4',
        Numpad6:'A4', Numpad7:'B4', Numpad8:'C5', Numpad9:'D5', NumpadAdd:'E5',
        NumpadDivide:'G5', NumpadMultiply:'A5', NumpadSubtract:'A4',
        ArrowLeft:'C3', ArrowDown:'D3', ArrowRight:'E3', ArrowUp:'F3'
    },
    punctuation: {
        Comma:',', Period:'.', Slash:'/', Semicolon:';', Quote:"'", BracketLeft:'[',
        BracketRight:']', Backslash:'\\', Minus:'-', Equal:'='
    },
    turkish: {
        KeyI:'ı', Semicolon:'ş', Quote:'i', BracketLeft:'ğ', BracketRight:'ü',
        Comma:'ö', Period:'ç', Slash:'.', Minus:'*', Equal:'-', Backslash:','
    },
    profile: 'auto', detected: {}, observed: {},
    init(onChange) {
        this.onChange = onChange;
        const rows = [
            ['KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash', 3],
            ['KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote', 4],
            ['KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight', 5],
            ['Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal', 6]
        ];
        rows.forEach(([codes, octave]) => codes.split(' ').forEach((code, i) => {
            this.white[code] = 'CDEFGAB'[i % 7] + (octave + Math.floor(i / 7));
        }));
        try { this.profile = localStorage.getItem('browsynth_keyboard_layout') || 'auto'; } catch {}
        if (!['auto','en','tr'].includes(this.profile)) this.profile = 'auto';
        document.getElementById('keyboardLayout').value = this.profile;
        this.refreshLayout();
        // An OS layout switch can happen while the page stays open.
        navigator.keyboard?.addEventListener?.('layoutchange', () => this.refreshLayout());
        window.addEventListener('focus', () => this.refreshLayout());
    },
    async refreshLayout() {
        try {
            const layout = await navigator.keyboard?.getLayoutMap?.();
            if (layout) { this.detected = Object.fromEntries(layout); this.observed = {}; this.onChange?.(); }
        } catch { /* Key events still supply labels when the layout API is unavailable. */ }
    },
    setProfile(profile) {
        this.profile = profile;
        try { localStorage.setItem('browsynth_keyboard_layout', profile); } catch {}
        this.onChange?.();
    },
    observe(event) {
        if (this.profile !== 'auto' || event.ctrlKey || event.metaKey || event.altKey ||
            event.shiftKey || event.isComposing || event.key.length !== 1) return;
        if (this.observed[event.code] !== event.key) {
            this.observed[event.code] = event.key;
            this.onChange?.();
        }
    },
    label(code) {
        const fallback = this.punctuation[code] ?? code.replace(/^(Key|Digit)/, '');
        const turkish = this.profile === 'tr' || this.profile === 'auto' && navigator.language.startsWith('tr');
        const base = turkish ? this.turkish[code] ?? fallback : fallback;
        const value = this.profile === 'auto' ? this.observed[code] ?? this.detected[code] ?? base : base;
        // Dotless ı and dotted i remain distinct on Turkish keyboards.
        return value === 'ı' ? 'ı' : value === 'i' && turkish ? 'İ' : value.toUpperCase();
    },
    noteForEvent(event, whiteOnly = false) {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
        return (whiteOnly ? this.white : this.chromatic)[event.code] || this.auxiliary[event.code] || null;
    },
    labelsForNote(note, whiteOnly = false) {
        return Object.entries(whiteOnly ? this.white : this.chromatic)
            .filter(([, mapped]) => mapped === note).map(([code]) => this.label(code));
    }
};
