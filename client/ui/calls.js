"use strict";
/* MPOL call control. Browser WebRTC with permission-on-demand and authenticated
   WebSocket signaling. TURN-enabled ICE configuration fetched from the authenticated server. */
let currentCall=null;
let callTick=null;
let callSoundInterval=null,callAudioContext=null;
let preferredVideoMirror=localStorage.getItem('mpol_video_mirror')==='1';
// Browser noise suppression / automatic gain can gate quiet syllables on some PCs.
// Start with unprocessed speech and allow the listener to enable suppression.
let callNoiseEnabled=localStorage.getItem('mpol_call_denoise')!=='0';
let callQualityTick=null;
function callAudioConstraints(){return {echoCancellation:true,noiseSuppression:callNoiseEnabled,
 autoGainControl:true,channelCount:{ideal:1},sampleRate:{ideal:48000}}}
async function measureCallQuality(){
 const c=currentCall;if(!c?.pc||c.pc.connectionState!=='connected')return;
 try{
  const stats=await c.pc.getStats();if(currentCall!==c)return;
  let received=0,lost=0,jitter=0,videoWidth=0,videoHeight=0,videoFps=0;
  stats.forEach(r=>{
   if(r.type==='inbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio')&&!r.isRemote){
    received+=Number(r.packetsReceived||0);lost+=Math.max(0,Number(r.packetsLost||0));
    jitter=Math.max(jitter,Number(r.jitter||0));
   }
   if(r.type==='outbound-rtp'&&(r.kind==='video'||r.mediaType==='video')){
    videoWidth=Number(r.frameWidth||0);videoHeight=Number(r.frameHeight||0);
    videoFps=Number(r.framesPerSecond||0);
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
   const cameraInfo=c.mode==='video'&&videoWidth&&videoHeight?
    ' · '+(c.screen?'экран ':'видео ')+videoWidth+'×'+videoHeight+(videoFps?' · '+Math.round(videoFps)+' FPS':''):'';
   quality.textContent='Аудиоканал подключён · '+Math.round(lost/total*100)+'% потерь'+cameraInfo;
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
 if(c.restarts>=5){$call('callQuality').textContent='Не удаётся восстановить связь. Для некоторых сетей нужен TURN-сервер.';return}
 if(c.lastRestart&&Date.now()-c.lastRestart<15000)return;
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
 if(currentCall!==c||!c.pc||c.pc.connectionState==='connected'||
    ['connected','completed'].includes(c.pc.iceConnectionState))return;
 // Do not renegotiate for short Wi-Fi / mobile handovers: ICE can recover itself.
 if(c.recoveryTimer)return;
 const failed=c.pc.connectionState==='failed'||c.pc.iceConnectionState==='failed';
 c.recoveryTimer=setTimeout(()=>{
  c.recoveryTimer=null;
  if(currentCall!==c||!c.pc||c.pc.connectionState==='connected'||
     ['connected','completed'].includes(c.pc.iceConnectionState))return;
  if(c.isCaller)restartCallIce(c);
  else if(!c.lastRestart||Date.now()-c.lastRestart>15000){
   c.lastRestart=Date.now();signalCall('restart',{});
  }
 },failed?1200:6500);
}
function prepareCallAudioFromGesture(){
 // Safari may require a user gesture to unlock remote audio playback.
 try{
  const Context=window.AudioContext||window.webkitAudioContext;
  if(Context){
   if(!callAudioContext)callAudioContext=new Context();
   callAudioContext.resume()?.catch?.(()=>{});
  }
 }catch{}
 const audio=$call('remoteAudio');
 audio.autoplay=true;audio.muted=!!currentCall?.speakerMuted;
 audio.setAttribute?.('playsinline','');
}
function playIncomingCallAudio(c){
 if(currentCall!==c||!c.remoteStream?.getAudioTracks().length)return;
 const audio=$call('remoteAudio');
 if(audio.srcObject!==c.remoteStream)audio.srcObject=c.remoteStream;
 audio.muted=!!c.speakerMuted;
 audio.volume=Number($call('callVolume').value)/100;
 const p=audio.play();
 p?.then?.(()=>{
  if(currentCall===c){
   c.audioPlaybackBlocked=false;
   $call('enableCallAudio').textContent='🔊 Звук включён';
  }
 })?.catch?.(()=>{
  if(currentCall!==c)return;
  c.audioPlaybackBlocked=true;
  $call('enableCallAudio').textContent='🔊 Нажмите для включения звука';
  $call('callQuality').textContent='Телефон заблокировал звук. Нажмите «Включить звук».';
  $call('callQuality').classList.add('warning');
 });
}
function startCallWatchdog(c){
 if(c.connectWatchdog)clearTimeout(c.connectWatchdog);
 c.connectWatchdog=setTimeout(()=>{
  if(currentCall!==c||!c.pc)return;
  if(['connected','completed'].includes(c.pc.iceConnectionState)||c.pc.connectionState==='connected')return;
  $call('callStatus').textContent='Проверяем соединение с мобильной сетью…';
  $call('callQuality').textContent='Звонок подключается дольше обычного. Проверяем TURN/STUN…';
  $call('callQuality').classList.add('warning');
  tryRecoverCall(c);
 },16000);
}
function stopCallRingtone(){
 if(callSoundInterval)clearInterval(callSoundInterval);
 callSoundInterval=null;
 window.mpolSound?.stop('incoming');
 window.mpolSound?.stop('outgoing');
}
function startCallRingtone(incoming){
 stopCallRingtone();
 const c=currentCall,kind=incoming?'incoming':'outgoing';
 const sound=()=>{
  if(currentCall!==c||c.started){stopCallRingtone();return}
  window.mpolSound?.play(kind);
 };
 sound();
 callSoundInterval=setInterval(sound,incoming?3300:2200);
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
const MPOL_FALLBACK_ICE=[{urls:['stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']}];
// Short-lived TURN credentials come from the authenticated server, not static JS.
async function loadCallIce(call){
 let config=null;
 try{config=await api('/calls/ice')}
 catch(e){console.warn('MPOL ICE config unavailable:',e.message)}
 if(currentCall!==call)return false;
 call.iceServers=Array.isArray(config?.iceServers)&&config.iceServers.length?
  config.iceServers:MPOL_FALLBACK_ICE;
 call.relayConfigured=!!config?.relayConfigured;
 call.relayProvider=String(config?.relayProvider||'stun-only');
 if(!call.relayConfigured){
  $call('callQuality').textContent='На сервере пока нет TURN-релея. В другой мобильной сети звонок может не соединиться.';
  $call('callQuality').classList.add('warning');
 }else{
  $call('callQuality').textContent=call.relayProvider==='metered-openrelay-public'?
   'Подключаем бесплатный TURN · связь зависит от сети и лимита релея…':
   'Подключаем TURN-сервер · проверяем соединение…';
  $call('callQuality').classList.remove('warning');
 }
 return true;
}
const $call=id=>document.getElementById(id);
function signalCall(kind,payload={}){
 if(!currentCall||!state.ws||state.ws.readyState!==WebSocket.OPEN){toast('Нет соединения для звонка');return false}
 state.ws.send(JSON.stringify({type:'call_signal',to:currentCall.peer,call_id:currentCall.id,kind,payload}));return true
}
function setCallVisualStage(stage){
 if(!currentCall)return;
 const card=$call('callCard');
 card.dataset.stage=stage;
 card.dataset.mode=currentCall.mode;
}
function updateCallButtons(c){
 const micOn=c?.stream?.getAudioTracks().some(t=>t.enabled)!==false;
 const mute=$call('muteMic'),speaker=$call('toggleSpeaker'),camera=$call('toggleCamera');
 mute.setAttribute('aria-pressed',String(!micOn));
 mute.title=micOn?'Выключить микрофон':'Включить микрофон';
 mute.setAttribute('aria-label',mute.title);
 const silent=!!c?.speakerMuted;
 speaker.setAttribute('aria-pressed',String(silent));
 speaker.title=silent?'Включить звук собеседника':'Выключить звук собеседника';
 speaker.setAttribute('aria-label',speaker.title);
 const cameraOn=!!c?.stream?.getVideoTracks().some(t=>t.enabled);
 camera.disabled=c?.mode!=='video';
 const share=$call('shareScreen');
 share.disabled=c?.mode!=='video'||!c?.pc||!navigator.mediaDevices?.getDisplayMedia;
 share.setAttribute('aria-pressed',String(!!c?.screen));
 share.title=c?.screen?'Остановить демонстрацию экрана':
  share.disabled?'Дождитесь подключения для демонстрации':'Демонстрировать экран или окно';
 share.setAttribute('aria-label',share.title);
 const stop=$call('stopShareScreen');
 stop.classList.toggle('hidden',!c?.screen);
 stop.disabled=!c?.screen;
 const mirror=$call('mirrorCamera');
 mirror.setAttribute('aria-pressed',String(!!c?.mirrorCamera));
 mirror.disabled=c?.mode!=='video';
 const flip=$call('switchCamera');
 flip.disabled=c?.mode!=='video'||!c?.stream;
 $call('localVideo').classList.toggle('camera-mirrored',!!c?.mirrorCamera&&!c?.screen);
 camera.setAttribute('aria-pressed',String(c?.mode==='video'&&!cameraOn));
 camera.title=c?.mode!=='video'?
  'Камера доступна только в видеозвонке':
  cameraOn?'Выключить камеру':'Включить камеру';
 camera.setAttribute('aria-label',camera.title);
}
function markCallConnected(c){
 if(currentCall!==c)return;
 if(c.connectWatchdog){clearTimeout(c.connectWatchdog);c.connectWatchdog=null}
 if(c.recoveryTimer){clearTimeout(c.recoveryTimer);c.recoveryTimer=null}
 c.restarts=0;
 playIncomingCallAudio(c);
 updateCallButtons(c);
 if(c.started)return;
 c.started=Date.now();stopCallRingtone();
 setCallVisualStage('connected');
 $call('callTitle').textContent=c.mode==='video'?'Видеосвязь':'На связи';
 $call('callStatus').textContent='Соединено';
 callTick=setInterval(updateCallDuration,1000);
 monitorCallQuality();
}
function callLayout(){
 const c=currentCall;if(!c)return;
 $call('callLayer').classList.remove('hidden');
 $call('callLayer').classList.toggle('audio-only',c.mode!=='video');
 $call('videoArea').classList.remove('has-remote-video');
 const stage=c.incoming?'incoming':c.started?'connected':'outgoing';
 setCallVisualStage(stage);
 $call('callTitle').textContent=c.incoming?
   (c.mode==='video'?'Входящий видеозвонок':'Входящий звонок'):
   c.started?(c.mode==='video'?'Видеосвязь':'На связи'):'Соединение...';
 $call('callStatus').textContent=c.incoming?'Принять или отклонить вызов':
   c.started?'Соединено':'Ожидаем ответа…';
 document.querySelector('.call-accept-controls').classList.toggle('hidden',!c.incoming);
 document.querySelector('.call-active-controls').classList.toggle('hidden',c.incoming);
 $call('shareScreen').classList.toggle('hidden',c.mode!=='video'||!navigator.mediaDevices?.getDisplayMedia);
 $call('callTimer').textContent='00:00';
 $call('callQuality').textContent='Ожидаем аудиосоединение…';
 $call('callQuality').classList.remove('warning');
 $call('noiseSuppression').checked=callNoiseEnabled;
 c.mirrorCamera=preferredVideoMirror;
 $call('callExtra').open=false;
 updateCallButtons(c);
}
async function getLocalCallMedia(mode){
 if(!navigator.mediaDevices?.getUserMedia)throw Error('Микрофон/камера недоступны. Нужен HTTPS и разрешение пользователя.');
 const video=mode==='video'?{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}:false;
 try{return await navigator.mediaDevices.getUserMedia({audio:callAudioConstraints(),video})}
 catch(e){
  const recoverable=['OverconstrainedError','NotFoundError','NotAllowedError','TypeError','NotReadableError','AbortError'];
  if(!recoverable.includes(e.name))throw e;
  // Camera access may fail independently of audio; keep video reception and
  // screen sharing available by reserving a recv/send video transceiver.
  const audio=await navigator.mediaDevices.getUserMedia({
   audio:{echoCancellation:true,noiseSuppression:callNoiseEnabled},video:false
  });
  if(mode==='video')toast('Камера недоступна. Звук подключён; можно включить камеру позже или показать экран.');
  return audio;
 }
}
async function beginCall(mode){
 if(currentCall)return toast('У вас уже есть активный звонок');
 const c=state.active;if(!c||c.is_group||c.is_saved||!c.peer_id)return toast('Звонить можно только другу из личного чата');
 if(!state.ws||state.ws.readyState!==WebSocket.OPEN)return toast('Онлайн-канал ещё не подключён');
 prepareCallAudioFromGesture();
 let stream;try{stream=await getLocalCallMedia(mode)}catch(e){return toast('Не удалось получить доступ к устройствам: '+e.message)}
 currentCall={id:crypto.randomUUID(),peer:c.peer_id,nick:c.name,mode,incoming:false,isCaller:true,stream,
  pc:null,ice:[],started:0,screen:null,remoteStream:null,restarts:0,mirrorCamera:preferredVideoMirror};
 const outgoing=currentCall;
 callLayout();$call('localVideo').srcObject=stream;
 $call('localVideo').classList.toggle('hidden',mode!=='video'||!stream.getVideoTracks().length);
 $call('localVideo').play().catch(()=>{});
 if(!await loadCallIce(outgoing)){endCall(false);return}
 if(!signalCall('invite',{mode})){endCall(false);return}
 startCallRingtone(false);
 currentCall.timeout=setTimeout(()=>{if(currentCall&&!currentCall.started){toast('На вызов не ответили');endCall(true)}},60000);
}
function createPeer(){
 const c=currentCall;if(!c)return null;
 const pc=new RTCPeerConnection({iceServers:c.iceServers||MPOL_FALLBACK_ICE,
  iceCandidatePoolSize:0,iceTransportPolicy:'all'});
 c.pc=pc;
 c.remoteStream=new MediaStream();
 if(c.mode==='video'&&!c.stream.getVideoTracks().length){
  pc.addTransceiver('video',{direction:'sendrecv'});
 }
 for(const t of c.stream.getTracks()){
  const sender=pc.addTrack(t,c.stream);
  if(t.kind==='audio')t.onended=()=>{if(currentCall===c)recoverMicrophone()};
  if(t.kind==='video'){
   // 720p capable, and 5x previous video bitrate ceiling (400kbps).
   // WebRTC congestion control can send less when the network is poor.
   try{
    const params=sender.getParameters();
    if(params.encodings?.length){
     params.encodings[0].maxBitrate=2000000;
     params.encodings[0].maxFramerate=30;
     params.degradationPreference='balanced';
     sender.setParameters(params).catch(()=>{});
    }
   }catch{}
  }
 }
 pc.onicecandidate=e=>{if(e.candidate&&currentCall===c)signalCall('ice',{candidate:e.candidate.toJSON()})};
 pc.onicecandidateerror=e=>{
  if(currentCall!==c||!c.relayConfigured)return;
  const status=$call('callQuality');
  status.textContent='Ошибка TURN/STUN ('+String(e.errorCode||'сеть')+'). Проверьте релей и интернет.';
  status.classList.add('warning');
 };
 pc.ontrack=e=>{
  if(currentCall!==c)return;
  // Both remote tracks belong to one persistent MediaStream; changing srcObject
  // on each ontrack event was interrupting playback in Chrome/Edge app mode.
  if(!c.remoteStream.getTracks().some(t=>t.id===e.track.id))c.remoteStream.addTrack(e.track);
  const audio=$call('remoteAudio'),video=$call('remoteVideo');
  // Never play local capture in a speaker; the remote stream is the sole
  // audio playback path and camera preview must always remain muted.
  $call('localVideo').muted=true;
  if(e.track.kind==='audio')playIncomingCallAudio(c);
  if(c.mode==='video'){
   if(video.srcObject!==c.remoteStream)video.srcObject=c.remoteStream;
   // Video is silent: the audio element is the only playback path.
   video.muted=true;
   video.play().catch(()=>{});
   if(e.track.kind==='video'){
    const area=$call('videoArea');
    const showVideo=()=>{if(currentCall===c && !e.track.muted)area.classList.add('has-remote-video')};
    e.track.onunmute=()=>{showVideo();video.play().catch(()=>{})};
    e.track.onmute=()=>{if(currentCall===c)area.classList.remove('has-remote-video')};
    video.onplaying=()=>{
     if(currentCall===c&&c.remoteStream.getVideoTracks().some(t=>!t.muted))
      area.classList.add('has-remote-video');
    };
    showVideo();
   }
  }
  if(e.track.kind==='audio'){
   e.track.onmute=()=>{if(currentCall===c)$call('callQuality').textContent='Входящий микрофон временно недоступен'};
   e.track.onunmute=()=>{if(currentCall===c){
    $call('callQuality').textContent='Входящий звук восстановлен';
    playIncomingCallAudio(c);
   }};
  }
 };
 pc.onconnectionstatechange=()=>{
  if(currentCall!==c)return;
  if(pc.connectionState==='connected'){
   if(c.connectWatchdog){clearTimeout(c.connectWatchdog);c.connectWatchdog=null}
   playIncomingCallAudio(c);
   markCallConnected(c)
  }else if(pc.connectionState==='disconnected'){
   $call('callStatus').textContent='Восстанавливаем соединение…';
   tryRecoverCall(c);
  }else if(pc.connectionState==='failed'){
   $call('callStatus').textContent='Сеть потеряна — восстанавливаем…';
   $call('callQuality').textContent=c.relayConfigured?'Проверяем соединение через TURN/STUN…':'Для этой сети может потребоваться TURN-сервер';
   $call('callQuality').classList.add('warning');
   tryRecoverCall(c);
  }else if(pc.connectionState==='closed'&&currentCall===c){endCall(false)}
 };
 pc.oniceconnectionstatechange=()=>{
  if(currentCall!==c)return;
  const ice=pc.iceConnectionState;
  if(ice==='connected'||ice==='completed'){
   if(c.connectWatchdog){clearTimeout(c.connectWatchdog);c.connectWatchdog=null}
   playIncomingCallAudio(c);
   markCallConnected(c);
  }else if(ice==='failed')tryRecoverCall(c);
  else if(ice==='disconnected')tryRecoverCall(c);
 };
 startCallWatchdog(c);
 updateCallButtons(c);
 return pc;
}
async function applyQueuedIce(){
 const c=currentCall;if(!c?.pc?.remoteDescription)return;
 for(const candidate of c.ice.splice(0)){try{await c.pc.addIceCandidate(candidate)}catch{}}
}
async function acceptIncomingCall(){
 const c=currentCall;if(!c||!c.incoming)return;
 prepareCallAudioFromGesture();
 try{
  c.stream=await getLocalCallMedia(c.mode);c.incoming=false;stopCallRingtone();
  callLayout();$call('callStatus').textContent='Подключаемся…';
  $call('localVideo').srcObject=c.stream;
  $call('localVideo').classList.toggle('hidden',!c.stream.getVideoTracks().length);
  $call('localVideo').play().catch(()=>{});
  if(!await loadCallIce(c)){endCall(false);return}
  createPeer();if(!signalCall('accept'))endCall(false);
 }catch(e){toast('Микрофон/камера не разрешены: '+e.message);signalCall('decline');endCall(false)}
}
async function onCallSignal(m){
 const kind=m.kind,from=m.from_id,id=m.call_id;
 if(kind==='invite'){
  if(currentCall){if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:'call_signal',to:from,call_id:id,kind:'busy'}));return}
  const mode=m.payload?.mode==='video'?'video':'audio';
  currentCall={id,peer:from,nick:m.nick||'Пользователь',mode,incoming:true,isCaller:false,stream:null,pc:null,ice:[],started:0,screen:null,remoteStream:null,restarts:0,mirrorCamera:preferredVideoMirror};
  callLayout();startCallRingtone(true);
  if(state.notif&&'Notification'in window&&Notification.permission==='granted'&&document.hidden){
   try{const n=new Notification('MPOL · '+(mode==='video'?'видеозвонок':'входящий звонок'),
     {body:'Откройте приложение, чтобы ответить',tag:'mpol-call'});
    n.onclick=()=>{window.focus();n.close()}}catch{}
  }
  return;
 }
 const c=currentCall;if(!c||c.id!==id||c.peer!==from)return;
 try{
  if(['decline','busy','hangup','unavailable'].includes(kind)){toast(kind==='unavailable'?'Собеседник сейчас не в сети. Для звонка ему нужно открыть MPOL.':kind==='busy'?'Собеседник занят':kind==='decline'?'Вызов отклонён':'Звонок завершён');endCall(false);return}
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
 if(c.connectWatchdog)clearTimeout(c.connectWatchdog);
 if(c.recoveryTimer)clearTimeout(c.recoveryTimer);
 try{c.pc?.close()}catch{}
 for(const track of c.stream?.getTracks()||[])track.stop();
 for(const track of c.screen?.getTracks()||[])track.stop();
 $call('localVideo').srcObject=null;$call('remoteVideo').srcObject=null;$call('remoteAudio').srcObject=null;
 $call('videoArea').classList.remove('has-remote-video');
 $call('callLayer').classList.add('hidden');
}
function toggleCallMic(){
 const c=currentCall;if(!c?.stream)return;
 const tracks=c.stream.getAudioTracks();const enabled=!tracks.some(t=>t.enabled);
 tracks.forEach(track=>{track.enabled=enabled});
 updateCallButtons(c);
}
function toggleCallSpeaker(){
 const c=currentCall;if(!c)return;
 c.speakerMuted=!c.speakerMuted;
 $call('remoteAudio').muted=c.speakerMuted;
 if(!c.speakerMuted){
  prepareCallAudioFromGesture();
  playIncomingCallAudio(c);
 }
 updateCallButtons(c);
}
function cameraVideoConstraints(deviceId){
 return {width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30},
  ...(deviceId?{deviceId:{exact:deviceId}}:{})};
}
function videoSender(c){
 return c.pc?.getSenders?.().find(s=>s.track?.kind==='video')||
  c.pc?.getTransceivers?.().find(t=>t.receiver?.track?.kind==='video')?.sender;
}
function updateLocalCallPreview(c){
 if(currentCall!==c)return;
 const camera=c.stream?.getVideoTracks()[0];
 const video=$call('localVideo');
 video.srcObject=c.screen || (camera?c.stream:null);
 video.classList.toggle('hidden',!c.screen&&!camera);
 video.classList.toggle('camera-mirrored',!!c.mirrorCamera&&!c.screen);
 if(video.srcObject)video.play().catch(()=>{});
 updateCallButtons(c);
}
async function toggleCallCamera(){
 const c=currentCall;if(!c?.stream||c.mode!=='video')return;
 const tracks=c.stream.getVideoTracks();
 if(tracks.length){
  const enabled=!tracks.some(t=>t.enabled);
  tracks.forEach(track=>{track.enabled=enabled});
  updateCallButtons(c);return;
 }
 let fresh=null;
 try{
  fresh=await navigator.mediaDevices.getUserMedia({video:cameraVideoConstraints(),audio:false});
  if(currentCall!==c){fresh.getTracks().forEach(t=>t.stop());return}
  const camera=fresh.getVideoTracks()[0];
  if(!camera)throw Error('Камера не найдена');
  const sender=videoSender(c);
  if(sender&&!c.screen)await sender.replaceTrack(camera);
  c.stream.addTrack(camera);
  updateLocalCallPreview(c);
 }catch(e){
  if(fresh)fresh.getTracks().forEach(t=>t.stop());
  toast('Не удалось включить камеру: '+e.message)
 }
}
function mirrorCallCamera(){
 preferredVideoMirror=!preferredVideoMirror;
 localStorage.setItem('mpol_video_mirror',preferredVideoMirror?'1':'0');
 if(currentCall){currentCall.mirrorCamera=preferredVideoMirror;updateLocalCallPreview(currentCall)}
 toast(preferredVideoMirror?'Зеркальный предпросмотр включён':'Зеркальный предпросмотр выключен');
}
async function switchCallCamera(){
 const c=currentCall;
 if(!c?.stream||c.mode!=='video')return;
 if(!navigator.mediaDevices?.enumerateDevices)return toast('Выбор камеры недоступен');
 let fresh=null;
 try{
  const devices=(await navigator.mediaDevices.enumerateDevices()).filter(x=>x.kind==='videoinput');
  if(devices.length<2)return toast('На устройстве доступна только одна камера');
  const old=c.stream.getVideoTracks()[0];
  const currentId=old?.getSettings?.().deviceId;
  const ix=devices.findIndex(x=>x.deviceId===currentId);
  const next=devices[(ix<0?1:ix+1)%devices.length];
  fresh=await navigator.mediaDevices.getUserMedia({
   audio:false,video:cameraVideoConstraints(next.deviceId)
  });
  if(currentCall!==c){fresh.getTracks().forEach(t=>t.stop());return}
  const camera=fresh.getVideoTracks()[0];
  if(!camera)throw Error('Не удалось открыть выбранную камеру');
  const sender=videoSender(c);
  if(sender&&!c.screen)await sender.replaceTrack(camera);
  if(old){c.stream.removeTrack(old);old.stop()}
  c.stream.addTrack(camera);
  updateLocalCallPreview(c);
  toast('Камера переключена');
 }catch(e){
  if(fresh)fresh.getTracks().forEach(t=>t.stop());
  toast('Смена камеры не удалась: '+e.message);
 }
}
async function stopCallScreen(c){
 if(currentCall!==c||!c.screen)return;
 const share=c.screen;
 // MediaStreamTrack.stop() does NOT emit the "ended" event. Restore
 // the sender and the UI here when Stop is pressed.
 c.screen=null;
 const sender=videoSender(c);
 try{
  if(sender)await sender.replaceTrack(c.stream?.getVideoTracks()[0]||null);
 }catch(e){
  if(currentCall===c)toast('Ошибка восстановления камеры: '+e.message);
 }finally{
  for(const track of share.getTracks()){track.onended=null;track.stop()}
  if(currentCall===c){updateLocalCallPreview(c);toast('Демонстрация экрана остановлена')}
 }
}
async function shareCallScreen(){
 const c=currentCall;if(!c||c.mode!=='video')return;
 if(c.screen)return stopCallScreen(c);
 if(!c.pc)return toast('Дождитесь ответа собеседника, затем включите демонстрацию.');
 const sender=videoSender(c);
 if(!sender)return toast('Видеоканал ещё не готов.');
 let share=null;
 try{
  // Each capture session must be explicitly chosen by the user.
  share=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
  const track=share.getVideoTracks()[0];
  if(!track)throw Error('Не выбран экран');
  if(currentCall!==c){share.getTracks().forEach(t=>t.stop());return}
  await sender.replaceTrack(track);
  c.screen=share;
  track.onended=()=>{if(currentCall===c&&c.screen===share)stopCallScreen(c)};
  updateLocalCallPreview(c);
  toast('Демонстрация экрана включена');
 }catch(e){
  if(share&&!c.screen)share.getTracks().forEach(t=>t.stop());
  if(!['NotAllowedError','AbortError'].includes(e.name))
   toast('Экран недоступен: '+e.message);
 }
}
$call('voiceCall').onclick=()=>beginCall('audio');
$call('videoCall').onclick=()=>beginCall('video');
$call('acceptCall').onclick=acceptIncomingCall;
$call('declineCall').onclick=()=>endCall(true);
$call('endCall').onclick=()=>endCall(true);
$call('muteMic').onclick=toggleCallMic;
$call('toggleSpeaker').onclick=toggleCallSpeaker;
$call('toggleCamera').onclick=toggleCallCamera;
$call('shareScreen').onclick=shareCallScreen;
$call('stopShareScreen').onclick=()=>{if(currentCall)stopCallScreen(currentCall)};
$call('mirrorCamera').onclick=mirrorCallCamera;
$call('switchCamera').onclick=switchCallCamera;
$call('noiseSuppression').onchange=async e=>{
 callNoiseEnabled=e.target.checked;localStorage.setItem('mpol_call_denoise',callNoiseEnabled?'1':'0');
 try{const t=currentCall?.stream?.getAudioTracks()[0];if(t?.applyConstraints)await t.applyConstraints(callAudioConstraints());
  toast(callNoiseEnabled?'Шумоподавление включено':'Шумоподавление отключено');
 }catch{toast('Это устройство не поддерживает изменение шумоподавления')}
};
$call('enableCallAudio').onclick=()=>{
 if(currentCall)currentCall.speakerMuted=false;
 prepareCallAudioFromGesture();
 if(currentCall){playIncomingCallAudio(currentCall);updateCallButtons(currentCall)}
 if(currentCall?.mode==='video')$call('remoteVideo').play()?.catch?.(()=>{});
 toast('Проверяем звук собеседника');
};
document.addEventListener('visibilitychange',()=>{
 if(!document.hidden&&currentCall){
  playIncomingCallAudio(currentCall);
  if(currentCall.pc?.connectionState==='failed'||currentCall.pc?.iceConnectionState==='failed')
   tryRecoverCall(currentCall);
 }
});
$call('callVolume').oninput=e=>{
 const volume=Number(e.target.value)/100;$call('remoteAudio').volume=volume;
};
