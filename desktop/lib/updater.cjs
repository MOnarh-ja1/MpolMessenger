'use strict';
const { net, dialog } = require('electron');

const API = 'https://api.github.com/repos/MOnarh-ja1/MpolMessenger/releases?per_page=20';
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)-desktop$/;
const DOWNLOAD_HOST = 'github.com';
function numericVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
  return value.split('.').map(Number);
}
function isNewer(next, current) {
  const a=numericVersion(next), b=numericVersion(current);
  if (!a||!b) return false;
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}
  return false;
}
function releaseFromList(list,current) {
  if(!Array.isArray(list)) return null;
  const matches=list.map(release=>{
    if(release.draft) return null;
    const m=RELEASE_TAG.exec(release.tag_name||'');
    if(!m||!isNewer(m[1],current))return null;
    const asset=(release.assets||[]).find(a=>a.name==='MpolMessenger.exe');
    if(!asset||!asset.browser_download_url)return null;
    const u=new URL(asset.browser_download_url);
    if(u.protocol!=='https:'||u.hostname!==DOWNLOAD_HOST||
        u.pathname!==`/MOnarh-ja1/MpolMessenger/releases/download/${release.tag_name}/MpolMessenger.exe`)return null;
    return {version:m[1],url:u.toString()};
  }).filter(Boolean);
  return matches.sort((a,b)=>isNewer(a.version,b.version)?-1:1)[0]||null;
}
async function checkForUpdate(current) {
  const response=await net.fetch(API,{headers:{'User-Agent':'MpolMessenger-UpdateCheck','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('GitHub update endpoint '+response.status);
  return releaseFromList(await response.json(),current);
}
async function offerDesktopUpdate(win,current) {
  if(win.isDestroyed())return;
  let available;
  try{available=await checkForUpdate(current);}
  catch(err){console.warn('MPOL update check:',err.message);return;}
  if(!available||win.isDestroyed())return;
  const result=await dialog.showMessageBox(win,{
    type:'info',title:'Обновление MPOL Messenger',
    message:'Доступна новая версия MPOL Messenger '+available.version,
    detail:'Текущая версия: '+current+'. Скачать новый Windows EXE в приложении? Аккаунты и чаты сохраняются на сервере. После скачивания закройте старый EXE и запустите новый файл.',
    buttons:['Скачать обновление','Позже'],
    defaultId:0,cancelId:1,noLink:true
  });
  if(result.response!==0||win.isDestroyed())return;
  // Download in Electron: the existing will-download handler prompts for a safe path.
  win.webContents.downloadURL(available.url);
}
module.exports={isNewer,releaseFromList,checkForUpdate,offerDesktopUpdate};
