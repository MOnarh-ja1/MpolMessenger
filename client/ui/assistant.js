'use strict';
/* MPOL assistant: explicit push-to-talk and allowlisted social commands.
   Voice stays on-device when a Windows ru-RU recognizer is installed.
   Browser speech may use its provider's recognition service. */
(() => {
 const byId=id=>document.getElementById(id);
 const core=window.MpolAssistantCore;
 const app=()=>window.mpolAssistantApp;
 if(!core||!byId('assistantPanel'))return;
 const ui={
  panel:byId('assistantPanel'),toggle:byId('assistantToggle'),close:byId('assistantClose'),
  orb:byId('assistantOrb'),status:byId('assistantStatus'),
  heard:byId('assistantHeard'),listen:byId('assistantListen'),
  browser:byId('assistantBrowserSpeech'),
  form:byId('assistantCommandForm'),input:byId('assistantCommand'),
  choices:byId('assistantChoices')
 };
 let open=false,active=false,browserRecognition=null,sequence=0;
 const browserSpeechAvailable=!!(window.SpeechRecognition||window.webkitSpeechRecognition);
 const clearChoices=()=>{ui.choices.replaceChildren();ui.choices.classList.add('hidden')};
 function status(text,mode='idle'){
  ui.status.textContent=text;
  ui.orb.dataset.state=mode;
  ui.listen.textContent=mode==='listening'?'■ Остановить':'🎙 Говорить';
 }
 function showHeard(text){
  ui.heard.textContent=String(text).slice(0,180);
  ui.heard.classList.toggle('hidden',!text);
 }
 function stopListening(){
  sequence++;
  active=false;
  try{browserRecognition?.abort()}catch{}
  browserRecognition=null;
  window.mpolNativeSpeech?.cancel?.().catch?.(()=>{});
  ui.browser.classList.add('hidden');
  status('Прослушивание остановлено');
 }
 function setOpen(next){
  if(open===next)return;
  open=next;ui.panel.classList.toggle('hidden',!open);
  ui.toggle.setAttribute('aria-expanded',String(open));
  ui.toggle.classList.toggle('active',open);
  if(!open){if(active)stopListening();clearChoices()}
  else{
   status('Готов слушать. Нажмите «Говорить» или напишите команду.');
   ui.panel.focus({preventScroll:true});
  }
 }
 function actionButton(text,fn,variant=''){
  const b=document.createElement('button');
  b.type='button';b.className='mpol-assistant-choice '+variant;
  b.textContent=text;
  b.onclick=async()=>{
   b.disabled=true;
   try{await fn()}catch(e){status(String(e?.message||e));b.disabled=false}
  };
  ui.choices.append(b);ui.choices.classList.remove('hidden');
  return b;
 }
 function showPeople(people,fn){
  clearChoices();
  for(const u of people.slice(0,8))
   actionButton(u.nick+' · '+u.id,()=>fn(u));
 }
 function contactList(){
  return app()?.contacts?.()||[];
 }
 async function searchMatches(target,preferFriends=false){
  const known=contactList();
  let matches=core.matchContacts(target,known);
  const exact=matches.filter(u=>u.score>=100);
  if(exact.length===1)return exact;
  // Resolve what the user asks for, without bulk downloading all accounts.
  if(String(target).trim().length>=3){
   try{
    const remote=await app()?.searchUsers?.(target);
    const combined=[...known,...(Array.isArray(remote)?remote:[])];
    matches=core.matchContacts(target,combined);
   }catch{
    // Older server versions may not yet expose the new search endpoint.
   }
  }
  if(preferFriends){
   const friendIds=new Set(known.filter(u=>u.friend).map(u=>u.id));
   matches=matches.filter(u=>friendIds.has(u.id));
  }
  return matches;
 }
 async function executeForUser(command,user){
  if(!app()?.isReady?.())return status('Войдите в аккаунт MPOL, чтобы пользоваться помощником.');
  clearChoices();
  const friend=app().isFriend(user.id);
  if(command.kind==='find'||command.kind==='profile'){
   app().showProfile(user);
   setOpen(false);
   return;
  }
  if(!friend){
   status('Сначала нужно добавить '+user.nick+' в друзья.');
   actionButton('Отправить заявку: '+user.nick,async()=>{
    await app().sendFriendRequest(user);
    clearChoices();status('Заявка отправлена. После принятия можно открыть чат или позвонить.');
   },'primary');
   return;
  }
  if(command.kind==='open_chat'){
   status('Открываю чат с '+user.nick+'…','working');
   await app().openChat(user);
   setOpen(false);
  }else if(command.kind==='group'){
   app().createGroupWith(user);
   setOpen(false);
  }else if(command.kind==='call'||command.kind==='video_call'){
   const video=command.kind==='video_call';
   status('Подтвердите '+(video?'видеозвонок':'звонок')+' пользователю '+user.nick+'.');
   actionButton('Подтвердить '+(video?'видеозвонок':'звонок')+' · '+user.nick,async()=>{
    status('Открываю '+(video?'видеозвонок':'звонок')+'…','working');
    await app().startCall(user,video?'video':'audio');
    setOpen(false);
   },'primary');
   actionButton('Отмена',()=>{clearChoices();status('Звонок отменён.')});
  }
 }
 async function submitCommand(value){
  if(!open)setOpen(true);
  const command=core.parse(value);
  showHeard(String(value||'').trim());
  clearChoices();
  ui.browser.classList.add('hidden');
  if(!app()?.isReady?.())return status('Войдите в аккаунт MPOL.');
  if(command.kind==='help'||command.kind==='unknown'){
   status(command.kind==='unknown'?'Не понял команду. Примеры:':'Примеры команд:');
   actionButton('Открой чат с Nows',()=>submitCommand('Открой чат с Nows'));
   actionButton('Позвони Nows',()=>submitCommand('Позвони Nows'));
   actionButton('Создай группу с Nows',()=>submitCommand('Создай группу с Nows'));
   return;
  }
  if(command.kind==='future')return status('Голосовые комнаты и серверы — следующий этап MPOL. Сейчас можно создавать групповые чаты.');
  if(command.kind==='tab'){
   app().showTab(command.tab);setOpen(false);return;
  }
  if(command.kind==='missing')return status('Укажите ник пользователя или его ID. Например: «Открой чат с Nows».');
  if(command.kind==='group'&&!command.target){
   app().createGroupWith(null);setOpen(false);return;
  }
  status('Ищу пользователя «'+command.target+'»…','working');
  let matches=await searchMatches(command.target,command.kind==='group');
  if(!open)return;
  if(!matches.length){
   status('Пользователь не найден. Проверьте написание ника или добавьте его в друзья.');
   return;
  }
  const best=matches[0].score;
  // Ambiguous voice recognition should never dial the wrong person.
  if(matches.length===1 || (best>=95 && matches[1].score<best-12)){
   try{await executeForUser(command,matches[0])}catch(e){status(e.message||'Не удалось выполнить команду')}
   return;
  }
  status('Нашёл несколько похожих ников. Выберите нужного человека.');
  showPeople(matches.filter(x=>x.score>=Math.max(56,best-22)),user=>executeForUser(command,user));
 }
 async function processTranscript(raw,seq){
  if(!open||seq!==sequence)return;
  active=false;browserRecognition=null;status('Распознано. Выполняю команду…','working');
  const text=String(raw||'').trim();
  if(!text)return status('Не расслышал команду. Попробуйте снова.');
  ui.input.value=text;
  await submitCommand(text);
 }
 function startBrowserRecognition(){
  if(!browserSpeechAvailable)return status('В этом браузере нет распознавания голоса. Используйте текстовый ввод.');
  const Ctor=window.SpeechRecognition||window.webkitSpeechRecognition;
  const seq=++sequence;
  const r=new Ctor();browserRecognition=r;active=true;
  r.lang='ru-RU';r.continuous=false;r.interimResults=false;r.maxAlternatives=1;
  status('Слушаю… Скажите команду.','listening');
  r.onresult=event=>{
   const value=event.results?.[0]?.[0]?.transcript||'';
   processTranscript(value,seq);
  };
  r.onerror=event=>{
   if(seq!==sequence)return;
   active=false;
   const reason=event.error==='not-allowed'?'Нет доступа к микрофону.':
    event.error==='network'?'Распознавание браузера недоступно в этой сети.':
    'Не удалось распознать голос ('+String(event.error||'ошибка')+').';
   status(reason+' Можно ввести команду текстом.');
  };
  r.onend=()=>{
   if(seq!==sequence)return;
   if(active){active=false;status('Не расслышал команду. Попробуйте ещё раз.')}
  };
  try{r.start()}catch(e){active=false;status('Не удалось включить микрофон: '+e.message)}
 }
 async function startNative(){
  if(!window.mpolNativeSpeech)return startBrowserRecognition();
  active=true;const seq=++sequence;
  status('Слушаю… Произнесите команду в микрофон.','listening');
  let result;
  try{result=await window.mpolNativeSpeech.recognize()}
  catch(e){result={ok:false,code:'unavailable',message:String(e?.message||e)}}
  if(seq!==sequence||!open)return;
  active=false;
  if(result?.ok&&result.text){
   await processTranscript(result.text,seq);
   return;
  }
  status(result?.message||'Распознавание Windows недоступно. Введите команду текстом.');
  if(browserSpeechAvailable&&result?.code!=='cancelled'){
   ui.browser.classList.remove('hidden');
  }
 }
 ui.toggle.onclick=()=>setOpen(!open);
 ui.close.onclick=()=>setOpen(false);
 ui.listen.onclick=()=>{
  if(active){stopListening();return}
  clearChoices();showHeard('');
  startNative();
 };
 ui.browser.onclick=()=>{
  // Browser implementations can send audio to the browser provider.
  ui.browser.classList.add('hidden');startBrowserRecognition();
 };
 ui.form.onsubmit=e=>{
  e.preventDefault();
  if(active)stopListening();
  submitCommand(ui.input.value).catch(err=>status(err.message||'Ошибка команды'));
 };
 ui.panel.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();setOpen(false);ui.toggle.focus()}
 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)stopListening()});
 window.addEventListener('mpol:signed-out',()=>setOpen(false));
})();
