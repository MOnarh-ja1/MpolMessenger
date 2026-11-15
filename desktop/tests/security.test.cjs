'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
 SERVER_ORIGIN,GITHUB_REPO,normalizeServerOrigin,isMpolUrl,canOpenExternal,safeFilename,
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

test('Server selection only accepts deliberate external HTTPS origin, no token leaks',()=>{
 for(const url of [
  'https://mpol.example.ru','https://mpol.example.ru/','https://demo.dada-tuda.ru'
 ]){
  const origin=normalizeServerOrigin(url);
  assert.ok(origin && origin.startsWith('https://'),url);
  assert.equal(isMpolUrl(origin+'/api/health',origin),true);
  assert.equal(isMpolUrl(SERVER_ORIGIN+'/api/me',origin),false);
 }
 for(const url of [
  'http://mpol.example.ru','https://mpol.example.ru.attacker.test/path',
  'https://example.ru/foo','https://example.ru?token=secret',
  'https://u:pass@example.ru','https://127.0.0.1','https://localhost',
  'https://192.168.0.1','file:///etc/passwd','javascript:alert(1)',
  'https://intranet.local','https://example.ru:8443',
  'https://example.ru/#hash','https://example.ru.','https://::1'
 ])assert.equal(normalizeServerOrigin(url),null,'Invalid server origin must be rejected: '+url);
});
test('Russian PaaS Docker image includes the phone website and persisted backend',()=>{
 const fs=require('node:fs');
 const file=require('node:path').resolve(__dirname,'../../Dockerfile');
 const docker=fs.readFileSync(file,'utf8');
 assert.match(docker,/COPY client\/ui \/app\/client\/ui/);
 assert.match(docker,/MPOL_REQUIRE_PERSISTENT_DB=1/);
 assert.match(docker,/\$\{PORT:-8000\}/);
 const desktop=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../main.cjs'),'utf8');
 assert.match(desktop,/isSettingsPage\(event\.senderFrame/);
 assert.match(desktop,/Ctrl|input\.control/);
});

test('Windows installer creates permanent shortcuts and recovery page uses guarded IPC',()=>{
 const fs=require('node:fs');
 const path=require('node:path');
 const root=path.resolve(__dirname,'..');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.match(pkg.version,/^\d+\.\d+\.\d+$/,'Version must be semantic; avoid pinning this test to a previous release');
 assert.equal(pkg.build.nsis.oneClick,false);
 assert.equal(pkg.build.nsis.perMachine,false);
 assert.equal(pkg.build.nsis.createStartMenuShortcut,true);
 assert.equal(pkg.build.nsis.createDesktopShortcut,true);
 assert.ok(pkg.build.win.target.some(t=>t.target==='nsis'));
 assert.ok(pkg.build.win.target.some(t=>t.target==='portable'));
 assert.ok(pkg.build.files.includes('offline.js'),'recovery script must be shipped inside EXE');
 const offline=fs.readFileSync(path.join(root,'offline.html'),'utf8');
 assert.match(offline,/<button id="retry"/);
 assert.match(offline,/<button id="settings"/);
 assert.doesNotMatch(offline,/href="mpol:\/\//,
  'An unregistered custom URL scheme causes a startup recovery error');
 const main=fs.readFileSync(path.join(root,'main.cjs'),'utf8');
 assert.match(main,/isLocalRecoveryPage\(event\.senderFrame/);
 assert.match(main,/isOfflinePage\(event\.senderFrame/);
 const preload=fs.readFileSync(path.join(root,'preload.cjs'),'utf8');
 assert.match(preload,/endsWith\('\/offline\.html'\)/);
});
