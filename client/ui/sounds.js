"use strict";
/* Original MPOL notification melodies, synthesized locally. No media files,
   remote music services or copyrighted samples. */
(() => {
 const AudioCtor=window.AudioContext||window.webkitAudioContext;
 let context=null;
 const active=new Map();
 const patterns={
  message:[[659.25,0,.13,.20],[830.61,.12,.19,.20],[1046.50,.28,.27,.23]],
  incoming:[[392,0,.24,.28],[523.25,.18,.27,.25],[659.25,.39,.27,.27],
            [783.99,.60,.27,.28],[1046.5,.83,.44,.21]],
  outgoing:[[440,0,.18,.13],[554.37,.25,.18,.13],[659.25,.50,.22,.14]]
 };
 const volume=()=>Math.max(0,Math.min(1,Number(localStorage.getItem('mpol_sound_volume')||'85')/100));
 const enabled=()=>localStorage.getItem('mpol_sound')!=='0';
 function unlock(){
  if(!AudioCtor)return null;
  try{
   if(!context)context=new AudioCtor();
   const p=context.resume();
   p?.catch?.(()=>{});
   return context;
  }catch{return null}
 }
 function stop(kind){
  const items=active.get(kind)||[];
  for(const item of items){try{item.stop()}catch{}}
  active.delete(kind);
 }
 function play(kind,preview=false){
  if(!patterns[kind]||(!preview&&!enabled()))return;
  const ctx=unlock();
  if(!ctx)return;
  // Each ringtone cycle gets fresh voices; never accumulate runaway nodes.
  stop(kind);
  const notes=[];
  for(const [frequency,offset,duration,intensity] of patterns[kind]){
   try{
    const osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type='sine';
    osc.frequency.setValueAtTime(frequency,ctx.currentTime+offset);
    const t=ctx.currentTime+offset;
    const amplitude=Math.max(.0001,Math.min(.21,intensity*volume()));
    gain.gain.setValueAtTime(.0001,t);
    gain.gain.exponentialRampToValueAtTime(amplitude,t+.035);
    gain.gain.setTargetAtTime(.0001,t+Math.max(.08,duration-.10),.042);
    gain.gain.setValueAtTime(.0001,t+duration);
    osc.connect(gain);gain.connect(ctx.destination);
    osc.start(t);osc.stop(t+duration+.01);
    osc.onended=()=>{try{osc.disconnect();gain.disconnect()}catch{}};
    notes.push(osc);
   }catch{}
  }
  active.set(kind,notes);
 }
 // WebAudio is often blocked until the user interacts with the tab.
 document.addEventListener('pointerdown',unlock,{passive:true});
 document.addEventListener('keydown',unlock,{passive:true});
 window.mpolSound={play,stop,unlock};
})();
