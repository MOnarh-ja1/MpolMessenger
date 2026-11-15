"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {normalizeServerOrigin}=require('./security.cjs');
const allowed=new Set(['audio','video','notifications']);
function loadPermissionGrants(file){
 try{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data?.version!==1||!data.origins||typeof data.origins!=='object')return {};
  const clean=Object.create(null);
  for(const [origin,grants] of Object.entries(data.origins)){
   if(normalizeServerOrigin(origin)!==origin||!grants||typeof grants!=='object')continue;
   clean[origin]=Object.create(null);
   for(const kind of allowed)if(grants[kind]===true)clean[origin][kind]=true;
  }
  return clean;
 }catch{return Object.create(null)}
}
function savePermissionGrants(file,grants){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const tmp=file+'.tmp';
 try{
  fs.writeFileSync(tmp,JSON.stringify({version:1,origins:grants}),{mode:0o600});
  fs.renameSync(tmp,file);
 }catch(e){
  try{fs.rmSync(tmp,{force:true})}catch{}
  throw e;
 }
}
function hasPermission(grants,origin,kind){
 return normalizeServerOrigin(origin)===origin&&allowed.has(kind)&&
  Object.prototype.hasOwnProperty.call(grants,origin)&&grants[origin]?.[kind]===true;
}
function grantPermissions(grants,origin,kinds){
 if(normalizeServerOrigin(origin)!==origin)throw Error('Untrusted origin');
 if(!Object.prototype.hasOwnProperty.call(grants,origin))grants[origin]=Object.create(null);
 for(const kind of kinds)if(allowed.has(kind))grants[origin][kind]=true;
}
function revokeMediaPermissions(grants,origin){
 if(!Object.prototype.hasOwnProperty.call(grants,origin))return;
 delete grants[origin].audio;delete grants[origin].video;
}
module.exports={loadPermissionGrants,savePermissionGrants,hasPermission,grantPermissions,revokeMediaPermissions};
