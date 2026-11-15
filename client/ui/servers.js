'use strict';
/* MPOL 3.8: authenticated server UI and four-person WebRTC voice rooms. */
(() => {
 const el=id=>document.getElementById(id), a=()=>window.mpolServerApp;
 if(!el('serverDashboard'))return;
 const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const titles={owner:'Владелец',admin:'Администратор',moderator:'Модератор',member:'Участник'};
 const rank={owner:3,admin:2,moderator:1,member:0};
 let spaces=[],current=null,selectedId='',voice=null,loadSeq=0;
 const api=(p,opts)=>a().api(p,opts);
 const fail=e=>a().toast(a().errorText(e));
 let lastError='';
 function explain(e){
  const msg=a().errorText(e);
  if(/HTTP\s+404|Not Found|404/i.test(msg))
   return 'На выбранном сервере MPOL нет поддержки игровых серверов. Обновите сервер до 3.8 или проверьте адрес в настройках EXE.';
  if(/HTTP\s+401|401/i.test(msg))
   return 'Сессия MPOL устарела. Войдите в аккаунт снова.';
  if(/HTTP\s+403|403/i.test(msg))
   return 'У вас нет разрешения на это действие. Проверьте роль на сервере.';
  if(/HTTP\s+5\d\d|502|503|504/i.test(msg))
   return 'Сервис MPOL временно недоступен. Данные сервера сохраняются; повторите позже.';
  return msg;
 }
 function displayError(e){
  lastError=explain(e);
  if(a().state.tab==='servers'){
   showDashboard();
   const target=el('serverOverview');
   target.innerHTML='<div class="server-empty server-error"><h2>Не удалось открыть серверы</h2>'+
    '<p>'+html(lastError)+'</p><small>Подключено: '+html(location.host)+'</small>'+
    '<button id="serverRetry" class="button">Повторить подключение</button>'+
    (typeof isDesktopClient!=='undefined'&&isDesktopClient?'<button id="serverOpenConfig" class="button outlined">Настроить сервер</button>':'')+'</div>';
   el('serverRetry').onclick=()=>reload().catch(displayError);
   el('serverOpenConfig')?.addEventListener('click',()=>{location.href='mpol://settings'});
  }
  a().toast(lastError);
 }
 const permitted=role=>current&&rank[current.role]>=rank[role];
 function wsSend(data){
  const ws=a().state.ws;
  if(!ws||ws.readyState!==WebSocket.OPEN){a().toast('Нет подключения к MPOL');return false}
  ws.send(JSON.stringify(data));return true;
 }
 async function reload(){
  const list=await api('/servers');lastError='';spaces=Array.isArray(list)?list:[];
  renderList(el('listSearch')?.value?.toLowerCase()||'');
  if(selectedId&&!spaces.some(x=>x.id===selectedId)){
   selectedId='';current=null;await leaveVoice();
  }
  if(a().state.tab==='servers'){
   if(selectedId)await select(selectedId);
   else if(spaces.length)await select(spaces[0].id);
   else render();
  }
 }
 function renderList(filter=''){
  if(a().state.tab!=='servers')return;
  const root=el('chatList');root.replaceChildren();
  for(const s of spaces.filter(x=>x.name.toLowerCase().includes(filter))){
   const btn=document.createElement('button');btn.className='server-list-item'+(selectedId===s.id?' selected':'');
   btn.innerHTML='<span class="server-list-icon">'+html(s.icon||'◈')+
    '</span><span class="server-list-meta"><strong>'+html(s.name)+'</strong><small>'+
    s.members_count+' участников · '+html(titles[s.role]||'')+'</small></span>';
   btn.onclick=()=>select(s.id).catch(fail);root.append(btn);
  }
  if(!root.children.length)root.innerHTML='<div class="list-blank"><strong>Нет серверов</strong>Создайте сервер и пригласите друзей.</div>';
 }
 function showDashboard(){
  el('openedChat').classList.add('hidden');el('emptyChat').classList.add('hidden');
  el('serverDashboard').classList.remove('hidden');
  // When Windows DPI scaling creates a narrow CSS viewport, the original
  // mobile layout hid .conversation completely. Keep the server pane visible.
  el('mainScreen').classList.remove('mobile-chat-open');
  el('mainScreen').classList.add('server-pane-open');
 }
 async function select(id){
  if(!id)return;
  selectedId=id;current=null;const seq=++loadSeq;
  showDashboard();renderList(el('listSearch')?.value?.toLowerCase()||'');
  try{
   const detail=await api('/servers/'+encodeURIComponent(id));
   if(seq!==loadSeq||selectedId!==id)return;
   current=detail;render();
  }catch(e){displayError(e)}
 }
 function openTab(){showDashboard();render();reload().catch(displayError)}
 function createServer(){
  a().modal('Создать сервер','<label>Название сервера<input id="newServerName" maxlength="72" placeholder="Моя команда"></label>'+
   '<label>Описание<input id="newServerDesc" maxlength="260" placeholder="Играем вместе"></label>'+
   '<label>Значок<input id="newServerIcon" maxlength="5" value="◈"></label>'+
   '<button class="button" id="newServerSave">Создать сервер</button>');
  el('newServerSave').onclick=async()=>{
   const save=el('newServerSave');if(save.disabled)return;
   save.disabled=true;
   try{
    const s=await api('/servers',{method:'POST',body:{name:el('newServerName').value.trim(),
     description:el('newServerDesc').value.trim(),icon:el('newServerIcon').value.trim()||'◈'}});
    a().closeModal();await reload();await select(s.id);
    a().toast('Сервер «'+s.name+'» создан');
   }catch(e){const button=el('newServerSave');if(button)button.disabled=false;displayError(e)}
  };
 }
 function editServer(){
  a().modal('Настройки сервера','<label>Название<input id="serverEditName" maxlength="72" value="'+html(current.name)+'"></label>'+
   '<label>Описание<input id="serverEditDesc" maxlength="260" value="'+html(current.description||'')+'"></label>'+
   '<label>Иконка<input id="serverEditIcon" maxlength="5" value="'+html(current.icon)+'"></label>'+
   '<button id="serverEditSave" class="button">Сохранить</button>');
  el('serverEditSave').onclick=async()=>{
   try{await api('/servers/'+encodeURIComponent(current.id),{method:'PUT',
    body:{name:el('serverEditName').value.trim(),description:el('serverEditDesc').value.trim(),
     icon:el('serverEditIcon').value.trim()||'◈'}});a().closeModal();await reload()}catch(e){fail(e)}
  };
 }
 function invite(){
  const friends=a().state.friends.filter(f=>!current.members.some(m=>m.id===f.id));
  if(!friends.length)return a().toast('Добавьте друзей в MPOL, чтобы пригласить их');
  a().modal('Пригласить друга','<label>Друг<select id="serverFriendSelect">'+friends.map(f=>
   '<option value="'+html(f.id)+'">'+html(f.nick)+'</option>').join('')+'</select></label>'+
   '<button id="serverInviteSave" class="button">Добавить на сервер</button>');
  el('serverInviteSave').onclick=async()=>{
   try{await api('/servers/'+encodeURIComponent(selectedId)+'/members',
    {method:'POST',body:{user_id:el('serverFriendSelect').value}});
    a().closeModal();await reload();a().toast('Друг добавлен')}catch(e){fail(e)}
  };
 }
 function createChannel(){
  a().modal('Новый канал','<label>Название<input id="serverNewChannelName" maxlength="64" placeholder="Игра 1"></label>'+
   '<label>Тип<select id="serverNewChannelKind"><option value="voice">Голосовая комната</option>'+
   '<option value="text">Текстовый канал</option></select></label>'+
   '<button class="button" id="serverNewChannelSave">Создать канал</button>');
  el('serverNewChannelSave').onclick=async()=>{
   try{await api('/servers/'+encodeURIComponent(selectedId)+'/channels',{method:'POST',
    body:{name:el('serverNewChannelName').value.trim(),kind:el('serverNewChannelKind').value}});
    a().closeModal();await select(selectedId)}catch(e){fail(e)}
  };
 }
 function manageMember(member){
  if(!permitted('moderator')||member.role==='owner'||member.id===a().state.me.id||
    rank[current.role]<=rank[member.role])return;
  const canRole=permitted('admin');
  const opts=['member','moderator',...(current.role==='owner'?['admin']:[])];
  a().modal('Участник '+html(member.nick),'<p>Роль: '+html(titles[member.role])+'</p>'+
   (canRole?'<label>Роль<select id="serverRoleChange">'+opts.map(role=>
    '<option value="'+role+'" '+(role===member.role?'selected':'')+'>'+titles[role]+'</option>').join('')+
    '</select></label><button id="serverRoleSave" class="button">Назначить роль</button>':'')+
   '<div class="server-modal-buttons"><button id="serverKick" class="button outlined">Удалить</button>'+
   '<button id="serverBan" class="button outlined">Заблокировать</button></div>');
  if(canRole)el('serverRoleSave').onclick=async()=>{
   try{await api('/servers/'+encodeURIComponent(selectedId)+'/members/'+encodeURIComponent(member.id)+'/role',
    {method:'PATCH',body:{role:el('serverRoleChange').value}});
    a().closeModal();await select(selectedId)}catch(e){fail(e)}
  };
  for(const [id,ban] of [['serverKick',false],['serverBan',true]]){
   el(id).onclick=async()=>{
    if(!confirm((ban?'Заблокировать ':'Удалить ')+member.nick+'?'))return;
    try{await api('/servers/'+encodeURIComponent(selectedId)+'/members/'+
      encodeURIComponent(member.id)+(ban?'?ban=true':''),{method:'DELETE'});
     a().closeModal();await select(selectedId)}catch(e){fail(e)}
   };
  }
 }
 function render(){
  if(a().state.tab!=='servers')return;
  showDashboard();
  const box=el('serverOverview');
  if(!current||current.id!==selectedId){
   box.innerHTML='<div class="server-empty"><div class="server-main-symbol">◈</div>'+
    '<h2>Игровые сервера MPOL</h2><p>Создайте сообщество и пригласите друзей.</p>'+
    '<button id="serverStartCreate" class="button">+ Создать сервер</button></div>';
   el('serverStartCreate').onclick=createServer;return;
  }
  const c=current;
  const text=c.channels.filter(x=>x.kind==='text'),rooms=c.channels.filter(x=>x.kind==='voice');
  box.innerHTML='<div class="server-quicknav"><select id="serverSwitch" aria-label="Выбрать сервер">'+
   spaces.map(s=>'<option value="'+html(s.id)+'" '+(s.id===selectedId?'selected':'')+'>'+html(s.name)+'</option>').join('')+
   '</select><button type="button" id="serverQuickCreate">+ Сервер</button></div>'+
   '<header class="server-overview-header">'+
   '<div class="server-cover">'+html(c.icon||'◈')+'</div><div class="server-heading">'+
   '<small>MPOL · СЕРВЕРА</small><h2>'+html(c.name)+'</h2><p>'+html(c.description||'Игровое сообщество')+
   '</p></div><div class="server-header-actions">'+
   (permitted('moderator')?'<button id="serverInvite">+ Пригласить</button>':'')+
   (permitted('admin')?'<button id="serverSettings">⚙</button>':'')+'</div></header>'+
   '<div class="server-columns"><section class="server-channels"><div class="server-label">ТЕКСТОВЫЕ КАНАЛЫ</div>'+
   text.map(t=>'<button class="server-channel-btn" data-text="'+html(t.id)+'"><b>#</b> '+html(t.name)+'</button>').join('')+
   '<div class="server-label server-voice-label">ГОЛОСОВЫЕ КОМНАТЫ '+
   (permitted('admin')?'<button id="serverPlusRoom" title="Новая комната">＋</button>':'')+'</div>'+
   rooms.map(t=>'<button class="server-channel-btn" data-room="'+html(t.id)+'"><b>♫</b> '+
    html(t.name)+' <small>'+t.online.length+'/4</small></button>').join('')+
   (permitted('admin')?'<button id="serverPlusChannel" class="server-add-channel">+ Создать канал</button>':'')+
   '</section><section class="server-member-section"><div class="server-label">УЧАСТНИКИ · '+c.members.length+'</div>'+
   c.members.map(m=>'<button class="server-member-btn" data-member="'+html(m.id)+'">'+
    '<span class="server-member-avatar">'+html((m.nick||'?').slice(0,1))+'</span>'+
    '<span><strong>'+html(m.nick)+'</strong><small>'+html(titles[m.role]||m.role)+'</small></span>'+
    '<span class="server-dot '+(m.online?'online':'')+'"></span></button>').join('')+
   (c.role!=='owner'?'<button id="serverLeave" class="server-leave">Покинуть сервер</button>':'')+
   '</section></div>';
  el('serverSwitch')?.addEventListener('change',event=>select(event.target.value).catch(displayError));
  el('serverQuickCreate')?.addEventListener('click',createServer);
  el('serverInvite')?.addEventListener('click',invite);
  el('serverSettings')?.addEventListener('click',editServer);
  el('serverPlusRoom')?.addEventListener('click',createChannel);
  el('serverPlusChannel')?.addEventListener('click',createChannel);
  box.querySelectorAll('[data-member]').forEach(b=>b.onclick=()=>{
   const m=c.members.find(x=>x.id===b.dataset.member);if(m)manageMember(m)
  });
  box.querySelectorAll('[data-text]').forEach(b=>b.onclick=async()=>{
   const ch=c.channels.find(x=>x.id===b.dataset.text);if(!ch?.chat_id)return;
   try{await a().refreshAll();await a().selectChat(ch.chat_id)}catch(e){fail(e)}
  });
  box.querySelectorAll('[data-room]').forEach(b=>b.onclick=()=>{
   const ch=c.channels.find(x=>x.id===b.dataset.room);
   if(ch)joinVoice(ch).catch(fail);
  });
  el('serverLeave')?.addEventListener('click',async()=>{
   if(!confirm('Покинуть сервер '+c.name+'?'))return;
   try{await api('/servers/'+encodeURIComponent(c.id)+'/members/'+
     encodeURIComponent(a().state.me.id),{method:'DELETE'});
    await leaveVoice();selectedId='';current=null;await reload();render()}catch(e){fail(e)}
  });
 }
 function updateVoice(){
  if(!voice)return;
  const v=voice;
  el('voiceStatus').textContent=v.joined?
   'В комнате · '+(v.peers.size+1)+'/4':'Подключаемся…';
  el('voiceMute').textContent=v.stream.getAudioTracks()[0]?.enabled?'🎙 Выключить микрофон':'◩ Включить микрофон';
  el('voiceCamera').textContent=v.camera?'◩ Выключить камеру':'▣ Включить камеру';
  el('voiceShare').textContent=v.screen?'■ Остановить показ':'▣ Показ экрана';
 }
 function peerCard(user,self=false){
  if(!voice||!user?.id)return;
  const root=el('voiceMembers');
  if([...root.children].some(x=>x.dataset.userId===user.id))return;
  const div=document.createElement('div');div.className='server-voice-peer';div.dataset.userId=user.id;
  div.innerHTML='<span class="server-member-avatar">'+html((user.nick||'?')[0])+'</span>'+
   '<span class="voice-peer-text"><strong>'+html(user.nick)+(self?' (вы)':'')+'</strong>'+
   '<small>'+(self?'Микрофон включён':'Подключается…')+'</small></span>';
  if(!self){
   const vol=document.createElement('input');vol.type='range';vol.min='0';vol.max='100';vol.value='100';
   vol.className='server-peer-volume';vol.setAttribute('aria-label','Громкость '+user.nick);
   const audio=document.createElement('audio');audio.autoplay=true;audio.playsInline=true;
   const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.muted=true;
   video.className='server-remote-video hidden';
   vol.oninput=()=>{const peer=voice?.peers.get(user.id);if(peer)peer.audio.volume=Number(vol.value)/100};
   div.append(vol,audio,video);
   voice.peers.set(user.id,{id:user.id,pc:null,div,audio,video,candidates:[]});
  }
  root.append(div);
 }
 function showVoice(){
  if(!voice)return;
  const v=voice,area=el('serverVoicePanel');area.classList.remove('hidden');
  area.innerHTML='<div class="voice-room-header"><div><small>ГОЛОСОВАЯ КОМНАТА</small>'+
   '<strong>'+html(v.channel.name)+'</strong></div><button id="voiceLeave">Выйти</button></div>'+
   '<p id="voiceStatus" class="voice-status"></p><div id="voiceMembers" class="voice-members"></div>'+
   '<video id="voicePreview" class="voice-preview hidden" autoplay muted playsinline></video>'+
   '<div class="voice-controls"><button id="voiceMute">🎙 Микрофон</button>'+
   '<button id="voiceCamera">▣ Камера</button><button id="voiceShare">▣ Показ экрана</button></div>'+
   '<small class="voice-note">Игровая комната · максимум 4 участника</small>';
  el('voiceLeave').onclick=leaveVoice;
  el('voiceMute').onclick=()=>{
   for(const t of v.stream.getAudioTracks())t.enabled=!t.enabled;
   updateVoice();
  };
  el('voiceCamera').onclick=()=>toggleCamera().catch(fail);
  el('voiceShare').onclick=()=>toggleShare().catch(fail);
  peerCard({id:a().state.me.id,nick:a().state.me.nick},true);updateVoice();
 }
 function transmit(to,kind,payload){
  wsSend({type:'space_voice_signal',to,kind,payload});
 }
 function peer(id){
  const v=voice;
  if(!v)return null;
  if(!v.peers.has(id))peerCard(current?.members.find(x=>x.id===id)||{id,nick:id});
  const p=v.peers.get(id);
  if(!p||p.pc)return p;
  const pc=new RTCPeerConnection({iceServers:v.iceServers,iceCandidatePoolSize:2});p.pc=pc;
  for(const track of v.stream.getAudioTracks())pc.addTrack(track,v.stream);
  const tx=pc.addTransceiver('video',{direction:'sendrecv'});
  const video=v.screen?.getVideoTracks()[0]||v.camera?.getVideoTracks()[0];
  if(video)tx.sender.replaceTrack(video).catch(()=>{});
  pc.onicecandidate=e=>{if(voice===v&&e.candidate)transmit(id,'ice',{candidate:e.candidate.toJSON()})};
  pc.ontrack=e=>{
   if(voice!==v)return;
   if(e.track.kind==='audio'){
    p.audio.srcObject=new MediaStream([e.track]);p.audio.play().catch(()=>{});
    p.div.querySelector('small').textContent='На связи';
   }else{
    p.video.srcObject=new MediaStream([e.track]);
    p.video.onplaying=()=>p.video.classList.remove('hidden');
    e.track.onmute=()=>p.video.classList.add('hidden');
    e.track.onunmute=()=>{p.video.classList.remove('hidden');p.video.play().catch(()=>{})};
    p.video.play().catch(()=>{});
   }
  };
  pc.onconnectionstatechange=()=>{
   if(voice!==v)return;
   const small=p.div.querySelector('small');
   if(small)small.textContent=pc.connectionState==='connected'?'На связи':
    pc.connectionState==='failed'?'Связь потеряна':'Подключение…';
  };
  return p;
 }
 async function offer(id){
  const p=peer(id);if(!p?.pc)return;
  const o=await p.pc.createOffer();await p.pc.setLocalDescription(o);
  transmit(id,'offer',{sdp:p.pc.localDescription.toJSON()});
 }
 async function flushIce(p){
  if(!p?.pc?.remoteDescription)return;
  for(const c of p.candidates.splice(0)){try{await p.pc.addIceCandidate(c)}catch{}}
 }
 async function receiveSignal(m){
  const v=voice;if(!v||m.user_id===a().state.me.id)return;
  const p=peer(m.user_id);if(!p?.pc)return;
  if(m.kind==='offer'){
   await p.pc.setRemoteDescription(m.payload.sdp);await flushIce(p);
   const answer=await p.pc.createAnswer();await p.pc.setLocalDescription(answer);
   if(voice===v)transmit(m.user_id,'answer',{sdp:p.pc.localDescription.toJSON()});
  }else if(m.kind==='answer'){
   if(p.pc.signalingState==='have-local-offer'){
    await p.pc.setRemoteDescription(m.payload.sdp);await flushIce(p);
   }
  }else if(m.kind==='ice'&&m.payload?.candidate){
   if(p.pc.remoteDescription){try{await p.pc.addIceCandidate(m.payload.candidate)}catch{}}
   else p.candidates.push(m.payload.candidate);
  }
 }
 async function joinVoice(channel){
  if(voice?.channel.id===channel.id)return;
  if(voice)await leaveVoice();
  if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection){
   a().toast('Для голосовой комнаты нужны HTTPS и поддержка WebRTC');return;
  }
  if(a().state.ws?.readyState!==WebSocket.OPEN){
   a().toast('Для входа в голосовую комнату требуется соединение с MPOL');return;
  }
  let stream=null;
  try{
   stream=await navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   const cfg=await api('/calls/ice');
   const iceServers=cfg?.iceServers?.length?cfg.iceServers:
    [{urls:['stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']}];
   voice={channel,stream,iceServers,peers:new Map(),joined:false,camera:null,screen:null};
   showDashboard();showVoice();
   if(!wsSend({type:'space_voice_join',channel_id:channel.id}))await leaveVoice();
  }catch(e){stream?.getTracks().forEach(t=>t.stop());fail(e)}
 }
 function preview(){
  if(!voice)return;
  const video=el('voicePreview');const stream=voice.screen||voice.camera;
  video.srcObject=stream;video.classList.toggle('hidden',!stream);
  if(stream)video.play().catch(()=>{});
  updateVoice();
 }
 async function replaceVideo(track){
  for(const p of voice?.peers.values()||[]){
   const sender=p.pc?.getTransceivers().find(t=>t.receiver.track.kind==='video')?.sender;
   try{if(sender)await sender.replaceTrack(track||null)}catch{}
  }
 }
 async function toggleCamera(){
  if(!voice)return;const v=voice;
  if(v.camera){
   const old=v.camera;v.camera=null;
   if(!v.screen)await replaceVideo(null);
   old.getTracks().forEach(t=>t.stop());
  }else{
   const stream=await navigator.mediaDevices.getUserMedia({audio:false,
    video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}}});
   if(voice!==v){stream.getTracks().forEach(t=>t.stop());return}
   v.camera=stream;if(!v.screen)await replaceVideo(stream.getVideoTracks()[0]);
  }
  preview();
 }
 async function stopShare(){
  if(!voice?.screen)return;
  const old=voice.screen;voice.screen=null;
  await replaceVideo(voice.camera?.getVideoTracks()[0]||null);
  old.getTracks().forEach(t=>{t.onended=null;t.stop()});preview();
 }
 async function toggleShare(){
  if(!voice)return;
  if(voice.screen)return stopShare();
  const v=voice;
  const share=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
  if(voice!==v){share.getTracks().forEach(t=>t.stop());return}
  const track=share.getVideoTracks()[0];if(!track)return;
  await replaceVideo(track);v.screen=share;
  track.onended=()=>{if(voice===v)stopShare()};preview();
 }
 async function leaveVoice(){
  const v=voice;if(!v)return;
  voice=null;wsSend({type:'space_voice_leave'});
  for(const p of v.peers.values()){
   try{p.pc?.close()}catch{}
   p.audio.srcObject=null;p.video.srcObject=null;
  }
  v.camera?.getTracks().forEach(t=>t.stop());
  v.screen?.getTracks().forEach(t=>{t.onended=null;t.stop()});
  v.stream.getTracks().forEach(t=>t.stop());
  el('serverVoicePanel').innerHTML='';el('serverVoicePanel').classList.add('hidden');
 }
 function onWebSocket(m){
  if(m.type==='servers_changed'){reload().catch(()=>{});return}
  if(!voice)return;
  if(m.type==='space_voice_error'){a().toast(m.message||'Комната недоступна');leaveVoice();return}
  if(m.channel_id!==voice.channel.id)return;
  if(m.type==='space_voice_joined'){
   voice.joined=true;updateVoice();
   for(const user of m.peers||[]){peerCard(user);offer(user.id).catch(fail)}
  }else if(m.type==='space_voice_peer_joined'){
   peerCard(m.user);updateVoice();
  }else if(m.type==='space_voice_peer_left'){
   const p=voice.peers.get(m.user_id);
   try{p?.pc?.close()}catch{}
   p?.div.remove();voice.peers.delete(m.user_id);updateVoice();
  }else if(m.type==='space_voice_signal')receiveSignal(m).catch(fail);
 }
 window.mpolServers={openTab,renderList,createServer,onWebSocket,leaveVoice,reload};
})();
