"use strict";
// Headless Edge/Chrome smoke test: F11/maximized/windowed viewport geometry.
// No production server or user accounts involved.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright-core');

const dir=path.resolve(__dirname,'../client/ui');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css',
 '.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
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
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser=null;
 try{
  for(const channel of ['msedge','chrome']){
   try{browser=await chromium.launch({headless:true,channel,
     args:['--disable-gpu','--no-first-run']});break}
   catch(err){console.log(channel+' not available: '+err.message.slice(0,120))}
  }
  if(!browser)throw Error('Neither Microsoft Edge nor Chrome is installed');
  const page=await browser.newPage({viewport:{width:1200,height:820}});
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  const iconCheck=await page.evaluate(async()=>{
   const names=['messages','friends','requests','search'];
   const images=[...document.querySelectorAll('.rail-stack .mpol-nav-icon')];
   if(images.length!==4)return {ok:false,error:'Expected four sidebar icons, got '+images.length};
   for(let i=0;i<images.length;i++){
    const image=images[i];
    if(!image.src.endsWith('/icons/'+names[i]+'.webp'))return {ok:false,error:'Wrong icon order for '+names[i]};
    try{await image.decode()}catch{return {ok:false,error:'Missing or invalid WebP image '+names[i]}}
    if(image.naturalWidth<64||image.naturalHeight<64)return {ok:false,error:'Icon resolution too small '+names[i]};
   }
   return {ok:typeof document.getElementById('railSearch').onclick==='function',
     error:'Search button missing click handler'};
  });
  assert.ok(iconCheck.ok,'Supplied icon assets and search routing: '+JSON.stringify(iconCheck));
  console.log('PASS: all four custom icons decode; search button is wired');
  const customActions=await page.evaluate(async()=>{
    const source=new Image();source.src='/icons/mpol-actions.webp?v=3.3.0';
    try{await source.decode()}catch(err){return {error:String(err),width:source.naturalWidth}}
    const actions=[
      ['.rail-secondary[data-tab="saved"]','.mpol-icon-star','0% 0%'],
      ['.rail-secondary[data-tab="settings"]','.mpol-icon-settings','50% 0%'],
      ['#voiceCall','.mpol-icon-call','100% 0%'],
      ['#videoCall','.mpol-icon-video','0% 100%'],
      ['#archiveChat','.mpol-icon-archive','50% 100%'],
      ['#deleteChat','.mpol-icon-delete','100% 100%']
    ];
    return {width:source.naturalWidth,height:source.naturalHeight,
      buttons:actions.map(([button,icon,pos])=>{
        const node=document.querySelector(button+' '+icon);
        const style=node?getComputedStyle(node):null;
        return {button,exists:!!node,
          sprite:style?.backgroundImage?.includes('mpol-actions.webp'),
          position:style?.backgroundPosition===pos}
      }),
      separateProfile:!!document.querySelector('#openChatProfile')};
  });
  assert.equal(customActions.width,144,'Expected the exact six-icon 3x2 WebP sprite');
  assert.equal(customActions.height,96,'Expected two rows of glossy icons');
  assert.equal(customActions.separateProfile,false,'Remove redundant View Profile button');
  for(const a of customActions.buttons){
    assert.ok(a.exists&&a.sprite&&a.position,'Missing/misplaced supplied icon '+JSON.stringify(a));
  }
  console.log('PASS: six user-supplied glossy icons decode in correct locations');


  await page.evaluate(()=>{
   document.getElementById('authScreen').classList.add('hidden');
   document.getElementById('mainScreen').classList.remove('hidden');
   document.getElementById('emptyChat').classList.add('hidden');
   document.getElementById('openedChat').classList.remove('hidden');
   const root=document.getElementById('messages');
   root.innerHTML='<div class="msg-row theirs"><div class="msg-bubble">Привет, сообщение собеседника</div></div><div class="msg-row mine"><div class="msg-bubble">Мой ответ</div></div>';
  });
  for(const [width,height] of [[1280,800],[1024,650],[800,550],[700,460],[640,410],[1280,920]]){
   await page.setViewportSize({width,height});
   const info=await page.evaluate(()=>{
    const box=id=>{const r=document.getElementById(id).getBoundingClientRect();
      return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height,width:r.width}};
    return {width:innerWidth,height:innerHeight,composer:box('composer'),
      conversation:box('openedChat'),messages:box('messages'),
      scrollWidth:document.documentElement.scrollWidth,
      scrollHeight:document.documentElement.scrollHeight};
   });
   assert.ok(info.composer.height>20,JSON.stringify(info));
   assert.ok(info.composer.bottom<=height+2,'Composer clipped at '+width+'x'+height+': '+JSON.stringify(info));
   assert.ok(info.composer.y>=0,'Composer above viewport at '+width+'x'+height);
   assert.ok(info.messages.height>30,'Message list collapsed at '+width+'x'+height);
   assert.ok(info.scrollWidth<=width+2,'Horizontal UI clipped at '+width+'x'+height);
   assert.ok(info.scrollHeight<=height+2,'Vertical UI overflow at '+width+'x'+height);
   console.log('PASS responsive '+width+'x'+height+' composer bottom '+Math.round(info.composer.bottom));
  }

  // User ID belongs only to the My Account profile, not the main chat sidebar.
  const profileCheck=await page.evaluate(()=>{
   const hasSidebarID=!!document.getElementById('myIdCard');
   state.me={id:'MPTEST123456',nick:'Тестовый профиль',avatar:'◉',
     description:'',email:null,email_verified:false,status:'online',is_developer:false};
   openSettings();
   const content=document.getElementById('modalContent');
   return {hasSidebarID,hasAccount:!!content.querySelector('#accountDetails'),
     id:content.querySelector('#accountDetails code')?.textContent,
     copied:!!content.querySelector('#copyProfileId')};
  });
  assert.equal(profileCheck.hasSidebarID,false,'ID should not appear in the chat list');
  assert.ok(profileCheck.hasAccount&&profileCheck.copied,'Account ID card is required in the profile');
  assert.equal(profileCheck.id,'MPTEST123456');
  await page.evaluate(()=>closeModal());
  console.log('PASS: unique account ID appears only inside My Account settings');

  const moderationUi=await page.evaluate(()=>{
    const u={id:'MPPEER123',nick:'Собеседник',avatar:'◉',online:true,description:'Мой профиль'};
    state.me.is_developer=false;showUserProfile(u);
    const regular={profile:document.getElementById('modalTitle').textContent,
      adminVisible:!!document.getElementById('openModeration')};
    closeModal();
    state.me.is_developer=true;showUserProfile(u);
    const developer={adminVisible:!!document.getElementById('openModeration')};
    closeModal();
    state.me.is_developer=false;
    state.active={id:'DM_TEST',name:'Собеседник',is_group:false,is_saved:false,
      peer_id:u.id,avatar:'◉',online:true,members:[state.me.id,u.id]};
    updateHeader();
    return {regular,developer,deleteChat:!!document.getElementById('deleteChat'),
      profileButton:!!document.getElementById('chatPeerHeader')&&
        !document.getElementById('chatPeerHeader').disabled};
  });
  assert.equal(moderationUi.regular.profile,'Профиль пользователя');
  assert.equal(moderationUi.regular.adminVisible,false,'Regular users must not see admin UI');
  assert.equal(moderationUi.developer.adminVisible,true,'Developer sees moderation UI');
  assert.ok(moderationUi.deleteChat&&moderationUi.profileButton,'Chat deletion and tappable profile header missing');
  console.log('PASS peer profile, developer-only moderation UI and chat deletion controls');
  const profileTap=await page.evaluate(async()=>{
    const originalApi=api;
    try{
      api=async path=>path.startsWith('/users/')?{
        id:'MPPEER123',nick:'Собеседник',avatar:'◉',online:true,
        description:'Профиль для проверки'
      }:originalApi(path);
      const header=document.getElementById('chatPeerHeader');
      if(header.disabled)return {opened:false,reason:'header disabled'};
      header.click();
      await new Promise(r=>setTimeout(r,0));
      return {opened:document.getElementById('modalTitle').textContent==='Профиль пользователя',
        hasCopy:!!document.getElementById('copyPeerId'),
        label:header.getAttribute('title')};
    }finally{api=originalApi;closeModal()}
  });
  assert.ok(profileTap.opened&&profileTap.hasCopy,'Peer profile click failed: '+JSON.stringify(profileTap));

  const clipboardFallback=await page.evaluate(async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
    const originalExec=document.execCommand;
    let selected='';
    Object.defineProperty(navigator,'clipboard',{configurable:true,
      value:{writeText:async()=>{throw Error('Clipboard permission denied')}}});
    document.execCommand=kind=>{
      selected=document.activeElement?.value||'';
      return kind==='copy';
    };
    try{
      const copied=await copyMpolText('Проверка копирования MPOL');
      return {copied,selected};
    }finally{
      document.execCommand=originalExec;
      if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);
      else delete navigator.clipboard;
    }
  });
  assert.equal(clipboardFallback.copied,true,'Fallback copy must work without Clipboard API permission');
  assert.equal(clipboardFallback.selected,'Проверка копирования MPOL');
  console.log('PASS: peer profile header opens on touch and clipboard fallback copies text');

  // iPhone-sized viewport: only one pane should be visible, input never clipped.
  for(const [width,height] of [[390,844],[375,667],[320,568]]){
   await page.setViewportSize({width,height});
   await page.evaluate(()=>document.getElementById('mainScreen').classList.add('mobile-chat-open'));
   const m=await page.evaluate(()=>{
     const rect=id=>{const b=document.getElementById(id).getBoundingClientRect();return {y:b.y,bottom:b.bottom,width:b.width,height:b.height}};
     return {composer:rect('composer'),back:rect('mobileBack'),messages:rect('messages'),
       hasSidebar:getComputedStyle(document.querySelector('.chat-list-panel')).display!=='none',
       hasNavigation:getComputedStyle(document.querySelector('.rail')).display!=='none',
       scrollWidth:document.documentElement.scrollWidth,
       inputFont:parseFloat(getComputedStyle(document.getElementById('messageInput')).fontSize)};
   });
   assert.ok(m.composer.height>=35 && m.composer.bottom<=height+2,JSON.stringify(m));
   assert.ok(m.messages.height>90,JSON.stringify(m));
   assert.ok(m.back.width>=36,JSON.stringify(m));
   assert.equal(m.hasSidebar,false,'Chat list must hide while chatting');
   assert.equal(m.hasNavigation,false,'Bottom rail must hide while chatting');
   assert.ok(m.inputFont>=16,'iPhone should not zoom the composer when focused');
   assert.ok(m.scrollWidth<=width+2,'No horizontal overflow '+width);
   console.log('PASS iPhone layout '+width+'x'+height);
   // Emoji picker must be entirely visible and must not open the keyboard on tap.
   await page.evaluate(()=>{
     const input=document.getElementById('messageInput');
     input.value='Привет ';
     document.getElementById('emojiBtn').click();
   });
   const picker=await page.evaluate(()=>{
     const p=document.getElementById('emojiPalette');
     const rect=p.getBoundingClientRect();
     return {top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,
       open:!p.classList.contains('hidden'),
       inputFocused:document.activeElement?.id==='emojiSearch',
       buttons:p.querySelectorAll('.emoji-grid button').length,
       userSelect:getComputedStyle(document.querySelector('.chat-list-panel')).userSelect,
       scale:document.querySelector('meta[name="viewport"]')?.content||''};
   });
   assert.ok(picker.open&&picker.buttons>20,'Emoji grid failed: '+JSON.stringify(picker));
   assert.ok(picker.top>=0&&picker.bottom<=height+2&&picker.left>=0&&picker.right<=width+2,
    'Emoji grid outside iPhone screen: '+JSON.stringify(picker));
   assert.equal(picker.inputFocused,false,'Opening emojis must not open the iPhone keyboard');
   assert.equal(picker.userSelect,'none','Application chrome must not be text-selectable');
   assert.ok(picker.scale.includes('user-scalable=no'),'Scale lock viewport missing');
   await page.locator('#emojiResults button').first().click();
   const selected=await page.evaluate(()=>({
     content:document.getElementById('messageInput').value,
     hidden:document.getElementById('emojiPalette').classList.contains('hidden')
   }));
   assert.ok(selected.content.includes('😀')&&selected.hidden,JSON.stringify(selected));
   console.log('PASS iPhone emoji '+width+'x'+height);

  }
  // Design reference: incoming (waveform + accept/decline) and outgoing
  // (animated connecting arc + 3 action controls + hangup), both mobile/PC.
  for(const [width,height] of [[1200,800],[390,844],[375,667],[320,568]]){
   await page.setViewportSize({width,height});
   for(const stage of ['incoming','outgoing','connected']){
    const shot=await page.evaluate(stage=>{
     currentCall={
      id:'design-test',peer:'MPPEER',nick:'A PRIVATE NICK MUST NOT SHOW',
      mode:'audio',incoming:stage==='incoming',isCaller:stage!=='incoming',
      started:stage==='connected'?Date.now():0,stream:null,remoteStream:null
     };
     callLayout();
     const card=document.getElementById('callCard');
     const box=el=>{const r=el.getBoundingClientRect();
      return {x:r.left,y:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
     const inc=document.querySelector('.call-accept-controls');
     const outgoing=document.querySelector('.call-active-controls');
     const tools=outgoing.querySelectorAll('.call-tools-row button');
     return {
      stage:card.dataset.stage,
      rect:box(card),
      incomingVisible:getComputedStyle(inc).display!=='none',
      outgoingVisible:getComputedStyle(outgoing).display!=='none',
      accept:box(document.getElementById('acceptCall')),
      decline:box(document.getElementById('declineCall')),
      end:box(document.getElementById('endCall')),
      actions:tools.length,
      title:document.getElementById('callTitle').textContent,
      mobileOverflow:document.documentElement.scrollWidth>innerWidth+2,
      wave:getComputedStyle(document.querySelector('.call-wave')).display,
      connectingDots:getComputedStyle(document.querySelector('.call-connecting-dots')).display,
      videoVisible:getComputedStyle(document.querySelector('.call-video-area')).display!=='none'
     };
    },stage);
    assert.equal(shot.stage,stage);
    assert.ok(shot.rect.width>260&&shot.rect.height>=240,JSON.stringify(shot));
    assert.ok(shot.rect.x>=0&&shot.rect.right<=width+2,'Call card off screen '+JSON.stringify(shot));
    assert.equal(shot.mobileOverflow,false,'Call UI horizontal overflow '+JSON.stringify(shot));
    assert.equal(shot.incomingVisible,stage==='incoming',JSON.stringify(shot));
    assert.equal(shot.outgoingVisible,stage!=='incoming',JSON.stringify(shot));
    assert.ok(!shot.title.includes('PRIVATE NICK'),'No avatar or nickname belongs on call page');
    assert.equal(shot.videoVisible,false,'Voice calls must not show a camera preview');
    if(stage==='incoming'){
     assert.ok(shot.accept.width>=80&&shot.decline.width>=80);
     assert.notEqual(shot.wave,'none');
    }else{
     assert.equal(shot.actions,3,'Mic, audio and camera controls required');
     assert.ok(shot.end.width>=150,'Big red end-call button required');
    }
   }
   const video=await page.evaluate(()=>{
    currentCall.mode='video';callLayout();
    return getComputedStyle(document.querySelector('.call-video-area')).display!=='none'
   });
   assert.equal(video,true,'Connected video should show remote camera');
   console.log('PASS call screen reference layout '+width+'x'+height);
  }
  await page.evaluate(()=>{currentCall=null;document.getElementById('callLayer').classList.add('hidden')});
 }finally{await browser?.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1;server.close()});
