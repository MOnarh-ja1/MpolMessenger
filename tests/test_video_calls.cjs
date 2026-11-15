"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync('client/ui/calls.js','utf8');
const html=fs.readFileSync('client/ui/index.html','utf8');
const css=fs.readFileSync('client/ui/style.css','utf8');
assert.match(html,/id="videoArea"/);
assert.match(html,/id="shareScreen"[^>]*call-tool-button/);
assert.equal((html.match(/id="shareScreen"/g)||[]).length,1,'Screen share has one visible toolbar control');
assert.match(css,/not\(\[data-stage="incoming"\]\) \.call-video-area/);

const elements=new Map(),toasts=[];
function el(id){
 if(!elements.has(id)){
  let obj=null;
  const classes=new Set(),attributes={};
  elements.set(id,{id,textContent:'',value:'100',className:'',checked:false,
   disabled:false,muted:false,title:'',dataset:{},style:{},
   classList:{
    add(c){classes.add(c)},remove(c){classes.delete(c)},
    contains(c){return classes.has(c)},toggle(c,force){
     const next=force===undefined?!classes.has(c):!!force;
     if(next)classes.add(c);else classes.delete(c);return next;
    }
   },
   setAttribute(k,v){attributes[k]=String(v)},
   getAttribute(k){return attributes[k]},
   play(){return Promise.resolve()},
   get srcObject(){return obj},set srcObject(v){obj=v}
  });
 }
 return elements.get(id);
}
class FakeTrack{
 constructor(kind,id){this.kind=kind;this.id=id;this.enabled=true;this.muted=false}
 stop(){this.onended?.()}
}
class FakeStream{
 constructor(tracks=[]){this.tracks=[...tracks]}
 getTracks(){return this.tracks}
 getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio')}
 getVideoTracks(){return this.tracks.filter(t=>t.kind==='video')}
 addTrack(t){this.tracks.push(t)}
 removeTrack(t){this.tracks=this.tracks.filter(x=>x!==t)}
}
class FakePC{
 constructor(){this.connectionState='new';this.iceConnectionState='new';this.senders=[];this.transceivers=[]}
 addTrack(track){
  const sender={track, getParameters(){return {encodings:[{}]}},
   async setParameters(){}, async replaceTrack(t){this.track=t}};
  this.senders.push(sender);return sender;
 }
 addTransceiver(kind){
  const sender={track:null,async replaceTrack(t){this.track=t}};
  this.senders.push(sender);
  const t={receiver:{track:{kind}},sender};this.transceivers.push(t);return t;
 }
 getSenders(){return this.senders}
 getTransceivers(){return this.transceivers}
}
const audio=new FakeStream([new FakeTrack('audio','mic')]);
const camera=new FakeTrack('video','camera');
const screen=new FakeTrack('video','screen');
const ctx=vm.createContext({
 document:{getElementById:el,querySelector:()=>({classList:el('controls').classList}),addEventListener(){}},
 localStorage:{getItem(){return null},setItem(){}},state:{sound:false},
 navigator:{mediaDevices:{
  async getUserMedia(c){
   if(c.video===false)return audio;
   if(c.video===true)return new FakeStream([camera]);
   const error=new Error('Camera absent');error.name='NotFoundError';throw error;
  },
  async getDisplayMedia(){return new FakeStream([screen])}
 }},window:{},RTCPeerConnection:FakePC,MediaStream:FakeStream,
 toast(value){toasts.push(value)},setTimeout(){return 1},clearTimeout(){},
 setInterval(){return 1},clearInterval(){},console,Date
});
vm.runInContext(code,ctx);
(async()=>{
 const stream=await vm.runInContext('getLocalCallMedia("video")',ctx);
 assert.equal(stream.getVideoTracks().length,0,'Unavailable camera must not block receiving video');
 ctx.testStream=stream;
 vm.runInContext(`currentCall={id:'call',peer:'B',mode:'video',nick:'B',isCaller:true,
  incoming:false,stream:testStream,ice:[],restarts:0,started:0};createPeer()`,ctx);
 const pc=vm.runInContext('currentCall.pc',ctx);
 assert.equal(pc.getTransceivers().length,1,'Video transceiver reserved for late camera and sharing');
 await vm.runInContext('shareCallScreen()',ctx);
 const videoSender=pc.getTransceivers()[0].sender;
 assert.equal(videoSender.track,screen,'Screen must replace video sender');
 assert.equal(el('shareScreen').getAttribute('aria-pressed'),'true');
 await vm.runInContext('shareCallScreen()',ctx);
 await Promise.resolve();await Promise.resolve();
 assert.equal(videoSender.track,null,'Stopping share restores video sender without camera');
 assert.equal(el('shareScreen').getAttribute('aria-pressed'),'false');
 await vm.runInContext('toggleCallCamera()',ctx);
 assert.equal(videoSender.track,camera,'Late camera should replace reserved video sender');
 assert.equal(el('localVideo').srcObject,stream);
 const incoming=new FakeTrack('video','remote');
 incoming.muted=true;
 pc.ontrack({track:incoming});
 assert.equal(el('videoArea').classList.contains('has-remote-video'),false);
 incoming.muted=false;incoming.onunmute();
 assert.equal(el('videoArea').classList.contains('has-remote-video'),true,'Remote picture shown when video packets arrive');
 console.log('PASS: video fallback, screen share, late camera and remote video');
})().catch(err=>{console.error(err);process.exitCode=1});
