let loadedTuningContent = null;

// Synth configuration object
const SynthConfig = {
    notes: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    whiteNotes: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    blackNotes: ['C#', 'D#', 'F#', 'G#', 'A#'],
    maxPolyphony: 16,
};

function applyOctaveShift(note) {
    const shift = SynthState.octaveShift || 0;
    if (!shift || !note) return note;
    const match = /^([A-G]#?)(-?\d+)$/.exec(note);
    if (!match) return note;
    return match[1] + (parseInt(match[2], 10) + shift);
}
// Global tempo — one BPM that the delay, trance gate, sidechain pump,
// kick and Cthulhu all sync to.
const Tempo = {
    bpm: 138,
    set(value) {
        let v = parseInt(value, 10);
        if (isNaN(v)) return;
        v = Math.max(40, Math.min(300, v));
        this.bpm = v;
        // Keep both BPM inputs in sync (main panel + Cthulhu modal)
        const g = document.getElementById('globalBpm');
        if (g && parseInt(g.value, 10) !== v) g.value = v;
        const c = document.getElementById('cthulhuArpBpm');
        if (c && parseInt(c.value, 10) !== v) c.value = v;
        if (typeof SynthState !== 'undefined' && SynthState.cthulhu) {
            SynthState.cthulhu.arp.bpm = v;
        }
        if (Synth.audioContext) {
            Synth.updateDelayTime();
            Arpeggiator.updateSpeed();
        }
    },
    beatSec() {
        return 60 / this.bpm;
    },
    barSec() {
        return 240 / this.bpm;
    }
};

// New Tuning System
const TuningSystem = {
    frequencies: new Array(128).fill(null),
    isCustomTuning: false,
    // Parse an AnaMark .tun file. When scaleType is given (built-in presets),
    // an equal-tempered scale is generated from the preset's step count;
    // otherwise the file's own cent values are used.
    parseTunFile(content, scaleType) {
        const lines = content.split('\n');
        const frequencies = new Array(128).fill(null);

        // Reference C4 = 261.63 Hz (MIDI note 60)
        const MIDDLE_C = 261.63;
        const C4_INDEX = 60;

        const STEPS_PER_OCTAVE = {
            '17-tone': 17,
            '13-tone': 13,
            '24-tone': 24
        }[scaleType] || 12;

        const STEP_RATIO = Math.pow(2, 1 / STEPS_PER_OCTAVE);

        lines.forEach(line => {
            line = line.trim();
            if (!line.startsWith('note ')) return;

            const parts = line.split('=');
            if (parts.length !== 2) return;

            const noteNumber = parseInt(parts[0].replace('note ', ''));
            const value = parseFloat(parts[1].trim());

            if (!isNaN(noteNumber) && !isNaN(value) && noteNumber >= 0 && noteNumber < 128) {
                if (scaleType) {
                    frequencies[noteNumber] = MIDDLE_C * Math.pow(STEP_RATIO, noteNumber - C4_INDEX);
                } else {
                    // .tun values are absolute cents above MIDI note 0 (~8.1758 Hz)
                    frequencies[noteNumber] = 8.1757989156 * Math.pow(2, value / 1200);
                }
            }
        });

        const validCount = frequencies.filter(f => f !== null).length;
        if (validCount === 0) {
            console.error('No valid frequencies found in tuning file!');
            return null;
        }

        return frequencies;
    },
    importTuning(frequencies) {
        if (!frequencies || frequencies.every(f => f === null)) {
            console.error('Invalid frequencies provided to import');
            return;
        }
        this.frequencies = frequencies;
        this.isCustomTuning = true;
    },
    resetToDefaultTuning() {
        this.frequencies = new Array(128).fill(null);
        this.isCustomTuning = false;
    },

    // Retune all currently-sounding voices to the active tuning
    refreshActiveVoices() {
        if (!Synth.audioContext) return;
        const now = Synth.audioContext.currentTime;
        Object.entries(SynthState.activeVoices).forEach(([note, voice]) => {
            const frequency = this.noteToFreq(note);
            if (voice.retune) { voice.retune(frequency); return; }
            voice.oscillators.forEach(osc => {
                osc.frequency.setValueAtTime(frequency, now);
            });
            if (voice.fmOsc) {
                voice.fmOsc.frequency.setValueAtTime(frequency * 2, now);
            }
        });
    },

    noteToFreq: function (note) { // Use function keyword to maintain correct 'this' binding
        if (!note) return 0;

        const matches = note.match(/([A-G]#?)(\d+)/);
        if (!matches) {
            console.error('Invalid note format:', note);
            return 0;
        }

        const [_, noteName, octaveStr] = matches;
        const octave = parseInt(octaveStr);
        const noteIndex = SynthConfig.notes.indexOf(noteName);
        const midiNote = noteIndex + (octave + 1) * 12;

        if (this.isCustomTuning && Number.isFinite(this.frequencies[midiNote])) {
            const customFreq = this.frequencies[midiNote];
            return customFreq;
        }

        const reference = Number(document.getElementById('referencePitch')?.value) || 440;
        const defaultFreq = reference * Math.pow(2, (midiNote - 69) / (this.divisions || 12));
        return defaultFreq;
    }
};
// Synth state
const SynthState = {
    activeVoices: {},
    activeNotes: new Set(),
    controls: {},
    lastFrequency: null,
    fmEnabled: false,
    lfoEnabled: false,
    noiseEnabled: false,
    whiteKeysOnly: false,
    octaveShift: 0,
    arpeggiator: {
        isOn: false,
        pattern: 'up',
        notes: [],
        intervalId: null
    },
    cthulhu: {
        enabled: false,                   // master on/off — when on, all notes route through the step arp
        pressedByUser: new Set(),         // notes the user is physically holding (source of truth)
        pendingLatchReset: false,         // next keypress (after all released) clears latched heldNotes
        arp: {
            latch: false,
            bpm: 138,
            rate: '1/16',
            length: 16,
            swing: 0,                     // 0..0.5
            strum: 0,                     // ms (negative = down-strum)
            steps: [],                    // populated in Cthulhu.init; each = { tones:[], octave, velocity, gate }
            heldNotes: [],                // sorted ascending — derived from pressedByUser (or latched)
            currentStep: 0,
            timeoutId: null,
            activeNotes: new Set()        // currently-sounding arp notes (for cleanup)
        }
    },
    filterEnabled: true,
    filterSettings: {
        type: 'lowpass',
        frequency: 1000,
        Q: 0
    },
    wavetable: {
        position: 0,
        periodicWave: null
    }
};

// Wavetable Editor System
const WavetableEditor = {
    FRAME_SIZE: 2048,
    frames: [],
    currentFrame: 0,
    currentTool: 'draw',
    isDrawing: false,
    lastDrawPoint: null,
    lineEndPoint: null,
    canvas2D: null,
    ctx2D: null,
    canvas3D: null,
    gl: null,
    rotateX: -30,
    rotateY: 30,
    zoom: 1.5,
    isDragging3D: false,
    lastMouseX: 0,
    lastMouseY: 0,

    init() {
        // Initialize with 8 frames of sine waves morphing to saw
        this.frames = [];
        for (let i = 0; i < 8; i++) {
            const frame = new Float32Array(this.FRAME_SIZE);
            const morphAmount = i / 7;
            for (let j = 0; j < this.FRAME_SIZE; j++) {
                const phase = (j / this.FRAME_SIZE) * Math.PI * 2;
                // Morph from sine to sawtooth
                const sine = Math.sin(phase);
                const saw = 1 - 2 * (j / this.FRAME_SIZE);
                frame[j] = sine * (1 - morphAmount) + saw * morphAmount;
            }
            this.frames.push(frame);
        }

        this.canvas2D = document.getElementById('wavetable2D');
        this.ctx2D = this.canvas2D.getContext('2d');
        this.canvas3D = document.getElementById('wavetable3D');

        this.initWebGL();
        this.setupEventListeners();
        this.updateFrameDisplay();
    },

    initWebGL() {
        this.gl = this.canvas3D.getContext('webgl') || this.canvas3D.getContext('experimental-webgl');
        if (!this.gl) {
            console.error('WebGL not supported, falling back to 2D');
            return;
        }

        const gl = this.gl;

        // Vertex shader - handles 3D positioning
        const vsSource = `
            attribute vec3 aPosition;
            attribute vec3 aColor;
            uniform mat4 uModelViewMatrix;
            uniform mat4 uProjectionMatrix;
            varying vec3 vColor;
            void main() {
                gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
                vColor = aColor;
            }
        `;

        // Fragment shader - handles coloring
        const fsSource = `
            precision mediump float;
            varying vec3 vColor;
            void main() {
                gl_FragColor = vec4(vColor, 1.0);
            }
        `;

        // Compile shaders
        const vertexShader = this.compileShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource);

        // Create program
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('Shader program failed:', gl.getProgramInfoLog(this.program));
            return;
        }

        // Get attribute/uniform locations
        this.attribLocations = {
            position: gl.getAttribLocation(this.program, 'aPosition'),
            color: gl.getAttribLocation(this.program, 'aColor')
        };
        this.uniformLocations = {
            modelViewMatrix: gl.getUniformLocation(this.program, 'uModelViewMatrix'),
            projectionMatrix: gl.getUniformLocation(this.program, 'uProjectionMatrix')
        };

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    },

    compileShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    },

    // Matrix math helpers
    createPerspectiveMatrix(fov, aspect, near, far) {
        const f = 1.0 / Math.tan(fov / 2);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) / (near - far), -1,
            0, 0, (2 * far * near) / (near - far), 0
        ]);
    },

    createModelViewMatrix() {
        const rx = this.rotateX * Math.PI / 180;
        const ry = this.rotateY * Math.PI / 180;
        const z = -3 / this.zoom;

        // Rotation matrices
        const cosX = Math.cos(rx), sinX = Math.sin(rx);
        const cosY = Math.cos(ry), sinY = Math.sin(ry);

        return new Float32Array([
            cosY, sinX * sinY, -cosX * sinY, 0,
            0, cosX, sinX, 0,
            sinY, -sinX * cosY, cosX * cosY, 0,
            0, 0, z, 1
        ]);
    },

    render3D() {
        if (!this.gl) return;

        const gl = this.gl;
        const canvas = this.canvas3D;

        // Set canvas size
        canvas.width = canvas.offsetWidth * window.devicePixelRatio;
        canvas.height = canvas.offsetHeight * window.devicePixelRatio;
        gl.viewport(0, 0, canvas.width, canvas.height);

        // Clear
        gl.clearColor(0.1, 0.1, 0.1, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.program);

        // Generate mesh data
        const { positions, colors, indices } = this.generateWavetableMesh();

        // Position buffer
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.attribLocations.position);
        gl.vertexAttribPointer(this.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

        // Color buffer
        const colorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.attribLocations.color);
        gl.vertexAttribPointer(this.attribLocations.color, 3, gl.FLOAT, false, 0, 0);

        // Index buffer
        const indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

        // Set matrices
        const projectionMatrix = this.createPerspectiveMatrix(
            45 * Math.PI / 180,
            canvas.width / canvas.height,
            0.1,
            100
        );
        const modelViewMatrix = this.createModelViewMatrix();

        gl.uniformMatrix4fv(this.uniformLocations.projectionMatrix, false, projectionMatrix);
        gl.uniformMatrix4fv(this.uniformLocations.modelViewMatrix, false, modelViewMatrix);

        // Draw
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);

        // Draw wireframe on top
        gl.depthFunc(gl.LEQUAL);
        this.renderWireframe(gl, positions);

        // Cleanup
        gl.deleteBuffer(positionBuffer);
        gl.deleteBuffer(colorBuffer);
        gl.deleteBuffer(indexBuffer);
    },

    renderWireframe(gl, positions) {
        // Create line mesh for wireframe effect
        const linePositions = [];
        const lineColors = [];
        const samplesPerFrame = 64;
        const numFrames = this.frames.length;

        // Draw horizontal lines (waveforms)
        for (let f = 0; f < numFrames; f++) {
            const frame = this.frames[f];
            const z = (f / (numFrames - 1)) * 2 - 1;
            const isCurrentFrame = f === this.currentFrame;

            for (let i = 0; i < samplesPerFrame - 1; i++) {
                const x1 = (i / (samplesPerFrame - 1)) * 2 - 1;
                const x2 = ((i + 1) / (samplesPerFrame - 1)) * 2 - 1;
                const sampleIdx1 = Math.floor((i / samplesPerFrame) * this.FRAME_SIZE);
                const sampleIdx2 = Math.floor(((i + 1) / samplesPerFrame) * this.FRAME_SIZE);
                const y1 = frame[sampleIdx1] * 0.5;
                const y2 = frame[sampleIdx2] * 0.5;

                linePositions.push(x1, y1, z, x2, y2, z);

                // Cyan for current frame, gradient for others
                if (isCurrentFrame) {
                    lineColors.push(0, 1, 0.62, 0, 1, 0.62);
                } else {
                    const brightness = 0.3 + (f / numFrames) * 0.4;
                    lineColors.push(0, brightness, brightness * 0.62, 0, brightness, brightness * 0.62);
                }
            }
        }

        const lineBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(linePositions), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.attribLocations.position);
        gl.vertexAttribPointer(this.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

        const lineColorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, lineColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineColors), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.attribLocations.color);
        gl.vertexAttribPointer(this.attribLocations.color, 3, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.LINES, 0, linePositions.length / 3);

        gl.deleteBuffer(lineBuffer);
        gl.deleteBuffer(lineColorBuffer);
    },

    generateWavetableMesh() {
        const positions = [];
        const colors = [];
        const indices = [];

        const samplesPerFrame = 64;
        const numFrames = this.frames.length;

        // Generate vertices
        for (let f = 0; f < numFrames; f++) {
            const frame = this.frames[f];
            const z = (f / (numFrames - 1)) * 2 - 1;

            for (let i = 0; i < samplesPerFrame; i++) {
                const x = (i / (samplesPerFrame - 1)) * 2 - 1;
                const sampleIdx = Math.floor((i / samplesPerFrame) * this.FRAME_SIZE);
                const y = frame[sampleIdx] * 0.5;

                positions.push(x, y, z);

                // Color based on height and frame position
                const hue = (f / numFrames) * 0.3; // Cyan to green
                const brightness = 0.15 + Math.abs(y) * 0.3;
                colors.push(hue * 0.5, brightness + 0.2, brightness * 0.62 + 0.2);
            }
        }

        // Generate indices for triangles
        for (let f = 0; f < numFrames - 1; f++) {
            for (let i = 0; i < samplesPerFrame - 1; i++) {
                const topLeft = f * samplesPerFrame + i;
                const topRight = topLeft + 1;
                const bottomLeft = (f + 1) * samplesPerFrame + i;
                const bottomRight = bottomLeft + 1;

                indices.push(topLeft, bottomLeft, topRight);
                indices.push(topRight, bottomLeft, bottomRight);
            }
        }

        return { positions, colors, indices };
    },

    render2D() {
        const canvas = this.canvas2D;
        const ctx = this.ctx2D;
        const frame = this.frames[this.currentFrame];

        canvas.width = canvas.offsetWidth * window.devicePixelRatio;
        canvas.height = canvas.offsetHeight * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;

        // Background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        // Grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Vertical lines
        for (let i = 0; i <= 8; i++) {
            const x = (i / 8) * width;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        // Horizontal lines
        for (let i = 0; i <= 4; i++) {
            const y = (i / 4) * height;
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
        }
        ctx.stroke();

        // Center line
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Waveform
        ctx.strokeStyle = '#00ff9d';
        ctx.lineWidth = 2;
        ctx.beginPath();

        const samplesPerPixel = this.FRAME_SIZE / width;
        for (let x = 0; x < width; x++) {
            const sampleIdx = Math.floor(x * samplesPerPixel);
            const y = height / 2 - frame[sampleIdx] * (height / 2 - 10);
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Glow effect
        ctx.strokeStyle = 'rgba(0, 255, 157, 0.3)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
            const sampleIdx = Math.floor(x * samplesPerPixel);
            const y = height / 2 - frame[sampleIdx] * (height / 2 - 10);
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    },

    setupEventListeners() {
        // 2D Canvas drawing
        this.canvas2D.addEventListener('mousedown', (e) => this.startDraw(e));
        this.canvas2D.addEventListener('mousemove', (e) => this.draw(e));
        this.canvas2D.addEventListener('mouseup', () => this.endDraw());
        this.canvas2D.addEventListener('mouseleave', () => this.endDraw());

        // 3D Canvas rotation
        this.canvas3D.addEventListener('mousedown', (e) => {
            this.isDragging3D = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        });
        document.addEventListener('mousemove', (e) => {
            if (this.isDragging3D) {
                const deltaX = e.clientX - this.lastMouseX;
                const deltaY = e.clientY - this.lastMouseY;
                this.rotateY += deltaX * 0.5;
                this.rotateX += deltaY * 0.5;
                this.rotateX = Math.max(-90, Math.min(90, this.rotateX));
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                document.getElementById('wt3dRotateX').value = this.rotateX;
                this.render3D();
            }
        });
        document.addEventListener('mouseup', () => {
            this.isDragging3D = false;
        });

        // 3D Controls
        document.getElementById('wt3dRotateX').addEventListener('input', (e) => {
            this.rotateX = parseFloat(e.target.value);
            this.render3D();
        });
        document.getElementById('wt3dZoom').addEventListener('input', (e) => {
            this.zoom = parseFloat(e.target.value);
            this.render3D();
        });

        // Frame navigation
        document.getElementById('prevFrame').addEventListener('click', () => {
            this.currentFrame = Math.max(0, this.currentFrame - 1);
            this.updateFrameDisplay();
        });
        document.getElementById('nextFrame').addEventListener('click', () => {
            this.currentFrame = Math.min(this.frames.length - 1, this.currentFrame + 1);
            this.updateFrameDisplay();
        });
        document.getElementById('addFrame').addEventListener('click', () => this.addFrame());
        document.getElementById('deleteFrame').addEventListener('click', () => this.deleteFrame());

        // Tools
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentTool = btn.id.replace('tool', '').toLowerCase();
                if (this.currentTool === 'smooth') this.smoothFrame();
                if (this.currentTool === 'normalize') this.normalizeFrame();
            });
        });

        // Preset waveforms
        document.getElementById('presetWaveform').addEventListener('change', (e) => {
            if (e.target.value) {
                this.loadPresetShape(e.target.value);
                e.target.value = '';
            }
        });

        // Wavetable presets
        document.getElementById('wavetablePresets').addEventListener('change', (e) => {
            if (e.target.value) {
                this.loadWavetablePreset(e.target.value);
                e.target.value = '';
            }
        });

        // Modal controls
        document.getElementById('openWavetableEditor').addEventListener('click', () => this.open());
        document.getElementById('closeWavetableEditor').addEventListener('click', () => this.close());
        document.getElementById('applyWavetable').addEventListener('click', () => this.apply());
    },

    startDraw(e) {
        this.isDrawing = true;
        this.lastDrawPoint = this.getCanvasPoint(e);
        if (this.currentTool === 'draw') {
            this.drawAt(this.lastDrawPoint);
        }
    },

    draw(e) {
        if (!this.isDrawing) return;
        const point = this.getCanvasPoint(e);

        if (this.currentTool === 'draw') {
            // Interpolate between last point and current for smooth lines
            if (this.lastDrawPoint) {
                this.drawLine(this.lastDrawPoint, point);
            }
            this.lastDrawPoint = point;
        } else if (this.currentTool === 'line') {
            this.lineEndPoint = point;
            // Preview line
            this.render2D();
            const ctx = this.ctx2D;
            ctx.strokeStyle = 'rgba(0, 255, 157, 0.5)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            const height = this.canvas2D.offsetHeight;
            const startY = height / 2 - this.lastDrawPoint.value * (height / 2 - 10);
            const endY = height / 2 - point.value * (height / 2 - 10);
            ctx.moveTo(this.lastDrawPoint.x * this.canvas2D.offsetWidth, startY);
            ctx.lineTo(point.x * this.canvas2D.offsetWidth, endY);
            ctx.stroke();
        }
    },

    endDraw() {
        if (this.isDrawing && this.currentTool === 'line' && this.lastDrawPoint && this.lineEndPoint) {
            this.drawLine(this.lastDrawPoint, this.lineEndPoint);
        }
        this.isDrawing = false;
        this.lastDrawPoint = null;
        this.lineEndPoint = null;
        this.render2D();
        this.render3D();
    },

    getCanvasPoint(e) {
        const rect = this.canvas2D.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        const value = 1 - y * 2; // Map to -1 to 1
        return { x: Math.max(0, Math.min(1, x)), value: Math.max(-1, Math.min(1, value)) };
    },

    drawAt(point) {
        const frame = this.frames[this.currentFrame];
        const sampleIdx = Math.floor(point.x * this.FRAME_SIZE);
        const brushSize = 20;

        for (let i = -brushSize; i <= brushSize; i++) {
            const idx = sampleIdx + i;
            if (idx >= 0 && idx < this.FRAME_SIZE) {
                const distance = Math.abs(i) / brushSize;
                const influence = 1 - distance * distance;
                frame[idx] = frame[idx] * (1 - influence) + point.value * influence;
            }
        }
        this.render2D();
    },

    drawLine(start, end) {
        const frame = this.frames[this.currentFrame];
        const startIdx = Math.floor(start.x * this.FRAME_SIZE);
        const endIdx = Math.floor(end.x * this.FRAME_SIZE);
        const steps = Math.abs(endIdx - startIdx) + 1;

        for (let i = 0; i < steps; i++) {
            const t = steps === 1 ? 0 : i / (steps - 1);
            const idx = Math.round(startIdx + (endIdx - startIdx) * t);
            const value = start.value + (end.value - start.value) * t;

            if (idx >= 0 && idx < this.FRAME_SIZE) {
                frame[idx] = value;
            }
        }
        this.render2D();
    },

    smoothFrame() {
        const frame = this.frames[this.currentFrame];
        const smoothed = new Float32Array(this.FRAME_SIZE);
        const windowSize = 5;

        for (let i = 0; i < this.FRAME_SIZE; i++) {
            let sum = 0;
            let count = 0;
            for (let j = -windowSize; j <= windowSize; j++) {
                const idx = (i + j + this.FRAME_SIZE) % this.FRAME_SIZE;
                sum += frame[idx];
                count++;
            }
            smoothed[i] = sum / count;
        }

        this.frames[this.currentFrame] = smoothed;
        this.render2D();
        this.render3D();
    },

    normalizeFrame() {
        const frame = this.frames[this.currentFrame];
        let max = 0;
        for (let i = 0; i < this.FRAME_SIZE; i++) {
            max = Math.max(max, Math.abs(frame[i]));
        }
        if (max > 0) {
            for (let i = 0; i < this.FRAME_SIZE; i++) {
                frame[i] /= max;
            }
        }
        this.render2D();
        this.render3D();
    },

    addFrame() {
        if (this.frames.length >= 64) return;
        const newFrame = new Float32Array(this.FRAME_SIZE);
        // Copy current frame
        newFrame.set(this.frames[this.currentFrame]);
        this.frames.splice(this.currentFrame + 1, 0, newFrame);
        this.currentFrame++;
        this.updateFrameDisplay();
    },

    deleteFrame() {
        if (this.frames.length <= 1) return;
        this.frames.splice(this.currentFrame, 1);
        this.currentFrame = Math.min(this.currentFrame, this.frames.length - 1);
        this.updateFrameDisplay();
    },

    updateFrameDisplay() {
        document.getElementById('currentFrameNum').textContent = this.currentFrame + 1;
        document.getElementById('totalFrames').textContent = this.frames.length;
        this.render2D();
        this.render3D();
    },

    loadPresetShape(type) {
        const frame = this.frames[this.currentFrame];
        for (let i = 0; i < this.FRAME_SIZE; i++) {
            const phase = (i / this.FRAME_SIZE) * Math.PI * 2;
            const t = i / this.FRAME_SIZE;

            switch (type) {
                case 'sine':
                    frame[i] = Math.sin(phase);
                    break;
                case 'triangle':
                    frame[i] = 2 * Math.abs(2 * t - 1) - 1;
                    break;
                case 'sawtooth':
                    frame[i] = 2 * t - 1;
                    break;
                case 'square':
                    frame[i] = t < 0.5 ? 1 : -1;
                    break;
                case 'pulse25':
                    frame[i] = t < 0.25 ? 1 : -1;
                    break;
                case 'pulse10':
                    frame[i] = t < 0.1 ? 1 : -1;
                    break;
                case 'random':
                    frame[i] = Math.random() * 2 - 1;
                    break;
                case 'clear':
                    frame[i] = 0;
                    break;
            }
        }
        this.render2D();
        this.render3D();
    },

    loadWavetablePreset(type) {
        this.frames = [];
        const numFrames = 8;

        for (let f = 0; f < numFrames; f++) {
            const frame = new Float32Array(this.FRAME_SIZE);
            const morph = f / (numFrames - 1);

            for (let i = 0; i < this.FRAME_SIZE; i++) {
                const phase = (i / this.FRAME_SIZE) * Math.PI * 2;
                const t = i / this.FRAME_SIZE;

                switch (type) {
                    case 'basic':
                        // Sine -> Triangle -> Saw -> Square
                        const sine = Math.sin(phase);
                        const tri = 2 * Math.abs(2 * t - 1) - 1;
                        const saw = 2 * t - 1;
                        const square = t < 0.5 ? 1 : -1;
                        if (morph < 0.33) {
                            const m = morph / 0.33;
                            frame[i] = sine * (1 - m) + tri * m;
                        } else if (morph < 0.66) {
                            const m = (morph - 0.33) / 0.33;
                            frame[i] = tri * (1 - m) + saw * m;
                        } else {
                            const m = (morph - 0.66) / 0.34;
                            frame[i] = saw * (1 - m) + square * m;
                        }
                        break;

                    case 'pwm':
                        // Pulse width modulation
                        const pw = 0.1 + morph * 0.4;
                        frame[i] = t < pw ? 1 : -1;
                        break;

                    case 'formant':
                        // Formant-like harmonics
                        const fundamental = Math.sin(phase);
                        const h2 = Math.sin(phase * 2) * (0.5 - morph * 0.4);
                        const h3 = Math.sin(phase * 3) * (0.3 + morph * 0.4);
                        const h4 = Math.sin(phase * 4) * morph * 0.3;
                        const h5 = Math.sin(phase * 5) * morph * 0.2;
                        frame[i] = (fundamental + h2 + h3 + h4 + h5) / 2;
                        break;

                    case 'digital':
                        // Bit-crushed / digital
                        const bits = 2 + Math.floor(morph * 6);
                        const levels = Math.pow(2, bits);
                        const rawSaw = 2 * t - 1;
                        frame[i] = Math.round(rawSaw * levels) / levels;
                        break;

                    case 'analog':
                        // Soft saturation / analog warmth
                        const rawVal = Math.sin(phase) + Math.sin(phase * 2) * 0.5 * morph;
                        const drive = 1 + morph * 3;
                        frame[i] = Math.tanh(rawVal * drive) / Math.tanh(drive);
                        break;

                    case 'vocal':
                        // Vowel-like formants
                        const f1 = Math.sin(phase);
                        const f2 = Math.sin(phase * (2 + morph * 2)) * 0.5;
                        const f3 = Math.sin(phase * (4 + morph * 4)) * 0.25;
                        frame[i] = (f1 + f2 + f3) / 1.75;
                        break;
                }
            }
            this.frames.push(frame);
        }

        this.currentFrame = 0;
        this.updateFrameDisplay();
    },

    open() {
        document.getElementById('wavetableModal').style.display = 'flex';
        setTimeout(() => {
            this.render2D();
            this.render3D();
        }, 50);
    },

    close() {
        document.getElementById('wavetableModal').style.display = 'none';
    },

    apply() {
        this.updatePeriodicWave();
        this.close();
    },

    updatePeriodicWave() {
        if (!Synth.audioContext || this.frames.length === 0) return;

        const position = SynthState.wavetable.position;
        const frameIdx = position * (this.frames.length - 1);
        const lowerIdx = Math.floor(frameIdx);
        const upperIdx = Math.min(lowerIdx + 1, this.frames.length - 1);
        const blend = frameIdx - lowerIdx;

        // Interpolate between frames
        const interpolated = new Float32Array(this.FRAME_SIZE);
        for (let i = 0; i < this.FRAME_SIZE; i++) {
            interpolated[i] = this.frames[lowerIdx][i] * (1 - blend) + this.frames[upperIdx][i] * blend;
        }

        // FFT to get harmonics for PeriodicWave
        const real = new Float32Array(this.FRAME_SIZE / 2);
        const imag = new Float32Array(this.FRAME_SIZE / 2);

        // Simple DFT for harmonics (first 256 harmonics)
        const numHarmonics = Math.min(256, this.FRAME_SIZE / 2);
        for (let k = 0; k < numHarmonics; k++) {
            let realSum = 0, imagSum = 0;
            for (let n = 0; n < this.FRAME_SIZE; n++) {
                const angle = -2 * Math.PI * k * n / this.FRAME_SIZE;
                realSum += interpolated[n] * Math.cos(angle);
                imagSum += interpolated[n] * Math.sin(angle);
            }
            real[k] = realSum / this.FRAME_SIZE;
            imag[k] = imagSum / this.FRAME_SIZE;
        }

        real[0] = 0; // Remove DC offset

        try {
            SynthState.wavetable.periodicWave = Synth.audioContext.createPeriodicWave(real, imag, { disableNormalization: false });
        } catch (e) {
            console.error('Failed to create PeriodicWave:', e);
        }
    }
};

