'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const crypto=require('node:crypto');
const src=fs.readFileSync(path.resolve(__dirname,'../lib/updater.cjs'),'utf8');
const bytes=Buffer.from('MPOL-TEST-BINARY-EXE-CONTENT');
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const net={fetch:async()=>new Response(bytes)};
const electron={net,dialog:{},shell:{},app:{getPath:()=>os.tmpdir()}};
const mod={exports:{}};
const context={module:mod,require:n=>n==='electron'?electron:require(n),console,URL,
 AbortController,AbortSignal,WeakSet,Math,Number,Promise};
vm.runInNewContext(src,context,{filename:'updater.cjs'});
const {isNewer,releaseFromList,downloadVerifiedUpdate}=mod.exports;
assert.equal(isNewer('2.6.0','2.5.0'),true);
assert.equal(isNewer('2.5.0','2.6.0'),false);
const release=(version='2.6.0')=>({tag_name:'v'+version+'-desktop',assets:[{
 name:'MpolMessenger.exe',size:110_000_000,
 digest:'sha256:'+digest,
 browser_download_url:'https://github.com/MOnarh-ja1/MpolMessenger/releases/download/v'+version+'-desktop/MpolMessenger.exe'
}]});
const chosen=releaseFromList([release('2.5.0'),release('2.6.0')],'2.5.0');
assert.equal(chosen.version,'2.6.0');
assert.equal(chosen.sha256,digest);
assert.equal(releaseFromList([{...release(),assets:[{...release().assets[0],digest:''}]}],'2.5.0'),null);
assert.equal(releaseFromList([{...release(),assets:[{...release().assets[0],
 browser_download_url:'https://example.com/untrusted.exe'}]}],'2.5.0'),null);
class FakeWindow extends EventEmitter{
 isDestroyed(){return false}
 getTitle(){return 'MPOL Messenger'}
 setTitle(value){this.title=value}
 setProgressBar(value){this.progress=value}
}
(async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'mpol-updater-test-'));
 const win=new FakeWindow();
 try{
  const target=path.join(dir,'MpolMessenger-2.6.0.exe');
  const info={url:chosen.url,size:bytes.length,sha256:digest};
  const downloaded=await downloadVerifiedUpdate(win,info,target);
  assert.equal(downloaded,target);
  assert.deepEqual(await fsp.readFile(target),bytes);
  assert.equal(win.progress,-1);
  assert.equal(fs.existsSync(target+'.mpol.part'),false);
  await assert.rejects(downloadVerifiedUpdate(win,{...info,sha256:'0'.repeat(64)},
    path.join(dir,'corrupt.exe')),/SHA-256/);
  assert.equal(fs.existsSync(path.join(dir,'corrupt.exe')),false);
  assert.equal(fs.existsSync(path.join(dir,'corrupt.exe.mpol.part')),false);
  console.log('PASS: release digest verification, streaming, progress reset, corruption cleanup');
 }finally{await fsp.rm(dir,{recursive:true,force:true})}
})().catch(err=>{console.error(err);process.exitCode=1});
