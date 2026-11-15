'use strict';
/* On-device intent resolver. Understands common spoken paraphrases without
   sending text to an AI service or permitting arbitrary actions. */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.MpolAssistantCore=api;
})(typeof window!=='undefined'?window:null,function(){
 const transliteration={
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
  'и':'i','й':'i','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh',
  'щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
 };
 function normalize(raw){
  return String(raw||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е')
   .replace(/[^a-zа-я0-9\s-]/g,' ').replace(/[-\s]+/g,' ').trim();
 }
 function key(raw){
  const letters=normalize(raw).replace(/[^a-zа-я0-9]/g,'');
  return Array.from(letters,x=>transliteration[x]??x).join('')
   // "Nows" and "Nowus" are often pronounced "ноус".
   .replace(/w/g,'u').replace(/ouu/g,'ou').replace(/uu+/g,'u')
   .replace(/iy/g,'i').replace(/yi/g,'i');
 }
 function distance(a,b){
  if(Math.abs(a.length-b.length)>2)return 3;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
   const row=[i];
   for(let j=1;j<=b.length;j++)
    row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
   prev=row;
  }
  return prev[b.length];
 }
 function matchContacts(target,people){
  const k=key(target),raw=String(target||'').trim().toUpperCase();
  if(!k)return [];
  const results=new Map();
  for(const p of people||[]){
   if(!p||!p.id||!p.nick)continue;
   const id=String(p.id).toUpperCase(),name=key(p.nick);
   let score=0;
   if(id===raw)score=120;
   else if(name===k)score=100;
   else if(name.startsWith(k)&&k.length>=3)score=85;
   else if(name.includes(k)&&k.length>=4)score=65;
   else if(k.length>=4&&name.length>=4&&distance(name,k)<=1)score=74;
   else if(k.length>=6&&name.length>=5&&distance(name,k)<=2)score=61;
   if(!score)continue;
   const old=results.get(id);
   if(!old||score>old.score)results.set(id,{...p,score});
  }
  return [...results.values()]
   .sort((a,b)=>b.score-a.score||String(a.nick).localeCompare(String(b.nick),'ru'))
   .slice(0,8);
 }
 const patterns={
  call:['позвони','позвонить','позванить','пазвони','набери','набрать','звони','звонить','вызови','вызвать','перезвони'],
  open_chat:['открой','открыть','открывай','открою','покажи','показать','найди','найти','перейди','зайди','переключи','напиши','написать','откройте'],
  group:['создай','создать','сделай','сделать','организуй','организовать'],
  profile:['профиль','профиля','профилю','профил','страницу','страница'],
  video:['видео','видеозвонок','видеовызов','видеосвязь','видезвонок','видеозванок','видеоразговор','камерой','камеру']
 };
 function inWords(word,dict){
  if(dict.includes(word))return true;
  if(word.length<5)return false;
  return dict.some(s=>s.length>=5&&distance(word,s)<=1);
 }
 function clean(raw){
  let s=normalize(raw);
  for(let i=0;i<4;i++){
   const old=s;
   s=s.replace(/^(?:эй|слушай|ну|так|пожалуйста|давай|можешь|можно|мне|а|ты|хочу|надо|нужно|сейчас|короче)\s+/,'');
   s=s.replace(/^(?:mpol|мпол|эмпол|эм пол|помощник|ассистент)\s+/,'');
   if(s===old)break;
  }
  return s.replace(/(^|\s)пожалуйста(?=\s|$)/g,' ').replace(/\s+/g,' ').trim();
 }
 function targetOf(words,from){
  let parts=words.slice(from).join(' ').trim();
  // Remove only leading connective/filler words; keep the actual nickname.
  for(let i=0;i<5;i++){
   const previous=parts;
   parts=parts.replace(/^(?:мне|сейчас|пожалуйста|моему|моей|мой|с|со|к|для|по нику|по имени|по|в|на|этим|этого|этому|этой|моим|другу|друга|другом|друзьями|человеку|человека|человеком|пользователя|пользователем|пользователю|пользователь|нику|ник|имени|имя)\s+/,'').trim();
   if(previous===parts)break;
  }
  return parts.replace(/\s+(?:пожалуйста|сейчас|быстро|ладно)$/,'').trim().slice(0,80);
 }
 function parse(input){
  const s=clean(input);
  if(!s)return {kind:'help'};
  if(/^(?:помощь|помоги|справка|что ты умеешь|команды|какие команды)$/.test(s))
   return {kind:'help'};
  const words=s.split(' ');
  if(/^(?:создай|создать|сделай|открой|открыть|зайди)\s+(?:голосовой\s+)?(?:сервер|канал|комнату|серверы)(?=\s|$)/.test(s))
   return {kind:'future'};
  const videoIdx=words.findIndex(w=>inWords(w,patterns.video));
  const callIdx=words.findIndex(w=>inWords(w,patterns.call));
  const groupIdx=words.findIndex(w=>inWords(w,patterns.group));
  const actionIdx=words.findIndex(w=>inWords(w,patterns.open_chat));
  const profileIdx=words.findIndex(w=>inWords(w,patterns.profile));
  const groupNoun=words.findIndex(w=>/^(?:группу|группы|группа|групповой|групповойчат|беседу|беседа)$/.test(w));
  const chatNoun=words.findIndex(w=>/^(?:чат|чад|чать|чатик|чаты|чата|диалог|диалоге|диалогом|переписку|переписка|перепеску|разговор|разговора|сообщения|сообщение)$/.test(w));
  const targetNoun=words.findIndex(w=>/^(?:друзья|друзей|друзьями|контакты|контактов)$/.test(w));
  const isDirectTab=(words.length<=5 &&
    (targetNoun>=0 || /^(?:чаты|сообщения|переписки|группы)$/.test(words.at(-1))) &&
    (actionIdx>=0||/^(?:друзья|контакты|группы|чаты|сообщения)$/.test(words[0])));
  if(isDirectTab){
   if(targetNoun>=0)return {kind:'tab',tab:'friends'};
   if(words.some(w=>/^(?:группы)$/.test(w)))return {kind:'tab',tab:'groups'};
   return {kind:'tab',tab:'chats'};
  }
  // "Открой профиль Ноуc", "Посмотри профиль Nows".
  if(profileIdx>=0&&(
   actionIdx>=0||/^(?:посмотри|посмотреть|найди|хочу|покажи)$/.test(words[0]))){
   const target=targetOf(words,profileIdx+1);
   return target?{kind:'profile',target}:{kind:'missing',action:'profile'};
  }
  // "Создай группу с...", "Сделай беседу...", or "Новая группа".
  if(groupNoun>=0&&(groupIdx>=0 || /^(?:новую|новая|группу)$/.test(words[0]))){
   const target=targetOf(words,groupNoun+1);
   return {kind:'group',target};
  }
  if(videoIdx>=0&&(callIdx>=0 || /звон|вызов|связ/.test(words[videoIdx]) ||
   /^(?:запусти|начни|сделай|организуй|включи)$/.test(words[0]))){
   // "Сделай видео звонок" is two words; remove the second video noun.
   let after=Math.max(videoIdx,callIdx)+1;
   if(words[after]&&/^(?:звонок|званок|вызов|разговор)$/.test(words[after]))after++;
   let target=targetOf(words,after);
   // "Позвони Ноуc по видео": target precedes the video qualifier.
   if(!target&&callIdx>=0&&videoIdx>callIdx){
    target=targetOf(words.slice(0,videoIdx).filter(w=>w!=='по'),callIdx+1);
   }
   return target?{kind:'video_call',target}:{kind:'missing',action:'video_call'};
  }
  // Some recognizers split the word "видеозвонок" into "видео звонок".
  if(videoIdx>=0&&callIdx<0&&
   words[videoIdx+1]&&/^(?:звонок|званок|вызов|разговор)$/.test(words[videoIdx+1])){
   const target=targetOf(words,videoIdx+2);
   return target?{kind:'video_call',target}:{kind:'missing',action:'video_call'};
  }
  if(callIdx<0&&(words.includes('звонок')||words.includes('вызов'))&&
   /^(?:начни|сделай|запусти|организуй|включи|давай)$/.test(words[0])){
   const nounIdx=words.findIndex(w=>w==='звонок'||w==='вызов');
   const target=targetOf(words,nounIdx+1);
   return target?{kind:'call',target}:{kind:'missing',action:'call'};
  }
  // "Позвони другу Nows", "Набери Nows", "Звони по видео Nows".
  if(callIdx>=0){
   const target=targetOf(words,callIdx+1);
   return target?{kind:'call',target}:{kind:'missing',action:'call'};
  }
  // "Открой чат с ...", "Напиши Nows", "Покажи переписку ...".
  if(actionIdx>=0){
   const first=words[actionIdx];
   if(/^(?:найди|найти|поищи|ищи|поиск)$/.test(first)&&chatNoun<0){
    const target=targetOf(words,actionIdx+1);
    return target?{kind:'find',target}:{kind:'missing',action:'find'};
   }
   if(chatNoun>=0){
    const target=targetOf(words,chatNoun+1);
    return target?{kind:'open_chat',target}:{kind:'missing',action:'open_chat'};
   }
   if(/^(?:напиши|написать|найди|найти|покажи|открой|открыть)$/.test(first)){
    const target=targetOf(words,actionIdx+1);
    return target?{kind:'open_chat',target}:{kind:'missing',action:'open_chat'};
   }
  }
  if(/^(?:найди|найти|ищи|поиск|поищи)(?=\s|$)/.test(s)){
   const target=targetOf(words,1);
   return target?{kind:'find',target}:{kind:'missing',action:'find'};
  }
  return {kind:'unknown'};
 }
 function selectTranscript(candidates,people){
  const list=(Array.isArray(candidates)?candidates:[candidates])
   .map(c=>typeof c==='string'?c:(c&&typeof c.text==='string'?c.text:''))
   .map(c=>c.trim()).filter(Boolean).slice(0,8);
  if(!list.length)return '';
  let best=list[0],score=-1;
  for(const utterance of list){
   const intent=parse(utterance);
   const valid=!['unknown','help','missing'].includes(intent.kind);
   let rank=valid?50:0;
   if(intent.kind==='tab')rank+=12;
   if(intent.target){
    const matched=matchContacts(intent.target,people||[]);
    if(matched[0])rank+=matched[0].score/2;
    else rank+=3;
   }
   if(rank>score){score=rank;best=utterance}
  }
  return best;
 }
 return {normalize,parse,key,matchContacts,selectTranscript};
});