// Utility functions
const Util = {
    createNoiseBuffer() {
        if (!Synth.audioContext) return null;
        if (this.noiseBuffer) return this.noiseBuffer;
        const bufferSize = Synth.audioContext.sampleRate;
        const buffer = Synth.audioContext.createBuffer(1, bufferSize, Synth.audioContext.sampleRate);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        this.noiseBuffer = buffer;
        return buffer;
    },
    formatValue(value, unit, format) {
        const num = parseFloat(value);
        if (format === 'freq') {
            const freq = num;
            if (freq >= 1000) return (freq / 1000).toFixed(1) + 'kHz';
            return Math.round(freq) + 'Hz';
        }
        if (format === 'time') {
            if (num < 1) return Math.round(num * 1000) + 'ms';
            return num.toFixed(2) + 's';
        }
        if (unit === '%') {
            return Math.round(num * 100) + '%';
        }
        if (unit === 'x') {
            return Math.round(num) + 'x';
        }
        if (unit === 'ct') {
            return Math.round(num) + 'ct';
        }
        if (unit === 'Hz') {
            return num.toFixed(1) + 'Hz';
        }
        // Default: show number with appropriate precision
        if (Number.isInteger(num)) return num.toString() + unit;
        return num.toFixed(1) + unit;
    }
};

// Preset Manager
const PresetManager = {
    STORAGE_KEY: 'browsynth_presets',

    getPresets() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            const parsed = stored ? JSON.parse(stored) : {};
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? Object.assign(Object.create(null), parsed) : Object.create(null);
        } catch (e) {
            console.error('Error loading presets:', e);
            return {};
        }
    },

    savePreset(name, settings) {
        const presets = this.getPresets();
        presets[name] = settings;
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(presets));
            return true;
        } catch (e) {
            console.error('Error saving preset:', e);
            return false;
        }
    },

    deletePreset(name) {
        const presets = this.getPresets();
        delete presets[name];
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(presets));
            return true;
        } catch (e) {
            console.error('Error deleting preset:', e);
            return false;
        }
    },

    loadPreset(name) {
        const presets = this.getPresets();
        return presets[name] || null;
    },

    updatePresetSelect() {
        const select = document.getElementById('presetSelect');
        if (!select) return;

        // Clear existing options except the first one
        while (select.options.length > 1) {
            select.remove(1);
        }

        // Add factory presets
        const factoryPresets = this.getFactoryPresets();
        if (Object.keys(factoryPresets).length > 0) {
            const factoryGroup = document.createElement('optgroup');
            factoryGroup.label = 'Factory';
            Object.keys(factoryPresets).forEach(name => {
                const option = document.createElement('option');
                option.value = 'factory:' + name;
                option.textContent = name;
                factoryGroup.appendChild(option);
            });
            select.appendChild(factoryGroup);
        }

        // Add user presets
        const userPresets = this.getPresets();
        if (Object.keys(userPresets).length > 0) {
            const userGroup = document.createElement('optgroup');
            userGroup.label = 'User';
            Object.keys(userPresets).sort().forEach(name => {
                const option = document.createElement('option');
                option.value = 'user:' + name;
                option.textContent = name;
                userGroup.appendChild(option);
            });
            select.appendChild(userGroup);
        }
    },

    getFactoryPresets() {
        return Object.fromEntries(FACTORY_PATCHES.map(patch => [patch.name, patch.settings]));
    },

    getCurrentSettings() {
        const settings = { __version: 2 };
        const controlIds = [
            'instrumentType', 'instrumentTone',
            'synthMode', 'waveform', 'unison', 'detune', 'fmAmount', 'wavetablePosition', 'arpClock', 'arpPattern', 'arpSpeed',
            'stereoSpread', 'unisonBlend', 'glideTime',
            'filterType', 'filterCutoff', 'filterResonance', 'filterEnvAmount',
            'attack', 'decay', 'sustain', 'release',
            'lfoRate', 'lfoAmount', 'noiseAmount',
            'masterVolume', 'masterReverb', 'masterDelay',
            'globalBpm', 'delayDivision', 'delayFeedback',
            'chorusAmount', 'driveAmount',
            'gateRate', 'gateDepth', 'gateSmooth',
            'sidechainAmount', 'sidechainRelease', 'kickLevel',
            'masterLowEQ', 'masterMidEQ', 'masterHighEQ'
        ];
        const checkboxIds = ['fmToggle', 'filterToggle', 'lfoToggle', 'noiseToggle',
            'gateToggle', 'sidechainToggle', 'kickToggle', 'arpToggle'];

        controlIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) settings[id] = el.value;
        });

        checkboxIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) settings[id] = el.checked;
        });

        // Snapshot Cthulhu state alongside other settings
        if (typeof Cthulhu !== 'undefined' && Cthulhu.snapshot) {
            settings.__cthulhu = Cthulhu.snapshot();
        }

        // Snapshot the trance gate pattern
        if (typeof TranceGate !== 'undefined' && TranceGate.snapshot) {
            settings.__gate = TranceGate.snapshot();
        }

        if (settings.synthMode === 'wavetable') {
            settings.__wavetable = WavetableEditor.frames.map(frame => Array.from(frame));
        }
        return settings;
    },

    applySettings(settings, { restoreTempo = false } = {}) {
        if (!settings) return;
        settings = { ...settings };
        // Tempo belongs to the session. Only an explicit session restore changes it.
        if (restoreTempo) Tempo.set(settings.globalBpm ?? settings.__cthulhu?.arp?.bpm ?? Tempo.bpm);
        if (settings.__version !== 2 && settings.filterCutoff !== undefined) {
            settings.filterCutoff = 20 * Math.pow(1000, (Number(settings.filterCutoff) - 20) / 19980);
        }
        if (Array.isArray(settings.__wavetable) && settings.__wavetable.length) {
            WavetableEditor.frames = settings.__wavetable.map(frame => Float32Array.from(frame));
            WavetableEditor.currentFrame = 0;
            WavetableEditor.apply();
        }

        Object.entries(settings).forEach(([key, value]) => {
            if (key.startsWith('__') || key === 'globalBpm') return;
            const el = document.getElementById(key);
            if (!el) return;

            if (el.type === 'checkbox') {
                el.checked = value;
                el.dispatchEvent(new Event('change'));
            } else {
                el.value = value;
                // Selects listen for 'change', sliders for 'input'
                el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input'));
            }
        });

        // Restore Cthulhu state if present
        if (settings.__cthulhu && typeof Cthulhu !== 'undefined' && Cthulhu.restore) {
            Cthulhu.restore(settings.__cthulhu);
        }

        // Restore the trance gate pattern if present
        if (settings.__gate && typeof TranceGate !== 'undefined' && TranceGate.restore) {
            TranceGate.restore(settings.__gate);
        }

        // Update all knob displays
        if (typeof UI !== 'undefined' && UI.updateCircularControls) {
            UI.updateCircularControls();
        }
    }
};

