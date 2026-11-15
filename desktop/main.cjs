'use strict';
const { app, BrowserWindow, Menu, dialog, session, shell, desktopCapturer, ipcMain, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SERVER_ORIGIN, normalizeServerOrigin, isMpolUrl, canOpenExternal,
  safeFilename, normalizeMediaTypes } = require('./lib/security.cjs');
const {loadPermissionGrants,savePermissionGrants,hasPermission,
  grantPermissions,revokeMediaPermissions}=require('./lib/media-permissions.cjs');

const APP_VERSION = '3.5.0';
const { offerDesktopUpdate } = require('./lib/updater.cjs');
let activeServerOrigin=SERVER_ORIGIN;
const isTrustedUrl=url=>isMpolUrl(url,activeServerOrigin);
const appUrl=()=>activeServerOrigin+'/?mpol_client='+APP_VERSION;
function serverStatePath(){return path.join(app.getPath('userData'),'server-origin.json')}
function readServerOrigin(){
 try{
  const data=JSON.parse(fs.readFileSync(serverStatePath(),'utf8'));
  return normalizeServerOrigin(data.origin)||SERVER_ORIGIN;
 }catch{return SERVER_ORIGIN}
}
function saveServerOrigin(origin){
 const dest=serverStatePath();
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.writeFileSync(dest,JSON.stringify({origin}),{mode:0o600});
}
function openServerSettings(win){
 if(!win||win.isDestroyed())return;
 win.loadFile(path.join(__dirname,'server-settings.html')).catch(()=>{});
}
function retryServer(win){
 if(!win||win.isDestroyed())return;
 win.loadURL(appUrl()).catch(()=>{
  if(!win.isDestroyed())win.loadFile(path.join(__dirname,'offline.html')).catch(()=>{});
 });
}
function isSettingsPage(url){
 return url===pathToFileURL(path.join(__dirname,'server-settings.html')).href;
}
function isOfflinePage(url){
 return url===pathToFileURL(path.join(__dirname,'offline.html')).href;
}
function isLocalRecoveryPage(url){
 return isSettingsPage(url)||isOfflinePage(url);
}
function installServerSettingsIpc(){
 ipcMain.handle('mpol:current-server',event=>{
  if(!isSettingsPage(event.senderFrame?.url||''))throw Error('Unauthorized server settings');
  return {current:activeServerOrigin,defaultOrigin:SERVER_ORIGIN};
 });
 ipcMain.handle('mpol:retry-server',event=>{
  if(!isLocalRecoveryPage(event.senderFrame?.url||''))throw Error('Unauthorized server retry');
  retryServer(BrowserWindow.fromWebContents(event.sender));
  return {ok:true};
 });
 ipcMain.handle('mpol:open-settings',event=>{
  if(!isOfflinePage(event.senderFrame?.url||''))throw Error('Unauthorized settings navigation');
  openServerSettings(BrowserWindow.fromWebContents(event.sender));
  return {ok:true};
 });
 ipcMain.handle('mpol:select-server',async(event,raw)=>{
  if(!isSettingsPage(event.senderFrame?.url||''))throw Error('Unauthorized server change');
  const win=BrowserWindow.fromWebContents(event.sender);
  if(!win||win.isDestroyed())return {ok:false,error:'Окно приложения закрыто'};
  const origin=normalizeServerOrigin(raw);
  if(!origin)return {ok:false,error:'Укажите HTTPS-адрес вида https://имя.домен без пути и параметров'};
  if(origin!==SERVER_ORIGIN){
   try{
    const response=await net.fetch(origin+'/api/health',{headers:{'Accept':'application/json'},
      signal:AbortSignal.timeout(12000)});
    if(!response.ok)return {ok:false,error:'Сервер не отвечает: HTTP '+response.status};
    const health=await response.json();
    if(health?.ok!==true||health?.service!=='mpol-messenger')
     return {ok:false,error:'Это не подтверждённый сервер MPOL. Обновите его код до версии 3.1'};
   }catch(e){return {ok:false,error:'Не удалось подключиться по HTTPS: '+(e.message||e)}}
   const confirmation=await dialog.showMessageBox(win,{
    title:'Подключение к другому серверу MPOL',type:'warning',
    message:'Подключить MPOL к '+origin+'?',
    detail:'Для смены сервера потребуется снова войти. Пароль и сообщения поступят на этот сервер. Выбирайте только собственный адрес MPOL, подключённый к существующей базе данных.',
    buttons:['Подключить','Отмена'],defaultId:1,cancelId:1,noLink:true
   });
   if(confirmation.response!==0)return {ok:false,error:'Изменение отменено'};
  }
  saveServerOrigin(origin);activeServerOrigin=origin;retryServer(win);
  return {ok:true};
 });
}
const WINDOW_PARTITION = 'persist:mpol-desktop-v23';
let mainWindow;

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function readWindowState() {
  try {
    const v = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if ([v.width,v.height].every(Number.isFinite) &&
        v.width >= 850 && v.width <= 5000 && v.height >= 560 && v.height <= 4000) {
      return { width:v.width, height:v.height, maximized:!!v.maximized };
    }
  } catch {}
  return { width:1270, height:830, maximized:false };
}
function storeWindowState(win) {
  if (win.isDestroyed()) return;
  const bounds = win.isNormal() ? win.getBounds() : win.getNormalBounds();
  const value = { width:bounds.width, height:bounds.height, maximized:win.isMaximized() };
  try { fs.mkdirSync(path.dirname(statePath()), { recursive:true });
    fs.writeFileSync(statePath(), JSON.stringify(value), { mode:0o600 }); } catch {}
}
function iconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'mpol.ico');
  return path.resolve(__dirname, '..', 'MpolMessenger.ico');
}
async function showPermissionPrompt(title, message) {
  const result = await dialog.showMessageBox(mainWindow, {
    type:'question', title, message, noLink:true,
    detail:'Доступ разрешён только для выбранного HTTPS-сервера MPOL и будет сохранён. Его можно сбросить в настройках приложения.',
    buttons:['Разрешить','Запретить'], defaultId:1, cancelId:1
  });
  return result.response === 0;
}
const permissionFile=()=>path.join(app.getPath('userData'),'media-permissions.json');
const rememberedPermissions=loadPermissionGrants(permissionFile());
function storePermissionKinds(kinds){
 grantPermissions(rememberedPermissions,activeServerOrigin,kinds);
 savePermissionGrants(permissionFile(),rememberedPermissions);
}
function setupPermissions(ses) {
  const isGranted=kind=>hasPermission(rememberedPermissions,activeServerOrigin,kind);
  ipcMain.handle('mpol:reset-media-permissions',event=>{
    if(!isTrustedUrl(event.senderFrame?.url||''))throw Error('Unauthorized permission reset');
    revokeMediaPermissions(rememberedPermissions,activeServerOrigin);
    savePermissionGrants(permissionFile(),rememberedPermissions);
    return {ok:true};
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    const verified = isTrustedUrl(details?.requestingUrl || origin);
    if (!verified) return false;
    if (permission === 'notifications') return isGranted('notifications');
    // Copying user-selected text is allowed only on our verified HTTPS origin.
    if (permission === 'clipboard-sanitized-write'||permission === 'clipboard-write') return true;
    if (permission === 'media') {
      const types=normalizeMediaTypes(details?.mediaTypes);
      if(!types.length&&['audio','video'].includes(details?.mediaType))types.push(details.mediaType);
      return types.length>0 && types.every(isGranted);
    }
    // The separate screen/window picker below still requires explicit consent.
    if (permission === 'display-capture') return true;
    return false;
  });
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isTrustedUrl(details?.requestingUrl || webContents.getURL())) {
      callback(false); return;
    }
    if (permission === 'clipboard-sanitized-write'||permission === 'clipboard-write') {
      callback(true); return;
    }
    if (permission === 'notifications') {
      if (isGranted('notifications')) {callback(true);return;}
      showPermissionPrompt('Уведомления MPOL',
        'Разрешить уведомления о новых сообщениях и звонках в Windows?')
        .then(yes => {if(yes)storePermissionKinds(['notifications']);callback(yes);})
        .catch(() => callback(false));
      return;
    }
    if (permission === 'media') {
      const types = normalizeMediaTypes(details?.mediaTypes);
      if (!types.length) {callback(false);return;}
      if (types.every(isGranted)) {callback(true);return;}
      const label = types.includes('video') ?
        (types.includes('audio') ? 'камере и микрофону' : 'камере') : 'микрофону';
      showPermissionPrompt('Доступ к устройствам MPOL',
        'Разрешить MPOL Messenger доступ к ' + label + '?\nИспользуется только при звонке или записи.')
        .then(yes => {
          if(yes)storePermissionKinds(types);
          callback(yes);
        }).catch(() => callback(false));
      return;
    }
    if (permission === 'display-capture') {
      // A separate picker requires the user to choose the exact screen/window.
      callback(true);
      return;
    }
    callback(false);
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isTrustedUrl(request.securityOrigin) || !request.videoRequested || !request.userGesture) {
      callback(null); return;
    }
    try {
      const sources = (await desktopCapturer.getSources({
        types:['screen','window'], thumbnailSize:{width:0,height:0},
        fetchWindowIcons:false
      })).slice(0,12);
      if (!sources.length) {callback(null);return;}
      const labels = sources.map((src,i) => (i+1)+'. '+src.name.slice(0,48));
      const result = await dialog.showMessageBox(mainWindow, {
        type:'question',title:'MPOL — демонстрация экрана',
        message:'Выберите экран или окно для показа собеседнику.',
        detail:'Видео вашего экрана будет передаваться во время звонка. Показ можно остановить в любой момент.',
        buttons:[...labels,'Отмена'],defaultId:labels.length,cancelId:labels.length,
        noLink:true
      });
      callback(result.response < sources.length ?
        {video:sources[result.response]} : null);
    } catch {callback(null);}
  });
  ses.on('will-download',(event,item,wc) => {
    if (!wc || !isTrustedUrl(wc.getURL())) {event.preventDefault();return;}
    item.setSaveDialogOptions({
      title:'Сохранить файл из MPOL Messenger',
      defaultPath:path.join(app.getPath('downloads'),safeFilename(item.getFilename()))
    });
  });
}
function navigateExternal(url) {
  if (canOpenExternal(url)) shell.openExternal(url).catch(()=>{});
}
function createWindow() {
  const initial = readWindowState();
  const ses = session.fromPartition(WINDOW_PARTITION);
  setupPermissions(ses);
  const win = new BrowserWindow({
    title:'Mpol Messenger',width:initial.width,height:initial.height,
    minWidth:850,minHeight:560,show:false,
    backgroundColor:'#0b0b0d',autoHideMenuBar:true,
    icon:iconPath(),
    webPreferences:{
      preload:path.join(__dirname,'preload.cjs'),
      partition:WINDOW_PARTITION,
      nodeIntegration:false,contextIsolation:true,sandbox:true,
      webSecurity:true,allowRunningInsecureContent:false,
      spellcheck:true
    }
  });
  mainWindow=win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show',()=>{win.show();if(initial.maximized)win.maximize();});
  // Also show a window when the free hosting provider needs extra startup time.
  win.webContents.once('dom-ready',()=>{if(!win.isVisible())win.show();});
  win.on('close',()=>storeWindowState(win));
  win.webContents.setWindowOpenHandler(({url})=>{
    navigateExternal(url);
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url)=>{
    if(url==='mpol://settings'){
      event.preventDefault();openServerSettings(win);return;
    }
    if(url==='mpol://retry'){
      event.preventDefault();retryServer(win);return;
    }
    if(!isTrustedUrl(url)){
      event.preventDefault();navigateExternal(url);
    }
  });
  win.webContents.on('will-redirect',(event,url)=>{
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  // Without the native menu, Chromium's text selection has no right-click
  // copy/paste controls inside a frameless app. Expose standard OS roles only.
  win.webContents.on('context-menu',(_event,params)=>{
    if(!isTrustedUrl(win.webContents.getURL()))return;
    const options=[];
    const editable=!!params.isEditable;
    const selected=!!params.selectionText?.length;
    if(selected)options.push({label:'Копировать',role:'copy'});
    if(editable){
      if(options.length)options.push({type:'separator'});
      options.push({label:'Вырезать',role:'cut',enabled:selected});
      options.push({label:'Вставить',role:'paste'});
      options.push({label:'Выделить всё',role:'selectAll'});
    }
    if(!options.length)return;
    Menu.buildFromTemplate(options).popup({window:win});
  });
  win.webContents.on('before-input-event',(e,input)=>{
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if(input.control&&input.shift&&input.key.toLowerCase()==='s'){
      e.preventDefault();openServerSettings(win);
    }else if (input.key === 'F11') {
      e.preventDefault();win.setFullScreen(!win.isFullScreen());
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      e.preventDefault();win.setFullScreen(false);
    } else if (input.control && input.key.toLowerCase() === 'r') {
      e.preventDefault();retryServer(win);
    } else if (input.key === 'F12' || (input.control&&input.shift&&input.key.toLowerCase()==='i')) {
      e.preventDefault();
    }
  });
  win.webContents.on('did-fail-load',(_event,code,_desc,url,isMainFrame)=>{
    if (isMainFrame && code!==-3 && isTrustedUrl(url)) {
      win.loadFile(path.join(__dirname,'offline.html')).catch(()=>{});
    }
  });
  win.webContents.once('did-finish-load',()=>{
    // Check releases silently; prompt only if a newer verified desktop EXE exists.
    if (isTrustedUrl(win.webContents.getURL())) {
      offerDesktopUpdate(win,APP_VERSION).catch(()=>{});
    }
  });
  retryServer(win);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance',()=>{
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(()=>{
    if (process.platform === 'win32') app.setAppUserModelId('com.mpol.messenger.desktop');
    Menu.setApplicationMenu(null);
    activeServerOrigin=readServerOrigin();
    installServerSettingsIpc();
    createWindow();
    app.on('activate',()=>{
      if (BrowserWindow.getAllWindows().length===0) createWindow();
    });
  }).catch(error=>{
    dialog.showErrorBox('MPOL Messenger',String(error));
    app.quit();
  });
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
}
