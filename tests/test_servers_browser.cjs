'use strict';
/* Browser integration test for the real Servers navigation (no user account or
   real MPOL backend required). Fail on page errors instead of silent no-ops. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright-core');
const dir=path.resolve(__dirname,'../client/ui');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 const name=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
 const file=path.resolve(dir,name);
 if(!file.startsWith(dir+path.sep)){res.writeHead(403).end();return}
 fs.readFile(file,(err,buf)=>{
  if(err){res.writeHead(404).end('missing');return}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});
  res.end(buf);
 });
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  for(const channel of ['msedge','chrome']){
   try{browser=await chromium.launch({headless:true,channel,args:['--disable-gpu']});break}
   catch{}
  }
  assert.ok(browser,'Chrome or Edge must be available');
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let listingRequests=0,createRequests=0;
  await page.route('**/api/servers**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.pathname==='/api/servers'&&req.method()==='GET'){
    listingRequests++;return route.fulfill({status:200,contentType:'application/json',body:'[]'});
   }
   if(url.pathname==='/api/servers'&&req.method()==='POST'){
    createRequests++;return route.fulfill({status:200,contentType:'application/json',
     body:JSON.stringify({id:'server-test',name:'Игровая',icon:'◈',members_count:1,role:'owner'})});
   }
   if(url.pathname==='/api/servers/server-test'){
    return route.fulfill({status:200,contentType:'application/json',
     body:JSON.stringify({id:'server-test',name:'Игровая',icon:'◈',role:'owner',members_count:1,
      channels:[{id:'voice-1',name:'Игровая',kind:'voice',online:[]}],
      members:[{id:'U1',nick:'Тест',role:'owner'}]})});
   }
   return route.fulfill({status:404,contentType:'application/json',body:'{"detail":"Not found"}'});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});
  await page.evaluate(()=>{
   state.me={id:'U1',nick:'Тест',avatar:'◉'};
   document.getElementById('authScreen').classList.add('hidden');
   document.getElementById('mainScreen').classList.remove('hidden');
  });
  await page.locator('[data-tab="servers"]').click();
  await page.waitForTimeout(350);
  const view=await page.evaluate(()=>({
   tab:state.tab,hidden:document.getElementById('serverDashboard').classList.contains('hidden'),
   text:document.getElementById('serverDashboard').innerText,
   panel:typeof window.mpolServers,
   visible:getComputedStyle(document.getElementById('serverDashboard')).display
  }));
  assert.equal(view.tab,'servers',JSON.stringify({view,errors}));
  assert.ok(!view.hidden,'Servers dashboard must be unhidden '+JSON.stringify({view,errors}));
  assert.ok(listingRequests>0,'Opening servers must request /api/servers '+JSON.stringify({view,errors}));
  assert.ok(view.text.includes('Создать сервер'),'Empty server creation action not present '+JSON.stringify({view,errors}));
  await page.locator('#newMessage').click();
  assert.ok(await page.locator('#newServerName').isVisible(),'New server modal must open on the primary button');
  await page.locator('#newServerName').fill('Игровая');
  await page.locator('#newServerSave').click();
  await page.waitForTimeout(400);
  assert.equal(createRequests,1,'Server creation API must be called');
  assert.ok((await page.locator('#serverOverview').innerText()).includes('Игровая'),
   'New server details should render after creation');
  assert.deepEqual(errors,[],'Browser JS exceptions');
  console.log('PASS: desktop Servers navigation, listing, creation modal, real API calls and overview');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})().catch(err=>{console.error(err);process.exitCode=1});