// MIDI Handler
const MIDIHandler = {
    midiAccess: null,
    inputs: [],
    enabled: false,

    async init() {
        if (this.enabled) return true; // Already initialized

        if (!navigator.requestMIDIAccess) {
            console.log('Web MIDI API not supported');
            this.updateButton('unsupported');
            return false;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess();
            this.midiAccess.onstatechange = (e) => this.onStateChange(e);
            this.connectInputs();
            this.enabled = true;
            return true;
        } catch (err) {
            console.error('MIDI access denied:', err);
            this.updateButton('denied');
            return false;
        }
    },

    connectInputs() {
        this.inputs = [];
        for (const input of this.midiAccess.inputs.values()) {
            input.onmidimessage = (e) => this.onMessage(e);
            this.inputs.push(input);
            console.log('MIDI input connected:', input.name);
        }
        this.updateButton(this.inputs.length > 0 ? 'connected' : 'disconnected');
    },

    onStateChange(e) {
        console.log('MIDI state change:', e.port.name, e.port.state);
        if (e.port.state === 'disconnected') {
            Sustain.set('midi', false); Voice.stopAllNotes(true); InstrumentVoice.panic();
        }
        this.connectInputs();
    },

    onMessage(e) {
        const [status, note, velocity] = e.data;
        const command = status >> 4;

        // Note On
        if (command === 9 && velocity > 0) {
            const noteName = applyOctaveShift(this.midiNoteToName(note));
            if (noteName) Voice.play(noteName, false, velocity / 127);
        }
        // Note Off (or Note On with velocity 0)
        else if (command === 8 || (command === 9 && velocity === 0)) {
            const noteName = applyOctaveShift(this.midiNoteToName(note));
            if (noteName) Voice.release(noteName);
        }
        // Pitch Bend
        else if (command === 14) {
            const bend = ((velocity << 7) | note) / 8192 - 1; // -1 to 1
            if (SynthState.controls.pitchBendWheel) {
                SynthState.controls.pitchBendWheel.value = bend;
                Synth.updatePitchBend(bend);
            }
        }
        // Control Change
        else if (command === 11) {
            this.handleCC(note, velocity);
        }
    },

    handleCC(cc, value) {
        const normalized = value / 127;

        // Common CC mappings
        const minFreq = 20, maxFreq = 20000;
        switch (cc) {
            case 64:
                Sustain.set('midi', value >= 64);
                break;
            case 120:
            case 123:
                Sustain.reset(); Voice.stopAllNotes(true); InstrumentVoice.panic();
                break;
            case 1: // Mod wheel -> Filter cutoff
                if (SynthState.controls.filterCutoff) {
                    // MIDI follows the knob's musical, logarithmic frequency sweep.
                    const sliderValue = minFreq * Math.pow(maxFreq / minFreq, normalized);
                    SynthState.controls.filterCutoff.value = sliderValue;
                    Synth.updateParams('filterCutoff');
                }
                break;
            case 7: // Volume
                if (SynthState.controls.masterVolume) {
                    SynthState.controls.masterVolume.value = normalized;
                    Synth.updateParams('masterVolume');
                }
                break;
            case 74: // Filter cutoff (common mapping)
                if (SynthState.controls.filterCutoff) {
                    const sliderValue = minFreq * Math.pow(maxFreq / minFreq, normalized);
                    SynthState.controls.filterCutoff.value = sliderValue;
                    Synth.updateParams('filterCutoff');
                }
                break;
            case 71: // Resonance
                if (SynthState.controls.filterResonance) {
                    SynthState.controls.filterResonance.value = normalized * 20;
                    Synth.updateParams('filterResonance');
                }
                break;
            case 91: // Reverb
                if (SynthState.controls.masterReverb) {
                    SynthState.controls.masterReverb.value = normalized;
                    Synth.updateParams('masterReverb');
                }
                break;
        }

        // Update UI
        UI.updateCircularControls();
    },

    midiNoteToName(midiNote) {
        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midiNote / 12) - 1;
        const note = notes[midiNote % 12];
        return note + octave;
    },

    updateButton(status) {
        const btn = document.getElementById('midiEnableButton');
        if (!btn) return;

        // Remove all status classes
        btn.classList.remove('midi-connected', 'midi-disconnected', 'midi-denied', 'midi-unsupported');

        switch (status) {
            case 'connected':
                btn.classList.add('midi-connected');
                btn.title = 'MIDI Connected: ' + this.inputs.map(i => i.name).join(', ');
                break;
            case 'disconnected':
                btn.classList.add('midi-disconnected');
                btn.title = 'MIDI enabled - No devices connected';
                break;
            case 'denied':
                btn.classList.add('midi-denied');
                btn.title = 'MIDI access denied - Click to retry';
                break;
            case 'unsupported':
                btn.classList.add('midi-unsupported');
                btn.title = 'Web MIDI not supported in this browser';
                btn.disabled = true;
                break;
            default:
                btn.title = 'Click to enable MIDI input';
        }
    }
};

// Synth voice creation and management
const Voice = {
    create(note, velocity = 1) {
        if (!Synth.audioContext) return null;

        // Check synth mode and create appropriate voice
        const synthMode = SynthState.controls.synthMode.value;
        if (synthMode === 'instrument') return InstrumentVoice.create(note, velocity);
        if (synthMode === 'piano') {
            return StringVoice.create(note);
        }
        const frequency = TuningSystem.noteToFreq(note); // Call directly on TuningSystem
        const now = Synth.audioContext.currentTime;

        const oscillators = [];
        const unisonChains = []; // per-oscillator gain (blend) + panner (spread)
        const unisonCount = parseInt(SynthState.controls.unison.value) || 1;
        const detune = parseFloat(SynthState.controls.detune.value) || 0;
        const spread = SynthState.controls.stereoSpread ? parseFloat(SynthState.controls.stereoSpread.value) : 0;
        const blend = SynthState.controls.unisonBlend ? parseFloat(SynthState.controls.unisonBlend.value) : 1;
        const glideTime = SynthState.controls.glideTime ? parseFloat(SynthState.controls.glideTime.value) : 0;
        const glideFrom = (glideTime > 0.001 && SynthState.lastFrequency &&
            Math.abs(SynthState.lastFrequency - frequency) > 0.01) ? SynthState.lastFrequency : null;
        const isWavetable = synthMode === 'wavetable' && SynthState.wavetable.periodicWave;

        for (let i = 0; i < unisonCount; i++) {
            const osc = Synth.audioContext.createOscillator();
            if (isWavetable) {
                osc.setPeriodicWave(SynthState.wavetable.periodicWave);
            } else {
                osc.type = SynthState.controls.waveform.value;
            }
            if (glideFrom) {
                osc.frequency.setValueAtTime(glideFrom, now);
                osc.frequency.exponentialRampToValueAtTime(frequency, now + glideTime);
            } else {
                osc.frequency.setValueAtTime(frequency, now);
            }
            // offset: -0.5 (far left/low detune) .. +0.5 (far right/high detune)
            const offset = unisonCount > 1 ? (i / (unisonCount - 1) - 0.5) : 0;
            osc.detune.setValueAtTime(offset * detune, now);

            const oscGain = Synth.audioContext.createGain();
            oscGain.gain.setValueAtTime((1 - (1 - blend) * Math.min(1, Math.abs(offset) * 2)) / unisonCount, now);
            const oscPan = Synth.audioContext.createStereoPanner();
            oscPan.pan.setValueAtTime(Math.max(-1, Math.min(1, offset * 2 * spread)), now);
            osc.connect(oscGain);
            oscGain.connect(oscPan);

            oscillators.push(osc);
            unisonChains.push({ gain: oscGain, pan: oscPan });
        }

        const gainNode = Synth.audioContext.createGain();
        gainNode.gain.setValueAtTime(0, now);

        const filter = Synth.audioContext.createBiquadFilter();
        filter.type = SynthState.filterSettings.type;
        filter.frequency.setValueAtTime(SynthState.filterSettings.frequency, now);
        filter.Q.setValueAtTime(SynthState.filterSettings.Q, now);

        // Connect nodes based on filter state
        if (SynthState.filterEnabled) {
            unisonChains.forEach(c => c.pan.connect(filter));
            filter.connect(gainNode);
        } else {
            unisonChains.forEach(c => c.pan.connect(gainNode));
        }

        const fmOsc = Synth.audioContext.createOscillator();
        if (glideFrom) {
            fmOsc.frequency.setValueAtTime(glideFrom * 2, now);
            fmOsc.frequency.exponentialRampToValueAtTime(frequency * 2, now + glideTime);
        } else {
            fmOsc.frequency.setValueAtTime(frequency * 2, now);
        }
        const fmGain = Synth.audioContext.createGain();
        fmGain.gain.setValueAtTime(SynthState.fmEnabled ? parseFloat(SynthState.controls.fmAmount.value) : 0, now);
        fmOsc.connect(fmGain);
        oscillators.forEach(osc => fmGain.connect(osc.frequency));

        const noiseOsc = Synth.audioContext.createBufferSource();
        noiseOsc.buffer = Util.createNoiseBuffer();
        noiseOsc.loop = true;
        const noiseGain = Synth.audioContext.createGain();
        noiseGain.gain.setValueAtTime(0, now);
        if (SynthState.noiseEnabled) {
            noiseOsc.connect(noiseGain);
            noiseGain.connect(SynthState.filterEnabled ? filter : gainNode);
        }

        const lfo = Synth.audioContext.createOscillator();
        const lfoGain = Synth.audioContext.createGain();
        lfo.frequency.setValueAtTime(parseFloat(SynthState.controls.lfoRate.value), now);
        lfoGain.gain.setValueAtTime(parseFloat(SynthState.controls.lfoAmount.value), now);

        // Connect LFO
        if (SynthState.lfoEnabled) {
            lfo.connect(lfoGain);
            lfoGain.connect(filter.frequency);
        }

        const pitchBend = {
            bend: 0,
            range: parseInt(SynthState.controls.pitchBendRange?.value) || 2
        };

        const updatePitchBend = (bend) => {
            const now = Synth.audioContext.currentTime;
            pitchBend.bend = bend; // remembered so updateVoice() preserves the bend
            const bendRange = pitchBend.range * 100; // Convert semitones to cents
            oscillators.forEach((osc, i) => {
                const count = oscillators.length;
                const currentDetune = Number(SynthState.controls.detune.value);
                const detuneAmount = count > 1 ? (i / (count - 1) - 0.5) * currentDetune : 0;
                const totalDetune = detuneAmount + bend * bendRange;

                // Ensure the value is finite and within a reasonable range
                const clampedDetune = Math.max(-4800, Math.min(4800, isFinite(totalDetune) ? totalDetune : 0));

                osc.detune.setTargetAtTime(clampedDetune, now, 0.01);
            });
        };

        gainNode.connect(Synth.compressor);

        // Start oscillators
        oscillators.forEach(osc => osc.start(now));
        fmOsc.start(now);
        noiseOsc.start(now);
        lfo.start(now);

        const updateVoice = () => {
            const now = Synth.audioContext.currentTime;

            // Update filter
            if (SynthState.filterEnabled) {
                filter.type = SynthState.filterSettings.type;
                filter.frequency.cancelScheduledValues(now);
                filter.frequency.setValueAtTime(SynthState.filterSettings.frequency, now);
                filter.Q.cancelScheduledValues(now);
                filter.Q.setValueAtTime(SynthState.filterSettings.Q, now);
                filter.disconnect();
                filter.connect(gainNode);
            }

            // Update oscillators, unison, detune, spread and blend
            const newUnisonCount = parseInt(SynthState.controls.unison.value) || 1;
            const newDetune = parseFloat(SynthState.controls.detune.value) || 0;
            const newSpread = SynthState.controls.stereoSpread ? parseFloat(SynthState.controls.stereoSpread.value) : 0;
            const newBlend = SynthState.controls.unisonBlend ? parseFloat(SynthState.controls.unisonBlend.value) : 1;
            const useWavetable = SynthState.controls.synthMode.value === 'wavetable' && SynthState.wavetable.periodicWave;

            // Adjust the number of oscillators if unison has changed
            while (oscillators.length < newUnisonCount) {
                const newOsc = Synth.audioContext.createOscillator();
                newOsc.frequency.setValueAtTime(frequency, now);
                const newGain = Synth.audioContext.createGain();
                const newPan = Synth.audioContext.createStereoPanner();
                newOsc.connect(newGain);
                newGain.connect(newPan);
                newOsc.start(now);
                fmGain.connect(newOsc.frequency);
                oscillators.push(newOsc);
                unisonChains.push({ gain: newGain, pan: newPan });
            }
            while (oscillators.length > newUnisonCount) {
                const oscToRemove = oscillators.pop();
                const chainToRemove = unisonChains.pop();
                oscToRemove.stop(now);
                oscToRemove.disconnect();
                chainToRemove.gain.disconnect();
                chainToRemove.pan.disconnect();
            }

            // Update each oscillator
            oscillators.forEach((osc, i) => {
                if (useWavetable) {
                    osc.setPeriodicWave(SynthState.wavetable.periodicWave);
                } else {
                    osc.type = SynthState.controls.waveform.value;
                }
                const offset = newUnisonCount > 1 ? (i / (newUnisonCount - 1) - 0.5) : 0;
                const bendCents = pitchBend.bend * pitchBend.range * 100;
                const totalDetune = offset * newDetune + bendCents;
                osc.detune.setValueAtTime(Math.max(-4800, Math.min(4800, isFinite(totalDetune) ? totalDetune : 0)), now);

                const chain = unisonChains[i];
                chain.gain.gain.setValueAtTime((1 - (1 - newBlend) * Math.min(1, Math.abs(offset) * 2)) / newUnisonCount, now);
                chain.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, offset * 2 * newSpread)), now);

                // Reconnect if filter state has changed
                chain.pan.disconnect();
                if (SynthState.filterEnabled) {
                    chain.pan.connect(filter);
                } else {
                    chain.pan.connect(gainNode);
                }
            });

            // Update FM
            if (SynthState.fmEnabled) {
                fmGain.gain.setValueAtTime(parseFloat(SynthState.controls.fmAmount.value), now);
            } else {
                fmGain.gain.setValueAtTime(0, now);
            }

            // Update Noise
            if (SynthState.noiseEnabled) {
                noiseGain.gain.setValueAtTime(parseFloat(SynthState.controls.noiseAmount.value), now);
                noiseOsc.connect(noiseGain);
                noiseGain.disconnect();
                noiseGain.connect(SynthState.filterEnabled ? filter : gainNode);
            } else {
                noiseGain.gain.setValueAtTime(0, now);
                noiseOsc.disconnect();
                noiseGain.disconnect();
            }

            // Update LFO
            if (SynthState.lfoEnabled) {
                lfo.frequency.setValueAtTime(parseFloat(SynthState.controls.lfoRate.value), now);
                lfoGain.gain.setValueAtTime(parseFloat(SynthState.controls.lfoAmount.value), now);
                lfo.connect(lfoGain);
                lfoGain.connect(filter.frequency);
            } else {
                lfo.disconnect();
                lfoGain.disconnect();
            }
        };

        SynthState.lastFrequency = frequency;

        return {
            oscillators, unisonChains, gainNode, filter, fmOsc, fmGain, noiseOsc, noiseGain, lfo, lfoGain, updateVoice, updatePitchBend, pitchBend, frequency
        };
    },

    play(note, isArpeggiator = false, velocity = 1) {
        if (!Synth.audioContext) return;
        if (SynthState.cthulhu && SynthState.cthulhu.enabled && !isArpeggiator) {
            Cthulhu.handleNoteOn(note);
            return;
        }
        if (SynthState.arpeggiator.isOn && !isArpeggiator) {
            Arpeggiator.addNote(note);
            return;
        }
        if (Sustain.pending.has(note)) this.release(note, true);
        if (SynthState.activeVoices[note]) return;

        if (Object.keys(SynthState.activeVoices).length >= SynthConfig.maxPolyphony) {
            this.release(Object.keys(SynthState.activeVoices)[0], true);
        }

        const voice = this.create(note, velocity);
        if (!voice) return;

        if (voice.start) {
            SynthState.activeVoices[note] = voice; SynthState.activeNotes.add(note);
            voice.start(); voice.updatePitchBend(Number(SynthState.controls.pitchBendWheel.value)||0);
            Synth.recordNoteEvent(note, true);
            document.querySelector(`.key[data-note="${note}"]`)?.classList.add('active');
            return;
        }

        // Special handling for piano voices
        if (voice.attackOsc) {
            const now = Synth.audioContext.currentTime;
            const attackTime = 0.01;  // Very quick attack
            const decayTime = 0.1;
            const sustainLevel = parseFloat(SynthState.controls.sustain.value) * 0.7 * velocity;

            // Main envelope
            voice.mainGain.gain.setValueAtTime(0, now);
            voice.mainGain.gain.linearRampToValueAtTime(velocity, now + attackTime);
            voice.mainGain.gain.exponentialRampToValueAtTime(sustainLevel + 0.001, now + attackTime + decayTime);

            // Attack noise envelope
            voice.attackGain.gain.setValueAtTime(0.3 * velocity, now);
            voice.attackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

            SynthState.activeVoices[note] = voice;
            SynthState.activeNotes.add(note);
            Synth.recordNoteEvent(note, true);

            const keyElement = document.querySelector(`.key[data-note="${note}"]`);
            if (keyElement) keyElement.classList.add('active');
            return;
        }

        if (Object.keys(SynthState.activeVoices).length >= SynthConfig.maxPolyphony) {
            const oldestNote = Object.keys(SynthState.activeVoices)[0];
            this.release(oldestNote, true);
        }

        if (voice && voice.updatePitchBend) {
            const currentPitchBend = parseFloat(SynthState.controls.pitchBendWheel?.value) || 0;
            voice.updatePitchBend(currentPitchBend);
        }
        SynthState.activeVoices[note] = voice;
        SynthState.activeNotes.add(note);
        Synth.recordNoteEvent(note, true);

        const now = Synth.audioContext.currentTime;
        const attackTime = parseFloat(SynthState.controls.attack.value);
        const decayTime = parseFloat(SynthState.controls.decay.value);
        const sustainLevel = parseFloat(SynthState.controls.sustain.value);

        // Adjust the peak level based on the number of active voices
        const peakLevel = 0.46 * velocity;
        const sustainedLevel = sustainLevel * peakLevel;

        voice.gainNode.gain.linearRampToValueAtTime(peakLevel, now + attackTime);
        voice.gainNode.gain.setTargetAtTime(sustainedLevel, now + attackTime, Math.max(0.003, decayTime / 4));

        // Filter envelope
        const filterEnvAmount = parseFloat(SynthState.controls.filterEnvAmount.value);
        const filterStartFreq = SynthState.filterSettings.frequency;
        const filterPeakFreq = Math.min(filterStartFreq * (1 + filterEnvAmount * 10), Synth.audioContext.sampleRate / 2);

        // Apply noise envelope
        if (SynthState.noiseEnabled) {
            const noiseAmount = parseFloat(SynthState.controls.noiseAmount.value);
            voice.noiseGain.gain.cancelScheduledValues(now);
            voice.noiseGain.gain.setValueAtTime(0, now);
            voice.noiseGain.gain.linearRampToValueAtTime(noiseAmount, now + attackTime);
            voice.noiseGain.gain.linearRampToValueAtTime(noiseAmount * sustainLevel, now + attackTime + decayTime);
        }

        // Apply LFO envelope
        if (SynthState.lfoEnabled) {
            const lfoAmount = parseFloat(SynthState.controls.lfoAmount.value);
            voice.lfoGain.gain.cancelScheduledValues(now);
            voice.lfoGain.gain.setValueAtTime(0, now);
            voice.lfoGain.gain.linearRampToValueAtTime(lfoAmount, now + attackTime);
        }

        if (SynthState.filterEnabled) {
            voice.filter.frequency.cancelScheduledValues(now);
            voice.filter.frequency.setValueAtTime(filterStartFreq, now);
            voice.filter.frequency.linearRampToValueAtTime(filterPeakFreq, now + attackTime);
            voice.filter.frequency.exponentialRampToValueAtTime(Math.max(20, filterStartFreq), now + attackTime + Math.max(0.01, decayTime));
        }

        const keyElement = document.querySelector(`.key[data-note="${note}"]`);
        if (keyElement) keyElement.classList.add('active');
    },

    release(note, isArpeggiator = false) {
        if (SynthState.cthulhu && SynthState.cthulhu.enabled && !isArpeggiator) {
            Cthulhu.handleNoteOff(note);
            return;
        }
        if (SynthState.arpeggiator.isOn && !isArpeggiator) {
            Arpeggiator.removeNote(note);
            return;
        }

        const voice = SynthState.activeVoices[note];
        if (voice && Sustain.on && !isArpeggiator) {
            Sustain.pending.add(note);
            document.querySelector(`.key[data-note="${note}"]`)?.classList.remove('active');
            return;
        }
        Sustain.pending.delete(note);
        Synth.recordNoteEvent(note, false);
        if (!voice) return;

        const releaseTime = parseFloat(SynthState.controls.release.value);

        // If voice has custom release method, use it
        if (voice.release) {
            voice.release(releaseTime);
        } else {
            const now = Synth.audioContext.currentTime;
            voice.gainNode.gain.cancelAndHoldAtTime(now);
            voice.gainNode.gain.setTargetAtTime(0, now, Math.max(0.003, releaseTime / 5));

            setTimeout(() => {
                if (voice.oscillators) {
                    voice.oscillators.forEach(osc => {
                        osc.stop();
                        osc.disconnect();
                    });
                }
                if (voice.unisonChains) {
                    voice.unisonChains.forEach(c => {
                        c.gain.disconnect();
                        c.pan.disconnect();
                    });
                }
                if (voice.gainNode) voice.gainNode.disconnect();
                if (voice.filter) voice.filter.disconnect();
                if (voice.fmOsc) {
                    voice.fmOsc.stop();
                    voice.fmOsc.disconnect();
                }
                if (voice.fmGain) voice.fmGain.disconnect();
                if (voice.noiseOsc) {
                    voice.noiseOsc.stop();
                    voice.noiseOsc.disconnect();
                }
                if (voice.noiseGain) voice.noiseGain.disconnect();
                if (voice.lfo) {
                    voice.lfo.stop();
                    voice.lfo.disconnect();
                }
                if (voice.lfoGain) voice.lfoGain.disconnect();
            }, releaseTime * 1000);
        }

        delete SynthState.activeVoices[note];
        SynthState.activeNotes.delete(note);

        const keyElement = document.querySelector(`.key[data-note="${note}"]`);
        if (keyElement) keyElement.classList.remove('active');
    },
    stopAllNotes: function (isArpeggiator = false) {
        if (SynthState.cthulhu && SynthState.cthulhu.enabled && !isArpeggiator) {
            Cthulhu.panic();
            return;
        }
        if (SynthState.arpeggiator.isOn && !isArpeggiator) {
            SynthState.arpeggiator.notes = [];
            Arpeggiator.stop();
            return;
        }
        SynthState.activeNotes.forEach(note => {
            if (SynthState.activeVoices[note]) {
                this.release(note, true);
            }
        });
        SynthState.activeNotes.clear();
        const keys = document.querySelectorAll('.key.active');
        keys.forEach(key => key.classList.remove('active'));
    }
};

