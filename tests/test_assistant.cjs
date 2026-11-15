'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {parse,key,matchContacts}=require('../client/ui/assistant-core.js');
const {startNativeRecognition,startOfflineRecognition}=require('../desktop/lib/speech.cjs');
const html=fs.readFileSync('client/ui/index.html','utf8');
const css=fs.readFileSync('client/ui/style.css','utf8');
const script=fs.readFileSync('client/ui/assistant.js','utf8');
const app=fs.readFileSync('client/ui/app.js','utf8');
const server=fs.readFileSync('server/app.py','utf8');
const cases=[
 ['Открой чат с пользователем Nows','open_chat','Nows'],
 ['Открой чат с Ноус','open_chat','Ноус'],
 ['Позвони Nows','call','Nows'],
 ['Видеозвонок с Nows','video_call','Nows'],
 ['Создай группу с Nows','group','Nows'],
 ['Открой профиль Nows','profile','Nows'],
 ['Найди пользователя Nows','find','Nows']
];
for(const [speech,kind,target] of cases){
 const result=parse(speech);
 assert.equal(result.kind,kind,speech);
 assert.equal(result.target,target,speech);
}
assert.equal(parse('Открой друзья').kind,'tab');
assert.equal(parse('Создай сервер').kind,'future');
assert.equal(parse('Позвони').kind,'missing');
assert.equal(parse('Удали все аккаунты').kind,'unknown');
assert.equal(key('Ноус'),key('Nows'));
assert.equal(matchContacts('Ноус',[{id:'MPA',nick:'Nows'}])[0].id,'MPA');
for(const id of ['assistantToggle','assistantPanel','assistantListen','assistantStatus'])
 assert.match(html,new RegExp('id="'+id+'"'));
for(const id of ['assistantCommandForm','assistantCommand','assistantHeard','assistantBrowserSpeech','assistantChoices','assistantClose'])
 assert.doesNotMatch(html,new RegExp('id="'+id+'"'),id+' should be removed');
assert.doesNotMatch(html,/Примеры:|Открой чат с Nows/, 'No hints or text fields under the orb');
assert.match(css,/button\.mpol-assistant-orb/);
assert.match(app,/window\.mpolAssistantApp/);
assert.match(server,/@app\.get\('\/api\/users\/search'\)/);

class FakeElement{
 constructor(id){this.id=id;this.attributes={};this.dataset={};this.classSet=new Set(['hidden']);
  this.classList={
   add:c=>this.classSet.add(c),
   remove:c=>this.classSet.delete(c),
   toggle:(c,on)=>{const next=on===undefined?!this.classSet.has(c):!!on;
    if(next)this.classSet.add(c);else this.classSet.delete(c);return next;},
   contains:c=>this.classSet.has(c)
  };
 }
 setAttribute(k,v){this.attributes[k]=String(v)}
 getAttribute(k){return this.attributes[k]}
 addEventListener(){}
 focus(){}
}
function simulatedBrowser({native=false,transcript='Открой чат с Ноус'}={}){
 const ids=['assistantToggle','assistantPanel','assistantListen','assistantStatus'];
 const elements=new Map(ids.map(id=>[id,new FakeElement(id)]));
 const status=[],calls=[];
 let activeRecognizer=null;
 class FakeRecognition{
  constructor(){activeRecognizer=this}
  start(){calls.push('speech-start')}
  stop(){calls.push('speech-stop')}
  abort(){calls.push('speech-abort')}
 }
 const friend={id:'MPA',nick:'Nows',friend:true};
 const api={
  isReady:()=>true,
  contacts:()=>[friend],
  searchUsers:async()=>[friend],
  isFriend:id=>id==='MPA',
  openChat:async user=>calls.push('chat:'+user.id),
  showTab:()=>{},showProfile:()=>{},sendFriendRequest:async()=>{},
  createGroupWith:()=>{},
  startCall:async()=>{}
 };
 const window={
  MpolAssistantCore:{parse,key,matchContacts},
  mpolAssistantApp:api,
  SpeechRecognition:FakeRecognition,
  confirm:()=>true,
  addEventListener(){}
 };
 if(native)window.mpolNativeSpeech={
  recognize:async()=>({ok:true,text:transcript}),cancel:async()=>{}
 };
 const document={
  getElementById:id=>elements.get(id),
  addEventListener(){}
 };
 const ctx=vm.createContext({window,document,toast:s=>status.push(s),
  setTimeout:()=>1,clearTimeout:()=>{},console});
 vm.runInContext(script,ctx);
 return {elements,status,calls,getRecognizer:()=>activeRecognizer,window};
}
async function checkUI(){
 const browser=simulatedBrowser();
 const open=browser.elements.get('assistantToggle'),orb=browser.elements.get('assistantListen');
 open.onclick();
 assert.equal(open.getAttribute('aria-expanded'),'true');
 assert.equal(browser.elements.get('assistantPanel').classList.contains('hidden'),false);
 orb.onclick();
 assert.ok(browser.calls.includes('speech-start'),'HTML browser must start recognition immediately on click');
 assert.equal(orb.getAttribute('aria-pressed'),'true');
 browser.getRecognizer().onresult({results:[[{transcript:'Открой чат с Ноус'}]]});
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.ok(browser.calls.includes('chat:MPA'),'Voice transcript should really open DM, not just display text');
 assert.equal(browser.elements.get('assistantPanel').classList.contains('hidden'),true);
 const second=simulatedBrowser();
 second.elements.get('assistantToggle').onclick();
 second.elements.get('assistantListen').onclick();
 second.elements.get('assistantListen').onclick();
 assert.ok(second.calls.includes('speech-abort'),'Clicking circle again must stop microphone');
 assert.equal(second.elements.get('assistantListen').getAttribute('aria-pressed'),'false');
 const exe=simulatedBrowser({native:true});
 exe.elements.get('assistantToggle').onclick();
 exe.elements.get('assistantListen').onclick();
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.ok(exe.calls.includes('chat:MPA'),'Desktop native speech must reach the same real action');
}
async function checkWorker(){
 const fake=()=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{};
  setImmediate(()=>{c.stdout.emit('data',Buffer.from('{"ok":true,"text":"Открой чат с Ноус"}\n'));c.emit('close',0)});
  return c;
 };
 const legacy=startNativeRecognition({platform:'win32',spawnProcess:(cmd,args)=>{
  assert.equal(cmd,'powershell.exe');assert.ok(args.includes('-EncodedCommand'));return fake();
 }});
 assert.equal((await legacy.promise).ok,true);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mpol-voice-'));
 try{
  const bin=path.join(tmp,'worker.exe'),model=path.join(tmp,'model');
  fs.writeFileSync(bin,'fake executable');fs.mkdirSync(model);
  const worker=startOfflineRecognition({platform:'win32',workerPath:bin,modelPath:model,
   spawnProcess:(cmd,args)=>{assert.equal(cmd,bin);assert.ok(args.includes('--model'));return fake()}});
  const result=await worker.promise;
  assert.equal(result.ok,true);
  assert.equal(result.text,'Открой чат с Ноус');
  const missing=startOfflineRecognition({platform:'win32',workerPath:path.join(tmp,'missing'),modelPath:model});
  assert.equal((await missing.promise).code,'missing-model');
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
}
Promise.all([checkUI(),checkWorker()]).then(()=>{
 console.log('PASS: single circular button, browser/native recognition, stop and real DM action');
}).catch(e=>{console.error(e);process.exitCode=1});
