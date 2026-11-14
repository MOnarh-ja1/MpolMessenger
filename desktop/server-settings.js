'use strict';
const input=document.getElementById('serverInput');
const status=document.getElementById('status');
const save=document.getElementById('save');
const current=document.getElementById('current');
let defaultOrigin='https://mpol-messenger-api.onrender.com';
function report(message){status.textContent=message;status.classList.toggle('error',!!message)}
async function initialise(){
 try{
  const info=await window.mpolServerSettings.current();
  current.textContent=info.current;
  input.value=info.current;
  defaultOrigin=info.defaultOrigin;
 }catch{report('Не удалось прочитать настройки. Попробуйте перезапустить приложение.')}
}
document.getElementById('form').addEventListener('submit',async event=>{
 event.preventDefault();
 save.disabled=true;report('Проверяем доступность сервера по HTTPS…');
 try{
  const result=await window.mpolServerSettings.select(input.value.trim());
  if(!result.ok)report(result.error||'Адрес не принят');
 }catch(e){report('Ошибка подключения: '+e.message)}
 finally{save.disabled=false}
});
document.getElementById('reset').addEventListener('click',()=>{input.value=defaultOrigin;report('')});
document.getElementById('retry').addEventListener('click',()=>window.mpolServerSettings.retry());
initialise();
