"use strict";
// Regression: actual MPOL HTML/JS should keep browser login across closing
// Safari-style tabs, avoid persisting desktop window logins, and never forget
// a valid stored token just because the API is temporarily unavailable.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright-core');
const dir=path.resolve(__dirname,'../client/ui');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css',
  '.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'};
const account={id:'MPDEMO123',nick:'Демо',avatar:'◉',description:'',email:null,
 email_verified:false,is_developer:false};
const token='local-test-token-not-a-real-account';
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 function json(status,obj){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(obj));
 }
 if(url.pathname==='/api/health')return json(200,{ok:true,durable_database:true});
 if(url.pathname==='/api/auth/login'||url.pathname==='/api/auth/register'){
  return json(200,{token,user:account});
 }
 if(url.pathname==='/api/me'){
  if(req.headers.authorization!=='Bearer '+token)return json(401,{detail:'Сессия недействительна'});
  return json(200,account);
 }
 if(url.pathname==='/api/chats'||url.pathname==='/api/friends'||url.pathname==='/api/friends/requests'){
  return json(200,[]);
 }
 if(url.pathname==='/api/auth/logout')return json(200,{ok:true});
 if(url.pathname.startsWith('/api/'))return json(404,{detail:'Not found'});
 const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
 const target=path.resolve(dir,name);
 if(!target.startsWith(dir+path.sep)){res.writeHead(403);res.end();return}
 fs.readFile(target,(err,data)=>{
  if(err){res.writeHead(404);res.end('not found');return}
  res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream'});
  res.end(data);
 });
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  for(const channel of ['msedge','chrome']){
   try{browser=await chromium.launch({headless:true,channel,args:['--disable-gpu','--no-first-run']});break}
   catch(err){console.log(channel+' not available: '+err.message.slice(0,120))}
  }
  if(!browser)throw Error('No Edge or Chrome available');
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto(origin+'/');
  await page.locator('#login').fill('demo');
  await page.locator('#password').fill('test-password-123');
  assert.equal(await page.locator('#rememberLogin').isChecked(),true);
  await page.locator('#authSubmit').click();
  await page.locator('#mainScreen').waitFor({state:'visible',timeout:15000});
  const saved=await page.evaluate(()=>({
   permanent:localStorage.getItem('mpol_token'),
   temporary:sessionStorage.getItem('mpol_token')
  }));
  assert.equal(saved.permanent,token,'Browser token must survive closing tabs');
  assert.equal(saved.temporary,null,'Browser token should not be saved in both places');
  await page.close();
  const reopened=await context.newPage();
  await reopened.goto(origin+'/');
  await reopened.locator('#mainScreen').waitFor({state:'visible',timeout:15000});
  assert.equal(await reopened.locator('#authScreen').isVisible(),false);
  console.log('PASS: iPhone/HTML saved login survives tab closure and opens the account automatically');

  // A temporarily unavailable server is not evidence that login expired.
  await reopened.route('**/api/me',route=>route.abort('failed'));
  await reopened.reload();
  await reopened.locator('#sessionRestore').waitFor({state:'visible',timeout:15000});
  assert.equal(await reopened.evaluate(()=>localStorage.getItem('mpol_token')),token);
  await reopened.unroute('**/api/me');
  await reopened.locator('#retrySession').click();
  await reopened.locator('#mainScreen').waitFor({state:'visible',timeout:15000});
  console.log('PASS: offline API does not destroy login; user can retry without password');

  // Explicit logout removes both session and persistent tokens.
  await reopened.evaluate(()=>signout(false));
  assert.deepEqual(await reopened.evaluate(()=>({
   persistent:localStorage.getItem('mpol_token'),
   temporary:sessionStorage.getItem('mpol_token')
  })),{persistent:null,temporary:null});
  await reopened.reload();
  await reopened.locator('#authForm').waitFor({state:'visible',timeout:15000});
  console.log('PASS: explicit logout prevents automatic re-login');

  // The checkbox lets shared-device browser users opt out of permanent storage.
  await reopened.locator('#rememberLogin').uncheck();
  await reopened.locator('#login').fill('demo');
  await reopened.locator('#password').fill('test-password-123');
  await reopened.locator('#authSubmit').click();
  await reopened.locator('#mainScreen').waitFor({state:'visible'});
  const optedOut=await reopened.evaluate(()=>({
   permanent:localStorage.getItem('mpol_token'),
   temporary:sessionStorage.getItem('mpol_token')
  }));
  assert.equal(optedOut.permanent,null);
  assert.equal(optedOut.temporary,token);
  const newTab=await context.newPage();
  await newTab.goto(origin+'/');
  await newTab.locator('#authForm').waitFor({state:'visible'});
  console.log('PASS: remember-me opt-out does not persist between separate tabs');

  // Electron intentionally preserves distinct identities per EXE window.
  const exePage=await context.newPage();
  await exePage.goto(origin+'/?mpol_client=2.8.0');
  await exePage.locator('#login').fill('demo');
  await exePage.locator('#password').fill('test-password-123');
  await exePage.locator('#authSubmit').click();
  await exePage.locator('#mainScreen').waitFor({state:'visible'});
  assert.equal(await exePage.evaluate(()=>localStorage.getItem('mpol_token')),null);
  assert.equal(await exePage.evaluate(()=>sessionStorage.getItem('mpol_token')),token);
  const anotherExe=await context.newPage();
  await anotherExe.goto(origin+'/?mpol_client=2.8.0');
  await anotherExe.locator('#authForm').waitFor({state:'visible'});
  console.log('PASS: desktop EXE keeps accounts isolated by window');

  await context.close();
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(err=>{console.error(err);process.exitCode=1;server.close()});
