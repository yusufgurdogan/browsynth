# browsynth

Your browser is an instrument. A polyphonic synthesizer for playing, shaping, and recording ideas. No build step or account required.

## Try it locally

From the project folder:

```sh
python -m http.server 4173 --bind 127.0.0.1
```

Open **http://localhost:4173**. Click **Enable audio**, or press **Hear it** to audition the selected patch.

## Playing

- Notes follow **physical key positions** on English, Turkish Q/F, AZERTY, QWERTZ and other layouts. On English, **Z–M** and **Q–U** play two octaves; **S/D/G/H/J** and **2/3/5/6/7** play the black keys.
- **Keys → Auto layout** reads your keyboard layout where supported and learns labels as you play. Choose **Türkçe Q** or **English (US)** to set labels explicitly. On Turkish Q, **ç → D4**, **. → E4**, and **ş → D♯4**. White Keys Only updates the labels and mapping together.
- Touch the piano, connect a MIDI keyboard, or use the **Am / F / C / G** chord pads.
- **Hold** latches notes. **Stop all** or **Esc** releases notes and stops rhythm.
- **Sustain** lets released notes ring; hold **Shift** for a momentary pedal, or use MIDI CC64. Repeated notes still retrigger with the pedal down. **Touch** selects Soft, Natural, or Firm strikes on the computer keyboard and chord pads; MIDI uses its own playing velocity.
- **Space** auditions the current sound when a control isn't focused. **Ctrl/Cmd + K** opens library search; the slash key plays a note.
- Drag knobs vertically. Hold **Shift** for fine control, use arrow keys on a focused knob, or double-click to restore the patch value.

## What's inside

- A searchable, categorized library with favorites and **40 factory sounds**. The **New** collection gathers the latest 12 instruments.
- **Felt Piano, Studio Grand, Dream Piano**: stereo piano recordings at three playing strengths, blended by velocity. The compact 6 MB bank loads locally when a recorded piano is selected. A progress message and retry button handle loading; switching patches cancels a pending preview.
- **Suitcase EP, Amber Reed, Crystal EP**: electric piano models with changing strike harmonics. **Marimba, Thumb Piano, Moon Vibes** use decaying, inharmonic partials. **Sunday Organ, Chamber Strings, Cloud Choir** add drawbar, bowed, and vowel-like synthesized tones.
- Your BPM stays fixed when browsing, resetting, or importing patches. Opening a recorded session restores its saved tempo.
- Separate **Sound**, **Effects**, **Rhythm**, and **Settings** sections.
- 16-note polyphony, stereo unison, glide, FM, noise, a filter envelope, and wavetable editing.
- Stereo reverb, tempo-synced ping-pong delay, chorus, drive, EQ, and output compression.
- A tempo-synced arpeggiator, 16-step gate, sidechain pump, kick, and the Cthulhu step sequencer. The gate starts with a smooth eighth-note pulse; choose Offbeat, Trance skip, Sixteenths, Half-time, or edit your own steps. Try a held Soft Focus chord.
- Adjustable A4 reference pitch, offline 12/13/17/24 equal divisions, and custom `.tun` imports.
- Patch saving in local browser storage, plus JSON patch backup/import.
- Recording, session save/load, and 24-bit WAV export at the actual audio sample rate.
- Responsive layout and a touch piano with two octaves on narrow screens.

The core interface and built-in tunings work offline. MIDI and recording support depend on browser capabilities; Chrome or Edge is a practical starting point. Saved patches belong to the browser and origin where they were created (for example, `localhost` and `127.0.0.1` have separate libraries).

## Files

- `index.html` — instrument interface and editors
- `style.css` — responsive studio styling
- `editors.css` — wavetable and step-sequencer layouts
- `engine.js` — Web Audio synthesis, MIDI, tuning, and sequencers
- `instruments.js` — sampled piano, electric pianos, mallets, organ, strings, choir, and sustain
- `samples/piano/` — locally hosted piano recordings, source manifest, attribution, and license
- `scripts/prepare-piano.py` — reproducible sample preparation (Python and ffmpeg)
- `presets.js` — complete factory patch definitions
- `keyboard.js` — physical note mappings and layout-aware key labels
- `studio.js` — library, playing controls, previews, saving, and recording

## Checks

With the local server running, open **http://localhost:4173/tests/audio.html** and press **Run audio checks**. This renders all factory patches without playing them through the speakers. Checks cover finite output, sample peaks, tuning, WAV export, patch migration, tempo preservation, gate transitions, international keyboard handling, all 66 piano recordings, soft/firm dynamics, sustain, repeated notes, voice cleanup, pitch bend, voice limits, loading failure/retry, and cancellation. Keyboard and MIDI events are simulated; physical hardware combinations can impose their own simultaneous-key limits.

Basic syntax checks:

```sh
node --check engine.js
node --check instruments.js
node --check presets.js
node --check keyboard.js
node --check studio.js
```

GitHub Pages deploys the static files when changes are pushed to `main`.

## License

The original project code keeps its existing license: do whatever u want with it lol.

The piano recordings are **Salamander Grand Piano V3 by Alexander Holm**, used under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). They were trimmed, faded, resampled, and encoded for this project. See [sample credits and modifications](samples/piano/README.md), [the full sample license](samples/piano/LICENSE.txt), and the [source repository](https://github.com/sfzinstruments/SalamanderGrandPiano). Felt and dream presets process the grand recordings; electric pianos, mallets, organ, strings, and choir are synthesized.
