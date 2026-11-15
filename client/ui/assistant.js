'use strict';
/* Push-to-talk MPOL: one accessible round button. Speech is processed only
   after the user's click and never recorded in the background. */
(() => {
 const byId=id=>document.getElementById(id);
 const core=window.MpolAssistantCore;
 const app=()=>window.mpolAssistantApp;
 const panel=byId('assistantPanel'),launcher=byId('assistantToggle');
 const button=byId('assistantListen'),live=byId('assistantStatus');
 if(!core||!panel||!launcher||!button)return;

 let opened=false,listening=false,busy=false,sequence=0,recognition=null,watchdog=null;
 const notify=msg=>{
  const message=String(msg||'').slice(0,260);
  live.textContent=message;
  if(typeof toast==='function')toast(message);
 };
 function appearance(mode){
  button.dataset.state=mode;
  button.setAttribute('aria-pressed',String(mode==='listening'));
  const label=mode==='listening'?'Остановить прослушивание':
    mode==='working'?'Выполняется команда':'Начать голосовую команду';
  button.setAttribute('aria-label',label);
  button.title=label;
  live.textContent=label;
 }
 function abort(){
  sequence++;
  listening=false;busy=false;
  if(watchdog){clearTimeout(watchdog);watchdog=null}
  try{recognition?.abort()}catch{}
  recognition=null;
  window.mpolNativeSpeech?.cancel?.().catch?.(()=>{});
  appearance('idle');
 }
 function show(next){
  if(next===opened)return;
  opened=next;panel.classList.toggle('hidden',!next);
  launcher.setAttribute('aria-expanded',String(next));
  launcher.classList.toggle('active',next);
  if(!next){abort();launcher.focus?.({preventScroll:true})}
  else {appearance('idle');button.focus?.({preventScroll:true})}
 }
 async function findPeople(name,forGroup){
  const local=app().contacts()||[];
  let found=core.matchContacts(name,local);
  const exact=found.filter(x=>x.score>=100);
  if(exact.length!==1 && name.trim().length>=3){
   try{
    const other=await app().searchUsers(name);
    if(Array.isArray(other))found=core.matchContacts(name,[...local,...other]);
   }catch{/* Older MPOL server: local friends still work. */}
  }
  if(forGroup){
   const friends=new Set(local.filter(x=>x.friend).map(x=>x.id));
   found=found.filter(x=>friends.has(x.id));
  }
  return found;
 }
 // Only use the existing MPOL confirmation / selection dialogs.
 function confirmAction(question){
  return typeof window.confirm==='function'&&window.confirm(question);
 }
 async function chooseMatch(matches){
  if(matches.length===1)return matches[0];
  const best=matches[0]?.score||0;
  if(matches.length>1&&best>=95&&best-matches[1].score>=15)return matches[0];
  if(typeof app().chooseContact==='function')return app().chooseContact(matches);
  notify('Найдено несколько похожих ников. Уточните имя.');
  return null;
 }
 async function doCommand(raw){
  if(!opened||!app()?.isReady?.())return notify('Для голосового помощника войдите в аккаунт MPOL.');
  const parsed=core.parse(raw);
  if(parsed.kind==='unknown'||parsed.kind==='help')return notify('Команда не распознана. Попробуйте ещё раз.');
  if(parsed.kind==='missing')return notify('Не расслышал ник пользователя. Произнесите команду снова.');
  if(parsed.kind==='future')return notify('Голосовые серверы будут добавлены в следующей версии.');
  if(parsed.kind==='tab'){app().showTab(parsed.tab);show(false);return}
  if(parsed.kind==='group'&&!parsed.target){app().createGroupWith(null);show(false);return}

  const found=await findPeople(parsed.target,parsed.kind==='group');
  if(!opened)return;
  if(!found.length)return notify('Пользователь «'+parsed.target+'» не найден.');
  const chosen=await chooseMatch(found);
  if(!opened||!chosen)return;
  if(parsed.kind==='profile'||parsed.kind==='find'){
   app().showProfile(chosen);show(false);return;
  }
  if(!app().isFriend(chosen.id)){
   if(confirmAction('Пользователь '+chosen.nick+' не в друзьях. Отправить заявку?')){
    await app().sendFriendRequest(chosen);
    show(false);
   }
   return;
  }
  if(parsed.kind==='open_chat'){
   await app().openChat(chosen);show(false);return;
  }
  if(parsed.kind==='group'){
   app().createGroupWith(chosen);show(false);return;
  }
  if(parsed.kind==='call'||parsed.kind==='video_call'){
   const type=parsed.kind==='video_call'?'видеозвонок':'голосовой звонок';
   if(!confirmAction('Начать '+type+' с '+chosen.nick+'?'))return;
   // Requires explicit confirmation before actual microphone activation and dialing.
   await app().startCall(chosen,parsed.kind==='video_call'?'video':'audio');
   show(false);
  }
 }
 async function heard(text,seq){
  if(seq!==sequence||!opened)return;
  listening=false;busy=true;
  if(watchdog){clearTimeout(watchdog);watchdog=null}
  appearance('working');
  const value=String(text||'').trim();
  if(!value){busy=false;appearance('idle');return notify('Не расслышал команду. Повторите.')}
  try{await doCommand(value)}
  catch(e){if(opened)notify(e?.message||'Не удалось выполнить команду.')}
  finally{if(seq===sequence){busy=false;appearance('idle')}}
 }
 function browserStart(){
  const Ctor=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Ctor){
   appearance('idle');
   notify('В этом браузере нет голосового распознавания. Откройте MPOL в Chrome или Microsoft Edge.');
   return;
  }
  let instance;
  try{instance=new Ctor()}catch{
   appearance('idle');notify('Не удалось включить распознавание речи.');return;
  }
  const seq=++sequence;recognition=instance;listening=true;
  instance.lang='ru-RU';instance.continuous=false;
  instance.interimResults=false;instance.maxAlternatives=3;
  let delivered=false;
  instance.onresult=event=>{
   if(seq!==sequence||delivered)return;
   delivered=true;
   const results=event.results?.[0];
   const candidates=[];
   for(let i=0;i<(results?.length||0);i++){
    const text=String(results[i]?.transcript||'').trim();
    if(text)candidates.push(text);
   }
   // Prefer a recognizable command over the browser's first alternative.
   const best=candidates.find(s=>!['unknown','help','missing'].includes(core.parse(s).kind))||candidates[0]||'';
   heard(best,seq).catch(()=>{});
   try{instance.stop()}catch{}
  };
  instance.onerror=event=>{
   if(seq!==sequence)return;
   listening=false;recognition=null;
   if(watchdog)clearTimeout(watchdog);watchdog=null;
   appearance('idle');
   if(event.error==='aborted')return;
   const messages={
    'not-allowed':'Доступ к микрофону запрещён в настройках браузера.',
    'audio-capture':'Микрофон не найден или занят.',
    'no-speech':'Речь не обнаружена. Нажмите на круг и повторите.',
    'network':'Речевой сервис браузера недоступен. Проверьте сеть или используйте EXE с офлайн-распознаванием.',
    'language-not-supported':'Русское распознавание недоступно в этом браузере.'
   };
   notify(messages[event.error]||'Ошибка голосового ввода. Попробуйте снова.');
  };
  instance.onend=()=>{
   if(seq!==sequence)return;
   recognition=null;
   if(watchdog)clearTimeout(watchdog);watchdog=null;
   if(listening&&!delivered){listening=false;appearance('idle');notify('Речь не распознана. Нажмите на круг и повторите.')}
  };
  appearance('listening');
  watchdog=setTimeout(()=>{if(seq!==sequence||!listening)return;try{instance.stop()}catch{}},14000);
  try{instance.start()}
  catch(e){
   listening=false;recognition=null;
   clearTimeout(watchdog);watchdog=null;
   appearance('idle');notify('Не удалось запустить голосовой ввод: '+e.message);
  }
 }
 async function nativeStart(){
  const seq=++sequence;listening=true;
  appearance('listening');
  let result;
  try{result=await window.mpolNativeSpeech.recognize()}
  catch(e){result={ok:false,message:'Не удалось запустить распознавание Windows: '+String(e?.message||e)}}
  if(seq!==sequence||!opened)return;
  listening=false;
  if(result?.ok&&result.text){await heard(result.text,seq);return}
  appearance('idle');
  if(result?.code==='cancelled')return;
  notify(result?.message||'Голосовой ввод в Windows недоступен. Проверьте микрофон.');
 }
 launcher.onclick=()=>show(!opened);
 button.onclick=()=>{
  if(busy)return;
  if(listening){abort();return}
  if(!app()?.isReady?.())return notify('Войдите в MPOL для голосовых команд.');
  if(window.mpolNativeSpeech)nativeStart();
  else browserStart();
 };
 panel.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();show(false)}
 });
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&listening)abort();
 });
 window.mpolAssistantClose=()=>show(false);
})();
