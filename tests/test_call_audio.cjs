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
 constructor(opts){this.iceServers=opts.iceServers;this.connectionState='new';this.senders=[]}
 addTrack(track){
  const sender={track,params:null,
   getParameters:()=>({encodings:[{}]}),
   setParameters(v){this.params=v;return Promise.resolve()}};
  this.senders.push(sender);return sender;
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
assert.equal(vm.runInContext('callNoiseEnabled',ctx),true,
 'Noise suppression should be on by default to reduce acoustic echo');
assert.equal(vm.runInContext('callAudioConstraints().echoCancellation',ctx),true);
assert.equal(vm.runInContext('callAudioConstraints().autoGainControl',ctx),true);
assert.equal(vm.runInContext('callAudioConstraints().noiseSuppression',ctx),true);
ctx.testStream=new FakeMediaStream([{id:'localmic',kind:'audio'},{id:'localcam',kind:'video'}]);
vm.runInContext(`currentCall={id:'abc',peer:'B',mode:'video',nick:'Peer',isCaller:true,
 stream:testStream,ice:[],started:0}; createPeer();`,ctx);
let pc=vm.runInContext('currentCall.pc',ctx);
const cameraSender=pc.senders.find(x=>x.track.kind==='video');
assert.equal(cameraSender.params.encodings[0].maxBitrate,2000000,
 'Video capped at 2Mbps instead of pixelated 400kbps');
assert.equal(cameraSender.params.encodings[0].maxFramerate,30);
assert.equal(cameraSender.params.degradationPreference,'balanced');
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
console.log('PASS: call audio remains single-output, echo cancel/denoise on, HD bitrate and 30 FPS cap');

(async()=>{
 // Browser requests short-lived ICE credentials from the API before negotiating.
 ctx.api=async()=>({iceServers:[
  {urls:['stun:stun.l.google.com:19302']},
  {urls:['turn:relay.example.test:3478'],username:'test-user',credential:'short-lived'}
 ],relayConfigured:true});
 const accepted=await vm.runInContext('loadCallIce(currentCall)',ctx);
 assert.equal(accepted,true);
 assert.equal(vm.runInContext('currentCall.relayConfigured',ctx),true);
 const peer=vm.runInContext('createPeer()',ctx);
 assert.equal(peer.iceServers.length,2,'Configured TURN should reach RTCPeerConnection');
 assert.equal(peer.iceServers[1].credential,'short-lived');
 ctx.api=async()=>{throw Error('network offline')};
 await vm.runInContext('loadCallIce(currentCall)',ctx);
 assert.equal(vm.runInContext('currentCall.relayConfigured',ctx),false);
 assert.equal(vm.runInContext('currentCall.iceServers.length',ctx),1);
 console.log('PASS: TURN credentials loaded with authenticated ICE fallback');
})().catch(e=>{console.error(e);process.exitCode=1});

