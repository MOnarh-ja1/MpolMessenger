'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
// Each EXE window must have its OWN login. localStorage shared a bearer token
// across all Edge/Chrome app windows and silently mixed account identities.
const legacyToken=localStorage.getItem('mpol_token');
if(!sessionStorage.getItem('mpol_token')&&legacyToken){
 sessionStorage.setItem('mpol_token',legacyToken);
}
localStorage.removeItem('mpol_token');
const storage = {
 get token(){return sessionStorage.getItem('mpol_token')||''},
 set token(v){if(v)sessionStorage.setItem('mpol_token',v);else sessionStorage.removeItem('mpol_token')}
};
const state = {me:null,chats:[],friends:[],requests:[],requestsLoaded:false,messages:[],active:null,tab:'chats',chatFilter:'all',ws:null,retry:0,reply:null,register:false,typingTimer:0,
  notif:localStorage.getItem('mpol_notify')==='1',sound:localStorage.getItem('mpol_sound')!=='0',scale:Number(localStorage.getItem('mpol_scale')||'100')};
function toast(text){const e=document.createElement('div');e.className='toast';e.textContent=text;$('toastZone').append(e);setTimeout(()=>e.remove(),4000)}
function errorText(err){return String(err?.message||err||'Неизвестная ошибка')}
async function api(path,{method='GET',body,form=false}={}){
 const opt={method,headers:{}};if(storage.token)opt.headers.Authorization='Bearer '+storage.token;
 if(body!==undefined){if(form)opt.body=body;else{opt.headers['Content-Type']='application/json';opt.body=JSON.stringify(body)}}
 const res=await fetch('/api'+path,opt);let data;try{data=await res.json()}catch{data=null}
 if(!res.ok){if(res.status===401 && state.me){signout(false);throw Error('Сессия истекла. Войдите снова.')}
 throw Error(typeof data?.detail==='string'?data.detail:'Ошибка сервера ('+res.status+')')}
 return data;
}
function timestr(v){if(!v)return '';const d=new Date(v);return d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}
function datestr(v){if(!v)return '';const d=new Date(v),today=new Date();return d.toDateString()===today.toDateString()?timestr(v):d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})}
function avatar(name,online=false,userId=null){
 const pic=name==='📷'&&userId?'<img class="avatar-photo" alt="" src="/api/avatars/'+encodeURIComponent(userId)+'">':esc((name||'◉').slice(0,3));
 return '<div class="avatar '+(online?'online':'')+'">'+pic+'</div>'
}
function updateOwnAvatar(){
 const btn=$('myProfile');if(!state.me)return;
 if(state.me.avatar==='📷'){btn.textContent='';btn.style.backgroundImage='url(/api/avatars/'+encodeURIComponent(state.me.id)+'?t='+Date.now()+')'}
 else{btn.textContent=state.me.nick.slice(0,1).toUpperCase();btn.style.backgroundImage=''}
}
function showLogin(){state.me=null;$('authScreen').classList.remove('hidden');$('mainScreen').classList.add('hidden');$('password').value='';serverHealth()}
function showApp(){ $('authScreen').classList.add('hidden');$('mainScreen').classList.remove('hidden');}
// No window-level globals exposed: every on-screen action binds a real handler.
async function serverHealth(){try{const r=await api('/health');$('serverStatus').textContent=r.ok?(r.temporary_storage?'Тестовый онлайн · данные могут исчезнуть':r.durable_database?'Онлайн · сообщения сохраняются':'Сервер доступен'):'Сервер не отвечает';$('serverStatus').previousElementSibling.classList.toggle('good',!!r.ok)}catch{$('serverStatus').textContent='Сервер недоступен';$('serverStatus').previousElementSibling.classList.remove('good')}}
async function startup(){try{if(storage.token){state.me=await api('/me');showMain();return}}catch{storage.token=''}showLogin()}
async function showMain(){
 // The /me response is authoritative; never infer account identity from a
 // developer badge, previous window, nickname, or another shared login.
 state.me=await api('/me');
 state.active=null;state.messages=[];state.chats=[];state.friends=[];
 $('emptyChat').classList.remove('hidden');$('openedChat').classList.add('hidden');
 showApp();state.requests=[];state.requestsLoaded=false;updateOwnAvatar();
 $('myAccountId').textContent=state.me.id;
 $('activeAccountLabel').textContent=state.me.nick+' · '+state.me.id;
 applyScale();await refreshAll();wsConnect();renderTab('chats');
}
function setFriendRequests(req){
 const existing=new Set(state.requests.map(r=>r.request_id));
 const incoming=state.requestsLoaded?req.filter(r=>!existing.has(r.request_id)):[];
 state.requests=req;state.requestsLoaded=true;
 const badge=$('requestDot');badge.textContent=req.length>9?'9+':String(req.length);
 badge.title=req.length+' заявок в друзья';badge.classList.toggle('hidden',req.length===0);
 if(incoming.length){
  const sender=incoming[0].user.nick;
  toast(incoming.length===1?'Новая заявка в друзья от '+sender:'Новых заявок в друзья: '+incoming.length);
  if(state.notif&&'Notification'in window&&Notification.permission==='granted'&&document.hidden){
   try{const n=new Notification('MPOL · заявка в друзья',{body:sender+' хочет добавить вас в друзья',tag:'mpol-friends'});n.onclick=()=>{window.focus();renderTab('notifications');n.close()}}catch{}
  }
 }
}
let refreshingAll=null;
async function refreshAll(){
 if(!state.me)return;
 if(refreshingAll)return refreshingAll;
 const accountId=state.me.id;
 refreshingAll=(async()=>{try{
  const [chats,friends,req]=await Promise.all([api('/chats'),api('/friends'),api('/friends/requests')]);
  if(state.me?.id!==accountId)return;
  state.chats=chats;state.friends=friends;setFriendRequests(req);renderList();
  if(state.active){const updated=chats.find(c=>c.id===state.active.id);if(updated){state.active=updated;updateHeader()}}
 }catch(e){if(state.me)toast(errorText(e))}})().finally(()=>{refreshingAll=null});
 return refreshingAll;
}
async function refreshRequests(){
 if(!state.me)return;
 try{const requests=await api('/friends/requests');if(!state.me)return;setFriendRequests(requests);if(state.tab==='notifications')renderList()}catch{}
}
async function openSavedChat(){
 try{const created=await api('/me/saved',{method:'POST'});await refreshAll();renderTab('chats');await selectChat(created.id)}
 catch(e){toast(errorText(e))}
}
async function toggleChatArchive(){
 if(!state.active||state.active.is_saved)return;
 try{const c=state.active;await api('/chats/'+encodeURIComponent(c.id)+'/archive',{method:'PUT',body:{archived:!c.archived}});
  await refreshAll();state.chatFilter=c.archived?'all':'archive';
  updateFilters();renderList();toast(c.archived?'Вернули из архива':'Переписка в архиве')}
 catch(e){toast(errorText(e))}
}
function updateFilters(){
 document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===state.chatFilter))
}
function renderTab(tab){if(tab==='saved'){openSavedChat();return}state.tab=tab;document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
 $('listTitle').textContent=({chats:'Сообщения',friends:'Друзья',groups:'Группы',notifications:'Заявки в друзья',settings:'Настройки'})[tab]||'Сообщения';
 $('chatFilters').classList.toggle('hidden',tab!=='chats');
 $('listSubtitle').textContent=({chats:'На связи с теми, кто важен',friends:'Ваш круг общения',groups:'Командные беседы',notifications:'Новые знакомства',settings:'Персональные параметры'})[tab];
 $('newMessage').textContent=tab==='groups'?'+ Создать группу':tab==='friends'?'+ Добавить друга':tab==='notifications'?'Обновить':'⚙ Настройки';
 if(tab==='chats')$('newMessage').textContent='+ Новый чат';
 $('createGroup').classList.toggle('hidden',tab==='settings'||tab==='notifications');
 if(tab==='settings'){openSettings();renderList();return}renderList();if(tab==='notifications')refreshRequests();}
