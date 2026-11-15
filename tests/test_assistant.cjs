'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {parse,key,matchContacts}=require('../client/ui/assistant-core.js');
const {startNativeRecognition}=require('../desktop/lib/speech.cjs');

const cases=[
 ['Открой чат с пользователем Nows','open_chat','Nows'],
 ['Открой чат с Ноус','open_chat','Ноус'],
 ['Позвони Nows','call','Nows'],
 ['Позвони пользователю Nows','call','Nows'],
 ['Видеозвонок с Nows','video_call','Nows'],
 ['Позвони по видео Nows','video_call','Nows'],
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
assert.equal(parse('Создай группу').kind,'group');
assert.equal(parse('Создай сервер').kind,'future');
assert.equal(parse('Удали все аккаунты').kind,'unknown',
 'Assistant must not accept administrative or arbitrary instructions');
assert.equal(parse('Позвони').kind,'missing');
assert.equal(key('Ноус'),key('Nows'),
 'Russian phonetic representation must match a romanized nickname');
const contacts=[
 {id:'MPA',nick:'Nows',friend:true},
 {id:'MPB',nick:'Nox',friend:true},
 {id:'MPC',nick:'Nowstone',friend:true}
];
assert.equal(matchContacts('Ноус',contacts)[0].id,'MPA');
assert.equal(matchContacts('MPB',contacts)[0].id,'MPB');
assert.equal(matchContacts('xzyqzz',contacts).length,0);

const html=fs.readFileSync('client/ui/index.html','utf8');
const js=fs.readFileSync('client/ui/assistant.js','utf8');
const app=fs.readFileSync('client/ui/app.js','utf8');
const server=fs.readFileSync('server/app.py','utf8');
assert.match(html,/id="assistantToggle"/);
assert.match(html,/id="assistantOrb"/);
assert.match(html,/id="assistantCommandForm"/);
assert.match(html,/assistant-core\.js/);
assert.match(html,/assistant\.js/);
assert.match(js,/mpolNativeSpeech/);
assert.match(js,/Подтвердить/);
assert.match(app,/window\.mpolAssistantApp/);
assert.match(app,/api\('\/dm\//);
assert.match(server,/@app\.get\('\/api\/users\/search'\)/);
assert.match(server,/user-search:/);

(async()=>{
 const fake=(command,args)=>{
  assert.equal(command,'powershell.exe');
  assert.ok(args.includes('-EncodedCommand'));
  const process=new EventEmitter();
  process.stdout=new EventEmitter();
  process.stderr=new EventEmitter();
  process.kill=()=>{};
  setImmediate(()=>{
   process.stdout.emit('data',Buffer.from('{"ok":true,"text":"Открой чат с Nows"}\n'));
   process.emit('close',0);
  });
  return process;
 };
 const native=startNativeRecognition({platform:'win32',spawnProcess:fake});
 const result=await native.promise;
 assert.equal(result.ok,true);
 assert.equal(result.text,'Открой чат с Nows');
 const unsupported=await startNativeRecognition({platform:'linux'}).promise;
 assert.equal(unsupported.code,'platform');
 console.log('PASS: Russian assistant actions, nickname resolution, UI wiring and native transcript adapter');
})().catch(err=>{console.error(err);process.exitCode=1});
