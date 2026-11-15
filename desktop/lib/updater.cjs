'use strict';
const { net, dialog, shell, app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const API = 'https://api.github.com/repos/MOnarh-ja1/MpolMessenger/releases?per_page=20';
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)-desktop$/;
const DOWNLOAD_HOST = 'github.com';
const running = new WeakSet();
function numericVersion(value){
 if(!/^\d+\.\d+\.\d+$/.test(value))return null;
 return value.split('.').map(Number);
}
function isNewer(next,current){
 const a=numericVersion(next),b=numericVersion(current);
 if(!a||!b)return false;
 for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
 return false;
}
function releaseFromList(list,current){
 if(!Array.isArray(list))return null;
 const matches=list.map(release=>{
  if(release.draft)return null;
  const m=RELEASE_TAG.exec(release.tag_name||'');
  if(!m||!isNewer(m[1],current))return null;
  // Prefer a real Windows installer: pinning the temporary Electron executable
  // extracted by an NSIS portable build creates broken taskbar shortcuts.
  // Older releases remain downloadable, but their portable EXE is fallback only.
  const asset=(release.assets||[]).find(a=>a.name==='MpolMessengerSetup.exe')||
    (release.assets||[]).find(a=>a.name==='MpolMessenger.exe');
  if(!asset?.browser_download_url)return null;
  const url=new URL(asset.browser_download_url);
  if(url.protocol!=='https:'||url.hostname!==DOWNLOAD_HOST||
    url.pathname!==`/MOnarh-ja1/MpolMessenger/releases/download/${release.tag_name}/${asset.name}`)return null;
  // Download only files with GitHub's signed release metadata + SHA-256 digest.
  const digest=/^sha256:([0-9a-f]{64})$/i.exec(asset.digest||'');
  const size=Number(asset.size);
  if(!digest||!Number.isSafeInteger(size)||size<40_000_000||size>500_000_000)return null;
  return {version:m[1],url:url.toString(),sha256:digest[1].toLowerCase(),
    size,kind:asset.name==='MpolMessengerSetup.exe'?'installer':'portable'};
 }).filter(Boolean);
 return matches.sort((a,b)=>isNewer(a.version,b.version)?-1:1)[0]||null;
}
async function checkForUpdate(current){
 const response=await net.fetch(API,{headers:{'User-Agent':'MpolMessenger-UpdateCheck','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error('GitHub update API '+response.status);
 return releaseFromList(await response.json(),current);
}
// Streams 100+ MB without buffering in memory. The EXE is not launched without
// a separate user action. A temporary .part file is discarded on any failure.
async function downloadVerifiedUpdate(win,update,destination){
 const target=path.resolve(destination),temp=target+'.mpol.part';
 const controller=new AbortController();
 const onClosed=()=>controller.abort();
 win.once('closed',onClosed);
 const oldTitle=win.getTitle();
 let file=null;
 let written=0,lastPercent=-1;
 const hash=crypto.createHash('sha256');
 try{
  await fs.mkdir(path.dirname(target),{recursive:true});
  const response=await net.fetch(update.url,{headers:{'User-Agent':'MpolMessenger-Desktop-Updater'},signal:controller.signal});
  if(!response.ok||!response.body)throw Error('Ошибка загрузки GitHub: '+response.status);
  file=await fs.open(temp,'w',0o600);
  const reader=response.body.getReader();
  while(true){
   const {value,done}=await reader.read();
   if(done)break;
   if(!value?.byteLength)continue;
   let off=0;
   while(off<value.byteLength){
    const result=await file.write(value,off,value.byteLength-off);
    if(!result.bytesWritten)throw Error('Ошибка записи обновления');
    off+=result.bytesWritten;
   }
   hash.update(value);
   written+=value.byteLength;
   if(written>update.size)throw Error('Размер обновления превышает размер релиза');
   const percent=Math.floor(written/update.size*100);
   if(percent!==lastPercent&&!win.isDestroyed()){
    lastPercent=percent;
    win.setTitle('MPOL · Скачивание обновления '+percent+'%');
    win.setProgressBar(Math.min(1,written/update.size));
   }
  }
  await file.close();file=null;
  if(written!==update.size)throw Error('Обновление скачано не полностью');
  if(hash.digest('hex')!==update.sha256)throw Error('Проверка SHA-256 не пройдена');
  // Save dialog already confirmed replacement of an existing file, if any.
  await fs.rename(temp,target);
  return target;
 }finally{
  if(file)await file.close().catch(()=>{});
  await fs.rm(temp,{force:true}).catch(()=>{});
  win.removeListener('closed',onClosed);
  if(!win.isDestroyed()){win.setProgressBar(-1);win.setTitle(oldTitle)}
 }
}
async function offerDesktopUpdate(win,current){
 if(win.isDestroyed()||running.has(win))return;
 running.add(win);
 try{
  let update;
  try{update=await checkForUpdate(current)}
  catch(err){console.warn('MPOL update check:',err.message);return}
  if(!update||win.isDestroyed())return;
  const choice=await dialog.showMessageBox(win,{
   type:'info',title:'Обновление MPOL Messenger',
   message:'Доступна версия '+update.version+' ('+Math.round(update.size/1048576)+' МБ)',
   detail:update.kind==='installer'?
    'Загрузится полноценный установщик Windows, который создаст постоянную программу и правильные ярлыки. Прогресс и проверка SHA-256 включены. Аккаунты и переписки остаются на сервере.':
    'Для этой старой версии доступен только переносной EXE. Не закрепляйте запущенный временный процесс на панели задач; предпочтительнее установить новую версию из GitHub.',
   buttons:[update.kind==='installer'?'Скачать установщик':'Скачать EXE','Позже'],
   defaultId:0,cancelId:1,noLink:true
  });
  if(choice.response!==0||win.isDestroyed())return;
  const suggested=path.join(app.getPath('downloads'),
    update.kind==='installer'?'MpolMessengerSetup-'+update.version+'.exe':
      'MpolMessenger-'+update.version+'.exe');
  const result=await dialog.showSaveDialog(win,{
   title:'Куда сохранить новую версию MPOL',
   defaultPath:suggested,
   buttonLabel:'Скачать EXE',
   filters:[{name:'Windows EXE',extensions:['exe']}]
  });
  if(result.canceled||!result.filePath||win.isDestroyed())return;
  try{
   const target=await downloadVerifiedUpdate(win,update,result.filePath);
   if(win.isDestroyed())return;
   const success=await dialog.showMessageBox(win,{
    type:'info',title:'MPOL · Обновление скачано',
    message:'MPOL Messenger '+update.version+' загружен и проверен',
    detail:update.kind==='installer'?
      'Файл: '+target+'\nУстановщик создаст постоянную папку приложения и ярлыки. Старый закреплённый значок переносной версии нужно открепить.':
      'Файл: '+target+'\nЗакройте старую версию и запустите новый файл.',
    buttons:update.kind==='installer'?
      ['Запустить установщик','Показать файл','Позже']:
      ['Показать файл','Готово'],
    defaultId:0,cancelId:update.kind==='installer'?2:1
   });
   if(update.kind==='installer'&&success.response===0){
    const error=await shell.openPath(target);
    if(error)await dialog.showMessageBox(win,{
      type:'error',title:'Не удалось запустить установщик MPOL',
      message:error,buttons:['Закрыть']
    });
    else app.quit();
   }else if(success.response===(update.kind==='installer'?1:0)){
    shell.showItemInFolder(target);
   }
  }catch(error){
   if(win.isDestroyed())return;
   await dialog.showMessageBox(win,{type:'error',title:'MPOL · Ошибка загрузки',
    message:'Не удалось скачать проверенное обновление',
    detail:String(error?.message||error)+'\nСкачанный неполный файл удалён. Повторите позднее.',
    buttons:['Закрыть']});
  }
 }finally{running.delete(win)}
}
module.exports={isNewer,releaseFromList,checkForUpdate,downloadVerifiedUpdate,offerDesktopUpdate};