function renderList(){let filter=$('listSearch').value.trim().toLowerCase();const root=$('chatList');root.replaceChildren();
 if(state.tab==='settings'){root.innerHTML='<div class="list-blank">Нажмите «Настройки», чтобы изменить профиль и уведомления.</div>';return}
 if(state.tab==='notifications'){
  if(!state.requests.length){root.innerHTML='<div class="list-blank"><strong>Нет новых заявок</strong>Новые заявки появятся здесь автоматически.</div>';return}
  for(const r of state.requests){
   const el=document.createElement('div');el.className='request-item';
   el.innerHTML=avatar(r.user.avatar,false,r.user.id)+`<div class="request-content"><strong>${esc(r.user.nick)}</strong><span>${esc(r.user.id)}</span><p>Хочет добавить вас в друзья</p><div class="request-buttons"><button type="button" data-accept="1">Принять</button><button type="button" data-accept="0">Отклонить</button></div></div>`;
   el.querySelector('[data-accept="1"]').onclick=()=>respondFriendRequest(r.request_id,true);
   el.querySelector('[data-accept="0"]').onclick=()=>respondFriendRequest(r.request_id,false);
   root.append(el);
  }return
 }
 if(state.tab==='friends'){let a=state.friends.filter(f=>f.nick.toLowerCase().includes(filter)||f.id.toLowerCase().includes(filter));if(!a.length)root.innerHTML='<div class="list-blank"><strong>Пока никого нет</strong>Найдите друга по уникальному ID.</div>';
  for(const f of a){const el=document.createElement('button');el.className='chat-item';el.innerHTML=avatar(f.avatar,f.online,f.id)+`<div class="chat-item-body"><div class="chat-item-head"><strong>${esc(f.nick)}</strong></div><div class="chat-item-preview">${f.online?'В сети':'Не в сети'} · ${esc(f.id)}</div></div>`;el.onclick=()=>openFriend(f);root.append(el)}return}
 const a=state.chats.filter(c=>{
  if(state.tab==='groups'&&!c.is_group)return false;
  if(state.chatFilter==='archive'){if(!c.archived)return false}
  else if(c.archived)return false;
  if(state.tab==='chats'){
   if(state.chatFilter==='direct'&&c.is_group)return false;
   if(state.chatFilter==='groups'&&!c.is_group)return false;
   if(state.chatFilter==='unread'&&!c.unread)return false;
  }
  return c.name.toLowerCase().includes(filter)
 });if(!a.length)root.innerHTML='<div class="list-blank"><strong>Диалогов пока нет</strong>Создайте чат или найдите друзей.</div>';
 for(const c of a){const el=document.createElement('button');el.className='chat-item'+(state.active?.id===c.id?' selected':'');el.innerHTML=avatar(c.avatar,c.online,c.peer_id)+`<div class="chat-item-body"><div class="chat-item-head"><strong>${esc(c.name)}</strong><time>${datestr(c.last?.sent_at)}</time></div><div class="chat-item-preview">${esc(c.last?.deleted?'Сообщение удалено':c.last?.body|| (c.last?.attachment?'📎 '+c.last.attachment.name:'Новая переписка'))}</div></div>${c.unread?`<span class="count-badge">${c.unread}</span>`:''}`;el.onclick=()=>selectChat(c.id);root.append(el)}
}
async function selectChat(id){try{const c=state.chats.find(x=>x.id===id);if(!c)throw Error('Чат не найден');state.active=c;state.reply=null;replyUpdate();$('emptyChat').classList.add('hidden');$('openedChat').classList.remove('hidden');updateHeader();state.messages=await api('/chats/'+encodeURIComponent(id)+'/messages');renderMessages();await api('/chats/'+encodeURIComponent(id)+'/read',{method:'POST'});state.active.unread=0;renderList();$('messageInput').focus()}catch(e){toast(errorText(e))}}
function updateHeader(){if(!state.active)return;const c=state.active;
 $('chatAvatar').innerHTML=(c.avatar==='📷'&&c.peer_id)?'<img class="avatar-photo" src="/api/avatars/'+encodeURIComponent(c.peer_id)+'" alt="">':esc(c.avatar);
 $('chatName').textContent=c.name;$('chatPresence').textContent=c.is_saved?'Только вы':c.is_group?c.members.length+' участников':c.online?'● В сети':'Не в сети';
 $('archiveChat').classList.toggle('hidden',!!c.is_saved);
 $('archiveChat').title=c.archived?'Вернуть из архива':'Отправить в архив';
 $('voiceCall').classList.toggle('hidden',c.is_group||c.is_saved);
 $('videoCall').classList.toggle('hidden',c.is_group||c.is_saved);
}
function renderMessages(){const root=$('messages');root.replaceChildren();let lastDay='';const c=state.active;
 for(const m of state.messages){if(m.deleted)continue;const day=new Date(m.sent_at).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});if(day!==lastDay){const label=document.createElement('div');label.className='day-divider';label.textContent=day;root.append(label);lastDay=day}
  const mine=String(m.user_id)===String(state.me.id);let reply='';if(m.reply_to){const original=state.messages.find(x=>x.id===m.reply_to);reply=`<div class="msg-reply">↪ ${esc(original?.body?.slice(0,80)||'Ответ на сообщение')}</div>`}
  const voice=!!m.attachment&&(['audio/webm','audio/ogg'].includes(m.attachment.type));
  const file=voice?'<button class="msg-file voice-file" data-audio="'+esc(m.attachment.id)+'">▶ Голосовое · '+Math.round(m.attachment.size/1024)+' КБ</button>':m.attachment?'<button class="msg-file" data-file="'+esc(m.attachment.id)+'">📎 '+esc(m.attachment.name)+' ('+Math.round(m.attachment.size/1024)+' КБ)</button>':'';
  const reacts=(m.reactions||[]).map(r=>'<button type="button" data-react="'+esc(r.emoji)+'" class="'+((r.users||[]).includes(state.me.id)?'my-reaction':'')+'">'+esc(r.emoji)+' '+r.count+'</button>').join('');
  const reactionHtml=reacts?'<div class="reaction-strip">'+reacts+'</div>':'';
  const row=document.createElement('div');
  row.className='msg-row '+(mine?'mine':'theirs');
  row.dataset.authorId=String(m.user_id);row.dataset.messageId=String(m.id);
  row.setAttribute('aria-label',mine?'Ваше сообщение':'Сообщение от '+(m.nick||'пользователя'));
  row.innerHTML=`<div class="mini-avatar">${m.avatar==='📷'?'<img class="avatar-photo" src="/api/avatars/'+encodeURIComponent(m.user_id)+'" alt="Аватар">':esc(m.avatar)}</div><div class="msg-bubble">${!mine?`<div class="msg-sender">${esc(m.nick||'Пользователь')}</div>`:'<div class="msg-sender msg-own-label">Вы</div>'}${reply}<div class="msg-text">${m.deleted?'Сообщение удалено':esc(m.body)}</div>${file}${reactionHtml}<div class="msg-meta">${m.edited_at?'изм. · ':''}${timestr(m.sent_at)}${mine?(c?.read_states&&Object.entries(c.read_states).some(([uid,t])=>uid!==state.me.id&&new Date(t)>=new Date(m.sent_at))?' · ✓✓':' · ✓'):''}</div></div><div class="msg-actions">${!m.deleted?'<button data-action="reply" title="Ответить">↶</button><button data-action="react" title="Реакция">♡</button><button data-action="copy" title="Копировать">⧉</button>':''}${mine&&!m.deleted?'<button data-action="edit" title="Редактировать">✎</button><button data-action="delete" title="Удалить">×</button>':''}</div>`;
  row.querySelectorAll('[data-action]').forEach(btn=>btn.onclick=()=>messageAction(btn.dataset.action,m));
  row.querySelectorAll('[data-react]').forEach(btn=>btn.onclick=()=>setReaction(m,btn.dataset.react)); 
  row.querySelector('[data-audio]')?.addEventListener('click',e=>playVoiceAttachment(m.attachment,e.currentTarget));
  row.querySelector('[data-file]')?.addEventListener('click',()=>previewOrDownload(m.attachment));root.append(row)}root.scrollTop=root.scrollHeight;
}
async function downloadFile(a){try{const res=await fetch('/api/attachments/'+encodeURIComponent(a.id),{headers:{Authorization:'Bearer '+storage.token}});if(!res.ok)throw Error('Не удалось загрузить файл');const blob=await res.blob(),url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=a.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000)}catch(e){toast(errorText(e))}}
async function previewOrDownload(a){
 if(!a.type?.startsWith('image/'))return downloadFile(a);
 try{const res=await fetch('/api/attachments/'+encodeURIComponent(a.id),{headers:{Authorization:'Bearer '+storage.token}});
  if(!res.ok)throw Error('Не удалось открыть изображение');
  const blob=await res.blob();const url=URL.createObjectURL(blob);
  modal('Изображение','<img class="image-preview" src="'+url+'" alt="Предпросмотр">');
  $('closeModal').addEventListener('click',()=>URL.revokeObjectURL(url),{once:true});
 }catch(e){toast(errorText(e))}
}
async function setReaction(m,emoji){
 try{await api('/messages/'+encodeURIComponent(m.id)+'/reaction',{method:'PUT',body:{emoji}})}catch(e){toast(errorText(e))}
}
function pickReaction(m){
 const items=['👍','❤️','😂','🔥','🎉','😮','😢','👏','👀','💯','😎','🙏'];
 modal('Реакция на сообщение','<div class="reaction-picker">'+items.map(e=>'<button type="button" data-emoji="'+e+'">'+e+'</button>').join('')+'</div>');
 document.querySelectorAll('#modalContent [data-emoji]').forEach(el=>el.onclick=async()=>{await setReaction(m,el.dataset.emoji);closeModal()})
}
async function messageAction(action,m){
 if(action==='react'){pickReaction(m);return}
 if(action==='copy'){try{await navigator.clipboard.writeText(m.body);toast('Текст скопирован')}catch{toast('Не удалось скопировать')}return}
 if(action==='reply'){state.reply=m.id;replyUpdate();$('messageInput').focus();return}if(action==='edit'){
  modal('Редактировать сообщение',`<label>Текст<textarea id="editBody" rows="4" maxlength="4000">${esc(m.body)}</textarea></label><button id="saveEdit" class="button">Сохранить</button>`);
  $('saveEdit').onclick=async()=>{try{await api('/messages/'+m.id,{method:'PATCH',body:{body:$('editBody').value}});closeModal();await loadMessages()}catch(e){toast(errorText(e))}};
  return}
 if(action==='delete'&&confirm('Удалить это сообщение?')){try{await api('/messages/'+m.id,{method:'DELETE'});await loadMessages()}catch(e){toast(errorText(e))}}
}
function replyUpdate(){$('replyChip').classList.toggle('hidden',!state.reply);if(state.reply){const m=state.messages.find(x=>x.id===state.reply);$('replyText').textContent='↶ '+(m?.nick||'Сообщение')+': '+(m?.body.slice(0,90)||'') }}
async function loadMessages(){if(!state.active)return;const id=state.active.id;state.messages=await api('/chats/'+encodeURIComponent(id)+'/messages');renderMessages()}
let sending=false;
async function send(){const c=state.active;if(!c||sending)return;const body=$('messageInput').value.trim();if(!body)return;sending=true;$('sendBtn').disabled=true;
 try{await api('/chats/'+encodeURIComponent(c.id)+'/messages',{method:'POST',body:{body,reply_to:state.reply}});$('messageInput').value='';state.reply=null;replyUpdate();await loadMessages();await refreshAll()}catch(e){toast(errorText(e))}finally{sending=false;$('sendBtn').disabled=false}}
