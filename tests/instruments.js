'use strict';

async function checkInstruments(frame,report) {
    const {Synth,SynthState,Voice,Studio,PianoSamples,InstrumentVoice,Sustain,MIDIHandler,TuningSystem,FACTORY_PATCHES}=frame.contentWindow.BrowsynthTest;
    const doc=frame.contentDocument;
    const grand=FACTORY_PATCHES.find(p=>p.name==='Studio Grand');
    const setup=(seconds=1)=>{
        Sustain.reset();for(const voice of [...InstrumentVoice.active])voice.dispose();
        SynthState.activeVoices={};SynthState.activeNotes.clear();
        const ctx=new OfflineAudioContext(2,Math.ceil(seconds*48000),48000);Synth.initAudioContext(ctx);
        Studio.selectPatch(grand,false);TuningSystem.divisions=12;return ctx;
    };
    report(PianoSamples.buffers.size===66&&[...PianoSamples.buffers.values()].every(b=>b.duration>.2&&b.numberOfChannels===2),'All 66 stereo recordings decoded: 22 notes, three playing strengths');
    const energies=[];
    for(const velocity of [.25,1]){
        const ctx=setup(2);
        ['C2','G2','C3','E3','A4','C5','E6','B6'].forEach(note=>Voice.play(note,true,velocity));
        const buffer=await ctx.startRendering();let energy=0,peak=0;
        for(const value of buffer.getChannelData(0)){energy+=value*value;peak=Math.max(peak,Math.abs(value));}
        const rms=Math.sqrt(energy/buffer.length);energies.push(rms);
        report(Number.isFinite(rms)&&rms>.001&&peak<1,`Grand piano ${velocity<.5?'soft':'firm'} chords across C2–B6: RMS ${rms.toFixed(4)}, peak ${peak.toFixed(4)}`);
    }
    report(energies[1]>energies[0]*1.3,'Firm piano strikes are measurably stronger than soft strikes');

    let ctx=setup();
    MIDIHandler.handleCC(64,127);Voice.play('C4',false,.6);Voice.release('C4');
    const first=SynthState.activeVoices.C4;
    report(!!first&&Sustain.pending.has('C4'),'MIDI sustain retains a released piano note');
    Voice.play('C4',false,.8);
    report(SynthState.activeVoices.C4!==first&&!Sustain.pending.has('C4'),'Repeated piano notes retrigger while the pedal is down');
    Voice.release('C4');MIDIHandler.handleCC(64,0);
    report(!SynthState.activeVoices.C4&&!Sustain.pending.size,'Pedal release damps notes that are no longer held');
    await ctx.startRendering();
    report(InstrumentVoice.active.size===0,'Released piano sources disconnect after their audio-clock tails');

    ctx=setup(.5);Voice.play('A4',true,.6);
    const bent=SynthState.activeVoices.A4;bent.pitchBend.range=12;bent.retune(660);bent.updatePitchBend(.5);
    await ctx.startRendering();
    report(bent.sources.filter(source=>source.buffer).every(source=>Math.abs(source.playbackRate.value-660/440*Math.sqrt(2))<.001),'Sample pitch follows retuning and pitch bend together');

    ctx=setup(.4);
    for(let i=0;i<20;i++)Voice.play(['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][i%12]+(3+Math.floor(i/12)),true,.65);
    report(Object.keys(SynthState.activeVoices).length===16,'Sampled piano respects the 16-note voice limit');
    Sustain.set('button',true);Studio.stopAll();await ctx.startRendering();
    report(!Sustain.on&&Sustain.pending.size===0&&InstrumentVoice.active.size===0,'Stop all clears the pedal, held notes, and released instrument tails');

    const saved=Studio.validateSettings({__version:2,synthMode:'instrument',instrumentType:'kalimba',instrumentTone:.37});
    report(saved.instrumentType==='kalimba'&&saved.instrumentTone===.37&&saved.synthMode==='instrument','Patch imports retain instrument model and tone');
    ctx=setup(1.4);Studio.selectPatch(FACTORY_PATCHES.find(p=>p.name==='Suitcase EP'),false);
    const paused=ctx.suspend(.4),rendering=ctx.startRendering();await paused;
    Voice.play('A4',true,.8);await ctx.resume();
    const late=(await rendering).getChannelData(0);let lateEnergy=0;
    for(let i=24000;i<48000;i++)lateEnergy+=late[i]*late[i];
    report(Math.sqrt(lateEnergy/24000)>.005,'Electric-piano strikes retain their attack after the audio clock has been running');
    for(const voice of [...InstrumentVoice.active])voice.dispose();
    doc.querySelector('[data-collection="new"]').click();
    report(doc.querySelectorAll('#presetList .preset-row').length===12,'New collection shows all 12 additions');
    Studio.collection='all';Studio.updateFilters();

    const bank=Object.create(PianoSamples);
    Object.assign(bank,{buffers:new Map(),state:'idle',promise:null,loaded:0,total:1,roots:[60],layers:[8]});
    const win=frame.contentWindow,fetchOriginal=win.fetch;
    try{
        win.fetch=async()=>new win.Response('',{status:503});
        const firstLoad=bank.load();
        report(bank.load()===firstLoad,'Concurrent piano requests share one loading operation');
        await firstLoad.catch(()=>{});
        report(bank.state==='error'&&bank.promise===null,'A missing recording leaves a recoverable loading error');
    }finally{win.fetch=fetchOriginal;}
    await bank.load();report(bank.state==='ready'&&bank.buffers.size===1,'Retry loads a recording after a failed request');

    const prepareOriginal=Studio.prepareInstrument,enableOriginal=Studio.enableAudio;
    try{
        let finish;Studio.prepareInstrument=()=>new Promise(resolve=>{finish=resolve;});Studio.enableAudio=()=>true;
        const preview=Studio.playDemo();Studio.selectPatch(FACTORY_PATCHES[0],false);finish(true);await preview;
        report(!Studio.demoPlaying&&!Studio.demoLoading&&Studio.current===FACTORY_PATCHES[0],'Changing sounds during loading cancels the pending demo');
    }finally{Studio.prepareInstrument=prepareOriginal;Studio.enableAudio=enableOriginal;}
}
