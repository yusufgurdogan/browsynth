'use strict';
const $ = id => document.getElementById(id);
const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const Studio = {
    ready: false, current: FACTORY_PATCHES[0], category: 'All', collection: 'all',
    favorites: new Set(), sources: new Map(), noteOwners: new Map(), hold: false,
    demoTimers: [], demoPlaying: false, applying: false, scopeMode: 'wave',
    init() {
        this.arrangeControls();
        this.installKnobs();
        this.createPiano();
        KeyboardMapping.init(() => this.updateKeyLabels());
        this.updateKeyLabels();
        TranceGate.init();
        $('panicButton').setAttribute('aria-label','Stop all');
        try {
            const saved = JSON.parse(localStorage.getItem('browsynth_favorites_v2'));
            this.favorites = new Set(Array.isArray(saved) ? saved : FACTORY_PATCHES.filter(p => p.favorite).map(p => p.id));
        } catch { this.favorites = new Set(FACTORY_PATCHES.filter(p => p.favorite).map(p => p.id)); }
        this.bindLibrary();
        this.bindPerformance();
        this.bindRecording();
        this.bindDialogs();
        $('startButton').addEventListener('click', () => this.enableAudio());
        $('midiEnableButton').addEventListener('click', () => this.enableAudio(), {capture:true});
        $('cthulhuButton').addEventListener('click', () => this.enableAudio(), {capture:true});
        $('openWavetableEditor').addEventListener('click', () => this.enableAudio(), {capture:true});
        $('tuningFile').addEventListener('click', () => this.enableAudio(), {capture:true});
        $('synthMode').addEventListener('change',()=>{if(this.applying)return;this.stopAll(false);this.updateInstrumentControls();});
        $('instrumentType').addEventListener('change',()=>{if(this.applying)return;this.stopAll(false);this.updateInstrumentControls();});
        $('retryPiano').addEventListener('click',()=>this.prepareInstrument());
        document.addEventListener('pianosamples',()=>this.updateInstrumentStatus());
        $('scopeModeButton').addEventListener('click', () => {
            this.scopeMode = this.scopeMode === 'wave' ? 'orbit' : 'wave';
            $('scopeModeButton').textContent = this.scopeMode === 'wave' ? 'WAVEFORM ↗' : 'LISSAJOUS ↗';
        });
        document.querySelectorAll('[data-tab]').forEach(button => {
            button.setAttribute('aria-label', button.dataset.tab[0].toUpperCase()+button.dataset.tab.slice(1));
            button.addEventListener('click', () => this.selectTab(button.dataset.tab));
            button.addEventListener('keydown', e => {
                if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
                e.preventDefault();
                const tabs = [...document.querySelectorAll('[data-tab]')];
                let index = tabs.indexOf(button);
                index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length-1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                this.selectTab(tabs[index].dataset.tab); tabs[index].focus();
            });
        });
        document.addEventListener('input', e => {
            if (!e.target.matches('#controls input, #controls select, #masterVolume, #globalBpm')) return;
            UI.updateCircularControls();
            if (!this.applying && e.target.id !== 'globalBpm') $('dirtyBadge').hidden = false;
        });
        document.addEventListener('change', e => {
            if (e.target.matches('#controls input, #controls select') && !this.applying) $('dirtyBadge').hidden = false;
        });
        $('globalBpm').addEventListener('change', () => {
            $('globalBpm').value = Math.max(40, Math.min(300, Number($('globalBpm').value) || 138));
            Tempo.set($('globalBpm').value);
        });
        const taps = [];
        $('tapTempo').addEventListener('click', () => {
            const now = performance.now();
            if (now - (taps.at(-1) || 0) > 2000) taps.length = 0;
            taps.push(now); if (taps.length > 5) taps.shift();
            if (taps.length > 1) { $('globalBpm').value = Math.max(40, Math.min(300, Math.round(60000 * (taps.length-1) / (now-taps[0])))); $('globalBpm').dispatchEvent(new Event('input',{bubbles:true})); }
        });
        this.selectPatch(this.current, false);
        this.drawScope();
        document.querySelectorAll('.modal').forEach(modal => {
            modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
            modal.setAttribute('aria-label', modal.id === 'cthulhuModal' ? 'Step sequencer' : 'Wavetable editor');
            modal.querySelector('.close-btn').setAttribute('aria-label', modal.id==='cthulhuModal'?'Close step sequencer':'Close wavetable editor');
            let previousFocus;
            new MutationObserver(()=>{
                const open=modal.style.display==='flex';
                if(open){previousFocus=document.activeElement;modal.querySelector('.close-btn').focus();}
                else if(previousFocus){previousFocus.focus();previousFocus=null;}
            }).observe(modal,{attributes:true,attributeFilter:['style']});
            modal.addEventListener('keydown',e=>{
                if(e.key!=='Tab')return;
                const focusable=[...modal.querySelectorAll('button,input,select,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);
                if(e.shiftKey&&document.activeElement===focusable[0]){e.preventDefault();focusable.at(-1).focus();}
                else if(!e.shiftKey&&document.activeElement===focusable.at(-1)){e.preventDefault();focusable[0].focus();}
            });
            modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
        });
        // The file input is created once to keep importing available offline.
        $('importPatch').addEventListener('change', e => this.importPatch(e.target.files[0]));
        $('referencePitch').addEventListener('change', () => {
            $('referencePitch').value = Math.max(400,Math.min(480, Number($('referencePitch').value)||440));
            if (this.ready) { this.stopAll(); TuningSystem.refreshActiveVoices(); }
        });
        $('resetTuning').addEventListener('click', () => { TuningSystem.divisions=12; $('tuningPreset').value=''; $('referencePitch').value=440; });
    },
    arrangeControls() {
        const newCollection=document.createElement('button');newCollection.dataset.collection='new';newCollection.textContent='New';newCollection.setAttribute('aria-pressed','false');
        document.querySelector('[data-collection="favorites"]').before(newCollection);
        ['Piano','Mallet'].forEach(category=>{const button=document.createElement('button');button.dataset.category=category;button.textContent=category==='Mallet'?'Mallets':'Piano';button.setAttribute('aria-pressed','false');document.querySelector('.category-list').append(button);});
        const touch=document.createElement('label');touch.className='keyboard-layout touch-control';
        touch.innerHTML='Touch <select id="playVelocity" aria-label="Playing strength"><option value=".4">Soft</option><option value=".72" selected>Natural</option><option value="1">Firm</option></select>';
        document.querySelector('.keyboard-footer').insertBefore(touch,document.querySelector('.keyboard-footer').lastElementChild);
        const credit=document.createElement('p');credit.className='sample-credit';credit.innerHTML='Piano recordings: <a href="https://github.com/sfzinstruments/SalamanderGrandPiano" target="_blank" rel="noopener noreferrer">Salamander Grand Piano by Alexander Holm</a> · <a href="samples/piano/LICENSE.txt" target="_blank" rel="noopener noreferrer">CC BY 3.0</a>. Edited into a compact stereo bank; felt and dream sounds add filtering and effects.';$('helpDialog').append(credit);
        const playingHelp=document.createElement('p');playingHelp.textContent='Sustain keeps released notes ringing. Hold Shift for a momentary pedal, or click Sustain to latch it. Touch selects soft, natural, or firm strikes for the computer keyboard. A MIDI keyboard uses its own velocity and sustain pedal.';$('helpDialog').append(playingHelp);
        const groups = [...document.querySelectorAll('#controlSource > .control-group')];
        const byName = new Map(groups.map(group => [group.querySelector('h2').textContent, group]));
        const move = (names, target) => names.forEach((name,i) => { const group=byName.get(name); group.querySelector('h2').dataset.number=String(i+1).padStart(2,'0'); $(target).append(group); });
        move(['Oscillator','Unison','Filter','Envelope'], 'panel-sound');
        move(['Delay','Chorus & Drive','EQ','Master'], 'panel-effects');
        move(['Arpeggiator','Trance Gate','Sidechain'], 'panel-rhythm');
        move(['Miscellaneous','Tuning'], 'panel-settings');
        byName.get('Oscillator').querySelector('h2').textContent = 'Oscillator';
        byName.get('Master').querySelector('h2').textContent = 'Space';
        byName.get('Miscellaneous').querySelector('h2').textContent = 'Playing';
        const extra = document.createElement('details'); extra.className='extra-controls';
        extra.innerHTML='<summary>More color <span class="dim">/ Modulation, noise & FM</span></summary><div class="extra-content"></div>';
        $('panel-sound').append(extra);
        extra.lastElementChild.append(byName.get('LFO'),byName.get('Noise'));
        const fmGroup=document.createElement('div'); fmGroup.className='control-group'; fmGroup.innerHTML='<h2>FM color</h2>';
        fmGroup.append($('fmToggle').closest('.control'),$('fmAmount').closest('.control')); extra.lastElementChild.append(fmGroup);
        const oscText=document.createElement('p'); oscText.id='sourceHint';oscText.className='settings-note'; oscText.textContent='Start with a shape. Add voices for width.'; byName.get('Oscillator').append(oscText);
        $('masterSlot').innerHTML='<label for="masterVolume">OUTPUT</label>';
        const volume=$('masterVolume'); const oldWrap=volume.closest('.control'); $('masterSlot').append(volume); oldWrap.remove();
        const output=document.createElement('output'); output.id='masterValue'; $('masterSlot').append(output);
        const reverbText=document.createElement('p'); reverbText.className='settings-note'; reverbText.textContent='A little room around your sound. Reverb and delay remain in stereo.'; byName.get('Master').append(reverbText);
        const motion=document.createElement('div'); motion.className='motion-extra'; motion.innerHTML='<div>Take your chords somewhere.<p>16 steps, per-note velocity, octave shifts and ready-to-play patterns.</p></div><button id="cthulhuButton">Open step sequencer ↗</button>'; $('panel-rhythm').append(motion);
        const settings=document.createElement('div'); settings.className='control-group';
        settings.innerHTML='<h2>Pitch & patches</h2><div class="control"><label for="referencePitch">A4 reference · Hz</label><input id="referencePitch" type="number" min="400" max="480" value="440" step="1"></div><div class="control"><label for="importPatch">Import a patch</label><input id="importPatch" type="file" accept=".json,application/json"></div><p class="settings-note">Equal divisions work offline. Custom .tun files keep their own reference pitch.</p><button id="removeUserPatch" disabled>Delete selected user patch</button>';
        $('panel-settings').append(settings);
        $('removeUserPatch').addEventListener('click', async () => {
            if (!this.current.id.startsWith('user:')) return;
            const old=this.current;
            if (!await this.ask(`Delete “${old.name}” from your saved sounds?`, 'Delete patch')) return;
            if (PresetManager.deletePreset(old.name)) { this.selectPatch(FACTORY_PATCHES[0]); this.toast('Patch removed from your library.'); }
        });
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 180 48'); svg.setAttribute('aria-label','Amplitude envelope'); svg.classList.add('envelope-graph');
        svg.innerHTML='<path class="gridline" d="M0 43H180M0 23H180M0 3H180"/><path id="envFill" class="env-fill"/><path id="envLine" class="env-line"/>';
        byName.get('Envelope').querySelector('h2').after(svg);
        document.querySelectorAll('.eq-control').forEach(control=>{const value=document.createElement('output');value.id=control.querySelector('input').id+'Value';control.querySelector('label').append(value);});
        $('controlSource').remove();
    },
    selectTab(name) {
        document.querySelectorAll('[data-tab]').forEach(button => {
            const selected = button.dataset.tab === name;
            button.classList.toggle('selected',selected); button.setAttribute('aria-selected',selected); button.tabIndex=selected?0:-1;
            $('panel-'+button.dataset.tab).hidden=!selected;
        });
    },
    updateInstrumentControls() {
        const mode=$('synthMode').value,instrument=mode==='instrument';
        $('waveformControl').style.display=mode==='waveform'?'flex':'none';
        $('wavetableControls').style.display=mode==='wavetable'?'flex':'none';
        $('instrumentControls').hidden=!instrument;$('sourceHint').hidden=instrument;
        $('synthMode').closest('.control-group').querySelector('h2').textContent=instrument?'Instrument':'Oscillator';
        $('unison').closest('.control-group').hidden=instrument;
        $('panel-sound').querySelector('.extra-controls').hidden=instrument;
        $('panel-sound').classList.toggle('instrument-mode',instrument);
        this.updateInstrumentStatus();
        if(instrument&&InstrumentVoice.isPiano($('instrumentType').value))this.prepareInstrument();
    },
    updateInstrumentStatus() {
        const piano=InstrumentVoice.isPiano($('instrumentType').value);
        $('retryPiano').hidden=!piano||PianoSamples.state!=='error';
        $('instrumentStatus').textContent=!piano?'Try Soft and Firm touch for different character.':
            PianoSamples.state==='ready'?'Stereo piano · three recorded playing strengths':
            PianoSamples.state==='error'?'Piano recordings could not load. Retry to play this sound.':
            `Loading piano… ${Math.round(PianoSamples.loaded/PianoSamples.total*100)}%`;
    },
    async prepareInstrument() {
        if($('synthMode').value!=='instrument'||!InstrumentVoice.isPiano($('instrumentType').value))return true;
        try{await PianoSamples.load(Synth.audioContext);this.updateInstrumentStatus();return true;}
        catch(error){console.warn('Piano loading failed:',error.message);this.updateInstrumentStatus();return false;}
    },
    enableAudio() {
        if (this.ready) { if (Synth.audioContext.state === 'suspended') Synth.audioContext.resume(); return true; }
        try {
            const snapshot=this.snapshot();
            Synth.initAudioContext();
            Synth.start();
            this.ready=true;
            this.applying=true; PresetManager.applySettings(snapshot); this.applying=false;
            SynthState.whiteKeysOnly=$('whiteKeysOnlyToggle').checked;
            SynthState.octaveShift=Number($('octaveShift').value)||0;
            TuningSystem.divisions=parseInt($('tuningPreset').value,10)||12;
            $('startModal').hidden=true;
            $('audioStatus').innerHTML='<i></i>Audio ready'; $('audioStatus').classList.add('ready');
            Synth.audioContext.resume().catch(()=>this.toast('Audio is paused. Click Enable audio to try again.'));
            $('scopeLabel').textContent='SIGNAL / LIVE';
            document.documentElement.dataset.audio='ready';
            return true;
        } catch(error) { console.error(error); this.toast('Could not start audio. Try reloading this page.'); return false; }
    },
    patches() {
        return [...FACTORY_PATCHES, ...Object.entries(PresetManager.getPresets()).map(([name,settings])=>({
            id:'user:'+name,name,settings,category:'User',color:'sand',character:'Your own creation',description:'A sound you made your own. Keep exploring, or record an idea.'
        }))];
    },
    filteredPatches() {
        const q=$('presetSearch').value.trim().toLowerCase();
        return this.patches().filter(p => (this.collection!=='favorites'||this.favorites.has(p.id)) &&
            (this.collection!=='new'||p.newSound) &&
            (this.collection!=='user'||p.id.startsWith('user:')) && (this.category==='All'||p.category===this.category) &&
            `${p.name} ${p.category} ${p.character}`.toLowerCase().includes(q));
    },
    renderLibrary() {
        const icons={Pluck:'M1 17 5 3 9 17 13 8 17 17 21 13',Lead:'M1 17V4l7 13V4l7 13V4l7 13',Bass:'M1 15V6h7v11h7V6h7',Pad:'M1 14Q6 0 11 11T23 10',Keys:'M2 5v13h18V5M8 5v8M14 5v8'};
        $('presetList').replaceChildren();
        const patches=this.filteredPatches(); $('presetCount').textContent=patches.length;
        patches.forEach(patch=>{
            const row=document.createElement('div'); row.className='preset-row'+(this.current.id===patch.id?' selected':'');
            const main=document.createElement('button'); main.className='preset-main'; main.setAttribute('aria-label','Load '+patch.name); main.setAttribute('aria-pressed',this.current.id===patch.id);
            main.innerHTML=`<span class="preset-icon ${patch.color}"><svg viewBox="0 0 24 22" aria-hidden="true"><path d="${icons[patch.category]||icons.Keys}"/></svg></span><span class="preset-text"><strong>${escapeHTML(patch.name)}</strong><small>${escapeHTML(patch.category)} · ${patch.id.startsWith('user:')?'Personal':'Factory'}</small></span>`;
            main.addEventListener('click',()=>this.selectPatch(patch));
            const star=document.createElement('button'); star.className='preset-star'; const favorite=this.favorites.has(patch.id);
            star.textContent=favorite?'★':'☆'; star.setAttribute('aria-label',(favorite?'Unfavorite ':'Favorite ')+patch.name); star.setAttribute('aria-pressed',favorite); star.addEventListener('click',()=>this.toggleFavorite(patch.id));
            row.append(main,star); $('presetList').append(row);
        });
        if (!patches.length) {
            const empty=document.createElement('div'); empty.className='empty-library';
            empty.textContent=this.collection==='user'?'Your saved sounds will live here.':this.collection==='favorites'?'Star a sound to keep it close.':'No sounds match that search.';
            const reset=document.createElement('button');reset.textContent='Show all sounds';reset.addEventListener('click',()=>{this.collection='all';this.category='All';$('presetSearch').value='';this.updateFilters();});empty.append(reset);$('presetList').append(empty);
        }
    },
    updateFilters() {
        document.querySelectorAll('[data-collection]').forEach(b=>{const on=b.dataset.collection===this.collection;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',on);});
        document.querySelectorAll('[data-category]').forEach(b=>{const on=b.dataset.category===this.category;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',on);});
        this.renderLibrary();
    },
    selectPatch(patch, keepDemo=true, { restoreTempo=false } = {}) {
        const resume=keepDemo&&this.demoPlaying;
        this.stopAll(); this.current=patch; this.applying=true;
        // Migrate old user patches in memory, without rewriting their saved copy.
        let settings={...patch.settings};
        if(settings.__version!==2 && settings.filterCutoff!==undefined)settings.filterCutoff=20*Math.pow(1000,(Number(settings.filterCutoff)-20)/19980);
        settings={...structuredClone(PATCH_DEFAULTS),...settings,__version:2};
        if(this.ready)PresetManager.applySettings(settings, {restoreTempo});
        else {
            Object.entries(settings).forEach(([id,value])=>{if(id==='globalBpm'||id.startsWith('__'))return;const el=$(id);if(el){if(el.type==='checkbox')el.checked=value;else el.value=value;}});
            if(restoreTempo)Tempo.set(settings.globalBpm ?? settings.__cthulhu?.arp?.bpm ?? Tempo.bpm);
            TranceGate.restore(settings.__gate);
        }
        this.resetValues={...settings};
        $('patchName').textContent=patch.name; $('patchCategory').textContent=patch.category.toUpperCase();
        $('patchOrigin').textContent=patch.id.startsWith('factory:')?`FACTORY / ${String(patch.index+1).padStart(2,'0')}`:'YOUR COLLECTION';
        $('patchDescription').textContent=patch.description; $('dirtyBadge').hidden=true;
        $('removeUserPatch').disabled=!patch.id.startsWith('user:');
        $('favoritePatch').setAttribute('aria-pressed',this.favorites.has(patch.id)); $('favoritePatch').textContent=this.favorites.has(patch.id)?'★':'☆';
        $('waveformControl').style.display=settings.synthMode==='waveform'?'flex':'none'; $('wavetableControls').style.display=settings.synthMode==='wavetable'?'flex':'none';
        this.updateInstrumentControls();UI.updateCircularControls(); this.renderLibrary(); this.applying=false;
        if(resume)this.playDemo();
    },
    toggleFavorite(id) {
        this.favorites.has(id)?this.favorites.delete(id):this.favorites.add(id);
        try{localStorage.setItem('browsynth_favorites_v2',JSON.stringify([...this.favorites]));}catch{this.toast('Favorites work for this visit. Browser storage is unavailable.');}
        this.renderLibrary();$('favoritePatch').textContent=this.favorites.has(this.current.id)?'★':'☆';$('favoritePatch').setAttribute('aria-pressed',this.favorites.has(this.current.id));
    },
    bindLibrary() {
        $('presetSearch').addEventListener('input',()=>this.renderLibrary());
        document.querySelectorAll('[data-collection]').forEach(b=>b.addEventListener('click',()=>{this.collection=b.dataset.collection;this.category='All';this.updateFilters();}));
        document.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{this.category=b.dataset.category;this.updateFilters();}));
        $('favoritePatch').addEventListener('click',()=>this.toggleFavorite(this.current.id));
        const next=delta=>{let patches=this.filteredPatches();if(!patches.length)patches=this.patches();let index=patches.findIndex(p=>p.id===this.current.id);this.selectPatch(patches[(index+delta+patches.length)%patches.length]);};
        $('previousPatch').addEventListener('click',()=>next(-1));$('nextPatch').addEventListener('click',()=>next(1));
        $('resetPatch').addEventListener('click',()=>{this.selectPatch(this.current);this.toast('Original patch settings restored.');});
        $('newPatch').addEventListener('click',()=>this.selectPatch({id:'init',name:'Blank Canvas',category:'Init',description:'One oscillator. Endless possibilities. Build a sound from the very beginning.',settings:{...PATCH_DEFAULTS,waveform:'sine',masterReverb:0,masterDelay:0}}));
        $('demoButton').addEventListener('click',()=>this.demoPlaying||this.demoLoading?this.stopDemo():this.playDemo());
    },
    installKnobs() {
        UI.updateCircularControls=()=>{
            document.querySelectorAll('.circular-control input').forEach(input=>{
                const value=Number(input.value), min=Number(input.min), max=Number(input.max);
                const normalized=input.dataset.log?Math.log(value/min)/Math.log(max/min):(value-min)/(max-min);
                input.parentElement.style.setProperty('--rotation',`${normalized*270-135}deg`);
                input.parentElement.style.setProperty('--amount',`${normalized*270}deg`);
                const label=Util.formatValue(value,input.parentElement.dataset.unit||'',input.parentElement.dataset.format||'');
                input.parentElement.querySelector('.knob-value').textContent=label;input.setAttribute('aria-valuetext',label);
            });
            $('masterValue').textContent=Math.round(Number($('masterVolume').value)*100)+'%';
            ['masterLowEQ','masterMidEQ','masterHighEQ'].forEach(id=>{const v=Number($(id).value);$(id+'Value').textContent=(v>0?'+':'')+v.toFixed(1)+' dB';});
            const a=8+Math.sqrt(Number($('attack').value)/2)*44,d=12+Math.sqrt(Number($('decay').value)/3)*38,s=43-Number($('sustain').value)*38,r=12+Math.sqrt(Number($('release').value)/5)*35;
            const end=178-r;const path=`M1 43 L${a} 5 Q${a+d*.4} ${s} ${a+d} ${s} L${end} ${s} Q${end+r*.3} 43 179 43`;
            $('envLine').setAttribute('d',path);$('envFill').setAttribute('d',path+' Z');
        };
        document.querySelectorAll('.circular-control').forEach(control=>{
            const input=control.querySelector('input');let drag=null;
            const normalized=()=>input.dataset.log?Math.log(Number(input.value)/Number(input.min))/Math.log(Number(input.max)/Number(input.min)):(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min));
            const set=n=>{n=Math.max(0,Math.min(1,n));const min=Number(input.min),max=Number(input.max);input.value=input.dataset.log?min*Math.pow(max/min,n):min+n*(max-min);input.dispatchEvent(new Event('input',{bubbles:true}));};
            input.addEventListener('pointerdown',e=>{e.preventDefault();input.focus({preventScroll:true});input.setPointerCapture(e.pointerId);drag={y:e.clientY,value:normalized()};});
            input.addEventListener('pointermove',e=>{if(drag)set(drag.value+(drag.y-e.clientY)/(e.shiftKey?1600:160));});
            input.addEventListener('pointerup',()=>{drag=null;}); input.addEventListener('pointercancel',()=>{drag=null;});
            input.addEventListener('dblclick',()=>{input.value=this.resetValues?.[input.id]??input.defaultValue;input.dispatchEvent(new Event('input',{bubbles:true}));});
            input.addEventListener('keydown',e=>{if(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft'].includes(e.key)){e.preventDefault();const delta=['ArrowUp','ArrowRight'].includes(e.key)?1:-1;const steps=(Number(input.max)-Number(input.min))/Number(input.step);set(normalized()+delta*(input.step==='1'&&steps<30?1/steps:e.shiftKey?.001:.01));}});
            input.addEventListener('wheel',e=>{if(document.activeElement!==input)return;e.preventDefault();set(normalized()-Math.sign(e.deltaY)*.015);},{passive:false});
        });
    },
    createPiano() {
        $('piano').replaceChildren();
        let white=0;
        for(let octave=3;octave<=5;octave++)for(const note of SynthConfig.notes){
            const name=note+octave,black=note.includes('#');const key=document.createElement('button');key.type='button';key.className='key'+(black?' black':'');key.dataset.note=name;key.setAttribute('aria-label','Play '+name);key.tabIndex=-1;
            if(black)key.style.setProperty('--key-index',white);else white++;
            key.innerHTML=`<span class="note-name">${note==='C'?name:''}</span><span class="key-label"></span>`;$('piano').append(key);
            key.addEventListener('click',e=>{if(e.detail===0){this.down('accessible:'+name,[name]);if(!this.hold)setTimeout(()=>this.up('accessible:'+name,true),220);}});
        }
    },
    updateKeyLabels() {
        const whiteOnly=$('whiteKeysOnlyToggle').checked;
        document.querySelectorAll('#piano .key').forEach(key=>{
            const labels=KeyboardMapping.labelsForNote(key.dataset.note,whiteOnly);
            key.querySelector('.key-label').textContent=labels.join(' ');
            key.title=key.dataset.note+(labels.length?' · '+labels.join(' / '):' · Touch to play');
        });
        const lower=['KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM'].map(code=>KeyboardMapping.label(code)).join(' ');
        const upper=['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU'].map(code=>KeyboardMapping.label(code)).join(' ');
        $('helpLowerKeys').textContent=lower;$('helpUpperKeys').textContent=upper;
        $('helpBlackKeys').textContent=['KeyS','KeyD','KeyG','KeyH','KeyJ'].map(code=>KeyboardMapping.label(code)).join(' ')+' / '+['Digit2','Digit3','Digit5','Digit6','Digit7'].map(code=>KeyboardMapping.label(code)).join(' ');
        $('playHint').textContent=whiteOnly?'White notes across all letter rows. Labels follow your keyboard.':`${lower.split(' ')[0]}–${lower.split(' ').at(-1)} & ${upper.split(' ')[0]}–${upper.split(' ').at(-1)} to play · keys follow your layout`;
        $('helpMode').textContent=whiteOnly?'White keys mode is on. All letter rows play white notes; the black-key shortcuts below apply when it is off.':'Notes follow key positions on your keyboard. Auto reads your layout when supported and learns labels as you play. You can also choose English or Türkçe Q below the piano.';
    },
    down(source,notes,velocity=Number($('playVelocity').value)) {
        if(!this.enableAudio())return;
        if($('synthMode').value==='instrument'&&InstrumentVoice.isPiano($('instrumentType').value)&&PianoSamples.state!=='ready'){
            this.prepareInstrument();this.toast('The piano is loading. It will be ready in a moment.');return;
        }
        if(this.sources.has(source)){if(this.hold)this.up(source,true);return;}
        const shifted=notes.map(note=>applyOctaveShift(note));this.sources.set(source,shifted);
        shifted.forEach(note=>{const count=this.noteOwners.get(note)||0;this.noteOwners.set(note,count+1);if(!count)Voice.play(note,false,velocity);});
    },
    up(source,force=false) {
        if(this.hold&&!force)return;const notes=this.sources.get(source);if(!notes)return;this.sources.delete(source);
        notes.forEach(note=>{const count=(this.noteOwners.get(note)||1)-1;if(count)this.noteOwners.set(note,count);else{this.noteOwners.delete(note);Voice.release(note);}});
    },
    bindPerformance() {
        const pedal=document.createElement('button');pedal.id='sustainButton';pedal.textContent='Sustain';pedal.title='Let released notes ring · hold Shift for a momentary pedal';pedal.setAttribute('aria-pressed','false');$('holdButton').before(pedal);
        pedal.addEventListener('click',()=>Sustain.set('button',!Sustain.sources.has('button')));
        const piano=$('piano');const pointers=new Map();
        piano.addEventListener('pointerdown',e=>{const key=e.target.closest('.key');if(!key)return;e.preventDefault();this.stopDemo();piano.setPointerCapture(e.pointerId);const source=this.hold?'latched:'+key.dataset.note:'pointer:'+e.pointerId;pointers.set(e.pointerId,{note:key.dataset.note,source});this.down(source,[key.dataset.note]);});
        piano.addEventListener('pointermove',e=>{const pointer=pointers.get(e.pointerId);if(!pointer||this.hold)return;const key=document.elementFromPoint(e.clientX,e.clientY)?.closest('.key');if(key&&pointer.note!==key.dataset.note){this.up(pointer.source,true);pointer.note=key.dataset.note;this.down(pointer.source,[key.dataset.note]);}});
        const end=e=>{const pointer=pointers.get(e.pointerId);if(pointer)this.up(pointer.source);pointers.delete(e.pointerId);};piano.addEventListener('pointerup',end);piano.addEventListener('pointercancel',end);piano.addEventListener('lostpointercapture',end);
        document.querySelectorAll('[data-chord]').forEach(button=>{
            button.addEventListener('pointerdown',e=>{e.preventDefault();this.stopDemo();button.setPointerCapture(e.pointerId);const source='chord:'+button.dataset.chord;this.down(source,button.dataset.chord.split(','));button.classList.toggle('active',this.sources.has(source));});
            const release=()=>{this.up('chord:'+button.dataset.chord);if(!this.hold)button.classList.remove('active');};button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);
            button.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();this.down('chord:'+button.dataset.chord,button.dataset.chord.split(','));}});button.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();release();}});
        });
        $('holdButton').addEventListener('click',()=>{this.hold=!this.hold;$('holdButton').setAttribute('aria-pressed',this.hold);if(!this.hold){for(const source of [...this.sources.keys()])this.up(source,true);document.querySelectorAll('[data-chord]').forEach(b=>b.classList.remove('active'));}});
        $('panicButton').addEventListener('click',()=>this.stopAll());
        const octave=delta=>{this.stopAll();const value=Math.max(-1,Math.min(1,Number($('octaveShift').value)+delta));$('octaveShift').value=value;$('octaveShift').dispatchEvent(new Event('change',{bubbles:true}));SynthState.octaveShift=value;this.updateOctave();};
        $('octaveDown').addEventListener('click',()=>octave(-1));$('octaveUp').addEventListener('click',()=>octave(1));$('octaveShift').addEventListener('change',()=>this.updateOctave());
        $('whiteKeysOnlyToggle').addEventListener('change',()=>{for(const source of [...this.sources.keys()])this.up(source,true);this.updateKeyLabels();});
        $('keyboardLayout').addEventListener('change',e=>{for(const source of [...this.sources.keys()])this.up(source,true);KeyboardMapping.setProfile(e.target.value);});
        $('pitchBendWheel').addEventListener('pointerup',()=>{$('pitchBendWheel').value=0;if(this.ready)Synth.updatePitchBend(0);});
        document.addEventListener('keydown',e=>{
            if(e.key==='Escape'){this.stopAll();document.querySelectorAll('.modal').forEach(m=>m.style.display='none');return;}
            if((e.ctrlKey||e.metaKey)&&e.code==='KeyK'&&!e.altKey&&!e.target.closest('dialog,.modal')){e.preventDefault();$('presetSearch').focus();return;}
            if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing||e.target.closest('dialog,.modal,select,textarea,[contenteditable]:not([contenteditable="false"])'))return;
            const input=e.target.closest('input');
            if(input && (!['checkbox','range'].includes(input.type)||['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.code)))return;
            if(e.code==='ShiftLeft'||e.code==='ShiftRight'){if(input?.type!=='range'){e.preventDefault();Sustain.set(e.code,true);}return;}
            KeyboardMapping.observe(e);
            if(e.code==='Space'&&!e.target.closest('button')){e.preventDefault();if(!e.repeat)this.demoPlaying?this.stopDemo():this.playDemo();return;}
            if(e.repeat)return;
            const note=KeyboardMapping.noteForEvent(e,$('whiteKeysOnlyToggle').checked);
            if(note){e.preventDefault();this.stopDemo();this.down('key:'+e.code,[note]);}
        });
        document.addEventListener('keyup',e=>{if(e.code==='ShiftLeft'||e.code==='ShiftRight')Sustain.set(e.code,false);this.up('key:'+e.code);});
        window.addEventListener('blur',()=>{Sustain.reset();this.stopDemo();for(const source of [...this.sources.keys()])this.up(source,true);if(this.ready){Voice.stopAllNotes(true);InstrumentVoice.panic();}pointers.clear();});
        document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stopAll();});
    },
    updateOctave(){const n=Number($('octaveShift').value);$('octaveDisplay').textContent='OCT '+(n>0?'+':'')+n;$('octaveDown').disabled=n<=-1;$('octaveUp').disabled=n>=1;},
    stopAll(stopRhythm=true) {
        Sustain.reset();InstrumentVoice.panic();
        this.stopDemo();for(const source of [...this.sources.keys()])this.up(source,true);this.sources.clear();this.noteOwners.clear();
        if(this.ready){Cthulhu.panic();Arpeggiator.stop();SynthState.arpeggiator.notes=[];Voice.stopAllNotes(true);if(stopRhythm)['kickToggle','sidechainToggle','gateToggle'].forEach(id=>{if($(id).checked){$(id).checked=false;$(id).dispatchEvent(new Event('change'));}});if(Synth.playbackAudio){Synth.playbackAudio.pause();if(this.recordingBlob)$('recordingStatus').textContent='Your take is ready';}}
        document.querySelectorAll('.key.active,[data-chord].active').forEach(k=>k.classList.remove('active'));
    },
    stopDemo(){this.demoRequest=(this.demoRequest||0)+1;this.demoLoading=false;this.demoTimers.forEach(clearTimeout);this.demoTimers=[];if(this.ready&&this.demoPlaying){Voice.stopAllNotes(true);InstrumentVoice.panic();}this.demoPlaying=false;$('demoButton').innerHTML='<span>▶</span> Hear it';$('demoButton').classList.remove('playing');},
    async playDemo() {
        if(!this.enableAudio())return;
        const request=this.demoRequest=(this.demoRequest||0)+1;
        this.demoLoading=true;
        if($('synthMode').value==='instrument'&&InstrumentVoice.isPiano($('instrumentType').value)&&PianoSamples.state!=='ready')$('demoButton').textContent='■ Cancel loading';
        const prepared=await this.prepareInstrument();
        if(request!==this.demoRequest)return;
        if(!prepared){this.stopDemo();return;}
        this.stopAll(false);this.demoPlaying=true;$('demoButton').innerHTML='<span>■</span> Stop demo';$('demoButton').classList.add('playing');
        const beat=60000/Tempo.bpm,category=this.current.category;let events=[];
        if(category==='Piano'){
            const progression=[['A2','A3','C4','E4','B4'],['F2','A3','C4','E4','A4'],['C3','G3','B3','D4','G4'],['G2','G3','B3','D4','A4']];
            progression.forEach((notes,chord)=>notes.forEach((note,i)=>events.push({notes:[note],at:chord*beat*2+i*38,length:beat*1.65,velocity:[.7,.56,.67,.77,.6][i]+(chord%2)*.05})));
        }
        else if(category==='Pad'){events=[{notes:['A3','C4','E4'],at:0,length:beat*4},{notes:['F3','A3','C4'],at:beat*4.5,length:beat*4}];}
        else if(category==='Bass'){events=[45,45,45,48,45,43,45,40,41,41,43,43,45,48,43,45].map((m,i)=>({notes:[CthulhuConfig.midiToNote(m)],at:i*beat*.5,length:beat*.34}));}
        else if(category==='Keys'){events=[['A3','C4','E4'],['F3','A3','C4'],['C4','E4','G4'],['G3','B3','D4']].map((notes,i)=>({notes,at:i*beat*2,length:beat*1.65}));}
        else{events=[69,76,72,76,67,74,71,74,65,72,69,72,67,71,74,72].map((m,i)=>({notes:[CthulhuConfig.midiToNote(m)],at:i*beat*.5,length:beat*(category==='Lead'?.39:.23)}));}
        events.forEach((event,i)=>{this.demoTimers.push(setTimeout(()=>{if(this.demoPlaying)event.notes.forEach(note=>Voice.play(note,true,event.velocity??[.78,.63,.87,.72][i%4]));},event.at));this.demoTimers.push(setTimeout(()=>event.notes.forEach(note=>Voice.release(note,true)),event.at+event.length));});
        const last=events.at(-1);this.demoTimers.push(setTimeout(()=>this.stopDemo(),last.at+last.length+300));
    },
    bindDialogs() {
        const confirmDialog=document.createElement('dialog');confirmDialog.id='confirmDialog';
        confirmDialog.innerHTML='<h2>One quick check.</h2><p id="confirmMessage"></p><div class="dialog-actions"><button id="cancelAction">Keep it</button><button id="confirmAction" class="primary-button">Confirm</button></div>';
        document.body.append(confirmDialog);
        $('helpButton').addEventListener('click',()=>$('helpDialog').showModal());
        $('savePresetButton').addEventListener('click',()=>{this.stopDemo();$('patchNameInput').value=this.current.name+(this.current.id.startsWith('factory:')?' — edit':'');$('saveError').hidden=true;$('saveDialog').showModal();$('patchNameInput').select();});
        document.querySelectorAll('[data-close-dialog]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
        document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}}));
        $('savePatchForm').addEventListener('submit',async e=>{
            e.preventDefault();const name=$('patchNameInput').value.trim();if(!name)return;
            if(Object.hasOwn(PresetManager.getPresets(),name)&&!await this.ask(`Replace your saved patch “${name}”?`,'Replace patch'))return;
            const settings=this.snapshot();
            if(!PresetManager.savePreset(name,settings)){$('saveError').textContent='Browser storage is full or unavailable. Download your patch instead.';$('saveError').hidden=false;return;}
            $('saveDialog').close();this.collection='user';this.category='All';$('presetSearch').value='';this.current={id:'user:'+name,name,category:'User',color:'sand',description:'A sound you made your own. Keep exploring, or record an idea.',settings};this.selectPatch(this.current,false);this.updateFilters();this.toast('Saved to your sound library.');
        });
        $('downloadPatch').addEventListener('click',()=>{this.download(JSON.stringify({format:'browsynth-patch',version:2,name:$('patchNameInput').value.trim()||this.current.name,settings:this.snapshot()},null,2),'browsynth-patch.json','application/json');this.toast('Patch downloaded.');});
    },
    ask(message,action) {
        return new Promise(resolve=>{
            const dialog=$('confirmDialog');$('confirmMessage').textContent=message;$('confirmAction').textContent=action;
            const finish=value=>{dialog.close();resolve(value);};
            $('cancelAction').onclick=()=>finish(false);$('confirmAction').onclick=()=>finish(true);
            dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.showModal();$('cancelAction').focus();
        });
    },
    snapshot(){if(this.ready)return PresetManager.getCurrentSettings();const settings=structuredClone(PATCH_DEFAULTS);Object.keys(settings).forEach(id=>{const el=$(id);if(el)settings[id]=el.type==='checkbox'?el.checked:el.value;});settings.globalBpm=Number($('globalBpm').value);settings.__gate=TranceGate.snapshot();if(this.current.settings.__cthulhu)settings.__cthulhu=structuredClone(this.current.settings.__cthulhu);if(this.current.settings.__wavetable)settings.__wavetable=structuredClone(this.current.settings.__wavetable);return settings;},
    async importPatch(file){if(!file)return;try{const data=JSON.parse(await file.text());if(data.format!=='browsynth-patch'||!data.settings||typeof data.name!=='string')throw Error('Choose a Browsynth patch file.');const settings=this.validateSettings(data.settings);const name=data.name.trim().slice(0,60)||'Imported patch';if(Object.hasOwn(PresetManager.getPresets(),name)&&!await this.ask(`Replace “${name}” with the imported patch?`, 'Replace patch'))return;if(!PresetManager.savePreset(name,settings))throw Error('Browser storage is unavailable.');this.collection='user';this.category='All';$('presetSearch').value='';this.selectPatch(this.patches().find(p=>p.id==='user:'+name));this.updateFilters();this.toast('Patch imported.');}catch(error){this.toast(error.message||'This patch could not be read.');}finally{$('importPatch').value='';}},
    validateSettings(raw) {
        if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid patch settings.');
        const settings=structuredClone(PATCH_DEFAULTS);
        const clamp=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
        if(raw.globalBpm!==undefined)settings.globalBpm=Math.round(clamp(raw.globalBpm,40,300,Tempo.bpm));
        for(const [id,value]of Object.entries(raw)){
            const el=$(id);if(!el||!Object.hasOwn(PATCH_DEFAULTS,id))continue;
            if(el.type==='checkbox')settings[id]=value===true;
            else if(el.tagName==='SELECT'){if([...el.options].some(o=>o.value===String(value)))settings[id]=value;}
            else settings[id]=clamp(value,el.min===''?-Infinity:Number(el.min),el.max===''?Infinity:Number(el.max),PATCH_DEFAULTS[id]);
        }
        if(raw.__version!==2&&raw.filterCutoff!==undefined)settings.filterCutoff=20*Math.pow(1000,(Number(settings.filterCutoff)-20)/19980);
        if(Array.isArray(raw.__gate?.pattern)&&raw.__gate.pattern.length===16)settings.__gate={pattern:raw.__gate.pattern.map(value=>value?1:0)};
        if(raw.__cthulhu&&typeof raw.__cthulhu==='object'){
            settings.__cthulhu={enabled:raw.__cthulhu.enabled===true};const arp=raw.__cthulhu.arp;
            if(arp&&Array.isArray(arp.steps))settings.__cthulhu.arp={latch:arp.latch===true,bpm:settings.globalBpm??Math.round(clamp(arp.bpm,40,300,Tempo.bpm)),
                rate:Object.hasOwn(CthulhuConfig.RATE_MAP,arp.rate)?arp.rate:'1/16',length:Math.round(clamp(arp.length,1,16,16)),
                swing:clamp(arp.swing,0,.5,0),strum:clamp(arp.strum,-150,150,0),
                steps:arp.steps.slice(0,16).map(step=>({tones:Array.isArray(step?.tones)?step.tones.filter(t=>t==='rand'||Number.isInteger(t)&&t>=1&&t<=8):[],octave:Math.round(clamp(step?.octave,-2,2,0)),velocity:clamp(step?.velocity,0,1,1),gate:clamp(step?.gate,.05,1,.85)}))};
        }
        if(Array.isArray(raw.__wavetable)&&raw.__wavetable.length>0&&raw.__wavetable.length<=64&&raw.__wavetable.every(frame=>Array.isArray(frame)&&frame.length===2048&&frame.every(value=>Number.isFinite(value))))settings.__wavetable=raw.__wavetable.map(frame=>frame.map(value=>Math.max(-1,Math.min(1,value))));
        settings.__version=2;return settings;
    },
    download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);},
    toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500);},
    drawScope() {
        const canvas=$('visualizer'),ctx=canvas.getContext('2d');const data=new Float32Array(2048);let frame=0;
        const draw=()=>{
            requestAnimationFrame(draw);if(document.hidden)return;const rect=canvas.getBoundingClientRect();if(!rect.width)return;
            const dpr=Math.min(devicePixelRatio,2),w=rect.width,h=rect.height;
            if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
            ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);let peak=0;
            if(this.ready){Synth.analyser.getFloatTimeDomainData(data);for(const v of data)peak=Math.max(peak,Math.abs(v));}
            ctx.strokeStyle='#c4ed94';ctx.lineWidth=1.3;ctx.beginPath();
            if(this.ready&&peak>.0002){
                if(this.scopeMode==='orbit'){for(let i=0;i<1500;i++){const x=w/2+data[i]*h*.65,y=h/2+data[i+170]*h*.65;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}}
                else{let start=0;for(let i=1;i<512;i++)if(data[i-1]<0&&data[i]>=0){start=i;break;}for(let i=0;i<1024;i++){const x=i/1023*w,y=h/2+data[start+i]*h*.44;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}}
            }else{for(let i=0;i<=w;i+=2){const envelope=Math.exp(-Math.pow((i-w*.5)/(w*.24),2));const amplitude=this.ready?1.8:24;const y=h/2+Math.sin(i*.12)*Math.sin(i*.013+frame*.003)*envelope*amplitude;i?ctx.lineTo(i,y):ctx.moveTo(i,y);}}
            ctx.stroke();frame++;
            if(frame%6===0){$('voiceCount').textContent=String(Object.keys(SynthState.activeVoices).length).padStart(2,'0')+' / 16 VOICES';$('signalLevel').textContent=peak>.0001?Math.round(20*Math.log10(peak))+' dB':'−∞ dB';const beat=this.ready?Synth.audioContext.currentTime/(60/Tempo.bpm):0;$('tempoLight').classList.toggle('pulse',this.ready&&(beat%1)<.1);}
        };draw();
    },
    bindRecording() {
        $('recordButton').addEventListener('click',()=>this.startRecording());
        $('stopButton').addEventListener('click',()=>this.stopRecording());
        $('playButton').addEventListener('click',()=>this.playRecording());
        $('exportWavButton').addEventListener('click',()=>this.exportWav());
        $('saveButton').addEventListener('click',()=>this.saveSession());
        const file=document.createElement('input');file.type='file';file.accept='.json';file.hidden=true;document.body.append(file);
        $('loadButton').addEventListener('click',()=>file.click());file.addEventListener('change',()=>{this.loadSession(file.files[0]);file.value='';});
    },
    recordingButtons(recording,ready=false){$('recordButton').disabled=recording;$('recordButton').classList.toggle('recording',recording);$('stopButton').disabled=!recording;['playButton','saveButton','exportWavButton'].forEach(id=>$(id).disabled=!ready);$('loadButton').disabled=recording;},
    startRecording() {
        if(!this.enableAudio())return;
        if(typeof MediaRecorder==='undefined'){this.toast('Recording is not supported by this browser. Try Chrome or Edge.');return;}
        try{
            if(Synth.playbackAudio)Synth.playbackAudio.pause();
            this.recordingSettings=this.snapshot();this.recordingName=this.current.name;
            this.recordingDestination=Synth.audioContext.createMediaStreamDestination();Synth.analyser.connect(this.recordingDestination);
            const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
            Synth.recordedChunks=[];Synth.recordedNotes=[];Synth.recordingStartTime=Synth.audioContext.currentTime;
            Synth.recorder=new MediaRecorder(this.recordingDestination.stream,mime?{mimeType:mime}:undefined);
            Synth.recorder.ondataavailable=e=>{if(e.data.size)Synth.recordedChunks.push(e.data);};
            Synth.recorder.onerror=e=>{console.error(e);this.toast('Recording failed. Please try again.');this.finishRecording();};
            Synth.recorder.onstop=()=>this.finishRecording();Synth.recorder.start(200);
            this.recordStarted=performance.now();this.recordingButtons(true);$('recordingStatus').textContent='Recording your output';
            this.recordTimer=setInterval(()=>{const seconds=Math.floor((performance.now()-this.recordStarted)/1000);$('recordingTime').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');},200);
        }catch(error){console.error(error);this.finishRecording();this.toast('Recording could not start.');}
    },
    stopRecording(){if(Synth.recorder?.state==='recording'){Synth.recorder.stop();$('stopButton').disabled=true;$('recordingStatus').textContent='Finishing take…';}},
    finishRecording(){clearInterval(this.recordTimer);if(this.recordingDestination){Synth.analyser.disconnect(this.recordingDestination);this.recordingDestination.stream.getTracks().forEach(track=>track.stop());this.recordingDestination=null;}this.recordingBlob=new Blob(Synth.recordedChunks,{type:Synth.recorder?.mimeType||'audio/webm'});this.recordingButtons(false,this.recordingBlob.size>0);$('recordingStatus').textContent=this.recordingBlob.size?'Your take is ready':'No audio captured';if(this.playbackURL)URL.revokeObjectURL(this.playbackURL);this.playbackURL=null;if(Synth.playbackSource){Synth.playbackSource.disconnect();Synth.playbackSource=null;}Synth.playbackAudio=null;},
    async playRecording(){if(!this.recordingBlob||!this.enableAudio())return;try{this.stopAll();if(!Synth.playbackAudio){this.playbackURL=URL.createObjectURL(this.recordingBlob);Synth.playbackAudio=new Audio(this.playbackURL);Synth.playbackSource=Synth.audioContext.createMediaElementSource(Synth.playbackAudio);Synth.playbackSource.connect(Synth.analyser);Synth.playbackAudio.onended=()=>{$('recordingStatus').textContent='Your take is ready';};}Synth.playbackAudio.currentTime=0;await Synth.playbackAudio.play();$('recordingStatus').textContent='Playing your take';}catch(error){console.error(error);this.toast('This recording could not be played.');}},
    async exportWav(){if(!this.recordingBlob||!this.enableAudio())return;$('exportWavButton').disabled=true;try{const buffer=await Synth.audioContext.decodeAudioData(await this.recordingBlob.arrayBuffer());const wave=encodeWav(buffer);this.download(wave,'browsynth-'+(this.recordingName||'take').toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.wav','audio/wav');this.toast('WAV exported · 24-bit stereo');}catch(error){console.error(error);this.toast('Could not convert this recording to WAV.');}finally{$('exportWavButton').disabled=false;}},
    async saveSession(){if(!this.recordingBlob)return;const audio=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(this.recordingBlob);});this.download(JSON.stringify({format:'browsynth-session',version:2,name:this.recordingName,audio,presets:this.recordingSettings,notes:Synth.recordedNotes}),'browsynth-session.json','application/json');this.toast('Session saved with audio and patch settings.');},
    async loadSession(file){if(!file)return;try{if(file.size>100*1024*1024)throw Error('Please choose a session under 100 MB.');const data=JSON.parse(await file.text());if(typeof data.audio!=='string'||!/^data:audio\/(webm|mp4|ogg|wav)(;codecs=[\w.,-]+)?;base64,/.test(data.audio))throw Error('Choose a Browsynth recording session.');if(!this.enableAudio())return;const settings=this.validateSettings(data.presets);const bytes=Uint8Array.from(atob(data.audio.split(',')[1]),c=>c.charCodeAt(0));const mime=data.audio.slice(5,data.audio.indexOf(';'));const decoded=await Synth.audioContext.decodeAudioData(bytes.buffer.slice(0));this.stopAll();if(Synth.playbackSource)Synth.playbackSource.disconnect();Synth.playbackAudio=null;Synth.playbackSource=null;if(this.playbackURL)URL.revokeObjectURL(this.playbackURL);this.playbackURL=null;this.recordingBlob=new Blob([bytes],{type:mime});Synth.recordedChunks=[this.recordingBlob];Synth.recordedNotes=Array.isArray(data.notes)?data.notes:[];this.recordingName=data.name||'Loaded session';this.recordingSettings=settings;this.selectPatch({id:'session',name:this.recordingName,category:'Session',description:'Your recording and the sound you captured. Press Play below to listen.',settings},false,{restoreTempo:true});this.recordingButtons(false,true);const seconds=Math.round(decoded.duration);$('recordingTime').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');$('recordingStatus').textContent='Session loaded';this.toast('Session loaded.');}catch(error){console.error(error);this.toast(error.message||'Could not open this session.');}}
};

// Write the actual buffer sample rate: changing only a WAV header changes pitch
// and duration. The 24-bit PCM stream keeps every decoded frame and channel.
function encodeWav(buffer) {
    const channels=buffer.numberOfChannels,bytes=buffer.length*channels*3;
    const array=new ArrayBuffer(44+bytes),view=new DataView(array);
    const str=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
    str(0,'RIFF');view.setUint32(4,36+bytes,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*3,true);view.setUint16(32,channels*3,true);view.setUint16(34,24,true);str(36,'data');view.setUint32(40,bytes,true);
    const data=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));let offset=44;
    for(let i=0;i<buffer.length;i++)for(let channel=0;channel<channels;channel++){const sample=Math.max(-1,Math.min(1,data[channel][i]));const value=Math.round(sample*(sample<0?8388608:8388607));view.setUint8(offset++,value&255);view.setUint8(offset++,(value>>8)&255);view.setUint8(offset++,(value>>16)&255);}
    return array;
}

// One visualizer and one initialization path. The audio engine retains its
// synthesis, MIDI, wavetable and step-sequencer implementations.
Synth.updateVisualizer=()=>{};
document.addEventListener('DOMContentLoaded',()=>Studio.init());
if(new URLSearchParams(location.search).has('test')) {
    window.BrowsynthTest = {Synth, SynthState, Voice, PresetManager, TuningSystem, Studio, FACTORY_PATCHES, KeyboardMapping, Tempo, TranceGate, PianoSamples, InstrumentVoice, Sustain, MIDIHandler, encodeWav};
}
