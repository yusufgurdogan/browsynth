'use strict';

function checkPlaying(frame, report) {
    const win=frame.contentWindow, doc=win.document;
    const {Studio, Voice, KeyboardMapping:keys, Tempo, FACTORY_PATCHES}=win.BrowsynthTest;
    const field=id=>doc.getElementById(id);
    Tempo.set(123);
    for(const patch of FACTORY_PATCHES) Studio.selectPatch(patch,false);
    const oldPatch={id:'test',name:'Legacy tempo',category:'User',description:'',settings:{__version:2,globalBpm:177,__cthulhu:{enabled:false,arp:{bpm:188,steps:[]}}}};
    Studio.selectPatch(oldPatch,false);
    report(Tempo.bpm===123&&field('globalBpm').value==='123','All factory sounds and legacy patches preserve tempo before audio starts');
    Studio.selectPatch(oldPatch,false,{restoreTempo:true});
    report(Tempo.bpm===177&&field('globalBpm').value==='177','Explicit session restore can restore tempo before audio starts');
    Studio.selectPatch(FACTORY_PATCHES[0],false);
    Tempo.set(138);

    const original={enable:Studio.enableAudio,play:Voice.play,release:Voice.release,profile:keys.profile};
    const played=[],released=[];
    // Exercise actual event handlers and ownership bookkeeping silently.
    Studio.enableAudio=()=>true;Voice.play=note=>played.push(note);Voice.release=note=>released.push(note);
    const send=(type,code,key,extra={},target=doc.body)=>target.dispatchEvent(new win.KeyboardEvent(type,{bubbles:true,cancelable:true,code,key,...extra}));
    try {
        field('whiteKeysOnlyToggle').checked=false;
        keys.profile='tr';Studio.updateKeyLabels();
        send('keydown','Period','ç');send('keydown','Slash','.');send('keydown','Semicolon','ş');
        report(Studio.sources.get('key:Period')?.[0]==='D4'&&Studio.sources.get('key:Slash')?.[0]==='E4'&&Studio.sources.get('key:Semicolon')?.[0]==='D#4','Turkish ç, . and ş hold three distinct notes together');
        report(doc.querySelector('[data-note="D4"] .key-label').textContent.includes('Ç')&&doc.querySelector('[data-note="D#4"] .key-label').textContent.includes('Ş')&&doc.querySelector('[data-note="E4"] .key-label').textContent.includes('.'),'Turkish labels appear on the correct piano keys');
        send('keyup','Period','Ç');send('keyup','Slash',':');send('keyup','Semicolon','Ş');
        report(Studio.sources.size===0&&released.length===3,'Releasing a key works even when its character changes with Shift');
        const count=played.length;
        send('keydown','Slash','/');send('keydown','Slash','/',{repeat:true});send('keyup','Slash','/');
        report(played.length===count+1&&played.at(-1)==='E4'&&doc.activeElement!==field('presetSearch'),'English slash plays a note once; it no longer opens search');
        send('keydown','KeyQ','q');send('keydown','Comma','ö');send('keyup','KeyQ','q');
        report(Studio.noteOwners.get('C4')===1&&Studio.sources.has('key:Comma'),'Two keys sharing one note do not cut each other off');
        send('keyup','Comma','ö');
        report(Studio.noteOwners.size===0,'The last owner releases a shared note');
        report(keys.noteForEvent({code:'KeyZ',key:'y'})==='C3'&&keys.noteForEvent({code:'KeyQ',key:'a'})==='C4'&&keys.noteForEvent({code:'KeyQ',key:'f'})==='C4','German, French and Turkish F letters keep the same physical fingering');
        report(keys.noteForEvent({code:'Numpad2',key:'ArrowDown'})==='D4'&&keys.noteForEvent({code:'NumpadDecimal',key:','})==='A3','Numpad works with Num Lock off and decimal comma');
        field('whiteKeysOnlyToggle').checked=true;field('whiteKeysOnlyToggle').dispatchEvent(new win.Event('change'));
        send('keydown','Period','ç');send('keydown','Slash','.');send('keydown','Semicolon','ş');
        report(Studio.sources.get('key:Period')?.[0]==='D4'&&Studio.sources.get('key:Slash')?.[0]==='E4'&&Studio.sources.get('key:Semicolon')?.[0]==='E5','White-notes mode also keeps Turkish punctuation distinct');
        field('whiteKeysOnlyToggle').checked=false;field('whiteKeysOnlyToggle').dispatchEvent(new win.Event('change'));
        report(Studio.sources.size===0&&Studio.noteOwners.size===0,'Changing keyboard mode releases held notes');
        const beforeTyping=played.length;
        send('keydown','KeyQ','q',{},field('presetSearch'));
        send('keydown','KeyQ','q',{isComposing:true});send('keydown','KeyQ','@',{ctrlKey:true,altKey:true});
        report(played.length===beforeTyping,'Typing in fields, composing text and AltGr do not trigger notes');
        send('keydown','KeyQ','q',{},field('gateToggle'));send('keyup','KeyQ','q',{},field('gateToggle'));
        send('keydown','KeyW','w',{},field('filterCutoff'));send('keyup','KeyW','w',{},field('filterCutoff'));
        report(played.length===beforeTyping+2&&Studio.sources.size===0,'Notes still play after toggling the gate or adjusting a knob');
        const beforeArrows=played.length;
        send('keydown','ArrowUp','ArrowUp',{},field('filterCutoff'));
        report(played.length===beforeArrows,'Arrow keys adjust focused knobs without playing extra notes');
        send('keydown','KeyK','k',{ctrlKey:true});
        report(doc.activeElement===field('presetSearch'),'Ctrl+K opens library search');field('presetSearch').blur();
    } finally {
        for(const source of [...Studio.sources.keys()])Studio.up(source,true);
        Studio.enableAudio=original.enable;Voice.play=original.play;Voice.release=original.release;
        keys.profile=original.profile;Studio.updateKeyLabels();
    }
}

