"use strict";
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');

const script=fs.readFileSync('client/ui/app.js','utf8');
function memory(){
 const data=new Map();
 return {getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,String(v)),
  removeItem:k=>data.delete(k)};
}
const sharedLocal=memory();
function createWindow(){
 const list={children:[],scrollHeight:200,scrollTop:0,
  replaceChildren(){this.children=[]},append(el){this.children.push(el)}};
 const document={
  getElementById:id=>id==='messages'?list:{},
  createElement:tag=>({tagName:tag,dataset:{},innerHTML:'',textContent:'',className:'',
    setAttribute(){},querySelectorAll(){return[]},querySelector(){return null},
    addEventListener(){}})
 };
 const ctx=vm.createContext({localStorage:sharedLocal,sessionStorage:memory(),document,
  timestr:()=> '12:00',Date,console,
  messageAction(){},setReaction(){},playVoiceAttachment(){},previewOrDownload(){},
  downloadFile(){}});
 // Load actual production authentication storage and message renderer functions.
 vm.runInContext(script.slice(0,script.indexOf('function toast(')),ctx);
 vm.runInContext(script.slice(script.indexOf('function renderMessages()'),
   script.indexOf('async function downloadFile(')),ctx);
 return {ctx,list};
}
const a=createWindow(),b=createWindow();
vm.runInContext('storage.token="alice-token"',a.ctx);
vm.runInContext('storage.token="bob-token"',b.ctx);
assert.equal(vm.runInContext('storage.token',a.ctx),'alice-token');
assert.equal(vm.runInContext('storage.token',b.ctx),'bob-token');
assert.equal(sharedLocal.getItem('mpol_token'),null,
 'Login tokens must not be stored in shared browser localStorage');
const messages=[
 {id:'ma',chat_id:'test-dm',user_id:'MPALICE',nick:'Alice',avatar:'A',body:'От Алисы',sent_at:'2026-11-14T12:00:00Z'},
 {id:'mb',chat_id:'test-dm',user_id:'MPBOB',nick:'Bob',avatar:'B',body:'От Боба',sent_at:'2026-11-14T12:01:00Z'}
];
function check(who,other,win){
 win.ctx.inputs={me:{id:who,nick:who},messages,active:{id:'test-dm',is_group:false}};
 vm.runInContext('state.me=inputs.me; state.messages=inputs.messages;state.active=inputs.active;renderMessages()',win.ctx);
 const rows=win.list.children.filter(x=>x.className?.includes('msg-row'));
 assert.equal(rows.length,2);
 const own=rows.find(r=>r.dataset.authorId===who);
 const incoming=rows.find(r=>r.dataset.authorId===other);
 assert.ok(own.className.includes('mine'),who+' own message must render on the right');
 assert.ok(!incoming.className.includes('mine'),who+' incoming message must render on the left');
 assert.ok(incoming.className.includes('theirs'));
 assert.ok(own.innerHTML.includes('data-action="delete"'),who+' can delete own messages');
 assert.ok(!incoming.innerHTML.includes('data-action="delete"'),who+' cannot delete other account messages');
 assert.ok(incoming.innerHTML.includes(other==='MPBOB'?'Bob':'Alice'),
  'Show incoming sender identity in the bubble');
}
check('MPALICE','MPBOB',a);
check('MPBOB','MPALICE',b);
console.log('PASS: two windows have independent tokens; own messages on right + delete; incoming on left without delete');