// Add this new object right after the Voice object
const StringVoice = {
    create(note) {
        if (!Synth.audioContext) return null;
        const ctx = Synth.audioContext;
        const frequency = TuningSystem.noteToFreq(note);
        const now = ctx.currentTime;

        // Create main oscillator bank for piano tone
        const oscs = [];
        const gains = [];
        const freqMultipliers = [1, 2, 4]; // Fundamental and harmonics
        const gainValues = [1, 0.6, 0.3];  // Relative volumes

        for (let i = 0; i < freqMultipliers.length; i++) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'triangle';  // Base tone
            osc.frequency.value = frequency * freqMultipliers[i];
            gain.gain.value = gainValues[i] * 0.2;

            osc.connect(gain);
            oscs.push(osc);
            gains.push(gain);
        }

        // Attack noise for hammer sound
        const attackOsc = ctx.createOscillator();
        const attackGain = ctx.createGain();
        attackOsc.type = 'sawtooth';  // Changed from 'white' to 'sawtooth'
        attackGain.gain.value = 0;
        attackOsc.connect(attackGain);

        // Main gain node
        const mainGain = ctx.createGain();
        mainGain.gain.value = 0;

        // Filter for warmth
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 5000;
        filter.Q.value = 0.5;

        // Connect everything
        gains.forEach(g => g.connect(filter));
        attackGain.connect(filter);
        filter.connect(mainGain);
        mainGain.connect(Synth.compressor);

        // Start all oscillators
        oscs.forEach(osc => osc.start(now));
        attackOsc.start(now);

        // Add release method to the voice
        const release = (releaseTime) => {
            const now = ctx.currentTime;
            mainGain.gain.cancelScheduledValues(now);
            mainGain.gain.setValueAtTime(mainGain.gain.value, now);
            mainGain.gain.exponentialRampToValueAtTime(0.001, now + releaseTime);

            // Cleanup after release
            setTimeout(() => {
                oscs.forEach(osc => {
                    osc.stop();
                    osc.disconnect();
                });
                gains.forEach(gain => gain.disconnect());
                attackOsc.stop();
                attackOsc.disconnect();
                attackGain.disconnect();
                filter.disconnect();
                mainGain.disconnect();
            }, releaseTime * 1000);
        };

        return {
            oscillators: oscs,
            gains: gains,
            attackOsc,
            attackGain,
            mainGain,
            filter,
            frequency,
            release,  // Add release method to returned object
            updateVoice: () => {
                filter.frequency.value = 5000;
                gains.forEach((gain, i) => {
                    gain.gain.value = gainValues[i] * 0.2;
                });
            }
        };
    }
};

// Arpeggiator functionality
const Arpeggiator = {
    step: 0,
    direction: 1,

    start() {
        if (SynthState.arpeggiator.notes.length === 0) return;
        this.stop();
        this.step = 0;
        this.direction = 1;
        this.playCurrentNote();
        const speed = this.calculateSpeed();
        SynthState.arpeggiator.intervalId = setInterval(() => this.playNextNote(), speed);
    },

    stop() {
        if (SynthState.arpeggiator.intervalId) {
            clearInterval(SynthState.arpeggiator.intervalId);
            SynthState.arpeggiator.intervalId = null;
        }
        Voice.stopAllNotes(true);
    },

    calculateSpeed() {
        const clockValue = parseInt(SynthState.controls.arpClock.value);
        const speedValue = Number(SynthState.controls.arpSpeed.value) || 1;
        return (60000 / Tempo.bpm) * (4 / clockValue) / speedValue;
    },

    updateSpeed() {
        if (SynthState.arpeggiator.isOn && SynthState.arpeggiator.notes.length > 0) {
            this.stop();
            this.start();
        }
    },

    addNote(note) {
        if (!SynthState.arpeggiator.notes.includes(note)) {
            SynthState.arpeggiator.notes.push(note);
        }
        if (SynthState.arpeggiator.isOn && SynthState.arpeggiator.notes.length === 1) {
            this.start();
        }
    },

    removeNote(note) {
        const index = SynthState.arpeggiator.notes.indexOf(note);
        if (index > -1) {
            SynthState.arpeggiator.notes.splice(index, 1);
        }
        if (SynthState.arpeggiator.notes.length === 0) {
            this.stop();
        }
    },

    playNextNote() {
        if (SynthState.arpeggiator.notes.length === 0) {
            this.stop();
            return;
        }
        this.step = this.getNextStep();
        this.playCurrentNote();
    },

    playCurrentNote() {
        if (SynthState.arpeggiator.notes.length === 0) return;
        const note = SynthState.arpeggiator.notes[this.step];
        Voice.stopAllNotes(true);
        Voice.play(note, true);
    },

    getNextStep() {
        const { pattern, notes } = SynthState.arpeggiator;
        const notesCount = notes.length;
        switch (pattern) {
            case 'up':
                return (this.step + 1) % notesCount;
            case 'down':
                return (this.step - 1 + notesCount) % notesCount;
            case 'upDown':
                if (this.step === 0) this.direction = 1;
                else if (this.step === notesCount - 1) this.direction = -1;
                return (this.step + this.direction + notesCount) % notesCount;
            case 'random':
                return Math.floor(Math.random() * notesCount);
            default:
                return (this.step + 1) % notesCount;
        }
    },
};