async function attach(){if(!state.active)return;$('fileInput').click()}
async function uploadFile(file){if(!file||!state.active)return;if(file.size>12*1024*1024){toast('Максимальный размер файла — 12 МБ');return false}const data=new FormData();data.append('file',file);try{toast('Загрузка файла…');const a=await api('/chats/'+encodeURIComponent(state.active.id)+'/attachments',{method:'POST',body:data,form:true});await api('/chats/'+encodeURIComponent(state.active.id)+'/messages',{method:'POST',body:{body:'',attachment_id:a.id}});await loadMessages();await refreshAll();toast('Файл отправлен');$('fileInput').value='';return true}catch(e){toast(errorText(e));return false}}
function wsConnect(){if(!storage.token||!state.me)return;try{const proto=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(proto+'//'+location.host+'/ws');state.ws=ws;
 ws.onopen=()=>{state.retry=0;ws.send(JSON.stringify({type:'auth',token:storage.token}))};
 ws.onmessage=async e=>{if(state.ws!==ws||!state.me)return;let m;try{m=JSON.parse(e.data)}catch{return}
  if(m.type==='call_signal'){onCallSignal(m);return}
  if(m.type==='authenticated'||m.type==='friend_request'){refreshAll().catch(()=>{});return}
  if(m.type==='message'){if(m.message.user_id!==state.me.id){notifyNewMessage(m.message)}if(state.active?.id===m.message.chat_id){if(!state.messages.some(x=>x.id===m.message.id)){state.messages.push(m.message);renderMessages()}api('/chats/'+state.active.id+'/read',{method:'POST'}).catch(()=>{})}refreshAll().catch(()=>{})}
  if(m.type==='message_deleted'){
   if(state.active?.id===m.chat_id){state.messages=state.messages.filter(x=>x.id!==m.message_id);renderMessages()}
   refreshAll().catch(()=>{});return
  }
  if(m.type==='message_updated'){if(state.active?.id===m.message.chat_id){const idx=state.messages.findIndex(x=>x.id===m.message.id);if(idx>=0){state.messages[idx]=m.message;renderMessages()}}refreshAll().catch(()=>{})}
  if(m.type==='chats_changed'||m.type==='friends_changed'||m.type==='presence'||m.type==='profile'||m.type==='read')refreshAll().catch(()=>{});
  if(m.type==='typing'&&state.active?.id===m.chat_id){$('typingIndicator').textContent='Собеседник печатает…';clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>$('typingIndicator').textContent='',1300)}
 };
 ws.onclose=()=>{if(state.ws===ws&&state.me){const delay=Math.min(30000,1000*Math.pow(2,Math.min(5,state.retry++)));setTimeout(()=>{if(state.me)wsConnect()},delay)}};
 ws.onerror=()=>{};
 }catch(e){toast('Не удалось подключить онлайн-канал')}}
