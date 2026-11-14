"use strict";
/* MPOL call control. Browser WebRTC with permission-on-demand and authenticated
   WebSocket signaling. STUN-only preview: peer-to-peer calls may fail on
   symmetric NATs or restrictive networks until a TURN relay is configured. */
let currentCall=null;
let callTick=null;
let callSoundInterval=null,callAudioContext=null;
// Browser noise suppression / automatic gain can gate quiet syllables on some PCs.
// Start with unprocessed speech and allow the listener to enable suppression.
let callNoiseEnabled=localStorage.getItem('mpol_call_denoise')==='1';
let callQualityTick=null;
function callAudioConstraints(){return {echoCancellation:true,noiseSuppression:callNoiseEnabled,
 autoGainControl:false,channelCount:{ideal:1},sampleRate:{ideal:48000}}}
async function measureCallQuality(){
 const c=currentCall;if(!c?.pc||c.pc.connectionState!=='connected')return;
 try{
  const stats=await c.pc.getStats();if(currentCall!==c)return;
  let received=0,lost=0,jitter=0;
  stats.forEach(r=>{
   if(r.type==='inbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio')&&!r.isRemote){
    received+=Number(r.packetsReceived||0);lost+=Math.max(0,Number(r.packetsLost||0));
    jitter=Math.max(jitter,Number(r.jitter||0));
   }
  });
  const quality=$call('callQuality');
  if(received+lost===0){
   quality.textContent='Нет входящих аудиопакетов. Проверьте звук собеседника и сеть.';
   quality.classList.add('warning');return
  }
  const total=received+lost;
  if(total>50&&(lost/total>.07||jitter>.07)){
   quality.textContent='Нестабильный интернет: возможны пропуски слов. Потери '+Math.round(lost/total*100)+'%';
   quality.classList.add('warning');
  }else{
   quality.textContent='Аудиоканал подключён · '+Math.round(lost/total*100)+'% потерь';
   quality.classList.remove('warning');
  }
 }catch{}
}
function monitorCallQuality(){
 if(callQualityTick)clearInterval(callQualityTick);
 measureCallQuality();
 callQualityTick=setInterval(measureCallQuality,4000);
}
async function restartCallIce(c){
 if(currentCall!==c||!c.pc||!c.isCaller)return;
 if(c.pc.signalingState!=='stable')return;
 if(c.restarts>=3){$call('callQuality').textContent='Не удаётся восстановить связь. Для некоторых сетей нужен TURN-сервер.';return}
 if(c.lastRestart&&Date.now()-c.lastRestart<10000)return;
 c.restarts=(c.restarts||0)+1;c.lastRestart=Date.now();
 try{
  c.pc.restartIce();
  const offer=await c.pc.createOffer({iceRestart:true});
  await c.pc.setLocalDescription(offer);
  signalCall('offer',{sdp:c.pc.localDescription.toJSON()});
  $call('callStatus').textContent='Переподключаем сеть…';
 }catch(e){$call('callQuality').textContent='Переподключение не удалось: '+e.message}
}
function tryRecoverCall(c){
 if(currentCall!==c||!c.pc||c.pc.connectionState==='connected')return;
 if(c.isCaller)restartCallIce(c);
 else if(!c.lastRestart||Date.now()-c.lastRestart>12000){
  c.lastRestart=Date.now();signalCall('restart',{});
 }
}
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
 $call('callQuality').textContent='Ожидаем аудиосоединение…';
 $call('callQuality').classList.remove('warning');
 $call('noiseSuppression').checked=callNoiseEnabled;
}
async function getLocalCallMedia(mode){
 if(!navigator.mediaDevices?.getUserMedia)throw Error('Микрофон/камера недоступны. Нужен HTTPS и разрешение пользователя.');
 return navigator.mediaDevices.getUserMedia({audio:callAudioConstraints(),video:mode==='video'?{width:{ideal:640},height:{ideal:360},frameRate:{ideal:15,max:20}}:false});
}
async function beginCall(mode){
 if(currentCall)return toast('У вас уже есть активный звонок');
 const c=state.active;if(!c||c.is_group||c.is_saved||!c.peer_id)return toast('Звонить можно только другу из личного чата');
 if(!state.ws||state.ws.readyState!==WebSocket.OPEN)return toast('Онлайн-канал ещё не подключён');
 let stream;try{stream=await getLocalCallMedia(mode)}catch(e){return toast('Не удалось получить доступ к устройствам: '+e.message)}
 currentCall={id:crypto.randomUUID(),peer:c.peer_id,nick:c.name,mode,incoming:false,isCaller:true,stream,
  pc:null,ice:[],started:0,screen:null,remoteStream:null,restarts:0};
 callLayout();$call('localVideo').srcObject=stream;
 $call('localVideo').classList.toggle('hidden',mode!=='video');
 if(!signalCall('invite',{mode})){endCall(false);return}
 startCallRingtone(false);
 currentCall.timeout=setTimeout(()=>{if(currentCall&&!currentCall.started){toast('На вызов не ответили');endCall(true)}},60000);
}
function createPeer(){
 const c=currentCall;if(!c)return null;
 const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}],iceCandidatePoolSize:2});
 c.pc=pc;
 c.remoteStream=new MediaStream();
 for(const t of c.stream.getTracks()){
  const sender=pc.addTrack(t,c.stream);
  if(t.kind==='audio')t.onended=()=>{if(currentCall===c)recoverMicrophone()};
  if(t.kind==='video'){
   // Keep camera bandwidth modest; prioritise intelligible audio on slow Wi-Fi.
   try{
    const params=sender.getParameters();
    if(params.encodings?.length){
     params.encodings[0].maxBitrate=400000;
     sender.setParameters(params).catch(()=>{});
    }
   }catch{}
  }
 }
 pc.onicecandidate=e=>{if(e.candidate&&currentCall===c)signalCall('ice',{candidate:e.candidate.toJSON()})};
 pc.ontrack=e=>{
  if(currentCall!==c)return;
  // Both remote tracks belong to one persistent MediaStream; changing srcObject
  // on each ontrack event was interrupting playback in Chrome/Edge app mode.
  if(!c.remoteStream.getTracks().some(t=>t.id===e.track.id))c.remoteStream.addTrack(e.track);
  const audio=$call('remoteAudio'),video=$call('remoteVideo');
  if(audio.srcObject!==c.remoteStream)audio.srcObject=c.remoteStream;
  audio.volume=Number($call('callVolume').value)/100;
  audio.muted=false;
  audio.play().catch(()=>{$call('callQuality').textContent='Нажмите «Включить звук» для воспроизведения';});
  if(c.mode==='video'){
   if(video.srcObject!==c.remoteStream)video.srcObject=c.remoteStream;
   // Video is silent: the audio element is the only playback path.
   video.muted=true;
   video.play().catch(()=>{});
  }
  if(e.track.kind==='audio'){
   e.track.onmute=()=>{if(currentCall===c)$call('callQuality').textContent='Входящий микрофон временно недоступен'};
   e.track.onunmute=()=>{if(currentCall===c)$call('callQuality').textContent='Входящий звук восстановлен'};
  }
 };
 pc.onconnectionstatechange=()=>{
  if(currentCall!==c)return;
  if(pc.connectionState==='connected'){
   if(!c.started){c.started=Date.now();stopCallRingtone();$call('callStatus').textContent='Соединено';callTick=setInterval(updateCallDuration,1000);monitorCallQuality()}
  }else if(pc.connectionState==='disconnected'){
   $call('callStatus').textContent='Восстанавливаем соединение…';
   setTimeout(()=>tryRecoverCall(c),3500);
  }else if(pc.connectionState==='failed'){
   $call('callStatus').textContent='Сеть потеряна — восстанавливаем…';
   tryRecoverCall(c);
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
  currentCall={id,peer:from,nick:m.nick||'Пользователь',mode,incoming:true,isCaller:false,stream:null,pc:null,ice:[],started:0,screen:null,remoteStream:null,restarts:0};
  callLayout();startCallRingtone(true);
  if(state.notif&&'Notification'in window&&Notification.permission==='granted'&&document.hidden){
   try{const n=new Notification('MPOL · входящий звонок',{body:m.nick||'Пользователь',tag:'mpol-call'});n.onclick=()=>{window.focus();n.close()}}catch{}
  }
  return;
 }
 const c=currentCall;if(!c||c.id!==id||c.peer!==from)return;
 try{
  if(['decline','busy','hangup'].includes(kind)){toast(kind==='busy'?'Собеседник занят':kind==='decline'?'Вызов отклонён':'Звонок завершён');endCall(false);return}
  if(kind==='restart'){if(c.isCaller)await restartCallIce(c);return}
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
 if(callQualityTick){clearInterval(callQualityTick);callQualityTick=null}
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
 const volume=Number(e.target.value)/100;$call('remoteAudio').volume=volume;
};
