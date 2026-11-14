const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../client/ui/app.js'),'utf8').replace(/startup\(\);\s*$/, '');
function app(){
 const items=new Map(),elements=new Map(),listeners={};
 const noop=()=>{};
 const element=()=>({value:'',textContent:'',classList:{add:noop,remove:noop,toggle:noop},previousElementSibling:{classList:{toggle:noop}},firstChild:{},append:noop,replaceChildren:noop,focus:noop,setAttribute:noop,addEventListener:noop});
 class Socket {static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;Socket.all.push(this)}send(){}close(){this.readyState=3;this.onclose?.()}}Socket.all=[];
 const ctx=vm.createContext({console,URL,WebSocket:Socket,FormData:class{},localStorage:{getItem:k=>items.get(k)||null,setItem:(k,v)=>items.set(k,v),removeItem:k=>items.delete(k)},document:{getElementById:k=>{if(!elements.has(k))elements.set(k,element());return elements.get(k)},querySelectorAll:()=>[],addEventListener:noop,createElement:element},window:{addEventListener:(k,v)=>listeners[k]=v},location:{protocol:'https:',host:'example.test',hostname:'example.test'},setInterval:noop,setTimeout:()=>1,clearTimeout:noop,fetch:async()=>{throw Error('offline')}});
 vm.runInContext(source,ctx);
 vm.runInContext("toast=()=>{};renderList=()=>{};renderMessages=()=>{};updateHeader=()=>{};showMain=async()=>{};serverHealth=async()=>{}",ctx);
 return {ctx,items,elements,Socket,run:s=>vm.runInContext(s,ctx)};
}
const response=(status,data)=>({ok:status<400,status,json:async()=>data});
test('offline startup retains session and retries successfully',async()=>{
 const a=app();a.items.set('mpol_token','saved');await a.run('startup()');assert.equal(a.items.get('mpol_token'),'saved');assert.equal(a.run('state.me'),null);
 a.ctx.fetch=async()=>response(200,{id:'alice',nick:'Alice'});await a.run('startup()');assert.equal(a.run('state.me.id'),'alice');
});
test('401 clears invalid saved session',async()=>{const a=app();a.items.set('mpol_token','expired');a.ctx.fetch=async()=>response(401,{});await a.run('startup()');assert.equal(a.items.has('mpol_token'),false)});
test('stale 401 cannot sign out a newly logged in account',async()=>{const a=app();a.items.set('mpol_token','old');let finish;a.ctx.fetch=()=>new Promise(r=>finish=r);const pending=a.run("api('/me')").catch(()=>{});a.items.set('mpol_token','new');finish(response(401,{}));await pending;assert.equal(a.items.get('mpol_token'),'new')});
test('reconnect authentication refreshes active chat history',async()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};state.active={id:'chat'};refreshAll=async()=>{};refreshRequests=async()=>{}");a.ctx.fetch=async()=>response(200,[{id:'missed',body:'offline message'}]);a.run('wsConnect()');await a.Socket.all[0].onmessage({data:JSON.stringify({type:'authenticated'})});assert.equal(a.run('state.messages[0].id'),'missed')});
test('history response for previous chat cannot replace current chat',async()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};state.active={id:'old'}");let finish;a.ctx.fetch=()=>new Promise(r=>finish=r);const pending=a.run('loadMessages()');a.run("state.active={id:'new'};state.messages=[{id:'new-message'}]");finish(response(200,[{id:'old-message'}]));await pending;assert.equal(a.run('state.messages[0].id'),'new-message')});
test('late history cannot restore data after logout',async()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};state.active={id:'chat'}");let finish;a.ctx.fetch=()=>new Promise(r=>finish=r);const pending=a.run('loadMessages()');await a.run('signout(false)');finish(response(200,[{id:'private'}]));await pending;assert.equal(a.run('state.messages.length'),0)});
test('friend request event refreshes requests without loading chats',async()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};refreshAll=async()=>{throw Error('unrelated API failed')}");a.ctx.fetch=async()=>response(200,[{request_id:1,user:{nick:'Bob'}}]);a.run('wsConnect()');await a.Socket.all[0].onmessage({data:JSON.stringify({type:'friend_request'})});assert.equal(a.run('state.requests.length'),1)});
test('repeated connect attempts share one connecting socket',()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};wsConnect();wsConnect()");assert.equal(a.Socket.all.length,1)});
test('a live message during snapshot fetch is not lost',async()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};state.active={id:'chat'}");let finish,calls=0;a.ctx.fetch=()=>++calls===1?new Promise(r=>finish=r):Promise.resolve(response(200,[{id:'new'}]));const pending=a.run('loadMessages()');a.run('messageRevision++');finish(response(200,[]));await pending;assert.equal(a.run('state.messages[0].id'),'new')});
test('old search response does not overwrite latest search',async()=>{const a=app();a.items.set('mpol_token','token');a.run("state.me={id:'alice'};state.active={id:'chat'}");let finish,calls=0;a.ctx.fetch=()=>++calls===1?new Promise(r=>finish=r):Promise.resolve(response(200,[{id:'latest'}]));const pending=a.run('loadMessages()');await a.run('loadMessages()');finish(response(200,[{id:'old'}]));await pending;assert.equal(a.run('state.messages[0].id'),'latest')});