// ─────────────────────────────────────────────────────────────
//  CTHULHU — step arpeggiator (à la Xfer Cthulhu)
// ─────────────────────────────────────────────────────────────
const CthulhuConfig = {
    NOTE_NAMES: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    TONE_ROWS: 8,    // chord-tone rows in the grid (1..8 from bottom up)
    STEPS: 16,
    // Step subdivisions per 4/4 bar
    RATE_MAP: {
        '1/4': 4, '1/8': 8, '1/16': 16, '1/32': 32,
        '1/8T': 12, '1/16T': 24
    },

    noteToMidi(name) {
        const m = /^([A-G]#?)(-?\d+)$/.exec(name);
        if (!m) return 60;
        const idx = this.NOTE_NAMES.indexOf(m[1]);
        return idx + (parseInt(m[2], 10) + 1) * 12;
    },
    midiToNote(midi) {
        const octave = Math.floor(midi / 12) - 1;
        return this.NOTE_NAMES[((midi % 12) + 12) % 12] + octave;
    },
    shiftOctave(noteName, by) {
        const m = /^([A-G]#?)(-?\d+)$/.exec(noteName);
        if (!m) return noteName;
        return m[1] + (parseInt(m[2], 10) + by);
    }
};

const Cthulhu = {
    initialized: false,

    init() {
        if (this.initialized) return;
        this.initialized = true;
        // Initialize 16 empty steps
        const steps = [];
        for (let i = 0; i < CthulhuConfig.STEPS; i++) {
            steps.push({ tones: [], octave: 0, velocity: 1.0, gate: 0.85 });
        }
        SynthState.cthulhu.arp.steps = steps;
        this.applyPattern('up'); // sensible default

        this.renderGrid();
        this.setupListeners();
    },

    // ── UI: Open / Close ──
    open() {
        document.getElementById('cthulhuModal').style.display = 'flex';
        this.renderGrid();
        this.syncControlsFromState();
    },
    close() {
        document.getElementById('cthulhuModal').style.display = 'none';
    },

    // ── UI: Render the entire grid (tone-grid + step numbers + param rows) ──
    renderGrid() {
        this.renderToneGrid();
        this.renderStepNumbers();
        this.renderParamRows();
    },

    renderToneGrid() {
        const axis = document.getElementById('cthulhuToneAxis');
        const grid = document.getElementById('cthulhuToneGrid');
        if (!axis || !grid) return;

        axis.innerHTML = '';
        grid.innerHTML = '';
        const steps = SynthState.cthulhu.arp.steps;
        const length = SynthState.cthulhu.arp.length;
        const rows = CthulhuConfig.TONE_ROWS;

        // Y-axis labels: ? at top, then 8..1 going down (1 at bottom)
        const labels = ['?', ...Array.from({ length: rows }, (_, i) => String(rows - i))];
        labels.forEach((lbl) => {
            const a = document.createElement('div');
            a.className = 'cthulhu-tone-axis-label';
            a.textContent = lbl;
            axis.appendChild(a);
        });

        // Grid rows: special "rand" row first, then tone rows from high to low
        const rowDefs = [{ tone: 'rand' }, ...Array.from({ length: rows }, (_, i) => ({ tone: rows - i }))];
        grid.style.gridTemplateColumns = `repeat(${CthulhuConfig.STEPS}, 1fr)`;
        grid.style.gridTemplateRows = `repeat(${rowDefs.length}, 1fr)`;

        rowDefs.forEach((row) => {
            for (let s = 0; s < CthulhuConfig.STEPS; s++) {
                const cell = document.createElement('div');
                cell.className = 'cthulhu-grid-cell';
                cell.dataset.step = String(s);
                cell.dataset.tone = String(row.tone);
                if (row.tone === 'rand') cell.classList.add('cthulhu-grid-cell-rand');
                if (s >= length) cell.classList.add('cthulhu-grid-cell-disabled');

                const isActive = steps[s].tones.includes(row.tone);
                if (isActive) cell.classList.add('cthulhu-grid-cell-on');

                cell.addEventListener('click', () => this.toggleStepTone(s, row.tone));
                grid.appendChild(cell);
            }
        });
    },

    toggleStepTone(stepIdx, tone) {
        const step = SynthState.cthulhu.arp.steps[stepIdx];
        if (!step) return;
        const i = step.tones.indexOf(tone);
        if (i >= 0) step.tones.splice(i, 1);
        else step.tones.push(tone);
        // re-render just the affected column for snappy feedback
        document.querySelectorAll(`.cthulhu-grid-cell[data-step="${stepIdx}"]`).forEach(cell => {
            const cellTone = cell.dataset.tone === 'rand' ? 'rand' : parseInt(cell.dataset.tone, 10);
            cell.classList.toggle('cthulhu-grid-cell-on', step.tones.includes(cellTone));
        });
    },

    renderStepNumbers() {
        const wrap = document.getElementById('cthulhuStepNumbers');
        if (!wrap) return;
        wrap.innerHTML = '';
        const length = SynthState.cthulhu.arp.length;
        for (let s = 0; s < CthulhuConfig.STEPS; s++) {
            const cell = document.createElement('div');
            cell.className = 'cthulhu-step-number';
            if (s >= length) cell.classList.add('cthulhu-step-number-disabled');
            cell.textContent = String(s + 1);
            wrap.appendChild(cell);
        }
    },

    renderParamRows() {
        const length = SynthState.cthulhu.arp.length;
        const steps = SynthState.cthulhu.arp.steps;
        const rows = [
            { id: 'cthulhuOctRow', key: 'octave', display: (s) => (s.octave > 0 ? '+' + s.octave : String(s.octave)), bar: false,
              delta: (s, dir) => { s.octave = Math.max(-2, Math.min(2, s.octave + dir)); } },
            { id: 'cthulhuVelRow', key: 'velocity', display: (s) => Math.round(s.velocity * 100) + '%', bar: true,
              delta: (s, dir) => { s.velocity = Math.max(0, Math.min(1, +(s.velocity + dir * 0.1).toFixed(2))); } },
            { id: 'cthulhuGateRow', key: 'gate', display: (s) => Math.round(s.gate * 100) + '%', bar: true,
              delta: (s, dir) => { s.gate = Math.max(0.05, Math.min(1, +(s.gate + dir * 0.05).toFixed(2))); } }
        ];

        rows.forEach(row => {
            const wrap = document.getElementById(row.id);
            if (!wrap) return;
            wrap.innerHTML = '';
            for (let s = 0; s < CthulhuConfig.STEPS; s++) {
                const cell = document.createElement('div');
                cell.className = 'cthulhu-param-cell';
                if (s >= length) cell.classList.add('cthulhu-param-cell-disabled');

                if (row.bar) {
                    const fill = document.createElement('div');
                    fill.className = 'cthulhu-param-cell-fill';
                    fill.style.height = (steps[s][row.key] * 100) + '%';
                    cell.appendChild(fill);
                }
                const lbl = document.createElement('span');
                lbl.className = 'cthulhu-param-cell-label';
                lbl.textContent = row.display(steps[s]);
                cell.appendChild(lbl);

                const refresh = () => {
                    lbl.textContent = row.display(steps[s]);
                    if (row.bar) {
                        const fill = cell.querySelector('.cthulhu-param-cell-fill');
                        if (fill) fill.style.height = (steps[s][row.key] * 100) + '%';
                    }
                };

                // Scroll wheel to change value
                cell.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    const dir = e.deltaY < 0 ? 1 : -1;
                    row.delta(steps[s], dir);
                    refresh();
                }, { passive: false });

                // Drag-vertical for touch / mouse (alternative to wheel)
                let dragging = false, lastY = 0;
                const onMove = (e) => {
                    if (!dragging) return;
                    const y = e.touches ? e.touches[0].clientY : e.clientY;
                    const dy = lastY - y;
                    if (Math.abs(dy) >= 6) {
                        row.delta(steps[s], dy > 0 ? 1 : -1);
                        refresh();
                        lastY = y;
                    }
                    e.preventDefault();
                };
                const onUp = () => {
                    dragging = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.removeEventListener('touchmove', onMove);
                    document.removeEventListener('touchend', onUp);
                };
                cell.addEventListener('mousedown', (e) => {
                    dragging = true;
                    lastY = e.clientY;
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                    e.preventDefault();
                });
                cell.addEventListener('touchstart', (e) => {
                    dragging = true;
                    lastY = e.touches[0].clientY;
                    document.addEventListener('touchmove', onMove, { passive: false });
                    document.addEventListener('touchend', onUp);
                    e.preventDefault();
                }, { passive: false });

                wrap.appendChild(cell);
            }
        });
    },

    applyPattern(name) {
        const arp = SynthState.cthulhu.arp;
        const len = arp.length;
        arp.steps.forEach(s => {
            s.tones = []; s.octave = 0; s.velocity = 1.0; s.gate = 0.85;
        });
        if (name === 'up') {
            // Each step plays exactly one chord-tone, ascending and wrapping (1..6)
            for (let i = 0; i < len; i++) {
                arp.steps[i].tones = [((i % 6) + 1)];
            }
        }
        // 'clear' is the reset above — nothing else to do
        this.renderGrid();
    },

    // ── Pattern presets ──
    // Each step is [tones, octave, velocity, gate]; missing steps stay empty.
    // The two Mau5 patterns follow deadmau5's own 6-step Cthulhu sequences
    // (1,5,1,3,2,6 from his Masterclass; 6,6,7,6,6,8 with a -2oct dip from a
    // published deconstruction of his MIDI) — 6-step length makes them roll
    // polymetrically over the 4/4 bar. Psy bass is the classic K-B-B-B offbeat;
    // Rolling/Bounce are the standard uplifting-trance octave rollers;
    // Stabs/1-3-5-8/Stutter are the textbook trance chord-tone rhythms.
    PRESETS: {
        'mau5-poly': {
            rate: '1/16', length: 6, swing: 0, steps: [
                [[1], 0, 1.0, 0.5], [[5], 0, 0.75, 0.45], [[1], 0, 0.85, 0.45],
                [[3], 0, 0.8, 0.45], [[2], 0, 0.85, 0.45], [[6], 0, 0.75, 0.45]
            ]
        },
        'strobe-six': {
            // deadmau5's 6,6,7,6,6,8 contour, voiced down to tones 3-5 —
            // his chords had 7 notes so "6th highest" was mid-register;
            // over a small held chord the literal tones scream too high
            rate: '1/16', length: 6, swing: 0, steps: [
                [[3], 0, 1.0, 0.5], [[3], 0, 0.8, 0.5], [[4], 0, 0.85, 0.5],
                [[3], 0, 0.8, 0.5], [[3], -2, 0.9, 0.5], [[5], 0, 0.85, 0.5]
            ]
        },
        'rolling-bass': {
            rate: '1/16', length: 16, swing: 0, steps: [
                [[1], 0, 1.0, 0.7], [[1], 1, 0.8, 0.7], [[1], 0, 0.85, 0.7], [[1], 0, 0.8, 0.7],
                [[1], 0, 1.0, 0.7], [[1], 1, 0.8, 0.7], [[1], 0, 0.85, 0.7], [[1], 0, 0.8, 0.7],
                [[1], 0, 1.0, 0.7], [[1], 1, 0.8, 0.7], [[1], 0, 0.85, 0.7], [[1], 0, 0.8, 0.7],
                [[1], 0, 1.0, 0.7], [[1], 1, 0.8, 0.7], [[1], 0, 0.85, 0.7], [[1], 0, 0.8, 0.7]
            ]
        },
        'psy-bass': {
            rate: '1/16', length: 16, swing: 0, steps: [
                null, [[1], 0, 0.9, 0.8], [[1], 0, 0.85, 0.8], [[1], 0, 1.0, 0.8],
                null, [[1], 0, 0.9, 0.8], [[1], 0, 0.85, 0.8], [[1], 0, 1.0, 0.8],
                null, [[1], 0, 0.9, 0.8], [[1], 0, 0.85, 0.8], [[1], 0, 1.0, 0.8],
                null, [[1], 0, 0.9, 0.8], [[1], 0, 0.85, 0.8], [[1], 0, 1.0, 0.8]
            ]
        },
        'octave-bounce': {
            rate: '1/16', length: 16, swing: 0, steps: [
                [[1], 0, 1.0, 0.55], [[1], 1, 0.8, 0.55], [[1], 0, 0.9, 0.55], [[1], 1, 0.8, 0.55],
                [[1], 0, 1.0, 0.55], [[1], 1, 0.8, 0.55], [[1], 0, 0.9, 0.55], [[1], 1, 0.8, 0.55],
                [[1], 0, 1.0, 0.55], [[1], 1, 0.8, 0.55], [[1], 0, 0.9, 0.55], [[1], 1, 0.8, 0.55],
                [[1], 0, 1.0, 0.55], [[1], 1, 0.8, 0.55], [[1], 0, 0.9, 0.55], [[1], 1, 0.8, 0.55]
            ]
        },
        'offbeat-stabs': {
            rate: '1/16', length: 16, swing: 0, steps: [
                null, null, [[1, 2, 3], 0, 1.0, 0.35], null,
                null, null, [[1, 2, 3], 0, 1.0, 0.35], null,
                null, null, [[1, 2, 3], 0, 1.0, 0.35], null,
                null, null, [[1, 2, 3], 0, 1.0, 0.35], null
            ]
        },
        'one-three-five': {
            rate: '1/16', length: 16, swing: 0, steps: [
                [[1], 0, 1.0, 0.5], [[2], 0, 0.8, 0.5], [[3], 0, 0.85, 0.5], [[4], 0, 0.8, 0.5],
                [[1], 0, 1.0, 0.5], [[2], 0, 0.8, 0.5], [[3], 0, 0.85, 0.5], [[4], 0, 0.8, 0.5],
                [[1], 0, 1.0, 0.5], [[2], 0, 0.8, 0.5], [[3], 0, 0.85, 0.5], [[4], 0, 0.8, 0.5],
                [[1], 0, 1.0, 0.5], [[2], 0, 0.8, 0.5], [[3], 0, 0.85, 0.5], [[4], 0, 0.8, 0.5]
            ]
        },
        'chord-stutter': {
            rate: '1/16', length: 16, swing: 0, steps: [
                [[1, 2, 3], 0, 1.0, 0.55], [[1, 2, 3], 0, 0.8, 0.55], null, [[1, 2, 3], 0, 0.85, 0.55],
                [[1, 2, 3], 0, 1.0, 0.55], null, [[1, 2, 3], 0, 0.85, 0.55], null,
                [[1, 2, 3], 0, 1.0, 0.55], [[1, 2, 3], 0, 0.8, 0.55], null, [[1, 2, 3], 0, 0.85, 0.55],
                [[1, 2, 3], 0, 1.0, 0.55], null, [[1, 2, 3], 0, 0.85, 0.55], null
            ]
        }
    },

    applyPreset(name) {
        const p = this.PRESETS[name];
        if (!p) return;
        const arp = SynthState.cthulhu.arp;
        arp.rate = p.rate;
        arp.length = p.length;
        arp.swing = p.swing || 0;
        arp.steps = [];
        for (let i = 0; i < CthulhuConfig.STEPS; i++) {
            const s = p.steps[i];
            arp.steps.push(s
                ? { tones: [...s[0]], octave: s[1], velocity: s[2], gate: s[3] }
                : { tones: [], octave: 0, velocity: 1.0, gate: 0.85 });
        }
        this.syncControlsFromState();
        this.renderGrid();
    },

    // ── Note routing ──
    handleNoteOn(note) {
        if (!Synth.audioContext) return;
        const C = SynthState.cthulhu;
        const arp = C.arp;

        // Latch reset: if all keys were previously released and we marked it pending,
        // clear the latched held-notes before adding this fresh keypress.
        if (arp.latch && C.pendingLatchReset && C.pressedByUser.size === 0) {
            arp.heldNotes = [];
        }
        C.pendingLatchReset = false;

        if (!C.pressedByUser.has(note)) C.pressedByUser.add(note);
        if (!arp.heldNotes.includes(note)) {
            arp.heldNotes.push(note);
            arp.heldNotes.sort((a, b) => CthulhuConfig.noteToMidi(a) - CthulhuConfig.noteToMidi(b));
        }
        this.updateHeldDisplay();
        this.startArp();
    },

    handleNoteOff(note) {
        const C = SynthState.cthulhu;
        const arp = C.arp;
        C.pressedByUser.delete(note);

        if (arp.latch) {
            if (C.pressedByUser.size === 0) C.pendingLatchReset = true;
            this.updateHeldDisplay();
            return;
        }
        const idx = arp.heldNotes.indexOf(note);
        if (idx >= 0) arp.heldNotes.splice(idx, 1);

        this.updateHeldDisplay();
        if (arp.heldNotes.length === 0) {
            this.stopArp();
        }
    },

    updateHeldDisplay() {
        const el = document.getElementById('cthulhuHeldDisplay');
        if (!el) return;
        const arp = SynthState.cthulhu.arp;
        if (arp.heldNotes.length === 0) {
            el.textContent = '—';
            el.classList.remove('cthulhu-held-display-active');
        } else {
            el.textContent = arp.heldNotes.join('  ');
            el.classList.add('cthulhu-held-display-active');
        }
        // Also indicate latch state visually
        el.classList.toggle('cthulhu-held-display-latched', arp.latch && SynthState.cthulhu.pressedByUser.size === 0 && arp.heldNotes.length > 0);
    },

    // ── Arp scheduler (setTimeout chain so we can do swing) ──
    startArp() {
        const arp = SynthState.cthulhu.arp;
        if (arp.timeoutId) return; // already running
        arp.currentStep = 0;
        // 15ms "chord gather window" — when the user presses a chord, the keydown
        // events arrive sequentially over ~5-15ms. Deferring the first tick lets
        // all simultaneously-pressed keys land in heldNotes before step 1 plays.
        this.tickArp(15);
    },

    stopArp() {
        const arp = SynthState.cthulhu.arp;
        if (arp.timeoutId) {
            clearTimeout(arp.timeoutId);
            arp.timeoutId = null;
        }
        arp.activeNotes.forEach(n => Voice.release(n, true));
        arp.activeNotes.clear();
        this.clearStepHighlight();
    },

    tickArp(delay) {
        const arp = SynthState.cthulhu.arp;
        arp.timeoutId = setTimeout(() => {
            if (arp.heldNotes.length === 0) {
                this.stopArp();
                return;
            }
            this.playStep(arp.currentStep);
            const stepMs = this.calculateStepMs();
            const swing = arp.swing;
            const isOdd = (arp.currentStep % 2 === 1);
            const nextDelay = isOdd ? stepMs * (1 - swing) : stepMs * (1 + swing);
            arp.currentStep = (arp.currentStep + 1) % arp.length;
            this.tickArp(nextDelay);
        }, delay);
    },

    calculateStepMs() {
        const arp = SynthState.cthulhu.arp;
        const stepsPerBar = CthulhuConfig.RATE_MAP[arp.rate] || 16;
        return (60000 / arp.bpm) * 4 / stepsPerBar;
    },

    playStep(idx) {
        const arp = SynthState.cthulhu.arp;
        this.highlightStep(idx);
        const step = arp.steps[idx];
        if (!step || step.tones.length === 0) return;
        if (arp.heldNotes.length === 0) return;

        // Resolve tone indices into note names
        const notesToPlay = [];
        step.tones.forEach(tone => {
            if (tone === 'rand') {
                const r = Math.floor(Math.random() * arp.heldNotes.length);
                notesToPlay.push(arp.heldNotes[r]);
            } else {
                const n = arp.heldNotes.length;
                const toneIdx = tone - 1;
                const wrapped = ((toneIdx % n) + n) % n;
                // Wrap past the chord size into higher octaves, but never
                // more than +2 — tone 6 over a single held note must not
                // end up 5 octaves up in dog-whistle territory
                const octWrap = Math.min(2, Math.floor(toneIdx / n));
                const baseNote = arp.heldNotes[wrapped];
                if (baseNote) notesToPlay.push(CthulhuConfig.shiftOctave(baseNote, octWrap));
            }
        });
        // Apply per-step octave shift
        const finalNotes = step.octave
            ? notesToPlay.map(n => CthulhuConfig.shiftOctave(n, step.octave))
            : notesToPlay;
        if (finalNotes.length === 0) return;

        // Release prior arp notes
        arp.activeNotes.forEach(n => Voice.release(n, true));
        arp.activeNotes.clear();

        // Strum
        const strum = arp.strum;
        const order = strum >= 0 ? finalNotes : [...finalNotes].reverse();
        const strumStep = Math.abs(strum);
        order.forEach((n, i) => {
            const delay = strumStep * i;
            if (delay === 0) {
                Voice.play(n, true, step.velocity);
                arp.activeNotes.add(n);
            } else {
                setTimeout(() => {
                    // Only play if we haven't been stopped in the meantime
                    if (arp.timeoutId === null && !arp.heldNotes.length) return;
                    Voice.play(n, true, step.velocity);
                    arp.activeNotes.add(n);
                }, delay);
            }
        });

        // Gate-based release
        const stepMs = this.calculateStepMs();
        const gateMs = Math.max(20, stepMs * step.gate);
        const playedSnapshot = [...finalNotes];
        setTimeout(() => {
            playedSnapshot.forEach(n => {
                if (arp.activeNotes.has(n)) {
                    Voice.release(n, true);
                    arp.activeNotes.delete(n);
                }
            });
        }, gateMs);
    },

    highlightStep(idx) {
        const cells = document.querySelectorAll('.cthulhu-step-number');
        cells.forEach((c, i) => c.classList.toggle('cthulhu-step-number-playing', i === idx));
        document.querySelectorAll('.cthulhu-grid-cell').forEach(c => {
            c.classList.toggle('cthulhu-grid-cell-column-playing', parseInt(c.dataset.step, 10) === idx);
        });
    },
    clearStepHighlight() {
        document.querySelectorAll('.cthulhu-step-number-playing').forEach(c => c.classList.remove('cthulhu-step-number-playing'));
        document.querySelectorAll('.cthulhu-grid-cell-column-playing').forEach(c => c.classList.remove('cthulhu-grid-cell-column-playing'));
    },

    panic() {
        const C = SynthState.cthulhu;
        this.stopArp();
        C.pressedByUser.clear();
        C.arp.heldNotes = [];
        C.pendingLatchReset = false;
        // Force-release any leftover voices
        Object.keys(SynthState.activeVoices).forEach(n => Voice.release(n, true));
        SynthState.activeNotes.clear();
        document.querySelectorAll('#piano .key.active').forEach(k => k.classList.remove('active'));
        this.updateHeldDisplay();
    },

    snapshot() {
        const C = SynthState.cthulhu;
        return {
            enabled: C.enabled,
            arp: {
                latch: C.arp.latch,
                bpm: C.arp.bpm,
                rate: C.arp.rate,
                length: C.arp.length,
                swing: C.arp.swing,
                strum: C.arp.strum,
                steps: C.arp.steps.map(s => ({
                    tones: [...s.tones],
                    octave: s.octave,
                    velocity: s.velocity,
                    gate: s.gate
                }))
            }
        };
    },
    restore(snap) {
        if (!snap) return;
        const C = SynthState.cthulhu;
        this.stopArp();
        if (snap.arp) {
            C.arp.latch = !!snap.arp.latch;
            C.arp.bpm = Tempo.bpm;
            C.arp.rate = snap.arp.rate || '1/16';
            C.arp.length = snap.arp.length || 16;
            C.arp.swing = snap.arp.swing || 0;
            C.arp.strum = snap.arp.strum || 0;
            if (Array.isArray(snap.arp.steps)) {
                C.arp.steps = snap.arp.steps.map(s => ({
                    tones: Array.isArray(s.tones) ? [...s.tones] : [],
                    octave: s.octave || 0,
                    velocity: typeof s.velocity === 'number' ? s.velocity : 1.0,
                    gate: typeof s.gate === 'number' ? s.gate : 0.85
                }));
                while (C.arp.steps.length < CthulhuConfig.STEPS) {
                    C.arp.steps.push({ tones: [], octave: 0, velocity: 1.0, gate: 0.85 });
                }
            }
        }
        C.enabled = !!snap.enabled;
        this.syncControlsFromState();
        // Restored state came from a synth preset, not the pattern list
        const patSel = document.getElementById('cthulhuPresetSelect');
        if (patSel) patSel.value = '';
        this.renderGrid();
    },

    syncControlsFromState() {
        const C = SynthState.cthulhu;
        const set = (id, val, prop = 'value') => {
            const el = document.getElementById(id);
            if (el) el[prop] = val;
        };
        set('cthulhuEnable', C.enabled, 'checked');
        set('cthulhuArpLatch', C.arp.latch, 'checked');
        set('cthulhuArpBpm', C.arp.bpm);
        set('cthulhuArpRate', C.arp.rate);
        set('cthulhuArpLength', C.arp.length);
        set('cthulhuArpSwing', Math.round(C.arp.swing * 100));
        set('cthulhuArpStrum', C.arp.strum);
        const sw = document.getElementById('cthulhuArpSwingVal');
        if (sw) sw.textContent = Math.round(C.arp.swing * 100) + '%';
        const st = document.getElementById('cthulhuArpStrumVal');
        if (st) st.textContent = C.arp.strum + 'ms';
        this.refreshCthulhuButton();
    },

    refreshCthulhuButton() {
        const btn = document.getElementById('cthulhuButton');
        if (!btn) return;
        btn.classList.toggle('cthulhu-active', SynthState.cthulhu.enabled);
    },

    setupListeners() {
        // Open / close
        document.getElementById('cthulhuButton').addEventListener('click', () => this.open());
        document.getElementById('closeCthulhu').addEventListener('click', () => this.close());
        document.getElementById('cthulhuModal').addEventListener('click', (e) => {
            if (e.target.id === 'cthulhuModal') this.close();
        });

        // Master enable
        document.getElementById('cthulhuEnable').addEventListener('change', (e) => {
            SynthState.cthulhu.enabled = e.target.checked;
            if (!SynthState.cthulhu.enabled) {
                this.panic();
            } else {
                // Disable the legacy arp to avoid double-triggering
                if (SynthState.controls.arpToggle && SynthState.controls.arpToggle.checked) {
                    SynthState.controls.arpToggle.checked = false;
                    SynthState.controls.arpToggle.dispatchEvent(new Event('change'));
                }
            }
            this.refreshCthulhuButton();
        });

        document.getElementById('cthulhuArpLatch').addEventListener('change', (e) => {
            SynthState.cthulhu.arp.latch = e.target.checked;
            if (!e.target.checked && SynthState.cthulhu.pressedByUser.size === 0) {
                // un-latching with no keys pressed: clear and stop
                SynthState.cthulhu.arp.heldNotes = [];
                this.stopArp();
            }
            this.updateHeldDisplay();
        });
        document.getElementById('cthulhuArpBpm').addEventListener('change', (e) => {
            let v = parseInt(e.target.value, 10);
            if (isNaN(v) || v < 40) v = 40;
            if (v > 300) v = 300;
            e.target.value = v;
            Tempo.set(v); // Cthulhu BPM is the global BPM
        });
        document.getElementById('cthulhuArpRate').addEventListener('change', (e) => {
            SynthState.cthulhu.arp.rate = e.target.value;
        });
        document.getElementById('cthulhuArpLength').addEventListener('change', (e) => {
            let v = parseInt(e.target.value, 10);
            if (isNaN(v) || v < 1) v = 1;
            if (v > 16) v = 16;
            e.target.value = v;
            SynthState.cthulhu.arp.length = v;
            this.renderGrid();
        });
        document.getElementById('cthulhuArpSwing').addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            SynthState.cthulhu.arp.swing = v / 100;
            document.getElementById('cthulhuArpSwingVal').textContent = v + '%';
        });
        document.getElementById('cthulhuArpStrum').addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            SynthState.cthulhu.arp.strum = v;
            document.getElementById('cthulhuArpStrumVal').textContent = v + 'ms';
        });

        // Pattern preset buttons (only Up + Clear)
        document.querySelectorAll('.cthulhu-pat-btn').forEach(btn => {
            btn.addEventListener('click', () => this.applyPattern(btn.dataset.pat));
        });

        // Pattern preset select
        document.getElementById('cthulhuPresetSelect').addEventListener('change', (e) => {
            if (e.target.value) this.applyPreset(e.target.value);
        });

        // Panic button — also useful for the user when something gets stuck
        document.getElementById('cthulhuPanic').addEventListener('click', () => this.panic());

        // Window blur — let go of all keys (browser stops sending keyup if focus lost)
        window.addEventListener('blur', () => {
            if (SynthState.cthulhu.enabled) this.panic();
        });
    }
};

