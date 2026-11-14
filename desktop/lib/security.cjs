'use strict';
const SERVER_ORIGIN = 'https://mpol-messenger-api.onrender.com';
const GITHUB_REPO = 'https://github.com/MOnarh-ja1/MpolMessenger';

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}
// No silent failover to untrusted servers: all alternates must be selected
// manually and verified against the authenticated MPOL health marker.
function normalizeServerOrigin(value) {
  const u=parseUrl(String(value||'').trim());
  if(!u || u.protocol!=='https:' || u.username || u.password || u.search || u.hash ||
     u.pathname!=='/' || u.port || u.hostname.length>253 ||
     !/^[a-z0-9.-]+$/i.test(u.hostname) || !u.hostname.includes('.') ||
     u.hostname.startsWith('.') || u.hostname.endsWith('.') ||
     u.hostname.includes('..') ||
     /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(u.hostname) ||
     /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null;
  return u.origin;
}
function isMpolUrl(value, trustedOrigin=SERVER_ORIGIN) {
  const u = parseUrl(value);
  return !!u && normalizeServerOrigin(trustedOrigin) === u?.origin && u.protocol === 'https:';
}
function canOpenExternal(value) {
  const u = parseUrl(value);
  return !!u && u.protocol === 'https:' && (
    u.hostname === 'github.com' || u.hostname === 'www.github.com' ||
    u.hostname === 'support.microsoft.com'
  );
}
function safeFilename(filename) {
  const name = String(filename || 'MPOL-download')
    .replace(/[<>:"\/\|?*\x00-\x1f]/g,'_')
    .replace(/[. ]+$/g,'').slice(0,150);
  return name || 'MPOL-download';
}
function normalizeMediaTypes(input) {
  const set = new Set((Array.isArray(input) ? input : []).filter(
    x => x === 'audio' || x === 'video'
  ));
  return [...set].sort();
}
function mediaKey(types) {
  return normalizeMediaTypes(types).join('+');
}
module.exports = { SERVER_ORIGIN, GITHUB_REPO, normalizeServerOrigin, isMpolUrl,
  canOpenExternal, safeFilename, normalizeMediaTypes, mediaKey };