function notifyNewMessage(m){if(state.sound){try{const a=new(window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator(),g=a.createGain();o.type='sine';o.frequency.value=540;g.gain.value=.03;o.connect(g);g.connect(a.destination);o.start();g.gain.exponentialRampToValueAtTime(.001,a.currentTime+.15);o.stop(a.currentTime+.15)}catch{}}
 if(state.notif&&'Notification'in window&&Notification.permission==='granted'&&document.hidden){try{const n=new Notification('MPOL · '+m.nick,{body:m.body||'📎 Вложение',tag:'mpol-'+m.chat_id});n.onclick=()=>{window.focus();selectChat(m.chat_id);n.close()}}catch{}}}
function modal(title,content){$('modalTitle').textContent=title;$('modalContent').innerHTML=content;$('modalLayer').classList.remove('hidden')}
function closeModal(){$('modalLayer').classList.add('hidden');$('modalContent').replaceChildren()}
function findFriends(){modal('Найти пользователя',`<p>Введите уникальный ID, например <strong>MP1234567890</strong>.</p><label>ID пользователя<input id="friendId" placeholder="MP..." maxlength="24"/></label><button class="button" id="findUserBtn">Найти</button><div id="findResult"></div>`);$('findUserBtn').onclick=async()=>{
 const id=$('friendId').value.trim().toUpperCase();try{const u=await api('/users/'+encodeURIComponent(id));const b=$('findResult');b.innerHTML=`<div class="user-line">${avatar(u.avatar,u.online)}<div><strong>${esc(u.nick)}</strong><div class="secondary">${esc(u.id)}</div></div><button id="inviteBtn">Добавить</button></div>`;$('inviteBtn').onclick=async()=>{try{const r=await api('/friends/request',{method:'POST',body:{target_id:u.id}});toast(r.state==='accepted'?'Теперь вы друзья':'Заявка отправлена');closeModal();refreshAll()}catch(e){toast(errorText(e))}}}catch(e){toast(errorText(e))}};}
function openFriend(f){modal(f.nick,`<p><strong>ID:</strong> ${esc(f.id)}<br><strong>Статус:</strong> ${f.online?'В сети':'Не в сети'}<br>${esc(f.description)}</p><button id="openDm" class="button">Открыть переписку</button><button id="blockFriend" class="button outlined">Заблокировать</button>`);
 $('openDm').onclick=async()=>{try{const c=await api('/dm/'+encodeURIComponent(f.id),{method:'POST'});closeModal();await refreshAll();renderTab('chats');selectChat(c.id)}catch(e){toast(errorText(e))}};
 $('blockFriend').onclick=async()=>{if(!confirm('Заблокировать пользователя?'))return;try{await api('/users/'+encodeURIComponent(f.id)+'/block',{method:'POST'});closeModal();await refreshAll();toast('Пользователь заблокирован')}catch(e){toast(errorText(e))}}}
function createGroup(){const options=state.friends.map(f=>`<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-add-member="${esc(f.id)}">${esc(f.nick)}</label>`).join('');
 modal('Создать группу',`<p>Групповой чат для друзей.</p><label>Название группы<input id="groupName" maxlength="80" placeholder="Например, Наша команда"></label><div class="secondary">Добавить участников</div><div class="list-mini">${options||'<p>Сначала добавьте друзей</p>'}</div><button id="makeGroup" class="button">Создать группу</button>`);
 $('makeGroup').onclick=async()=>{const name=$('groupName').value.trim(),members=[...document.querySelectorAll('[data-add-member]:checked')].map(x=>x.dataset.addMember);try{const c=await api('/groups',{method:'POST',body:{name,members}});closeModal();await refreshAll();renderTab('groups');selectChat(c.id)}catch(e){toast(errorText(e))}};}
async function respondFriendRequest(id,accept){
 try{await api('/friends/requests/'+encodeURIComponent(id),{method:'POST',body:{accept}});await refreshAll();toast(accept?'Заявка принята — теперь вы друзья':'Заявка отклонена')}
 catch(e){toast(errorText(e))}
}
async function copyAccountId(){
 const id=state.me?.id;if(!id)return;
 try{
  if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(id);
  else{const el=document.createElement('textarea');el.value=id;el.setAttribute('readonly','');el.style.position='fixed';el.style.left='-9999px';document.body.append(el);el.select();const ok=document.execCommand('copy');el.remove();if(!ok)throw Error('copy denied')}
  toast('ID скопирован: '+id);
 }catch{toast('Не удалось скопировать ID. Выделите его вручную в настройках.')}
}
function openRequests(){const html=state.requests.map(r=>`<div class="notice-item" data-request="${r.request_id}">${avatar(r.user.avatar)}<div class="name"><strong>${esc(r.user.nick)}</strong><div class="secondary">${esc(r.user.id)}</div></div><button data-answer="1">✓</button><button data-answer="0">✕</button></div>`).join('');modal('Заявки в друзья',html||'<p>Новых заявок пока нет.</p>');document.querySelectorAll('[data-request]').forEach(el=>el.querySelectorAll('[data-answer]').forEach(btn=>btn.onclick=async()=>{try{await api('/friends/requests/'+el.dataset.request,{method:'POST',body:{accept:btn.dataset.answer==='1'}});await refreshAll();openRequests()}catch(e){toast(errorText(e))}}))}
function chatDetails(){if(!state.active)return;const c=state.active;
 let html=`<p><strong>${esc(c.name)}</strong><br>${c.is_group?'Группа · '+c.members.length+' участников':'Личная переписка'}</p>`;
 if(c.is_group){const choices=state.friends.filter(x=>!c.members.includes(x.id));html+=`<div class="secondary">Добавить участника</div><label><select id="addMemberSelect"><option value="">Выберите друга</option>${choices.map(u=>`<option value="${esc(u.id)}">${esc(u.nick)}</option>`).join('')}</select></label><button class="button" id="addMemberBtn">Добавить в группу</button>`;
 html+=`<p class="secondary">Участники: ${c.members.map(esc).join(', ')}</p>`;
 if(c.role!=='owner')html+='<button id="leaveGroup" class="button outlined">Покинуть группу</button>';
 }
 modal('Информация о чате',html);
 $('addMemberBtn')?.addEventListener('click',async()=>{try{await api('/groups/'+c.id+'/members',{method:'POST',body:{user_id:$('addMemberSelect').value}});closeModal();await refreshAll();toast('Участник добавлен')}catch(e){toast(errorText(e))}});
 $('leaveGroup')?.addEventListener('click',async()=>{if(!confirm('Покинуть группу?'))return;try{await api('/groups/'+c.id+'/members/'+state.me.id,{method:'DELETE'});closeModal();state.active=null;$('openedChat').classList.add('hidden');$('emptyChat').classList.remove('hidden');await refreshAll()}catch(e){toast(errorText(e))}})
}
function applyScale(){
 // Zooming <html> caused vh-based panels to extend beyond the bottom of
 // maximized/F11 windows. Scale text only; keep viewport geometry at 1:1.
 document.documentElement.style.zoom='1';
 const factor=Math.max(0.85,Math.min(1.25,Number(state.scale||100)/100));
 document.documentElement.style.setProperty('--mpol-text-scale',String(factor));
}
function openSettings(){modal('Профиль и настройки',`<div class="profile-hero"><div class="profile-hero-avatar">${state.me.avatar==='📷'?'<img src="/api/avatars/'+encodeURIComponent(state.me.id)+'?t='+Date.now()+'" alt="Аватар">':esc(state.me.avatar||state.me.nick[0])}</div><div class="profile-hero-name"><h3>${esc(state.me.nick)}</h3><p>${esc(state.me.description||'Мой профиль MPOL')}</p>${state.me.is_developer?'<span class="developer-tag">Разработчик</span>':''}</div></div><section class="settings-panel"><h3>Мой аккаунт</h3><div class="profile-id-card"><div class="profile-id-caption">ВАШ ID · ДЛЯ ПОИСКА В ДРУЗЬЯХ</div><div class="profile-id-row"><code>${esc(state.me.id)}</code><button id="copyProfileId" type="button">Скопировать</button></div></div></section><section class="settings-panel"><h3>Редактирование профиля</h3><label>Никнейм<input id="profileNick" value="${esc(state.me.nick)}" maxlength="48"></label><label>О себе<textarea id="profileDescription" maxlength="260" rows="3">${esc(state.me.description||'')}</textarea></label><label>Аватар (символ)<input id="profileAvatar" value="${esc(state.me.avatar)}" maxlength="8"></label>
 <label>Фотография профиля (PNG, JPG или WEBP до 800 КБ)<input id="profilePhoto" type="file" accept="image/png,image/jpeg,image/webp"></label><button id="uploadProfilePhoto" class="button outlined">Загрузить фото профиля</button>
 <label>Сетевой статус<select id="profileStatus"><option value="online">В сети</option><option value="away">Отошёл</option><option value="dnd">Не беспокоить</option><option value="invisible">Невидимка</option></select></label><button class="button" id="saveProfile">Сохранить профиль</button></section><section class="settings-panel"><h3>Уведомления и интерфейс</h3>
 <div class="setting-row">Уведомления Windows <input type="checkbox" id="notificationsOn" ${state.notif?'checked':''}></div><div class="setting-row">Звук сообщений <input type="checkbox" id="soundsOn" ${state.sound?'checked':''}></div><div class="setting-row">Масштаб интерфейса <select id="scaleSelect"><option value="85">85%</option><option value="100">100%</option><option value="110">110%</option><option value="125">125%</option></select></div>
 </section><section class="settings-panel"><h3>Безопасность</h3><div class="setting-row">Email: ${esc(state.me.email||'не указан')} ${state.me.email_verified?'✓ подтверждён':'(не подтверждён)'}</div>${state.me.email&&!state.me.email_verified?'<button id="verifyEmail" class="button outlined">Подтвердить email</button>':''}<button id="changePassword" class="button outlined">Изменить пароль</button>${state.me.is_developer?'<details class="developer-settings developer-only"><summary>Режим разработчика</summary><p>Доступ защищён проверкой прав на сервере.</p><button id="checkDeveloper" class="button outlined">Проверить права разработчика</button><button id="serverSettings" class="button outlined">Настройка сервера</button></details>':''}</section><button id="logOut" class="button outlined">Выйти из аккаунта</button><p class="secondary">ID можно отправить друзьям для поиска. Пароль и токен никому не передавайте.</p>`);
 $('copyProfileId').onclick=copyAccountId;
 $('uploadProfilePhoto').onclick=uploadProfilePhoto;
 $('profileStatus').value=state.me.status;$('scaleSelect').value=String(state.scale);
 $('saveProfile').onclick=async()=>{try{state.me=await api('/me',{method:'PATCH',body:{nick:$('profileNick').value,description:$('profileDescription').value,avatar:$('profileAvatar').value,status:$('profileStatus').value}});updateOwnAvatar();toast('Профиль сохранён');closeModal();refreshAll()}catch(e){toast(errorText(e))}};
 $('notificationsOn').onchange=async e=>{if(e.target.checked&&'Notification'in window){const r=await Notification.requestPermission();state.notif=r==='granted';e.target.checked=state.notif}else state.notif=false;localStorage.setItem('mpol_notify',state.notif?'1':'0')};
 $('soundsOn').onchange=e=>{state.sound=e.target.checked;localStorage.setItem('mpol_sound',state.sound?'1':'0')};
 $('scaleSelect').onchange=e=>{state.scale=Number(e.target.value);localStorage.setItem('mpol_scale',state.scale);applyScale()};
 $('logOut').onclick=()=>signout(true);$('changePassword').onclick=changePassword;
 $('checkDeveloper')?.addEventListener('click',async()=>{try{const result=await api('/developer/status');toast(result.ok?'Права разработчика подтверждены':'Доступ ограничен')}catch(e){toast('Нет доступа: '+errorText(e))}});
 $('serverSettings')?.addEventListener('click',async()=>{try{await api('/developer/status');configServer()}catch(e){toast('Нет прав разработчика')}});
 $('verifyEmail')?.addEventListener('click',verifyEmail);
}
async function uploadProfilePhoto(){
 const file=$('profilePhoto')?.files?.[0];if(!file)return toast('Выберите изображение');
 if(file.size>800000)return toast('Максимальный размер фото — 800 КБ');
 try{const data=new FormData();data.append('file',file);state.me=await api('/me/photo',{method:'POST',body:data,form:true});
 updateOwnAvatar();toast('Фотография обновлена');openSettings();refreshAll()}catch(e){toast(errorText(e))}
}
function verifyEmail(){modal('Подтверждение email',`<p>Получите 8-значный код на ${esc(state.me.email)}. Не передавайте его другим.</p><button id="requestVerify" class="button">Получить код</button><label>Код<input id="verifyCode" maxlength="8" inputmode="numeric" placeholder="12345678"></label><button id="confirmVerify" class="button outlined">Подтвердить</button>`);
 $('requestVerify').onclick=async()=>{try{await api('/auth/email/verification/request',{method:'POST'});toast('Код отправлен на email')}catch(e){toast(errorText(e))}};
 $('confirmVerify').onclick=async()=>{try{await api('/auth/email/verification/confirm',{method:'POST',body:{code:$('verifyCode').value}});state.me=await api('/me');toast('Почта подтверждена');openSettings()}catch(e){toast(errorText(e))}};
}
function forgotPassword(){modal('Восстановление пароля',`<p>Доступно только для подтверждённого email при настроенной серверной почте.</p><label>Ваш email<input id="recoverEmail" type="email" placeholder="name@example.com"></label><button class="button" id="sendRecovery">Отправить код</button><label>Код из письма<input id="recoverCode" maxlength="8" placeholder="12345678"></label><label>Новый пароль<input type="password" id="recoverPassword" placeholder="Не менее 10 символов"></label><button class="button outlined" id="recoverSubmit">Сменить пароль</button>`);
 $('sendRecovery').onclick=async()=>{try{await api('/auth/password/reset/request',{method:'POST',body:{email:$('recoverEmail').value}});toast('Если email подтверждён, код отправлен')}catch(e){toast(errorText(e))}};
 $('recoverSubmit').onclick=async()=>{try{await api('/auth/password/reset/confirm',{method:'POST',body:{email:$('recoverEmail').value,code:$('recoverCode').value,new_password:$('recoverPassword').value}});toast('Пароль изменён. Войдите с новым паролем.');closeModal()}catch(e){toast(errorText(e))}};
}
function changePassword(){modal('Изменить пароль',`<label>Текущий пароль<input id="oldPw" type="password"></label><label>Новый пароль (от 10 символов)<input id="newPw" type="password"></label><button id="changePwBtn" class="button">Сменить пароль</button>`);
 $('changePwBtn').onclick=async()=>{try{await api('/me/password',{method:'POST',body:{old_password:$('oldPw').value,new_password:$('newPw').value}});toast('Пароль изменён. Войдите снова.');signout(false)}catch(e){toast(errorText(e))}}}
async function configServer(){if(location.protocol==='https:' && !['localhost','127.0.0.1'].includes(location.hostname)){modal('Сервер MPOL','<p>Вы подключены к общему тестовому серверу MPOL. Данные могут исчезнуть после перезапуска сервера.</p>');return;}let data={url:''};try{const r=await fetch('/__config');data=await r.json()}catch{};
 modal('Подключение к серверу',`<p>Для общения через интернет обоим пользователям нужен один и тот же доступный сервер MPOL. Для локальной проверки используйте <strong>http://127.0.0.1:8000</strong>.</p><label>Адрес сервера<input id="serverUrl" placeholder="https://chat.example.com" value="${esc(data.url||'')}"></label><button class="button" id="saveServer">Сохранить и переподключиться</button><p class="secondary">В интернете используйте HTTPS с настоящим сертификатом. Указанный сервер может получать ваши сообщения.</p>`);
 $('saveServer').onclick=async()=>{try{const r=await fetch('/__config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:$('serverUrl').value.trim()})});const x=await r.json();if(!r.ok)throw Error(x.error||'Ошибка адреса');storage.token='';location.reload()}catch(e){toast(errorText(e))}}}
async function signout(send){if(send)api('/auth/logout',{method:'POST'}).catch(()=>{});if(typeof currentCall!=='undefined'&&currentCall)endCall(true);storage.token='';state.me=null;state.active=null;state.requests=[];state.requestsLoaded=false;state.ws?.close();state.ws=null;closeModal();showLogin()}
function openSearch(){findFriends()}
$('toggleAuth').onclick=()=>{state.register=!state.register;$('registerFields').classList.toggle('hidden',!state.register);$('confirmFields').classList.toggle('hidden',!state.register);$('authSubtitle').textContent=state.register?'Создайте аккаунт и найдите друзей.':'Добро пожаловать. Войдите в свой аккаунт.';$('authSubmit').firstChild.textContent=state.register?'Зарегистрироваться ':'Войти ';$('toggleAuth').innerHTML=state.register?'Уже есть аккаунт? <b>Войти</b>':'Нет аккаунта? <b>Создать аккаунт</b>';$('password').setAttribute('autocomplete',state.register?'new-password':'current-password')};
$('authForm').onsubmit=async e=>{e.preventDefault();$('authError').textContent='';$('authSubmit').disabled=true;try{const login=$('login').value.trim(),password=$('password').value;if(state.register&&password!==$('password2').value)throw Error('Пароли не совпадают');const body=state.register?{nick:$('nick').value,login,password,email:$('email').value||null}:{login,password};const data=await api(state.register?'/auth/register':'/auth/login',{method:'POST',body});storage.token=data.token;state.me=data.user;await showMain()}catch(e){$('authError').textContent=errorText(e)}finally{$('authSubmit').disabled=false}};
$('configureServer').onclick=configServer;$('forgotPassword').onclick=forgotPassword;$('newMessage').onclick=()=>{if(state.tab==='notifications')refreshAll();else if(state.tab==='settings')openSettings();else if(state.tab==='groups')createGroup();else findFriends()};$('createGroup').onclick=createGroup;
$('copyMyId').onclick=copyAccountId;
document.querySelectorAll('[data-filter]').forEach(el=>el.onclick=()=>{state.chatFilter=el.dataset.filter;updateFilters();renderList()});
updateFilters();
$('emptyFind').onclick=findFriends;document.querySelectorAll('.rail-btn[data-tab]').forEach(b=>b.onclick=()=>renderTab(b.dataset.tab));$('myProfile').onclick=openSettings;
$('listSearch').oninput=renderList;$('composer').onsubmit=e=>{e.preventDefault();send()};$('voiceBtn').onclick=toggleVoiceRecording;$('archiveChat').onclick=toggleChatArchive;$('attachBtn').onclick=attach;$('fileInput').onchange=e=>uploadFile(e.target.files[0]);
$('emojiBtn').onclick=toggleEmojiPalette;$('messageInput').oninput=()=>{if(state.ws?.readyState===WebSocket.OPEN&&state.active){state.ws.send(JSON.stringify({type:'typing',chat_id:state.active.id}))}};
$('clearReply').onclick=()=>{state.reply=null;replyUpdate()};$('searchMessages').onclick=()=>{$('messageSearchBar').classList.toggle('hidden');$('messageSearchInput').focus()};
$('messageSearchInput').oninput=async e=>{try{if(!state.active)return;state.messages=await api('/chats/'+state.active.id+'/messages'+(e.target.value?'?search='+encodeURIComponent(e.target.value):''));renderMessages()}catch(err){toast(errorText(err))}};
$('messageSearchClear').onclick=()=>{$('messageSearchInput').value='';$('messageSearchBar').classList.add('hidden');loadMessages()};$('chatInfo').onclick=chatDetails;
$('closeModal').onclick=closeModal;$('modalBackdrop').onclick=closeModal;document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
setInterval(()=>{if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:'ping'}));if(location.hostname==='127.0.0.1'||location.hostname==='localhost')fetch('/__ping').catch(()=>{})},15000);
setInterval(()=>{if(!state.me)serverHealth()},10000);
setInterval(()=>{if(state.me)refreshRequests()},12000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.me)refreshAll()});
window.addEventListener('focus',()=>{if(state.me)refreshRequests()});

