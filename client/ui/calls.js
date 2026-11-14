"use strict";
/* MPOL call control. Browser WebRTC with permission-on-demand and authenticated
   WebSocket signaling. STUN-only preview: peer-to-peer calls may fail on
   symmetric NATs or restrictive networks until a TURN relay is configured. */
let currentCall=null;
let callTick=null;
let callSoundInterval=null,callAudioContext=null;
let callNoiseEnabled=localStorage.getItem('mpol_call_denoise')!=='0';
function callAudioConstraints(){return {echoCancellation:true,noiseSuppression:callNoiseEnabled,
 autoGainControl:true,channelCount:{ideal:1},sampleRate:{ideal:48000}}}
function callTone(freq){
 if(!state.sound)return;
 try{
  const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)return;
  if(!callAudioContext)callAudioContext=new AudioCtx();
  callAudioContext.resume().catch(()=>{});
  const t=callAudioContext.currentTime,g=callAudioContext.createGain(),o=callAudioContext.createOscillator();
  o.frequency.value=freq;o.type='sine';
  g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(0.02,t+0.015);
  g.gain.exponentialRampToValueAtTime(0.0001,t+0.18);
  o.connect(g);g.connect(callAudioContext.destination);o.start(t);o.stop(t+0.19);
 }catch{}
}
function stopCallRingtone(){if(callSoundInterval)clearInterval(callSoundInterval);callSoundInterval=null}
function startCallRingtone(incoming){
 stopCallRingtone();
 const sound=()=>{if(!currentCall||currentCall.started){stopCallRingtone();return}
  callTone(incoming?750:450);
  if(incoming)setTimeout(()=>{if(currentCall?.incoming)callTone(660)},230);
 };
 sound();callSoundInterval=setInterval(sound,incoming?2400:2900);
}
async function recoverMicrophone(){
 const c=currentCall;if(!c||!c.pc||c.recovering)return;
 c.recovering=true;
 try{
  const fresh=await navigator.mediaDevices.getUserMedia({audio:callAudioConstraints()});
  if(currentCall!==c){fresh.getTracks().forEach(t=>t.stop());return}
  const track=fresh.getAudioTracks()[0],old=c.stream.getAudioTracks()[0];
  const sender=c.pc.getSenders().find(s=>s.track?.kind==='audio');
  if(sender)await sender.replaceTrack(track);
  if(old){c.stream.removeTrack(old);old.stop()}
  c.stream.addTrack(track);track.onended=()=>{if(currentCall===c)recoverMicrophone()};
  toast('Микрофон переподключён');
 }catch(e){toast('Микрофон недоступен: '+e.message)}
 finally{c.recovering=false}
}
const $call=id=>document.getElementById(id);
function signalCall(kind,payload={}){
 if(!currentCall||!state.ws||state.ws.readyState!==WebSocket.OPEN){toast('Нет соединения для звонка');return false}
 state.ws.send(JSON.stringify({type:'call_signal',to:currentCall.peer,call_id:currentCall.id,kind,payload}));return true
}
function callLayout(){
 const c=currentCall;if(!c)return;
 $call('callLayer').classList.remove('hidden');
 $call('callLayer').classList.toggle('audio-only',c.mode!=='video');
 $call('callTitle').textContent=c.incoming?'Звонок от '+c.nick:'Звонок · '+c.nick;
 $call('callStatus').textContent=c.incoming?'Входящий '+(c.mode==='video'?'видеозвонок':'голосовой звонок'):'Ожидание ответа…';
 document.querySelector('.call-accept-controls').classList.toggle('hidden',!c.incoming);
 document.querySelector('.call-active-controls').classList.toggle('hidden',c.incoming);
 $call('muteMic').textContent='Микрофон включён';
 $call('toggleCamera').classList.toggle('hidden',c.mode!=='video');
 $call('shareScreen').classList.toggle('hidden',c.mode!=='video');
 $call('callTimer').textContent='00:00';
 $call('noiseSuppression').checked=callNoiseEnabled;
}
async function getLocalCallMedia(mode){
 if(!navigator.mediaDevices?.getUserMedia)throw Error('Микрофон/камера недоступны. Нужен HTTPS и разрешение пользователя.');
 return navigator.mediaDevices.getUserMedia({audio:callAudioConstraints(),video:mode==='video'?{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24}}:false});
}
async function beginCall(mode){
 if(currentCall)return toast('У вас уже есть активный звонок');
 const c=state.active;if(!c||c.is_group||c.is_saved||!c.peer_id)return toast('Звонить можно только другу из личного чата');
 if(!state.ws||state.ws.readyState!==WebSocket.OPEN)return toast('Онлайн-канал ещё не подключён');
 let stream;try{stream=await getLocalCallMedia(mode)}catch(e){return toast('Не удалось получить доступ к устройствам: '+e.message)}
 currentCall={id:crypto.randomUUID(),peer:c.peer_id,nick:c.name,mode,incoming:false,stream,
  pc:null,ice:[],started:0,screen:null};
 callLayout();$call('localVideo').srcObject=stream;
 $call('localVideo').classList.toggle('hidden',mode!=='video');
 if(!signalCall('invite',{mode})){endCall(false);return}
 startCallRingtone(false);
 currentCall.timeout=setTimeout(()=>{if(currentCall&&!currentCall.started){toast('На вызов не ответили');endCall(true)}},60000);
}
function createPeer(){
 const c=currentCall;if(!c)return null;
 const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
 c.pc=pc;
 for(const t of c.stream.getTracks()){
  pc.addTrack(t,c.stream);
  if(t.kind==='audio')t.onended=()=>{if(currentCall===c)recoverMicrophone()}
 }
 pc.onicecandidate=e=>{if(e.candidate&&currentCall===c)signalCall('ice',{candidate:e.candidate.toJSON()})};
 pc.ontrack=e=>{
  if(currentCall!==c)return;
  const stream=e.streams?.[0]||new MediaStream([e.track]);
  if(c.mode==='video'){
    $call('remoteVideo').srcObject=stream;$call('remoteVideo').muted=false;
    $call('remoteVideo').play().catch(()=>{toast('Нажмите «Включить звук»')});
  }else{
    $call('remoteAudio').srcObject=stream;
    $call('remoteAudio').volume=Number($call('callVolume').value)/100;
    $call('remoteAudio').play().catch(()=>{toast('Нажмите «Включить звук»')});
  }
 };
 pc.onconnectionstatechange=()=>{
  if(currentCall!==c)return;
  if(pc.connectionState==='connected'){
   if(!c.started){c.started=Date.now();stopCallRingtone();$call('callStatus').textContent='Соединено';callTick=setInterval(updateCallDuration,1000)}
  }else if(pc.connectionState==='disconnected'){$call('callStatus').textContent='Восстанавливаем соединение…'}
  else if(pc.connectionState==='failed'){
    try{pc.restartIce()}catch{toast('Соединение потеряно');endCall(false)}
  }else if(pc.connectionState==='closed'&&currentCall===c){endCall(false)}
 };
 return pc;
}
async function applyQueuedIce(){
 const c=currentCall;if(!c?.pc?.remoteDescription)return;
 for(const candidate of c.ice.splice(0)){try{await c.pc.addIceCandidate(candidate)}catch{}}
}
async function acceptIncomingCall(){
 const c=currentCall;if(!c||!c.incoming)return;
 try{
  c.stream=await getLocalCallMedia(c.mode);c.incoming=false;stopCallRingtone();
  callLayout();$call('callStatus').textContent='Подключаемся…';
  $call('localVideo').srcObject=c.stream;
  createPeer();signalCall('accept');
 }catch(e){toast('Микрофон/камера не разрешены: '+e.message);signalCall('decline');endCall(false)}
}
async function onCallSignal(m){
 const kind=m.kind,from=m.from_id,id=m.call_id;
 if(kind==='invite'){
  if(currentCall){if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:'call_signal',to:from,call_id:id,kind:'busy'}));return}
  const mode=m.payload?.mode==='video'?'video':'audio';
  currentCall={id,peer:from,nick:m.nick||'Пользователь',mode,incoming:true,stream:null,pc:null,ice:[],started:0,screen:null};
  callLayout();startCallRingtone(true);
  if(state.notif&&'Notification'in window&&Notification.permission==='granted'&&document.hidden){
   try{const n=new Notification('MPOL · входящий звонок',{body:m.nick||'Пользователь',tag:'mpol-call'});n.onclick=()=>{window.focus();n.close()}}catch{}
  }
  return;
 }
 const c=currentCall;if(!c||c.id!==id||c.peer!==from)return;
 try{
  if(['decline','busy','hangup'].includes(kind)){toast(kind==='busy'?'Собеседник занят':kind==='decline'?'Вызов отклонён':'Звонок завершён');endCall(false);return}
  if(kind==='accept'&&!c.incoming){
   const pc=createPeer();const offer=await pc.createOffer();await pc.setLocalDescription(offer);
   signalCall('offer',{sdp:pc.localDescription.toJSON()});$call('callStatus').textContent='Устанавливаем соединение…';return
  }
  if(kind==='offer'&&c.pc){
   await c.pc.setRemoteDescription(m.payload.sdp);await applyQueuedIce();
   const answer=await c.pc.createAnswer();await c.pc.setLocalDescription(answer);
   signalCall('answer',{sdp:c.pc.localDescription.toJSON()});return
  }
  if(kind==='answer'&&c.pc){await c.pc.setRemoteDescription(m.payload.sdp);await applyQueuedIce();return}
  if(kind==='ice'&&m.payload?.candidate){
   if(c.pc?.remoteDescription)await c.pc.addIceCandidate(m.payload.candidate);
   else c.ice.push(m.payload.candidate);
  }
 }catch(e){toast('Ошибка соединения: '+e.message);endCall(true)}
}
function updateCallDuration(){
 const c=currentCall;if(!c||!c.started)return;
 const secs=Math.floor((Date.now()-c.started)/1000);
 $call('callTimer').textContent=String(Math.floor(secs/60)).padStart(2,'0')+':'+String(secs%60).padStart(2,'0');
}
function endCall(notify=true){
 const c=currentCall;if(!c)return;
 if(notify)signalCall(c.incoming?'decline':'hangup');
 stopCallRingtone();currentCall=null;if(callTick){clearInterval(callTick);callTick=null}
 if(c.timeout)clearTimeout(c.timeout);
 try{c.pc?.close()}catch{}
 for(const track of c.stream?.getTracks()||[])track.stop();
 for(const track of c.screen?.getTracks()||[])track.stop();
 $call('localVideo').srcObject=null;$call('remoteVideo').srcObject=null;$call('remoteAudio').srcObject=null;
 $call('callLayer').classList.add('hidden');
}
function toggleCallMic(){
 const stream=currentCall?.stream;if(!stream)return;
 for(const track of stream.getAudioTracks())track.enabled=!track.enabled;
 $call('muteMic').textContent=stream.getAudioTracks().some(t=>t.enabled)?'Микрофон включён':'Микрофон выключен'
}
function toggleCallCamera(){
 const stream=currentCall?.stream;if(!stream)return;
 for(const track of stream.getVideoTracks())track.enabled=!track.enabled;
 $call('toggleCamera').textContent=stream.getVideoTracks().some(t=>t.enabled)?'Камера включена':'Камера выключена'
}
async function shareCallScreen(){
 const c=currentCall;if(!c?.pc||c.mode!=='video')return;
 try{
  const share=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
  const track=share.getVideoTracks()[0];const sender=c.pc.getSenders().find(s=>s.track?.kind==='video');
  if(!sender){share.getTracks().forEach(t=>t.stop());return toast('Видеодорожка недоступна')}
  await sender.replaceTrack(track);c.screen=share;$call('localVideo').srcObject=share;
  $call('shareScreen').textContent='Экран показывается';
  track.onended=async()=>{
   if(currentCall!==c)return;
   const camera=c.stream.getVideoTracks()[0];if(camera)await sender.replaceTrack(camera);
   $call('localVideo').srcObject=c.stream;$call('shareScreen').textContent='Экран';c.screen=null
  };
 }catch(e){if(e.name!=='NotAllowedError')toast('Экран недоступен: '+e.message)}
}
$call('voiceCall').onclick=()=>beginCall('audio');
$call('videoCall').onclick=()=>beginCall('video');
$call('acceptCall').onclick=acceptIncomingCall;
$call('declineCall').onclick=()=>endCall(true);
$call('endCall').onclick=()=>endCall(true);
$call('muteMic').onclick=toggleCallMic;
$call('toggleCamera').onclick=toggleCallCamera;
$call('shareScreen').onclick=shareCallScreen;
$call('noiseSuppression').onchange=async e=>{
 callNoiseEnabled=e.target.checked;localStorage.setItem('mpol_call_denoise',callNoiseEnabled?'1':'0');
 try{const t=currentCall?.stream?.getAudioTracks()[0];if(t?.applyConstraints)await t.applyConstraints(callAudioConstraints());
  toast(callNoiseEnabled?'Шумоподавление включено':'Шумоподавление отключено');
 }catch{toast('Это устройство не поддерживает изменение шумоподавления')}
};
$call('enableCallAudio').onclick=()=>{
 $call('remoteAudio').play().catch(()=>{});$call('remoteVideo').play().catch(()=>{});
 callAudioContext?.resume().catch(()=>{});toast('Звук включён');
};
$call('callVolume').oninput=e=>{
 const volume=Number(e.target.value)/100;$call('remoteAudio').volume=volume;$call('remoteVideo').volume=volume
};
