'use strict';
/* A deterministic, non-LLM command parser: no arbitrary code or server actions. */
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
 function key(raw){
  const letters=String(raw||'').normalize('NFKC').toLowerCase()
   .replace(/[ё]/g,'е').replace(/[^a-zа-я0-9]/g,'');
  return Array.from(letters,x=>transliteration[x]??x).join('').replace(/w/g,'u');
 }
 function parse(input){
  let s=String(input||'').trim().replace(/[.!?]+$/,'').trim();
  s=s.replace(/^(?:эй[, ]+)?(?:mpol|эмпол|мпол|помощник)[, ]+/i,'').trim();
  if(!s)return {kind:'help'};
  if(/^(?:помощь|что ты умеешь|команды|помоги)$/i.test(s))return {kind:'help'};
  if(/^(?:открой|покажи|перейди в?)\s+(?:мои\s+)?(?:друзья|список друзей)$/i.test(s))
   return {kind:'tab',tab:'friends'};
  if(/^(?:открой|покажи|перейди в?)\s+(?:мои\s+)?(?:сообщения|чаты|переписки)$/i.test(s))
   return {kind:'tab',tab:'chats'};
  if(/^(?:открой|покажи)\s+(?:мои\s+)?(?:группы)$/i.test(s))
   return {kind:'tab',tab:'groups'};
  if(/^(?:создай|создать|открой)\s+(?:сервер|голосовую комнату)/i.test(s))
   return {kind:'future'};
  const rules=[
   ['video_call',/^(?:позвони\s+(?:по\s+видео|с\s+камерой)|(?:начни|сделай|запусти)\s+видео\s*звонок|видео\s*звонок|видеозвонок)\s+(.*)$/i],
   ['call',/^(?:позвони|набери|начни\s+(?:голосовой\s+)?звонок|голосовой\s+звонок)(?:\s+(.*))?$/i],
   ['group',/^(?:создай|создать|сделай|открой)\s+(?:новую\s+)?группу\s*(.*)$/i],
   ['open_chat',/^(?:открой|покажи|перейди\s+в|найди|начни)\s+(?:личный\s+)?(?:чат|переписку|диалог)\s+(.*)$/i],
   ['open_chat',/^(?:напиши|написать|открой\s+переписку)\s+(.*)$/i],
   ['profile',/^(?:открой|покажи)\s+профиль\s+(.*)$/i],
   ['find',/^(?:найди|ищи|поиск)\s+(?:пользователя|человека|друга)?\s*(.*)$/i]
  ];
  for(const [kind,re] of rules){
   const m=re.exec(s);
   if(!m)continue;
   let target=(m[1]||'').replace(/^(?:с\s+)?(?:(?:пользователем|пользователя|пользователю|человеком|человека|другом|друга|другу|по\s+нику)\s+)?/i,'').trim();
   target=target.replace(/\s+(?:пожалуйста|сейчас)$/i,'').trim();
   if(target.length>80)return {kind:'help'};
   if(!target&&kind==='group')return {kind:'group',target:''};
   return target?{kind,target}:{kind:'missing',action:kind};
  }
  return {kind:'unknown'};
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
  return [...results.values()].sort((a,b)=>b.score-a.score||String(a.nick).localeCompare(String(b.nick),'ru')).slice(0,8);
 }
 return {parse,key,matchContacts};
});
