'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadPermissionGrants,savePermissionGrants,hasPermission,
 grantPermissions,revokeMediaPermissions}=require('../lib/media-permissions.cjs');
const first='https://mpol-messenger-api.onrender.com';
const second='https://mpol.example.ru';

test('media permissions remember only explicit grants on a trusted origin',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpol-perm-'));
 const file=path.join(dir,'media-permissions.json');
 try{
  const grants=loadPermissionGrants(file);
  assert.equal(hasPermission(grants,first,'audio'),false);
  grantPermissions(grants,first,['audio','video']);
  savePermissionGrants(file,grants);
  const saved=loadPermissionGrants(file);
  assert.equal(hasPermission(saved,first,'audio'),true);
  assert.equal(hasPermission(saved,first,'video'),true);
  assert.equal(hasPermission(saved,second,'audio'),false,
   'Changing the server must not transfer microphone access');
  assert.equal(hasPermission(saved,'https://mpol.example.ru.evil.com','audio'),false);
  assert.equal(hasPermission(saved,first,'display-capture'),false,
   'Screen capture must always require a new explicit picker');
  revokeMediaPermissions(saved,first);
  savePermissionGrants(file,saved);
  assert.equal(hasPermission(loadPermissionGrants(file),first,'audio'),false);
  assert.equal(hasPermission(loadPermissionGrants(file),first,'video'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('untrusted origins and corrupted permission files grant nothing',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpol-perm-'));
 const file=path.join(dir,'grant.json');
 try{
  fs.writeFileSync(file,'not JSON');
  assert.equal(hasPermission(loadPermissionGrants(file),first,'audio'),false);
  assert.throws(()=>grantPermissions({},'http://mpol-messenger-api.onrender.com',['audio']));
  fs.writeFileSync(file,JSON.stringify({
   version:1,origins:{'http://unsafe.example.com':{audio:true},
    [first]:{audio:true,video:false,notifications:true,'display-capture':true}}
  }));
  const saved=loadPermissionGrants(file);
  assert.equal(hasPermission(saved,first,'audio'),true);
  assert.equal(hasPermission(saved,first,'video'),false);
  assert.equal(hasPermission(saved,first,'notifications'),true);
  assert.equal(hasPermission(saved,'http://unsafe.example.com','audio'),false);
  assert.equal(hasPermission(saved,first,'display-capture'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
