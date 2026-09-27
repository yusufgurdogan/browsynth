'use strict';
const frame=document.getElementById('instrument'),run=document.getElementById('run'),results=document.getElementById('results');
frame.addEventListener('load',()=>{run.disabled=false;results.textContent='Ready. Nothing is played through your speakers.';});
run.addEventListener('click',async()=>{
    run.disabled=true;results.textContent='';let failures=0;const report=(pass,message)=>{results.textContent+=(pass?'PASS  ':'FAIL  ')+message+'\n';if(!pass)failures++;};
    const {Synth,SynthState,Voice,PresetManager,TuningSystem,Studio,FACTORY_PATCHES,Tempo,TranceGate,PianoSamples,InstrumentVoice,encodeWav}=frame.contentWindow.BrowsynthTest;
    try{
        checkPlaying(frame,report);
        await PianoSamples.load();
        for(let index=0;index<FACTORY_PATCHES.length;index++){
            const patch=FACTORY_PATCHES[index];
            SynthState.activeVoices={};SynthState.activeNotes.clear();
            const context=new OfflineAudioContext(2,48000*3,48000);
            Synth.initAudioContext(context);
            if(index===0){Synth.start();Studio.ready=true;}
            PresetManager.applySettings(patch.settings);
            const notes=patch.category==='Bass'?['A2']:patch.category==='Pad'?['A3','C4','E4']:['A4'];
            notes.forEach(note=>Voice.play(note,true,.8));
            // Exercise the real envelope and effects with a scheduled release.
            Object.values(SynthState.activeVoices).forEach(voice=>{
                voice.gainNode.gain.cancelAndHoldAtTime(1.6);
                voice.gainNode.gain.setTargetAtTime(0,1.6,Math.max(.003,Number(patch.settings.release)/5));
            });
            const buffer=await context.startRendering();
            let peak=0,energy=0,finite=true;for(let channel=0;channel<2;channel++)for(const value of buffer.getChannelData(channel)){finite&&=Number.isFinite(value);peak=Math.max(peak,Math.abs(value));energy+=value*value;}
            const rms=Math.sqrt(energy/(buffer.length*2));
            report(finite&&peak>.005&&peak<1&&rms>.0005,`${patch.name}: peak ${peak.toFixed(4)}, RMS ${rms.toFixed(4)}, finite stereo output`);
            for(const voice of [...InstrumentVoice.active])voice.dispose();
            if(index===0){
                const wav=encodeWav(buffer),view=new DataView(wav);
                report(view.getUint32(24,true)===48000&&view.getUint16(22,true)===2&&view.getUint16(34,true)===24&&view.getUint32(40,true)===buffer.length*6,'WAV retains 48 kHz, stereo, 24 bits and all 144000 frames (3 seconds)');
            }
        }
        await checkInstruments(frame,report);
        TuningSystem.resetToDefaultTuning();TuningSystem.divisions=12;
        report(Math.abs(TuningSystem.noteToFreq('A4')-440)<.0001&&Math.abs(TuningSystem.noteToFreq('A5')-880)<.0001,'12-tone A4=440 Hz and A5=880 Hz');
        TuningSystem.divisions=24;
        report(Math.abs(TuningSystem.noteToFreq('A5')-440*Math.sqrt(2))<.0001,'24-tone divisions are generated locally');
        const testBuffer={numberOfChannels:1,length:3,sampleRate:44100,getChannelData:()=>Float32Array.from([-1,0,1])};
        const pcm=new DataView(encodeWav(testBuffer));
        report(pcm.getUint8(46)===128&&pcm.getUint8(47)===0&&pcm.getUint8(52)===127,'PCM maps negative and positive full scale correctly at 44.1 kHz');
        const migrated=Studio.validateSettings({filterCutoff:9860});
        report(Math.abs(migrated.filterCutoff-600.5)<3&&migrated.__version===2,'Legacy filter values migrate to Hz');
        const saved=Studio.validateSettings({__version:2,masterLowEQ:-4,filterCutoff:750});
        report(saved.masterLowEQ===-4&&saved.filterCutoff===750,'Imported settings preserve negative EQ and real frequency');
        report(FACTORY_PATCHES.every(p=>p.settings.__version===2&&!p.settings.kickToggle&&!p.settings.arpToggle&&!p.settings.__cthulhu.enabled),'Factory changes do not unexpectedly enable drums or sequencers');
        Tempo.set(123);
        for(const patch of FACTORY_PATCHES)Studio.selectPatch(patch,false);
        const legacy={__version:2,globalBpm:176,__cthulhu:{enabled:false,arp:{bpm:189,steps:[]}}};
        PresetManager.applySettings(legacy);
        report(Tempo.bpm===123&&frame.contentDocument.getElementById('globalBpm').value==='123'&&SynthState.cthulhu.arp.bpm===123,'All factory sounds and nested legacy sequencer settings preserve running tempo');
        PresetManager.applySettings(legacy,{restoreTempo:true});
        report(Tempo.bpm===176&&SynthState.cthulhu.arp.bpm===176,'An explicit session restore keeps the synth and sequencer at the saved tempo');
        const select=frame.contentDocument.getElementById('gatePreset');
        select.value='Offbeat';select.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true}));
        report(TranceGate.pattern.join('')==='0011001100110011','Gate pattern chooser loads Offbeat');
        frame.contentDocument.querySelector('#gatePattern button').click();
        report(select.value==='custom'&&Studio.snapshot().__gate.pattern[0]===1,'Edited gate steps become Custom and survive a patch snapshot');
        await checkGate(frame,report);
    }catch(error){report(false,error.stack||error.message);}
    results.textContent+=`\n${failures?'FAILED: '+failures+' checks':'ALL CHECKS PASSED'}`;
    results.className=failures?'fail':'pass';run.disabled=false;
});
