'use strict';

const PianoSamples = {
    buffers: new Map(), state: 'idle', promise: null, loaded: 0, total: 66,
    roots: Array.from({length:22},(_,i)=>33+i*3), layers: [4,8,12],
    filename(midi,layer) {
        return ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'][midi%12]+(Math.floor(midi/12)-1)+'-v'+layer+'.mp3';
    },
    notify() { document.dispatchEvent(new CustomEvent('pianosamples',{detail:{state:this.state,loaded:this.loaded,total:this.total}})); },
    load(context) {
        if(this.state==='ready')return Promise.resolve();
        if(this.promise)return this.promise;
        this.state='loading';this.notify();
        const decoder=context||new OfflineAudioContext(2,1,44100);
        const jobs=this.roots.flatMap(root=>this.layers.map(layer=>({root,layer,key:root+':'+layer}))).filter(job=>!this.buffers.has(job.key));
        this.promise=(async()=>{
            const worker=async()=>{
                while(jobs.length){
                    const job=jobs.shift();
                    const response=await fetch('samples/piano/'+this.filename(job.root,job.layer));
                    if(!response.ok)throw Error('Piano sample unavailable: '+response.status);
                    const buffer=await decoder.decodeAudioData(await response.arrayBuffer());
                    if(buffer.duration<.1||buffer.numberOfChannels!==2)throw Error('Invalid piano recording');
                    this.buffers.set(job.key,buffer);this.loaded=this.buffers.size;this.notify();
                }
            };
            const results=await Promise.allSettled(Array.from({length:4},worker));
            const failure=results.find(result=>result.status==='rejected');
            if(failure)throw failure.reason;
            this.state='ready';this.notify();
        })().catch(error=>{this.state='error';this.notify();throw error;}).finally(()=>{this.promise=null;});
        return this.promise;
    },
    layersFor(velocity) {
        const v=Math.max(0,Math.min(1,velocity));
        if(v<=.25)return [{layer:4,weight:1}];
        if(v<.6){const t=(v-.25)/.35;return [{layer:4,weight:1-t},{layer:8,weight:t}];}
        const t=(v-.6)/.4;return [{layer:8,weight:1-t},{layer:12,weight:t}];
    },
    nearest(frequency) {
        const midi=69+12*Math.log2(frequency/440);
        return this.roots.reduce((a,b)=>Math.abs(a-midi)<=Math.abs(b-midi)?a:b);
    }
};

