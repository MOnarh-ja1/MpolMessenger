"use strict";
/* MPOL voice notes: local microphone permission, browser MediaRecorder,
   12 MB server upload, preview before sending, and on-demand playback. */
let recording=null;
let recordTimeInterval=null;
const EMOJI_LIST=[
 '😀','😃','😄','😁','😆','😂','🤣','😊','🙂','🙃','😉','😍','😘','🥰',
 '😎','🤩','🥳','🤔','🤗','😐','😑','😏','😢','😭','😡','😱','🥺',
 '👍','👎','👌','✌️','🤝','👏','🙌','🙏','💪','👀','💯','❤️','🧡',
 '💛','💚','💙','💜','🤍','🔥','⭐','✨','🎉','🎁','🎮','🎧','🎤',
 '📸','🍕','☕','🐱','🐶','🌙','🌍','🚀','💬','✅','❌'
];
function closeEmojiPalette(){
 const palette=document.getElementById('emojiPalette');
 if(palette)palette.classList.add('hidden');
}
function renderEmojiOptions(query=''){
 const grid=document.getElementById('emojiResults');
 if(!grid)return;
 let items=EMOJI_LIST;
 const q=query.trim().toLowerCase();
 const terms={love:['❤️','😍','🥰','😘','🤍'],heart:['❤️','🧡','💛','💚','💙','💜'],smile:['😀','😊','🙂','😂'],
  огонь:['🔥'],сердце:['❤️','🥰','😍'],смех:['😂','🤣'],грусть:['😢','😭','🥺'],лайк:['👍','👌'],игра:['🎮'],музыка:['🎧','🎤']};
 if(q)items=terms[q]||EMOJI_LIST.filter(e=>e.includes(q));
 grid.replaceChildren();
 if(!items.length){
  const none=document.createElement('p');
  none.className='emoji-empty';none.textContent='Эмодзи не найдены';grid.append(none);return;
 }
 for(const emoji of items){
  const button=document.createElement('button');
  button.type='button';button.textContent=emoji;button.title=emoji;
  button.setAttribute('aria-label','Вставить '+emoji);
  button.addEventListener('click',()=>{
   const inp=document.getElementById('messageInput');
   if(!inp)return;
   const start=Number.isInteger(inp.selectionStart)?inp.selectionStart:inp.value.length;
   const end=Number.isInteger(inp.selectionEnd)?inp.selectionEnd:start;
   inp.setRangeText(emoji,start,end,'end');
   inp.dispatchEvent(new Event('input',{bubbles:true}));
   closeEmojiPalette();
   // Focusing the composer on iPhone opens the keyboard and shrinks the chat.
   if(window.matchMedia('(min-width:601px)').matches)inp.focus();
  });
  grid.append(button);
 }
}
function toggleEmojiPalette(){
 const p=document.getElementById('emojiPalette');
 if(!p.classList.contains('hidden')){closeEmojiPalette();return}
 p.innerHTML='<div class="emoji-header"><strong>Эмодзи</strong><button type="button" id="closeEmoji" aria-label="Закрыть эмодзи">✕</button></div>'+
 '<label><span class="emoji-search-label">Поиск смайликов</span><input id="emojiSearch" type="search" placeholder="Сердце, смех, огонь…" aria-label="Поиск эмодзи" autocomplete="off"></label>'+
 '<div id="emojiResults" class="emoji-grid"></div>';
 p.classList.remove('hidden');
 document.getElementById('closeEmoji').onclick=closeEmojiPalette;
 document.getElementById('emojiSearch').oninput=e=>renderEmojiOptions(e.target.value);
 renderEmojiOptions();
 if(window.matchMedia('(min-width:601px)').matches)document.getElementById('emojiSearch').focus();
}
document.addEventListener('pointerdown',ev=>{
 const palette=document.getElementById('emojiPalette');
 if(!palette||palette.classList.contains('hidden'))return;
 if(!palette.contains(ev.target)&&!document.getElementById('emojiBtn')?.contains(ev.target))closeEmojiPalette();
});
function recordButton(active,sec=0){
 const b=$('voiceBtn');b.classList.toggle('recording',active);
 b.textContent=active?'● '+Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0'):'🎙';
 b.title=active?'Остановить запись и прослушать':'Записать голосовое сообщение'
}
async function toggleVoiceRecording(){
 if(recording){recording.recorder.stop();return}
 if(!state.active)return toast('Сначала откройте переписку');
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return toast('Запись голоса не поддерживается');
 if(!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')&&!MediaRecorder.isTypeSupported('audio/webm'))return toast('Нужен Edge или Chrome с поддержкой WebM');
 let stream;try{stream=await navigator.mediaDevices.getUserMedia({audio:true})}
 catch(e){toast('Нет доступа к микрофону: '+e.message);return}
 const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
 const rec=new MediaRecorder(stream,{mimeType:mime});
 const session={recorder:rec,stream,chunks:[],chatId:state.active.id,started:Date.now()};
 recording=session;
 rec.ondataavailable=e=>{if(e.data?.size)session.chunks.push(e.data)};
 rec.onstop=()=>{
  session.stream.getTracks().forEach(t=>t.stop());
  if(recordTimeInterval)clearInterval(recordTimeInterval);
  recordTimeInterval=null;recording=null;recordButton(false);
  const blob=new Blob(session.chunks,{type:'audio/webm'});
  if(!blob.size){toast('Нечего отправлять — запись пуста');return}
  if(blob.size>12*1024*1024){toast('Голосовое слишком длинное (макс. 12 МБ)');return}
  const url=URL.createObjectURL(blob);
  const sec=Math.round((Date.now()-session.started)/1000);
  modal('Голосовое сообщение','<p>Длительность: '+sec+' сек. Прослушайте перед отправкой.</p><audio class="voice-preview" id="recordPreview" controls src="'+url+'"></audio><div class="voice-actions"><button class="button" id="sendRecording">Отправить</button><button class="button outlined" id="cancelRecording">Отмена</button></div>');
  $('cancelRecording').onclick=()=>{URL.revokeObjectURL(url);closeModal()};
  $('sendRecording').onclick=async()=>{
   if(state.active?.id!==session.chatId)return toast('Откройте исходный чат для отправки');
   $('sendRecording').disabled=true;
   try{const file=new File([blob],'voice-'+Date.now()+'.webm',{type:'audio/webm'});
    if(await uploadFile(file)){closeModal();URL.revokeObjectURL(url)}else $('sendRecording').disabled=false}catch(e){toast(e.message);$('sendRecording').disabled=false}
  };
  setTimeout(()=>URL.revokeObjectURL(url),5*60*1000);
 };
 rec.onerror=()=>{stream.getTracks().forEach(t=>t.stop());recording=null;recordButton(false);toast('Ошибка записи')};
 rec.start(250);
 recordButton(true);
 recordTimeInterval=setInterval(()=>{
  if(recording!==session)return;
  const sec=Math.floor((Date.now()-session.started)/1000);
  recordButton(true,sec);if(sec>=120)rec.stop()
 },1000);
}
async function playVoiceAttachment(a,btn){
 if(!a||!btn)return;
 btn.disabled=true;btn.textContent='Загружаем аудио…';
 try{
  const res=await fetch('/api/attachments/'+encodeURIComponent(a.id),{headers:{Authorization:'Bearer '+storage.token}});
  if(!res.ok)throw Error('Не удалось загрузить голосовое');
  const blob=await res.blob();const url=URL.createObjectURL(blob);
  const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=url;audio.className='voice-playback';
  btn.replaceWith(audio);audio.addEventListener('ended',()=>setTimeout(()=>URL.revokeObjectURL(url),60000),{once:true});
  await audio.play().catch(()=>{});
 }catch(e){btn.disabled=false;btn.textContent='▶ Голосовое · повторить';toast(e.message)}
}