// ─────────────────────────────────────────────────────────────
//  TRANCE GATE — 16-step rhythmic volume gate synced to BPM
// ─────────────────────────────────────────────────────────────
const TranceGate = {
    patterns: {
        'Eighth pulse': [1,1,0,0, 1,1,0,0, 1,1,0,0, 1,1,0,0],
        'Offbeat': [0,0,1,1, 0,0,1,1, 0,0,1,1, 0,0,1,1],
        'Trance skip': [1,1,0,1, 0,0,1,1, 1,0,1,0, 1,1,0,0],
        'Sixteenths': [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
        'Half-time': [1,1,1,1, 0,0,0,0, 1,1,1,1, 0,0,0,0]
    },
    pattern: [1,1,0,0, 1,1,0,0, 1,1,0,0, 1,1,0,0],
    cells: [],
    step: 0,
    timer: null,
    nextStepTime: 0,
    lastTarget: 1,
    generation: 0,

    init() {
        const select = document.getElementById('gatePreset');
        if (select && !select.options.length) {
            Object.keys(this.patterns).forEach(name => select.add(new Option(name, name)));
            select.add(new Option('Custom', 'custom'));
            select.lastElementChild.disabled = true;
            select.addEventListener('change', () => {
                if (this.patterns[select.value]) this.restore({ pattern: this.patterns[select.value] });
            });
        }
        this.renderPattern();
    },

    syncPreset() {
        const select = document.getElementById('gatePreset');
        if (select) select.value = Object.keys(this.patterns).find(name =>
            this.patterns[name].every((value, i) => value === this.pattern[i])) || 'custom';
    },

    renderPattern() {
        const wrap = document.getElementById('gatePattern');
        if (!wrap) return;
        wrap.innerHTML = '';
        this.cells = [];
        this.pattern.forEach((on, i) => {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.setAttribute('aria-label', 'Gate step ' + (i + 1));
            cell.setAttribute('aria-pressed', String(!!on));
            cell.className = 'gate-step' + (on ? ' gate-step-on' : '');
            cell.title = 'Step ' + (i + 1);
            cell.addEventListener('click', () => {
                this.pattern[i] = this.pattern[i] ? 0 : 1;
                cell.classList.toggle('gate-step-on', !!this.pattern[i]);
                cell.setAttribute('aria-pressed', String(!!this.pattern[i]));
                this.syncPreset();
                document.getElementById('dirtyBadge').hidden = false;
            });
            wrap.appendChild(cell);
            this.cells.push(cell);
        });
        this.syncPreset();
    },

    setEnabled(on) {
        if (on) this.start();
        else this.stop();
    },

    start() {
        if (!Synth.audioContext || !Synth.gateGain || this.timer) return;
        this.step = 0;
        this.generation++;
        this.lastTarget = 1;
        this.nextStepTime = Synth.audioContext.currentTime + 0.02;
        this.timer = setInterval(() => this.schedule(), 25);
        this.schedule();
    },

    stop() {
        this.generation++;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (Synth.audioContext && Synth.gateGain) {
            const now = Synth.audioContext.currentTime;
            Synth.gateGain.gain.cancelScheduledValues(now);
            Synth.gateGain.gain.setTargetAtTime(1, now, 0.01);
        }
        this.clearHighlight();
    },

    stepSec() {
        const rate = SynthState.controls.gateRate ? SynthState.controls.gateRate.value : '1/16';
        const stepsPerBar = { '1/8': 8, '1/16': 16, '1/32': 32 }[rate] || 16;
        return Tempo.barSec() / stepsPerBar;
    },

    // Lookahead scheduler ("tale of two clocks"): timer wakes every 25ms
    // and schedules gain automation up to 120ms ahead on the audio clock.
    schedule() {
        const ctx = Synth.audioContext;
        // Skip missed steps after throttling instead of queuing old automation.
        if (this.nextStepTime < ctx.currentTime) {
            const missed = Math.ceil((ctx.currentTime - this.nextStepTime) / this.stepSec());
            this.step = (this.step + missed) % this.pattern.length;
            this.nextStepTime += missed * this.stepSec();
        }
        while (this.nextStepTime < ctx.currentTime + 0.12) {
            const idx = this.step;
            const t = this.nextStepTime;
            this.scheduleStep(idx, t);

            const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
            const generation = this.generation;
            setTimeout(() => { if (this.timer && generation === this.generation) this.highlight(idx); }, delayMs);

            this.step = (this.step + 1) % this.pattern.length;
            this.nextStepTime += this.stepSec();
        }
    },

    scheduleStep(index, time) {
        const depth = Math.max(0, Math.min(1, Number(SynthState.controls.gateDepth.value)));
        const smooth = Math.min(this.stepSec() * 0.45,
            Math.max(0.001, Number(SynthState.controls.gateSmooth.value)));
        const target = this.pattern[index] ? 1 : 1 - depth;
        const gain = Synth.gateGain.gain;
        gain.setValueAtTime(this.lastTarget, time);
        gain.linearRampToValueAtTime(target, time + smooth);
        this.lastTarget = target;
    },

    highlight(idx) {
        this.cells.forEach((c, i) => c.classList.toggle('gate-step-playing', i === idx));
    },
    clearHighlight() {
        this.cells.forEach(c => c.classList.remove('gate-step-playing'));
    },

    snapshot() {
        return { pattern: [...this.pattern] };
    },
    restore(snap) {
        if (snap && Array.isArray(snap.pattern) && snap.pattern.length === this.pattern.length) {
            this.pattern = snap.pattern.map(v => (v ? 1 : 0));
            this.renderPattern();
        }
    }
};

// ─────────────────────────────────────────────────────────────
//  BEAT CLOCK — drives the sidechain pump and the kick generator,
//  one pulse per beat, synced to the global BPM
// ─────────────────────────────────────────────────────────────
const BeatClock = {
    timer: null,
    nextBeatTime: 0,

    update() {
        const c = SynthState.controls;
        const needed = (c.sidechainToggle && c.sidechainToggle.checked) ||
            (c.kickToggle && c.kickToggle.checked);
        if (needed) this.start();
        else this.stop();
    },

    start() {
        if (!Synth.audioContext || !Synth.sidechainGain || this.timer) return;
        this.nextBeatTime = Synth.audioContext.currentTime + 0.05;
        this.timer = setInterval(() => this.schedule(), 25);
    },

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (Synth.audioContext && Synth.sidechainGain) {
            const now = Synth.audioContext.currentTime;
            Synth.sidechainGain.gain.cancelScheduledValues(now);
            Synth.sidechainGain.gain.setTargetAtTime(1, now, 0.02);
        }
    },

    schedule() {
        const ctx = Synth.audioContext;
        const c = SynthState.controls;
        while (this.nextBeatTime < ctx.currentTime + 0.12) {
            const t = this.nextBeatTime;
            const beat = Tempo.beatSec();
            if (c.sidechainToggle.checked) {
                const amount = parseFloat(c.sidechainAmount.value);
                // Slam shut, hold at the bottom, then swoop back up late —
                // exponential rise from near-zero stays low most of the way
                // and jumps at the end, which is the classic hard pump.
                const dip = Math.max(0.001, 1 - amount);
                const hold = beat * 0.15;
                const rise = Math.max(0.05, Math.min(parseFloat(c.sidechainRelease.value), beat - hold - 0.02));
                const g = Synth.sidechainGain.gain;
                g.setValueAtTime(1, t);
                g.linearRampToValueAtTime(dip, t + 0.008);
                g.setValueAtTime(dip, t + hold);
                g.exponentialRampToValueAtTime(1, t + hold + rise);
            }
            if (c.kickToggle.checked) {
                Synth.triggerKick(t);
            }
            this.nextBeatTime += beat;
        }
    }
};

// UI related functions
const UI = {
    createPiano() {
        const piano = document.getElementById('piano');
        piano.innerHTML = '';
        for (let octave = 1; octave < 7; octave++) {
            SynthConfig.whiteNotes.forEach(note => {
                const key = document.createElement('div');
                key.className = 'key';
                key.dataset.note = note + octave;
                piano.appendChild(key);
            });
        }

        const whiteKeys = piano.querySelectorAll('.key');
        let blackKeyIndex = 0;
        whiteKeys.forEach((whiteKey, index) => {
            if (index % 7 !== 2 && index % 7 !== 6) {
                const blackKey = document.createElement('div');
                blackKey.className = 'key black';
                blackKey.dataset.note = SynthConfig.blackNotes[blackKeyIndex % 5] + (Math.floor(index / 7) + 1);
                whiteKey.parentNode.insertBefore(blackKey, whiteKey.nextSibling);
                blackKeyIndex++;
            }
        });
    },

    updateCircularControls() {
        document.querySelectorAll('.circular-control input[type="range"]').forEach(input => {
            const value = parseFloat(input.value);
            const min = parseFloat(input.min);
            const max = parseFloat(input.max);
            const normalizedValue = (value - min) / (max - min);
            const rotation = normalizedValue * 270 - 135; // Map 0-1 to -135deg to 135deg
            input.parentNode.style.setProperty('--rotation', `${rotation}deg`);

            // Update value display
            const valueSpan = input.parentNode.querySelector('.knob-value');
            if (valueSpan) {
                const unit = input.parentNode.dataset.unit || '';
                const format = input.parentNode.dataset.format || '';
                valueSpan.textContent = Util.formatValue(value, unit, format);
            }
        });
    },

    handleCircularControlInteraction(event) {
        const control = event.currentTarget;
        const input = control.querySelector('input[type="range"]');
        let startY, startValue;

        function handleStart(e) {
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            startValue = parseFloat(input.value);
            document.addEventListener('mousemove', handleMove);
            document.addEventListener('touchmove', handleMove, { passive: false });
            document.addEventListener('mouseup', handleEnd);
            document.addEventListener('touchend', handleEnd);
        }

        function handleMove(e) {
            const currentY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const deltaY = startY - currentY;
            const range = input.max - input.min;
            const valueChange = (deltaY / 100) * range;
            let newValue = Math.max(input.min, Math.min(input.max, startValue + valueChange));

            input.value = newValue;
            Synth.updateParams();
            input.dispatchEvent(new Event('input'));
            e.preventDefault();
        }

        function handleEnd() {
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('touchmove', handleMove);
            document.removeEventListener('mouseup', handleEnd);
            document.removeEventListener('touchend', handleEnd);
        }

        if (event.type === 'mousedown') {
            handleStart(event);
        } else if (event.type === 'touchstart') {
            handleStart(event);
        }
    },
    initializeEventListeners() {
        // Control event listeners
        Object.entries(SynthState.controls).forEach(([key, control]) => {
            if (!control || !control.addEventListener) return;
            if (control.tagName === 'BUTTON' || control.type === 'file') return;
            if (control.type === 'checkbox' || control.tagName === 'SELECT') {
                control.addEventListener('change', () => Synth.updateParams(key));
            } else {
                control.addEventListener('input', () => Synth.updateParams(key));
            }
        });

        // Arpeggiator controls
        SynthState.controls.arpToggle.addEventListener('change', (e) => {
            SynthState.arpeggiator.isOn = e.target.checked;
            if (SynthState.arpeggiator.isOn) {
                if (SynthState.arpeggiator.notes.length > 0) {
                    Arpeggiator.start();
                }
            } else {
                Arpeggiator.stop();
            }
        });

        SynthState.controls.arpSpeed.addEventListener('input', () => Arpeggiator.updateSpeed());
        SynthState.controls.arpClock.addEventListener('change', () => Arpeggiator.updateSpeed());
        SynthState.controls.arpPattern.addEventListener('change', () => {
            SynthState.arpeggiator.pattern = SynthState.controls.arpPattern.value;
            Arpeggiator.updateSpeed();
        });

        SynthState.controls.pitchBendWheel.addEventListener('mouseup', (e) => {
            e.target.value = 0;
            Synth.updatePitchBend(0);
        });

        SynthState.controls.pitchBendWheel.addEventListener('touchend', (e) => {
            e.target.value = 0;
            Synth.updatePitchBend(0);
        });

        SynthState.controls.whiteKeysOnlyToggle.addEventListener('change', (e) => {
            SynthState.whiteKeysOnly = e.target.checked;
        });

        SynthState.controls.octaveShift = document.getElementById('octaveShift');
        SynthState.controls.octaveShift.addEventListener('change', (e) => {
            Voice.stopAllNotes();
            SynthState.octaveShift = parseInt(e.target.value, 10) || 0;
        });

        // Performance keys and accessible knob gestures are handled by Studio.
        window.addEventListener('resize', () => Synth.updateVisualizer());

        const toggleVisualizerButton = document.getElementById('toggleVisualizer');
        toggleVisualizerButton.addEventListener('click', () => Synth.toggleVisualizer());

        // Visualizer mode selector
        document.getElementById('visualizerMode').addEventListener('change', (e) => {
            Synth.visualizerMode = e.target.value;
        });

        // Initialize Preset controls
        PresetManager.updatePresetSelect();

        document.getElementById('presetSelect').addEventListener('change', (e) => {
            const value = e.target.value;
            if (!value) return;

            const [type, name] = value.split(':');
            let settings;

            if (type === 'factory') {
                settings = PresetManager.getFactoryPresets()[name];
            } else {
                settings = PresetManager.loadPreset(name);
            }

            if (settings) {
                PresetManager.applySettings(settings);
            }
        });

        // MIDI enable button (opt-in, no auto-request)
        document.getElementById('midiEnableButton').addEventListener('click', () => {
            MIDIHandler.init();
        });

        // Equal divisions are generated locally, so tuning works offline.
        SynthState.controls.tuningPreset.addEventListener('change', (e) => {
            const divisions = parseInt(e.target.value, 10);
            TuningSystem.divisions = divisions || 12;
            TuningSystem.resetToDefaultTuning();
            TuningSystem.refreshActiveVoices();
        });
    }
};

