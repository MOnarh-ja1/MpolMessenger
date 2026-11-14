'use strict';
const {contextBridge,ipcRenderer}=require('electron');
// Only the app's own local settings screen may access this narrowly scoped IPC.
// No Node APIs or local files are exposed to remote MPOL web content.
if(location.protocol==='file:' && decodeURIComponent(location.pathname).endsWith('/server-settings.html')){
 contextBridge.exposeInMainWorld('mpolServerSettings',{
  current:()=>ipcRenderer.invoke('mpol:current-server'),
  select:url=>ipcRenderer.invoke('mpol:select-server',String(url)),
  retry:()=>ipcRenderer.invoke('mpol:retry-server')
 });
}