const InstrumentVoice = {
    active: new Set(),
    isPiano(type) { return ['grand','felt','dream'].includes(type); },
    create(note,velocity=1) {
        const ctx=Synth.audioContext,now=ctx.currentTime,c=SynthState.controls;
        const type=c.instrumentType.value,piano=this.isPiano(type);
        if(piano&&PianoSamples.state!=='ready')return null;
        velocity=Math.max(.01,Math.min(1,velocity));
        let frequency=TuningSystem.noteToFreq(note),released=false,disposed=false,started=false;
        const nodes=[],sources=[],pitched=[],oscillators=[];
        const gainNode=ctx.createGain(),filter=ctx.createBiquadFilter(),tone=ctx.createBiquadFilter();
        const tremolo=ctx.createGain();tremolo.gain.value=1;
        gainNode.gain.value=0;tone.type='lowpass';tone.Q.value=.4;
        tone.connect(filter);filter.connect(tremolo);tremolo.connect(gainNode);gainNode.connect(Synth.compressor);
        nodes.push(tone,filter,tremolo,gainNode);
        const pitchBend={bend:0,range:parseInt(c.pitchBendRange.value)||2};
        const decay=Math.max(.15,Number(c.decay.value));
        const updateVoice=()=>{
            const brightness=Number(c.instrumentTone.value);
            const set=(param,value)=>started?param.setTargetAtTime(value,ctx.currentTime,.015):param.setValueAtTime(value,ctx.currentTime);
            set(tone.frequency,Math.min(ctx.sampleRate*.45,900*Math.pow(18,brightness)*(.65+velocity*.5)));
            filter.type=c.filterToggle.checked?c.filterType.value:'allpass';
            set(filter.frequency,Number(c.filterCutoff.value));set(filter.Q,Number(c.filterResonance.value));
        };
        const updatePitchBend=bend=>{
            pitchBend.bend=bend;
            const ratio=Math.pow(2,bend*pitchBend.range/12);
            pitched.forEach(p=>p.param.setTargetAtTime(frequency*p.ratio*ratio,ctx.currentTime,.01));
        };
        const addOsc=(ratio,level,tail=0,wave='sine',cents=0)=>{
            if(frequency*ratio>ctx.sampleRate*.45)return null;
            const osc=ctx.createOscillator(),amp=ctx.createGain();
            osc.type=wave;osc.frequency.value=frequency*ratio;osc.detune.value=cents;amp.gain.setValueAtTime(level,now);
            if(tail)amp.gain.exponentialRampToValueAtTime(.00001,now+Math.max(.04,tail));
            osc.connect(amp);amp.connect(tone);sources.push(osc);oscillators.push(osc);nodes.push(amp);
            pitched.push({param:osc.frequency,ratio});return osc;
        };
        const addFM=(carrier,ratio,index,tail)=>{
            if(!carrier)return;
            const mod=ctx.createOscillator(),amount=ctx.createGain();
            mod.frequency.value=frequency*ratio;amount.gain.setValueAtTime(frequency*index,now);
            amount.gain.exponentialRampToValueAtTime(frequency*.015,now+tail);
            mod.connect(amount);amount.connect(carrier.frequency);sources.push(mod);nodes.push(amount);
            pitched.push({param:mod.frequency,ratio});
        };
        const addTremolo=(rate,depth)=>{
            const lfo=ctx.createOscillator(),amount=ctx.createGain();
            lfo.frequency.value=rate;amount.gain.value=depth;tremolo.gain.value=1-depth;
            lfo.connect(amount);amount.connect(tremolo.gain);sources.push(lfo);nodes.push(amount);
        };
        let naturalEnd=0;
        if(piano){
            const root=PianoSamples.nearest(frequency),rootHz=440*Math.pow(2,(root-69)/12);
            for(const {layer,weight} of PianoSamples.layersFor(velocity)){
                if(weight<.001)continue;
                const source=ctx.createBufferSource(),amp=ctx.createGain();
                source.buffer=PianoSamples.buffers.get(root+':'+layer);source.playbackRate.value=frequency/rootHz;amp.gain.value=weight;
                source.connect(amp);amp.connect(tone);sources.push(source);nodes.push(amp);
                pitched.push({param:source.playbackRate,ratio:1/rootHz});
            }
        }else if(type==='tines'){
            const carrier=addOsc(1,.7,5*decay);
            addFM(carrier,1,.15+velocity*velocity*1.7,.85*decay);
            addOsc(2,.12,1.8*decay);addOsc(7.01,.045*velocity,.18*decay);naturalEnd=7*decay;
        }else if(type==='reed'){
            addOsc(1,.66,4*decay);addOsc(2,.23*velocity,2.2*decay);addOsc(3,.12*velocity,.85*decay);
            addOsc(4,.035,.35*decay);addTremolo(4.6,.07);naturalEnd=6*decay;
        }else if(type==='fmkeys'){
            const carrier=addOsc(1,.7,4.5*decay);
            addFM(carrier,2,.5+velocity*velocity*3.2,.7*decay);
            addOsc(1.002,.1,2.8*decay);naturalEnd=6*decay;
        }else if(['marimba','kalimba','vibes'].includes(type)){
            const modal=type==='marimba'?[[1,.85,2],[3.99,.25,.22],[9.96,.07,.09],[16.9,.025,.05]]:
                type==='kalimba'?[[1,.75,2.8],[2.76,.2,.35],[5.4,.1,.15],[8.93,.04,.07]]:
                [[1,.7,4.5],[3.99,.2,1.3],[10,.07,.4],[17.1,.025,.16]];
            const length=Math.max(.6,Math.min(1.6,Math.sqrt(330/frequency)))*decay;
            modal.forEach(([ratio,level,tail])=>addOsc(ratio,level,tail*length));
            if(type==='vibes')addTremolo(5.2,.09);
            naturalEnd=6*length;
        }else if(type==='organ'){
            [[.5,.2],[1,.6],[2,.28],[3,.16],[4,.09],[6,.04],[8,.02]].forEach(([ratio,level])=>addOsc(ratio,level));
            addOsc(3,.07,.15);addTremolo(5.7,.025);
        }else if(type==='strings'){
            [-11,-3,4,12].forEach(cents=>addOsc(1,.18,0,'sawtooth',cents));
        }else if(type==='choir'){
            const harmonics=[];
            for(let i=1;i<=20&&frequency*i<6000;i++){
                const f=frequency*i;
                const formants=.12+2.4*Math.exp(-(((f-750)/200)**2))+2*Math.exp(-(((f-1150)/240)**2))+1.3*Math.exp(-(((f-2800)/500)**2));
                harmonics.push([i,formants/i]);
            }
            const total=harmonics.reduce((sum,[,amp])=>sum+amp,0);
            harmonics.forEach(([ratio,amp])=>addOsc(ratio,amp/total*1.3));
        }
        if(type==='strings'||type==='choir'){
            const lfo=ctx.createOscillator(),depth=ctx.createGain();lfo.frequency.value=5.1;depth.gain.setValueAtTime(0,now);
            depth.gain.linearRampToValueAtTime(type==='choir'?7:4,now+.8);
            lfo.connect(depth);oscillators.forEach(osc=>depth.connect(osc.detune));sources.push(lfo);nodes.push(depth);
        }
        let remaining=sources.length;
        const dispose=()=>{
            if(disposed)return;disposed=true;
            sources.forEach(source=>{try{source.stop();}catch{}source.disconnect();});nodes.forEach(node=>node.disconnect());
            this.active.delete(voice);
            if(SynthState.activeVoices[note]===voice){
                delete SynthState.activeVoices[note];SynthState.activeNotes.delete(note);
                document.querySelector(`.key[data-note="${note}"]`)?.classList.remove('active');
            }
        };
        const voice={gainNode,filter,oscillators,sources,pitchBend,updateVoice,updatePitchBend,dispose,
            retune(next){frequency=next;updatePitchBend(pitchBend.bend);},
            start(){
                started=true;
                const attack=Math.max(.002,Number(c.attack.value));
                const peak=(piano?1.25:type==='organ'?.38:.5)*Math.pow(velocity,piano?.65:1);
                gainNode.gain.setValueAtTime(0,now);gainNode.gain.linearRampToValueAtTime(peak,now+attack);
                gainNode.gain.setTargetAtTime(peak*Number(c.sustain.value),now+attack,Math.max(.01,decay/4));
                if(c.filterToggle.checked){
                    const base=Number(c.filterCutoff.value),peakHz=Math.min(ctx.sampleRate*.45,base*(1+Number(c.filterEnvAmount.value)*10));
                    filter.frequency.setValueAtTime(base,now);filter.frequency.linearRampToValueAtTime(peakHz,now+attack);
                    filter.frequency.exponentialRampToValueAtTime(Math.max(20,base),now+attack+Math.max(.01,decay));
                }
                sources.forEach(source=>{
                    source.onended=()=>{remaining--;if(!remaining)dispose();};
                    source.start(now);if(naturalEnd)source.stop(now+naturalEnd);
                });
            },
            release(seconds=.2,force=false){
                if(disposed||released&&!force)return;released=true;
                const t=ctx.currentTime,tail=Math.max(.025,seconds);
                gainNode.gain.cancelAndHoldAtTime(t);gainNode.gain.setTargetAtTime(0,t,tail/5);
                sources.forEach(source=>{try{source.stop(t+tail+.02);}catch{}});
            }
        };
        updateVoice();this.active.add(voice);return voice;
    },
    panic(){for(const voice of this.active)voice.release(.045,true);}
};

const Sustain = {
    sources:new Set(),pending:new Set(),
    get on(){return this.sources.size>0;},
    set(source,enabled){
        enabled?this.sources.add(source):this.sources.delete(source);
        document.getElementById('sustainButton')?.setAttribute('aria-pressed',String(this.on));
        if(!this.on){const notes=[...this.pending];this.pending.clear();notes.forEach(note=>Voice.release(note,true));}
    },
    reset(){this.sources.clear();this.pending.clear();document.getElementById('sustainButton')?.setAttribute('aria-pressed','false');}
};
