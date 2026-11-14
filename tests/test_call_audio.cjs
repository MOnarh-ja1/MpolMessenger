"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync('client/ui/calls.js','utf8');

const elements=new Map();
function element(id){
 if(!elements.has(id)){
  let stream=null,assignments=0;
  elements.set(id,{id,textContent:'',className:'',checked:false,muted:false,volume:1,
   style:{},classList:{add(){},remove(){},toggle(){}},play:()=>Promise.resolve(),
   get srcObject(){return stream},set srcObject(value){assignments++;stream=value},
   get srcAssignments(){return assignments}});
 }
 return elements.get(id);
}
class FakeMediaStream{
 constructor(tracks=[]){this.tracks=[...tracks]}
 addTrack(t){this.tracks.push(t)}
 getTracks(){return this.tracks}
 getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio')}
 getVideoTracks(){return this.tracks.filter(t=>t.kind==='video')}
}
class FakePC{
 constructor(opts){this.iceServers=opts.iceServers;this.connectionState='new'}
 addTrack(track){
  return {track,getParameters:()=>({encodings:[{}]}),setParameters:()=>Promise.resolve()}
 }
}
const localStorage={getItem:()=>null,setItem(){}};
const ctx=vm.createContext({
 document:{getElementById:element,querySelector:()=>({classList:element('controls').classList})},
 state:{sound:false},localStorage,window:{},navigator:{},toast(){},
 RTCPeerConnection:FakePC,MediaStream:FakeMediaStream,
 setInterval(){return 1},clearInterval(){},setTimeout(){return 1},clearTimeout(){},
 console,Date
});
vm.runInContext(code,ctx);
assert.equal(vm.runInContext('callNoiseEnabled',ctx),false,
 'Noise gate must be optional; clipping speech on some microphones');
assert.equal(vm.runInContext('callAudioConstraints().echoCancellation',ctx),true);
assert.equal(vm.runInContext('callAudioConstraints().autoGainControl',ctx),false);
ctx.testStream=new FakeMediaStream([{id:'localmic',kind:'audio'}]);
vm.runInContext(`currentCall={id:'abc',peer:'B',mode:'video',nick:'Peer',isCaller:true,
 stream:testStream,ice:[],started:0}; createPeer();`,ctx);
let pc=vm.runInContext('currentCall.pc',ctx);
pc.ontrack({track:{id:'in-audio',kind:'audio'},streams:[]});
const audio=element('remoteAudio'),video=element('remoteVideo');
assert.equal(audio.srcAssignments,1);
assert.equal(audio.srcObject.getTracks().length,1);
pc.ontrack({track:{id:'in-video',kind:'video'},streams:[]});
assert.equal(audio.srcAssignments,1,'Adding video must NOT reset remote audio element');
assert.equal(audio.srcObject.getTracks().length,2);
assert.equal(video.srcAssignments,1);
assert.equal(video.muted,true,'Only the audio element may output sound, no duplicated video audio');
pc.ontrack({track:{id:'in-video',kind:'video'},streams:[]});
assert.equal(audio.srcAssignments,1);
assert.equal(video.srcAssignments,1);
console.log('PASS: call audio stream stays stable during video track events; video muted; optional noise gate');