function checkRequiredExeUpdate(){
 const params=new URLSearchParams(location.search);
 const version=params.get('mpol_client');
 const appWindow=(window.matchMedia?.('(display-mode: standalone)').matches||
  window.matchMedia?.('(display-mode: minimal-ui)').matches||navigator.standalone===true);
 if(location.hostname!=='mpol-messenger-api.onrender.com')return;
 if(!appWindow&&!version)return;
 if(version==='2.1.0')return;
 // The old EXE did not include an updater: its hosted UI can still show
 // a blocking version notice. Browsers cannot silently execute downloads.
 const layer=document.createElement('div');
 layer.className='mpol-required-update';
 layer.innerHTML='<div class="mpol-update-card"><div class="mpol-update-label">MPOL · ОБНОВЛЕНИЕ</div>'+
 '<h2>Требуется новая версия</h2>'+
 '<p>Вышел Mpol Messenger 2.1.0. Исправлены звонки, настройки профиля, аватары и удаление сообщений.</p>'+
 '<p>Скачайте новый EXE, закройте старое окно и запустите скачанную версию. Аккаунт и переписки останутся на сервере.</p>'+
 '<a class="mpol-update-download" href="https://github.com/MOnarh-ja1/MpolMessenger/releases/download/v2.1.0/MpolMessenger.exe" target="_blank" rel="noopener">Скачать обновление EXE ↗</a>'+
 '<small>Браузер по правилам Windows не может автоматически открыть скачанный EXE.</small></div>';
 document.body.append(layer);
}
checkRequiredExeUpdate();

startup();