async function checkGate(frame, report) {
    const {Synth,SynthState,Tempo,TranceGate:gate}=frame.contentWindow.BrowsynthTest;
    const saved={context:Synth.audioContext,gain:Synth.gateGain,pattern:gate.snapshot(),bpm:Tempo.bpm};
    const controls=SynthState.controls;
    const values={rate:controls.gateRate.value,depth:controls.gateDepth.value,smooth:controls.gateSmooth.value};
    try {
        controls.gateRate.value='1/16';controls.gateDepth.value='.8';controls.gateSmooth.value='.018';
        gate.restore({pattern:gate.patterns['Eighth pulse']});
        for(const bpm of [40,138,300]) {
            Tempo.set(bpm);
            const rate=240/bpm/16,ctx=new OfflineAudioContext(1,Math.ceil(rate*16*48000),48000);
            Synth.audioContext=ctx;Synth.gateGain=ctx.createGain();
            const source=ctx.createConstantSource();source.connect(Synth.gateGain);Synth.gateGain.connect(ctx.destination);source.start(0);
            gate.lastTarget=1;for(let i=0;i<16;i++)gate.scheduleStep(i,i*rate);
            const rendered=await ctx.startRendering(),data=rendered.getChannelData(0);
            let good=true,jump=0;
            for(let i=0;i<16;i++)good&&=Math.abs(data[Math.floor((i+.5)*rate*48000)]-(gate.pattern[i]?1:.2))<.001;
            for(let i=1;i<data.length;i++)jump=Math.max(jump,Math.abs(data[i]-data[i-1]));
            report(good&&jump<.002,`Gate at ${bpm} BPM: correct pulse, 80% depth, smooth edges without gain jumps`);
        }
    } finally {
        Synth.audioContext=saved.context;Synth.gateGain=saved.gain;Tempo.set(saved.bpm);gate.restore(saved.pattern);
        controls.gateRate.value=values.rate;controls.gateDepth.value=values.depth;controls.gateSmooth.value=values.smooth;
    }
}
