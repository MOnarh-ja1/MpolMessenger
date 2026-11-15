'use strict';
const help=document.getElementById('help');
async function run(action,message){
 help.textContent=message;
 try{await window.mpolRecovery[action]()}
 catch(err){help.textContent='Не удалось выполнить действие. Перезапустите MPOL. '+String(err?.message||'')}
}
document.getElementById('retry').addEventListener('click',()=>run('retry','Проверяем подключение…'));
document.getElementById('settings').addEventListener('click',()=>run('settings','Открываем настройки сервера…'));