// Main Synth object
const Synth = {
    recorder: null,
    recordedChunks: [],
    recordedNotes: [],
    recordingStartTime: 0,
    audioContext: null,
    compressor: null,
    playbackAudio: null,
    playbackSource: null,
    masterReverb: null,
    pingPong: null,
    chorus: null,
    drive: null,
    gateGain: null,
    sidechainGain: null,
    kickBus: null,
    masterLowEQ: null,
    masterMidEQ: null,
    masterHighEQ: null,
    visualizerEnabled: true,
    visualizerMode: 'lissajous',
    visualizerToken: 0,

    initialize() {
        // Show piano immediately behind modal
        UI.createPiano();

        const startButton = document.getElementById('startButton');
        const startModal = document.getElementById('startModal');

        startButton.addEventListener('click', () => {
            this.initAudioContext();
            startModal.style.display = 'none';
            this.start();
        });

        document.getElementById('recordButton').addEventListener('click', () => this.startRecording());
        document.getElementById('stopButton').addEventListener('click', () => this.stopRecording());
        document.getElementById('saveButton').addEventListener('click', () => this.saveRecording());
        document.getElementById('loadButton').addEventListener('click', () => this.loadRecording());
        document.getElementById('playButton').addEventListener('click', () => this.playRecording());
        document.getElementById('exportWavButton').addEventListener('click', () => this.exportWav());
    },
    start() {
        // Initialize all controls
        SynthState.controls = {
            synthMode: document.getElementById('synthMode'),
            instrumentType: document.getElementById('instrumentType'),
            instrumentTone: document.getElementById('instrumentTone'),
            whiteKeysOnlyToggle: document.getElementById('whiteKeysOnlyToggle'),
            globalBpm: document.getElementById('globalBpm'),
            masterVolume: document.getElementById('masterVolume'),
            masterReverb: document.getElementById('masterReverb'),
            masterDelay: document.getElementById('masterDelay'),
            delayDivision: document.getElementById('delayDivision'),
            delayFeedback: document.getElementById('delayFeedback'),
            chorusAmount: document.getElementById('chorusAmount'),
            driveAmount: document.getElementById('driveAmount'),
            stereoSpread: document.getElementById('stereoSpread'),
            unisonBlend: document.getElementById('unisonBlend'),
            glideTime: document.getElementById('glideTime'),
            gateToggle: document.getElementById('gateToggle'),
            gateRate: document.getElementById('gateRate'),
            gateDepth: document.getElementById('gateDepth'),
            gateSmooth: document.getElementById('gateSmooth'),
            sidechainToggle: document.getElementById('sidechainToggle'),
            sidechainAmount: document.getElementById('sidechainAmount'),
            sidechainRelease: document.getElementById('sidechainRelease'),
            kickToggle: document.getElementById('kickToggle'),
            kickLevel: document.getElementById('kickLevel'),
            masterLowEQ: document.getElementById('masterLowEQ'),
            masterMidEQ: document.getElementById('masterMidEQ'),
            masterHighEQ: document.getElementById('masterHighEQ'),
            waveform: document.getElementById('waveform'),
            unison: document.getElementById('unison'),
            detune: document.getElementById('detune'),
            fmAmount: document.getElementById('fmAmount'),
            filterToggle: document.getElementById('filterToggle'),
            filterType: document.getElementById('filterType'),
            filterCutoff: document.getElementById('filterCutoff'),
            filterResonance: document.getElementById('filterResonance'),
            filterEnvAmount: document.getElementById('filterEnvAmount'),
            attack: document.getElementById('attack'),
            decay: document.getElementById('decay'),
            sustain: document.getElementById('sustain'),
            release: document.getElementById('release'),
            lfoRate: document.getElementById('lfoRate'),
            lfoAmount: document.getElementById('lfoAmount'),
            noiseAmount: document.getElementById('noiseAmount'),
            arpToggle: document.getElementById('arpToggle'),
            arpPattern: document.getElementById('arpPattern'),
            arpSpeed: document.getElementById('arpSpeed'),
            arpClock: document.getElementById('arpClock'),
            fmToggle: document.getElementById('fmToggle'),
            lfoToggle: document.getElementById('lfoToggle'),
            noiseToggle: document.getElementById('noiseToggle'),
            pitchBendWheel: document.getElementById('pitchBendWheel'),
            pitchBendRange: document.getElementById('pitchBendRange'),
            tuningPreset: document.getElementById('tuningPreset'),
            tuningFile: document.getElementById('tuningFile'),
            applyTuning: document.getElementById('applyTuning'),
            resetTuning: document.getElementById('resetTuning')
        };

        // Set initial states
        SynthState.controls.fmToggle.checked = SynthState.fmEnabled;
        SynthState.controls.lfoToggle.checked = SynthState.lfoEnabled;
        SynthState.controls.noiseToggle.checked = SynthState.noiseEnabled;
        SynthState.controls.applyTuning.disabled = true;

        // Setup tuning file handler
        SynthState.controls.tuningFile.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) {
                SynthState.controls.applyTuning.disabled = true;
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                loadedTuningContent = e.target.result;
                SynthState.controls.applyTuning.disabled = false;
            };
            reader.onerror = (e) => {
                console.error('Error reading file:', e);
                SynthState.controls.applyTuning.disabled = true;
            };
            reader.readAsText(file);
        });

        // Setup apply tuning handler
        SynthState.controls.applyTuning.addEventListener('click', () => {
            if (!loadedTuningContent) return;

            const frequencies = TuningSystem.parseTunFile(loadedTuningContent);
            if (!frequencies) {
                console.error('Failed to parse frequencies from file');
                return;
            }

            TuningSystem.importTuning(frequencies);
            TuningSystem.refreshActiveVoices();
        });

        // Setup reset tuning handler
        SynthState.controls.resetTuning.addEventListener('click', () => {
            TuningSystem.resetToDefaultTuning();
            loadedTuningContent = null;
            SynthState.controls.applyTuning.disabled = true;
            SynthState.controls.tuningFile.value = '';
            TuningSystem.refreshActiveVoices();
        });

        // Setup pitch bend range controls
        if (SynthState.controls.pitchBendRange === null) {
            console.error('pitchBendRange element not found');
        } else {
            // Initialize pitch bend range
            this.updatePitchBendRange(parseInt(SynthState.controls.pitchBendRange.value) || 2);
        }

        // Setup range increment/decrement controls
        document.getElementById('incrementRange').addEventListener('click', () => this.incrementPitchBendRange());
        document.getElementById('decrementRange').addEventListener('click', () => this.decrementPitchBendRange());

        // Setup initial control states
        Tempo.set(SynthState.controls.globalBpm.value);
        this.updateMasterVolume();
        this.updateMasterReverb();
        this.updateMasterDelay();
        this.updateMasterEQ();
        this.updateChorus();
        this.updateDrive();

        // Initialize the trance gate pattern UI
        TranceGate.init();

        // Initialize UI (piano was already created behind the start modal)
        UI.initializeEventListeners();
        this.updateVisualizer();
        this.updateParams();

        // Initialize Wavetable Editor
        WavetableEditor.init();
        WavetableEditor.apply(); // Apply default wavetable

        // Initialize Cthulhu (chord trigger + step arp)
        Cthulhu.init();
        Cthulhu.syncControlsFromState();

        // Synth mode change handler - show/hide wavetable controls
        SynthState.controls.synthMode.addEventListener('change', (e) => {
            const mode = e.target.value;
            document.getElementById('waveformControl').style.display = mode === 'waveform' ? 'block' : 'none';
            document.getElementById('wavetableControls').style.display = mode === 'wavetable' ? 'block' : 'none';
        });

        // Wavetable position change handler
        const wavetablePositionControl = document.getElementById('wavetablePosition');
        if (wavetablePositionControl) {
            wavetablePositionControl.addEventListener('input', (e) => {
                SynthState.wavetable.position = parseFloat(e.target.value);
                WavetableEditor.updatePeriodicWave();
                // Update active voices with new wavetable
                Object.values(SynthState.activeVoices).forEach(voice => {
                    if (voice.updateVoice) voice.updateVoice();
                });
            });
        }
    },
    initAudioContext(context) {
        this.audioContext = context || new (window.AudioContext || window.webkitAudioContext)();
        this.masterGainNode = this.audioContext.createGain();
        this.masterGainNode.gain.setValueAtTime(0.7, this.audioContext.currentTime);

        this.masterReverb = this.createReverbEffect();
        this.pingPong = this.createPingPongDelay();
        this.drive = this.createDriveStage();
        this.chorus = this.createChorusEffect();
        this.masterLowEQ = this.audioContext.createBiquadFilter();
        this.masterMidEQ = this.audioContext.createBiquadFilter();
        this.masterHighEQ = this.audioContext.createBiquadFilter();

        this.compressor = this.audioContext.createDynamicsCompressor();
        this.compressor.threshold.setValueAtTime(-12, this.audioContext.currentTime);
        this.compressor.knee.setValueAtTime(30, this.audioContext.currentTime);
        this.compressor.ratio.setValueAtTime(3, this.audioContext.currentTime);
        this.compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
        this.compressor.release.setValueAtTime(0.25, this.audioContext.currentTime);

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;

        // Trance gate chops the synth pre-effects; sidechain pumps the
        // whole mix (reverb/delay tails included) at the end of the chain.
        this.gateGain = this.audioContext.createGain();
        this.sidechainGain = this.audioContext.createGain();
        // Kick joins after the sidechain so it isn't ducked by its own pump
        this.kickBus = this.audioContext.createGain();
        this.kickShaper = this.audioContext.createWaveShaper();
        {
            const n = 1024;
            const curve = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const x = (i / (n - 1)) * 2 - 1;
                curve[i] = Math.tanh(2 * x) / Math.tanh(2);
            }
            this.kickShaper.curve = curve;
            this.kickShaper.oversample = '2x';
        }
        this.kickShaper.connect(this.kickBus);
        this.kickNoiseBuffer = Util.createNoiseBuffer();

        // Create dry/wet gains for reverb and delay
        this.reverbDry = this.audioContext.createGain();
        this.reverbWet = this.audioContext.createGain();
        this.delayBus = this.audioContext.createGain();
        this.delayDry = this.audioContext.createGain();
        this.delayWet = this.audioContext.createGain();

        // Connect the nodes:
        // compressor → EQ → gate → drive → chorus → reverb → ping-pong delay → sidechain → master
        this.compressor.connect(this.masterLowEQ);
        this.masterLowEQ.connect(this.masterMidEQ);
        this.masterMidEQ.connect(this.masterHighEQ);
        this.masterHighEQ.connect(this.gateGain);
        this.gateGain.connect(this.drive.input);
        this.drive.output.connect(this.chorus.input);
        this.chorus.output.connect(this.reverbDry);
        this.chorus.output.connect(this.reverbWet);
        this.reverbWet.connect(this.masterReverb);
        this.masterReverb.connect(this.delayBus);
        this.reverbDry.connect(this.delayBus);
        this.delayBus.connect(this.delayDry);
        this.delayDry.connect(this.sidechainGain);
        this.delayBus.connect(this.delayWet);
        this.delayWet.connect(this.pingPong.input);
        this.pingPong.output.connect(this.sidechainGain);
        this.sidechainGain.connect(this.masterGainNode);
        this.kickBus.connect(this.masterGainNode);
        this.outputLimiter = this.audioContext.createDynamicsCompressor();
        this.outputLimiter.threshold.value = -3;
        this.outputLimiter.knee.value = 0;
        this.outputLimiter.ratio.value = 20;
        this.outputLimiter.attack.value = 0.002;
        this.outputLimiter.release.value = 0.12;
        this.masterGainNode.connect(this.outputLimiter);
        this.outputLimiter.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);
        // Start the visualizer
        this.updateVisualizer();

        // Set up EQ filters
        this.masterLowEQ.type = 'lowshelf';
        this.masterLowEQ.frequency.value = 200;
        this.masterMidEQ.type = 'peaking';
        this.masterMidEQ.frequency.value = 1000;
        this.masterMidEQ.Q.value = 1;
        this.masterHighEQ.type = 'highshelf';
        this.masterHighEQ.frequency.value = 3000;

        // Initialize delay
        this.delayWet.gain.value = 0;
        this.delayDry.gain.value = 1;

        // Initialize reverb
        this.reverbWet.gain.value = 0;
        this.reverbDry.gain.value = 1;
    },

    createReverbEffect() {
        const reverbNode = this.audioContext.createConvolver();
        const length = this.audioContext.sampleRate * 4; // 4 seconds
        const impulse = this.audioContext.createBuffer(2, length, this.audioContext.sampleRate);
        const impulseL = impulse.getChannelData(0);
        const impulseR = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const t = i / this.audioContext.sampleRate;
            const decay = Math.exp(-t * 3); // Adjust decay rate
            impulseL[i] = (Math.random() * 2 - 1) * decay;
            impulseR[i] = (Math.random() * 2 - 1) * decay;
        }

        reverbNode.buffer = impulse;
        return reverbNode;
    },

    // Stereo ping-pong delay: echoes alternate left/right, with a highpass
    // in the feedback loop so the repeats don't pile up mud in the lows.
    createPingPongDelay() {
        const ctx = this.audioContext;
        const input = ctx.createGain();
        const delayL = ctx.createDelay(3.0);
        const delayR = ctx.createDelay(3.0);
        const feedback = ctx.createGain();
        const feedbackHP = ctx.createBiquadFilter();
        const panL = ctx.createStereoPanner();
        const panR = ctx.createStereoPanner();
        const output = ctx.createGain();

        delayL.delayTime.value = 0.326; // dotted 8th at 138 BPM
        delayR.delayTime.value = 0.326;
        feedback.gain.value = 0.45;
        feedbackHP.type = 'highpass';
        feedbackHP.frequency.value = 180;
        panL.pan.value = -0.85;
        panR.pan.value = 0.85;

        input.connect(delayL);
        delayL.connect(panL);
        panL.connect(output);
        delayL.connect(delayR);
        delayR.connect(panR);
        panR.connect(output);
        delayR.connect(feedback);
        feedback.connect(feedbackHP);
        feedbackHP.connect(delayL);

        return { input, output, delayL, delayR, feedback };
    },

    // Stereo chorus: two modulated delay lines panned apart, LFO phases inverted
    createChorusEffect() {
        const ctx = this.audioContext;
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const delayL = ctx.createDelay(0.1);
        const delayR = ctx.createDelay(0.1);
        const panL = ctx.createStereoPanner();
        const panR = ctx.createStereoPanner();
        const lfo = ctx.createOscillator();
        const depthL = ctx.createGain();
        const depthR = ctx.createGain();

        delayL.delayTime.value = 0.018;
        delayR.delayTime.value = 0.026;
        lfo.type = 'sine';
        lfo.frequency.value = 0.6;
        depthL.gain.value = 0.004;
        depthR.gain.value = -0.005;
        panL.pan.value = -0.7;
        panR.pan.value = 0.7;
        wet.gain.value = 0;
        dry.gain.value = 1;

        lfo.connect(depthL);
        depthL.connect(delayL.delayTime);
        lfo.connect(depthR);
        depthR.connect(delayR.delayTime);
        input.connect(dry);
        dry.connect(output);
        input.connect(delayL);
        delayL.connect(panL);
        panL.connect(wet);
        input.connect(delayR);
        delayR.connect(panR);
        panR.connect(wet);
        wet.connect(output);
        lfo.start();

        return { input, output, dry, wet };
    },

    // Soft-saturation drive: tanh waveshaper with variable pre-gain, dry/wet mixed
    createDriveStage() {
        const ctx = this.audioContext;
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const pre = ctx.createGain();
        const shaper = ctx.createWaveShaper();

        const n = 1024;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * 2 - 1;
            curve[i] = Math.tanh(3 * x) / Math.tanh(3);
        }
        shaper.curve = curve;
        shaper.oversample = '4x';

        pre.gain.value = 1;
        wet.gain.value = 0;
        dry.gain.value = 1;

        input.connect(dry);
        dry.connect(output);
        input.connect(pre);
        pre.connect(shaper);
        shaper.connect(wet);
        wet.connect(output);

        return { input, output, dry, wet, pre };
    },

    // Synthesized four-on-the-floor kick: saturated sine body with a
    // two-stage pitch drop, plus a short filtered-noise beater tick
    triggerKick(time) {
        const ctx = this.audioContext;
        const level = parseFloat(SynthState.controls.kickLevel.value) || 0;
        if (level <= 0) return;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(210, time);
        osc.frequency.exponentialRampToValueAtTime(58, time + 0.03);
        osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(level * 1.2, time + 0.004);
        gain.gain.exponentialRampToValueAtTime(level * 0.4, time + 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.45);

        const noise = ctx.createBufferSource();
        noise.buffer = this.kickNoiseBuffer;
        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.value = 4000;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(level * 0.5, time);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.012);

        osc.connect(gain);
        gain.connect(this.kickShaper); // saturation gives the body its weight
        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.kickBus);
        osc.start(time);
        osc.stop(time + 0.5);
        noise.start(time);
        noise.stop(time + 0.03);
    },

    incrementPitchBendRange() {
        const currentRange = parseInt(SynthState.controls.pitchBendRange.value) || 2;
        const newRange = Math.min(24, currentRange + 1); // Max range is 24 semitones
        SynthState.controls.pitchBendRange.value = newRange;
        this.updatePitchBendRange(newRange);
    },

    decrementPitchBendRange() {
        const currentRange = parseInt(SynthState.controls.pitchBendRange.value) || 2;
        const newRange = Math.max(1, currentRange - 1); // Min range is 1 semitone
        SynthState.controls.pitchBendRange.value = newRange;
        this.updatePitchBendRange(newRange);
    },

    updatePitchBendRange(range) {
        const clampedRange = Math.max(1, Math.min(24, range)); // Clamp range between 1 and 24 semitones
        Object.values(SynthState.activeVoices).forEach(voice => {
            if (!voice.pitchBend || !voice.updatePitchBend) return;
            voice.pitchBend.range = clampedRange;
            voice.updatePitchBend(voice.pitchBend.bend);
        });
    },

    updatePitchBend(bend) {
        Object.values(SynthState.activeVoices).forEach(voice => {
            if (voice.updatePitchBend) {
                voice.updatePitchBend(bend);
            }
        });
    },

    updateMasterReverb() {
        const reverbAmount = parseFloat(SynthState.controls.masterReverb.value);
        const dryAmount = Math.cos(reverbAmount * 0.5 * Math.PI);
        const wetAmount = Math.sin(reverbAmount * 0.5 * Math.PI);

        this.reverbWet.gain.setTargetAtTime(wetAmount, this.audioContext.currentTime, 0.01);
        this.reverbDry.gain.setTargetAtTime(dryAmount, this.audioContext.currentTime, 0.01);
    },

    updateMasterDelay() {
        const mix = parseFloat(SynthState.controls.masterDelay.value);
        const dryAmount = Math.cos(mix * 0.5 * Math.PI);
        const wetAmount = Math.sin(mix * 0.5 * Math.PI);

        this.delayWet.gain.setTargetAtTime(wetAmount, this.audioContext.currentTime, 0.01);
        this.delayDry.gain.setTargetAtTime(dryAmount, this.audioContext.currentTime, 0.01);

        const feedback = parseFloat(SynthState.controls.delayFeedback.value);
        this.pingPong.feedback.gain.setTargetAtTime(feedback, this.audioContext.currentTime, 0.01);

        this.updateDelayTime();
    },

    // Note divisions in beats: dotted 8th (0.75) is THE trance delay
    DELAY_DIV_BEATS: {
        '1/4': 1, '1/8': 0.5, '1/8D': 0.75, '1/8T': 1 / 3,
        '1/16': 0.25, '1/16D': 0.375, '1/16T': 1 / 6
    },

    updateDelayTime() {
        if (!this.pingPong) return;
        const div = SynthState.controls.delayDivision ? SynthState.controls.delayDivision.value : '1/8D';
        const beats = this.DELAY_DIV_BEATS[div] || 0.75;
        const t = Math.min(3, Tempo.beatSec() * beats);
        this.pingPong.delayL.delayTime.setTargetAtTime(t, this.audioContext.currentTime, 0.05);
        this.pingPong.delayR.delayTime.setTargetAtTime(t, this.audioContext.currentTime, 0.05);
    },

    updateChorus() {
        const amount = parseFloat(SynthState.controls.chorusAmount.value);
        const t = this.audioContext.currentTime;
        this.chorus.wet.gain.setTargetAtTime(Math.sin(amount * 0.5 * Math.PI), t, 0.01);
        this.chorus.dry.gain.setTargetAtTime(Math.cos(amount * 0.5 * Math.PI), t, 0.01);
    },

    updateDrive() {
        const amount = parseFloat(SynthState.controls.driveAmount.value);
        const t = this.audioContext.currentTime;
        this.drive.pre.gain.setTargetAtTime(1 + amount * 12, t, 0.01);
        // Wet tamed slightly as drive rises — tanh output sits near full scale
        this.drive.wet.gain.setTargetAtTime(Math.sin(amount * 0.5 * Math.PI) * (1 - amount * 0.35), t, 0.01);
        this.drive.dry.gain.setTargetAtTime(Math.cos(amount * 0.5 * Math.PI), t, 0.01);
    },

    updateMasterEQ() {
        const lowGain = parseFloat(SynthState.controls.masterLowEQ.value);
        const midGain = parseFloat(SynthState.controls.masterMidEQ.value);
        const highGain = parseFloat(SynthState.controls.masterHighEQ.value);

        this.masterLowEQ.gain.setTargetAtTime(lowGain, this.audioContext.currentTime, 0.01);
        this.masterMidEQ.gain.setTargetAtTime(midGain, this.audioContext.currentTime, 0.01);
        this.masterHighEQ.gain.setTargetAtTime(highGain, this.audioContext.currentTime, 0.01);
    },
    updateParams(changedParam) {
        if (changedParam === 'masterReverb') {
            this.updateMasterReverb();
        } else if (changedParam === 'masterDelay' || changedParam === 'delayDivision' || changedParam === 'delayFeedback') {
            this.updateMasterDelay();
        } else if (changedParam === 'globalBpm') {
            Tempo.set(SynthState.controls.globalBpm.value);
        } else if (changedParam === 'chorusAmount') {
            this.updateChorus();
        } else if (changedParam === 'driveAmount') {
            this.updateDrive();
        } else if (changedParam === 'gateToggle') {
            TranceGate.setEnabled(SynthState.controls.gateToggle.checked);
        } else if (changedParam === 'sidechainToggle' || changedParam === 'kickToggle') {
            BeatClock.update();
        } else if (changedParam === 'masterLowEQ' || changedParam === 'masterMidEQ' || changedParam === 'masterHighEQ') {
            this.updateMasterEQ();
        } else if (changedParam === 'pitchBendWheel') {
            this.updatePitchBend(parseFloat(SynthState.controls.pitchBendWheel.value));
        } else if (changedParam === 'pitchBendRange') {
            this.updatePitchBendRange(parseInt(SynthState.controls.pitchBendRange.value));
        } else if (changedParam === 'masterVolume') {
            this.updateMasterVolume();
        } else if (changedParam === 'unison' || changedParam === 'detune' || changedParam === 'waveform') {
            Object.values(SynthState.activeVoices).forEach(voice => voice.updateVoice?.());
        } else if (changedParam === 'filterToggle') {
            SynthState.filterEnabled = SynthState.controls.filterToggle.checked;
        } else if (changedParam === 'noiseToggle') {
            SynthState.noiseEnabled = SynthState.controls.noiseToggle.checked;
        } else if (changedParam === 'lfoToggle') {
            SynthState.lfoEnabled = SynthState.controls.lfoToggle.checked;
        }

        SynthState.filterSettings.type = SynthState.controls.filterType.value;
        SynthState.filterSettings.frequency = Number(SynthState.controls.filterCutoff.value);
        SynthState.filterSettings.Q = parseFloat(SynthState.controls.filterResonance.value);
        SynthState.fmEnabled = SynthState.controls.fmToggle.checked;

        const voiceParams = ['waveform', 'unison', 'detune', 'stereoSpread', 'unisonBlend', 'instrumentTone',
            'fmToggle', 'fmAmount', 'filterToggle', 'filterType', 'filterCutoff', 'filterResonance',
            'noiseToggle', 'noiseAmount', 'lfoToggle', 'lfoRate', 'lfoAmount'];
        if (!changedParam || voiceParams.includes(changedParam)) {
            Object.values(SynthState.activeVoices).forEach(voice => {
                if (voice.updateVoice) voice.updateVoice();
            });
        }
        UI.updateCircularControls();
    },

    updateMasterVolume() {
        const volume = parseFloat(SynthState.controls.masterVolume.value);
        if (this.masterGainNode) {
            this.masterGainNode.gain.setTargetAtTime(volume, this.audioContext.currentTime, 0.01);
        }
    },

    startRecording() {
        this.recordedChunks = [];
        this.recordedNotes = [];
        // Discard any previous recording's playback objects so Play uses the new take
        if (this.playbackAudio) this.playbackAudio.pause();
        if (this.playbackSource) this.playbackSource.disconnect();
        this.playbackAudio = null;
        this.playbackSource = null;
        this.recordingStartTime = this.audioContext.currentTime;
        const stream = this.createMediaStreamFromAudioGraph();
        this.recorder = new MediaRecorder(stream);
        this.recorder.ondataavailable = (e) => this.recordedChunks.push(e.data);
        this.recorder.start();
        document.getElementById('recordButton').disabled = true;
        document.getElementById('stopButton').disabled = false;
        document.getElementById('playButton').disabled = true;
        document.getElementById('saveButton').disabled = true;
        document.getElementById('exportWavButton').disabled = true;
    },

    stopRecording() {
        this.recorder.stop();
        document.getElementById('recordButton').disabled = false;
        document.getElementById('stopButton').disabled = true;
        document.getElementById('playButton').disabled = false;
        document.getElementById('saveButton').disabled = false;
        document.getElementById('exportWavButton').disabled = false;
    },

    playRecording() {
        if (this.playbackAudio) {
            this.playbackAudio.currentTime = 0;
        } else if (this.recordedChunks.length > 0) {
            const blob = new Blob(this.recordedChunks, { type: 'audio/wav' });
            const audioURL = URL.createObjectURL(blob);
            this.playbackAudio = new Audio(audioURL);
        } else {
            console.log('No recording to play');
            return;
        }

        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        if (!this.playbackSource) {
            this.playbackSource = this.audioContext.createMediaElementSource(this.playbackAudio);
            this.playbackSource.connect(this.compressor);
        }

        this.playbackAudio.play().then(() => {
            this.animatePlayback();
            this.updateVisualizer();
        }).catch(error => {
            console.error('Error playing audio:', error);
        });
    },

    updateVisualizer() {
        if (!this.analyser || !this.visualizerEnabled) return;

        // Invalidate any previously running draw loop
        const token = ++this.visualizerToken;

        const visualizer = document.getElementById('visualizer');
        const width = visualizer.offsetWidth;
        const height = visualizer.offsetHeight;

        // Set canvas resolution (not CSS size)
        visualizer.width = width * window.devicePixelRatio;
        visualizer.height = height * window.devicePixelRatio;

        const ctx = visualizer.getContext('2d');
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const bufferLength = this.analyser.frequencyBinCount;
        const timeData = new Uint8Array(bufferLength);

        const synth = this;

        // Oscilloscope
        const drawOscilloscope = () => {
            synth.analyser.getByteTimeDomainData(timeData);

            ctx.fillStyle = 'rgba(26, 26, 26, 0.3)';
            ctx.fillRect(0, 0, width, height);

            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00ff9d';
            ctx.beginPath();

            const sliceWidth = width / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = timeData[i] / 128.0;
                const y = v * height / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                x += sliceWidth;
            }

            ctx.stroke();
        };

        // Lissajous
        const drawLissajous = () => {
            synth.analyser.getByteTimeDomainData(timeData);

            ctx.fillStyle = 'rgba(26, 26, 26, 0.08)';
            ctx.fillRect(0, 0, width, height);

            const centerX = width / 2;
            const centerY = height / 2;
            const scale = height * 0.45;

            ctx.strokeStyle = '#00ff9d';
            ctx.lineWidth = 2;
            ctx.beginPath();

            const offset = Math.floor(bufferLength / 4);
            for (let i = 0; i < bufferLength - offset; i++) {
                const x = ((timeData[i] - 128) / 128) * scale + centerX;
                const y = ((timeData[i + offset] - 128) / 128) * scale + centerY;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.stroke();
        };

        const draw = () => {
            if (!synth.visualizerEnabled || synth.visualizerToken !== token) return;

            requestAnimationFrame(draw);

            switch (synth.visualizerMode) {
                case 'lissajous':
                    drawLissajous();
                    break;
                case 'oscilloscope':
                default:
                    drawOscilloscope();
                    break;
            }
        };

        draw();
    },

    toggleVisualizer() {
        this.visualizerEnabled = !this.visualizerEnabled;
        const visualizer = document.getElementById('visualizer');

        if (this.visualizerEnabled) {
            visualizer.style.display = 'block';
            this.updateVisualizer();
        } else {
            visualizer.style.display = 'none';
        }
    },

    animatePlayback() {
        const startTime = this.audioContext.currentTime;
        let lastUpdateTime = 0;
        const updateInterval = 50; // Update every 50ms

        const animate = () => {
            if (!this.playbackAudio || this.playbackAudio.paused) {
                document.querySelectorAll('.key.active').forEach(key => key.classList.remove('active'));
                return;
            }

            const currentTime = this.audioContext.currentTime - startTime;

            if (currentTime - lastUpdateTime >= updateInterval / 1000) {
                this.recordedNotes.forEach(noteEvent => {
                    if (Math.abs(noteEvent.time - currentTime) < 0.05) {
                        const keyElement = document.querySelector(`.key[data-note="${noteEvent.note}"]`);
                        if (keyElement) {
                            if (noteEvent.isNoteOn) {
                                keyElement.classList.add('active');
                            } else {
                                keyElement.classList.remove('active');
                            }
                        }
                    }
                });

                lastUpdateTime = currentTime;
            }

            requestAnimationFrame(animate);
        };

        requestAnimationFrame(animate);
    },

    saveRecording() {
        if (this.recordedChunks.length === 0) {
            console.log('No recording to save');
            return;
        }

        const blob = new Blob(this.recordedChunks, { type: 'audio/wav' });
        const reader = new FileReader();
        reader.onload = (event) => {
            const audioData = event.target.result;
            const presets = this.getPresets();
            const data = {
                audio: audioData,
                presets: presets,
                notes: this.recordedNotes
            };
            const json = JSON.stringify(data);
            const jsonBlob = new Blob([json], { type: 'application/json' });

            const saveFile = async () => {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: 'browsynth_recording.json',
                        types: [{
                            description: 'Browsynth Recording',
                            accept: { 'application/json': ['.json'] },
                        }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(jsonBlob);
                    await writable.close();
                    console.log('File saved successfully');
                } catch (err) {
                    console.error('Failed to save file:', err);
                }
            };

            saveFile();
        };
        reader.readAsDataURL(blob);
    },

    loadRecording() {
        const loadFile = async () => {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{
                        description: 'Browsynth Recording',
                        accept: { 'application/json': ['.json'] },
                    }],
                });
                const file = await handle.getFile();
                const contents = await file.text();
                const data = JSON.parse(contents);
                this.setPresets(data.presets);

                if (this.playbackAudio) {
                    this.playbackAudio.pause();
                }
                // Drop the media source tied to the old audio element so the
                // loaded recording gets routed through the FX chain too
                if (this.playbackSource) {
                    this.playbackSource.disconnect();
                    this.playbackSource = null;
                }
                this.playbackAudio = new Audio(data.audio);
                this.recordedChunks = [];
                this.recordedNotes = data.notes || [];
                fetch(data.audio)
                    .then(res => res.blob())
                    .then(blob => {
                        this.recordedChunks.push(blob);
                    });
                document.getElementById('playButton').disabled = false;
                document.getElementById('saveButton').disabled = false;
                console.log('File loaded successfully');
            } catch (err) {
                console.error('Failed to load file:', err);
            }
        };

        loadFile();
    },

    getPresets() {
        const presets = {};
        for (const [key, control] of Object.entries(SynthState.controls)) {
            // Buttons carry no state and file inputs can't be restored
            if (control.tagName === 'BUTTON' || control.type === 'file') continue;
            presets[key] = control.type === 'checkbox' ? control.checked : control.value;
        }
        return presets;
    },

    setPresets(presets) {
        for (const [key, value] of Object.entries(presets)) {
            const control = SynthState.controls[key];
            if (!control || control.tagName === 'BUTTON' || control.type === 'file') continue;
            if (control.type === 'checkbox') {
                control.checked = value;
            } else {
                control.value = value;
            }
            this.updateParams(key);
        }
    },

    createMediaStreamFromAudioGraph() {
        const dest = this.audioContext.createMediaStreamDestination();
        this.analyser.connect(dest);
        return dest.stream;
    },

    recordNoteEvent(note, isNoteOn) {
        if (this.recorder && this.recorder.state === "recording") {
            const time = this.audioContext.currentTime - this.recordingStartTime;
            this.recordedNotes.push({ note, time, isNoteOn });
        }
    },

    exportWav() {
        if (!this.audioContext) {
            console.error('AudioContext is not initialized');
            return;
        }
        if (this.recordedChunks.length === 0) {
            console.log('No recording to export');
            return;
        }

        const blob = new Blob(this.recordedChunks, { type: 'audio/wav' });

        blob.arrayBuffer().then(arrayBuffer => {
            this.audioContext.decodeAudioData(arrayBuffer, (audioBuffer) => {
                const offlineCtx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, 44100);
                const source = offlineCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(offlineCtx.destination);
                source.start();

                offlineCtx.startRendering().then(renderedBuffer => {
                    const wav = this.audioBufferToWav(renderedBuffer);
                    const wavBlob = new Blob([new DataView(wav)], { type: 'audio/wav' });

                    const url = URL.createObjectURL(wavBlob);
                    const a = document.createElement('a');
                    document.body.appendChild(a);
                    a.style = 'display: none';
                    a.href = url;
                    a.download = 'browsynth_recording.wav';
                    a.click();
                    window.URL.revokeObjectURL(url);
                }).catch(err => {
                    console.error('Error rendering audio:', err);
                });
            }, (err) => {
                console.error('Error decoding audio data:', err);
            });
        }).catch(err => {
            console.error('Error reading blob:', err);
        });
    },

    audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = 44100;
        const format = 1; // PCM
        const bitDepth = 24;

        let result = new ArrayBuffer(44 + buffer.length * numChannels * 3);
        let view = new DataView(result);

        // Write WAV header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + buffer.length * numChannels * 3, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * 3, true);
        view.setUint16(32, numChannels * 3, true);
        view.setUint16(34, bitDepth, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, buffer.length * numChannels * 3, true);

        // Write audio data
        const length = buffer.length;
        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let channel = 0; channel < numChannels; channel++) {
                let sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
                sample = Math.round(sample * 0x7FFFFF);
                view.setInt24(offset, sample, true);
                offset += 3;
            }
        }

        return result;
    },

    writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    },
};

DataView.prototype.setInt24 = function (pos, val, littleEndian) {
    this.setUint8(pos + (littleEndian ? 0 : 2), val & 0xFF);
    this.setUint8(pos + 1, (val >> 8) & 0xFF);
    this.setUint8(pos + (littleEndian ? 2 : 0), (val >> 16) & 0xFF);
};

// Initialize the synth when the DOM is fully loaded
