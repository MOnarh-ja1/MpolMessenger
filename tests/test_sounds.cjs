"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync('client/ui/sounds.js','utf8');
const played=[],stopped=[];
let settings={mpol_sound:'1',mpol_sound_volume:'85'};
class AudioContext{
 constructor(){this.currentTime=0;this.destination={}}
 resume(){return Promise.resolve()}
 createGain(){return {gain:{
  setValueAtTime(){},exponentialRampToValueAtTime(){},setTargetAtTime(){}
 },connect(){},disconnect(){}}}
 createOscillator(){
  const obj={frequency:{setValueAtTime(f){obj.freq=f}},connect(){},disconnect(){},
   start(){played.push(obj)},stop(){stopped.push(obj)},onended:null};
  return obj;
 }
}
const window={AudioContext};
const document={addEventListener(){}};
const localStorage={getItem(k){return settings[k]??null}};
const context=vm.createContext({window,document,localStorage});
vm.runInContext(code,context);
assert.equal(typeof window.mpolSound.play,'function');
window.mpolSound.play('message');
assert.equal(played.length,3,'Notification should be melodic instead of one beep');
const notes=played.map(x=>x.freq);
assert.equal(new Set(notes).size,3,'Distinct pitches are required');
window.mpolSound.play('incoming');
assert.ok(played.length>=8,'Call should play a multi-note ringtone');
const before=played.length;
settings.mpol_sound='0';
window.mpolSound.play('message');
assert.equal(played.length,before,'Muted notification setting must suppress audio');
window.mpolSound.play('message',true);
assert.equal(played.length,before+3,'Preview button may play with sounds disabled');
window.mpolSound.stop('incoming');
assert.ok(stopped.length>0,'Stop ringtone should stop scheduled voices');
console.log('PASS: original melodic audio, volume control, mute and previews');
