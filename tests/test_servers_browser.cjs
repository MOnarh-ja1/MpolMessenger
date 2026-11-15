'use strict';
// Full interactive Servers journey in headless Edge/Chrome, without real accounts.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'../client/ui');
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css',
 '.webp':'image/webp','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 const name=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
 const target=path.resolve(root,name);
 if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
 fs.readFile(target,(err,bytes)=>{
  if(err){res.writeHead(404);res.end('not found');return}
  res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream'});
  res.end(bytes);
 });
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  for(const channel of ['msedge','chrome']){
   try{browser=await chromium.launch({headless:true,channel,args:['--disable-gpu','--no-first-run']});break}
   catch(e){console.log(channel+' unavailable: '+e.message.slice(0,120))}
  }
  if(!browser)throw Error('Chrome or Edge required');
  const page=await browser.newPage({viewport:{width:1100,height:760}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?mpol_client=3.8.1');
  await page.evaluate(()=>{
   state.me={id:'MPOLTEST',nick:'Test Owner',avatar:'◈',is_developer:false};
   state.friends=[];state.chats=[];
   document.getElementById('authScreen').classList.add('hidden');
   document.getElementById('mainScreen').classList.remove('hidden');
   const bridge=window.mpolServerApp;const oldApi=bridge.api;
   const fixtures={servers:[]};
   window.__serverBrowserTest={fixtures,oldApi};
   bridge.api=async (url,opt={})=>{
    if(url==='/servers'&&!opt.method)return fixtures.servers;
    if(url==='/servers'&&opt.method==='POST'){
     const created={id:'server-demo',name:opt.body.name,description:opt.body.description,
      icon:opt.body.icon,owner_id:'MPOLTEST',members_count:1,role:'owner'};
     fixtures.servers.push(created);return created;
    }
    if(url==='/servers/server-demo'){
     const s=fixtures.servers[0];
     return {...s,channels:[
      {id:'text-demo',name:'общий',kind:'text',chat_id:'demo-chat',online:[]},
      {id:'voice-demo',name:'Игровая',kind:'voice',chat_id:null,online:[]}],
      members:[{id:'MPOLTEST',nick:'Test Owner',role:'owner',online:true}]};
    }
    throw Error('Unexpected test endpoint '+url);
   };
  });
  await page.click('.rail-btn[data-tab="servers"]');
  await page.waitForSelector('#serverStartCreate',{state:'visible'});
  assert.equal(await page.locator('#serverDashboard').isVisible(),true);
  await page.click('#serverStartCreate');
  await page.fill('#newServerName','Игровая команда');
  await page.fill('#newServerDesc','Играем и общаемся');
  await page.click('#newServerSave');
  await page.waitForFunction(()=>document.querySelector('.server-heading h2')?.textContent==='Игровая команда');
  assert.equal(await page.locator('[data-room="voice-demo"]').isVisible(),true);
  assert.equal(await page.locator('[data-text="text-demo"]').isVisible(),true);
  assert.equal(await page.locator('#serverSettings').isVisible(),true);
  console.log('PASS: click Servers > create server > real dashboard with text/voice rooms');

  await page.setViewportSize({width:390,height:740});
  await page.evaluate(()=>renderTab('chats'));
  await page.click('.rail-btn[data-tab="servers"]');
  await page.waitForSelector('#serverQuickCreate',{state:'visible'});
  const box=await page.locator('#serverDashboard').boundingBox();
  assert.ok(box&&box.width>250&&box.height>200,'Server content hidden by mobile view: '+JSON.stringify(box));
  assert.equal(await page.locator('.rail-btn[data-tab="servers"]').isVisible(),true,
   'Keep tabs reachable in small EXE windows');
  await page.click('#serverQuickCreate');
  assert.equal(await page.locator('#newServerSave').isVisible(),true);
  await page.click('#closeModal');
  console.log('PASS: servers remain visible in narrow Windows/high-DPI layout');

  await page.evaluate(()=>{
   window.__serverBrowserTest.api=window.mpolServerApp.api;
   window.mpolServerApp.api=async()=>{throw Error('HTTP 404 Not Found')};
   renderTab('servers');
  });
  await page.waitForSelector('.server-error #serverRetry',{state:'visible'});
  const message=await page.locator('.server-error').innerText();
  assert.match(message,/На выбранном сервере MPOL нет поддержки/);
  await page.evaluate(()=>{window.mpolServerApp.api=window.__serverBrowserTest.api});
  await page.click('#serverRetry');
  await page.waitForSelector('#serverQuickCreate',{state:'visible'});
  await page.click('.rail-btn[data-tab="chats"]');
  const switched=await page.evaluate(()=>!document.getElementById('mainScreen').classList.contains('server-pane-open'));
  assert.ok(switched,'Servers layout must reset when clicking chats');
  assert.deepEqual(errors,[],'Uncaught JavaScript errors: '+errors.join('; '));
  console.log('PASS: visible errors, retry and restoring chat navigation');
 }finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
