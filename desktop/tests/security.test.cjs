'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 SERVER_ORIGIN,GITHUB_REPO,isMpolUrl,canOpenExternal,safeFilename,
 normalizeMediaTypes,mediaKey
}=require('../lib/security.cjs');

test('MPOL only trusts the exact production HTTPS origin',()=>{
 assert.equal(SERVER_ORIGIN,'https://mpol-messenger-api.onrender.com');
 for(const url of [
  SERVER_ORIGIN, SERVER_ORIGIN+'/',SERVER_ORIGIN+'/?mpol_client=2.3.0',
  SERVER_ORIGIN+'/api/chats',SERVER_ORIGIN+'/icons/messages.webp'
 ]) assert.equal(isMpolUrl(url),true,url);
 for(const url of [
  'http://mpol-messenger-api.onrender.com',
  'https://mpol-messenger-api.onrender.com.attacker.test',
  'https://mpol-messenger-api.onrender.com@evil.test',
  'javascript:alert(1)','file:///etc/passwd','data:text/html,hi',
  'http://127.0.0.1:8080','https://evil.example'
 ]) assert.equal(isMpolUrl(url),false,url);
});
test('external links are limited to vetted HTTPS destinations',()=>{
 assert.equal(GITHUB_REPO,'https://github.com/MOnarh-ja1/MpolMessenger');
 for(const u of [
   'https://github.com/MOnarh-ja1/MpolMessenger/releases',
   'https://www.github.com/openai',
   'https://support.microsoft.com/help'
 ]) assert.equal(canOpenExternal(u),true,u);
 for(const u of [
   'https://github.com.bad.example/malware',
   'http://github.com/openai','javascript:alert(1)',
   'file:///C:/Windows/system.ini','https://evil.example'
 ]) assert.equal(canOpenExternal(u),false,u);
});
test('download names cannot escape Downloads or contain Windows path delimiters',()=>{
 assert.equal(safeFilename('../../MPOL.exe'),'.._.._MPOL.exe');
 assert.equal(safeFilename('file<abc>?.txt'),'file_abc__.txt');
 assert.equal(safeFilename('test.txt... '),'test.txt');
 assert.equal(safeFilename(''),'MPOL-download');
 assert.ok(safeFilename('a'.repeat(999)).length<=150);
});
test('only audio and video permission kinds can be requested',()=>{
 assert.deepEqual(normalizeMediaTypes(['audio','video','audio','other']),['audio','video']);
 assert.equal(mediaKey(['video','audio']),'audio+video');
 assert.deepEqual(normalizeMediaTypes(['serial','unknown']),[]);
});
