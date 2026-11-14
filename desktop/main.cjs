'use strict';
const { app, BrowserWindow, Menu, dialog, session, shell, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SERVER_ORIGIN, isMpolUrl, canOpenExternal,
  safeFilename, normalizeMediaTypes } = require('./lib/security.cjs');

const APP_VERSION = '3.0.0';
const { offerDesktopUpdate } = require('./lib/updater.cjs');
const APP_URL = SERVER_ORIGIN + '/?mpol_client=' + APP_VERSION;
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
    detail:'Разрешение действует только внутри MPOL Messenger. Его можно сбросить после перезапуска приложения.',
    buttons:['Разрешить','Запретить'], defaultId:1, cancelId:1
  });
  return result.response === 0;
}
function setupPermissions(ses) {
  const mediaGrants = new Set();
  let notificationsGranted = false;
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    const verified = isMpolUrl(details?.requestingUrl || origin);
    if (!verified) return false;
    if (permission === 'notifications') return notificationsGranted;
    // Copying user-selected text is allowed only on our verified HTTPS origin.
    if (permission === 'clipboard-sanitized-write'||permission === 'clipboard-write') return true;
    if (permission === 'media') {
      const type = details?.mediaType;
      return (type === 'audio' || type === 'video') && mediaGrants.has(type);
    }
    // The separate screen/window picker below still requires explicit consent.
    if (permission === 'display-capture') return true;
    return false;
  });
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isMpolUrl(details?.requestingUrl || webContents.getURL())) {
      callback(false); return;
    }
    if (permission === 'clipboard-sanitized-write'||permission === 'clipboard-write') {
      callback(true); return;
    }
    if (permission === 'notifications') {
      if (notificationsGranted) {callback(true);return;}
      showPermissionPrompt('Уведомления MPOL',
        'Разрешить уведомления о новых сообщениях и звонках в Windows?')
        .then(yes => {notificationsGranted = yes; callback(yes);})
        .catch(() => callback(false));
      return;
    }
    if (permission === 'media') {
      const types = normalizeMediaTypes(details?.mediaTypes);
      if (!types.length) {callback(false);return;}
      if (types.every(t => mediaGrants.has(t))) {callback(true);return;}
      const label = types.includes('video') ?
        (types.includes('audio') ? 'камере и микрофону' : 'камере') : 'микрофону';
      showPermissionPrompt('Доступ к устройствам MPOL',
        'Разрешить MPOL Messenger доступ к ' + label + '?\nИспользуется только при звонке или записи.')
        .then(yes => {
          if (yes) types.forEach(t => mediaGrants.add(t));
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
    if (!isMpolUrl(request.securityOrigin) || !request.videoRequested || !request.userGesture) {
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
    if (!wc || !isMpolUrl(wc.getURL())) {event.preventDefault();return;}
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
    if (!isMpolUrl(url)) {
      event.preventDefault();
      navigateExternal(url);
    }
  });
  win.webContents.on('will-redirect',(event,url)=>{
    if (!isMpolUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  // Without the native menu, Chromium's text selection has no right-click
  // copy/paste controls inside a frameless app. Expose standard OS roles only.
  win.webContents.on('context-menu',(_event,params)=>{
    if(!isMpolUrl(win.webContents.getURL()))return;
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
    if (input.key === 'F11') {
      e.preventDefault();win.setFullScreen(!win.isFullScreen());
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      e.preventDefault();win.setFullScreen(false);
    } else if (input.control && input.key.toLowerCase() === 'r') {
      e.preventDefault();win.loadURL(APP_URL);
    } else if (input.key === 'F12' || (input.control&&input.shift&&input.key.toLowerCase()==='i')) {
      e.preventDefault();
    }
  });
  win.webContents.on('did-fail-load',(_event,code,_desc,url,isMainFrame)=>{
    if (isMainFrame && code!==-3 && isMpolUrl(url)) {
      win.loadFile(path.join(__dirname,'offline.html')).catch(()=>{});
    }
  });
  win.webContents.once('did-finish-load',()=>{
    // Check releases silently; prompt only if a newer verified desktop EXE exists.
    if (win.webContents.getURL().startsWith(SERVER_ORIGIN+'/')) {
      offerDesktopUpdate(win,APP_VERSION).catch(()=>{});
    }
  });
  win.loadURL(APP_URL).catch(()=>{
    if (!win.isDestroyed()) win.loadFile(path.join(__dirname,'offline.html')).catch(()=>{});
  });
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
