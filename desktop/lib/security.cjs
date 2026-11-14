'use strict';
const SERVER_ORIGIN = 'https://mpol-messenger-api.onrender.com';
const GITHUB_REPO = 'https://github.com/MOnarh-ja1/MpolMessenger';

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}
function isMpolUrl(value) {
  const u = parseUrl(value);
  return !!u && u.origin === SERVER_ORIGIN && (u.protocol === 'https:');
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
    .replace(/[<>:"/\\|?*\\x00-\\x1f]/g,'_')
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
module.exports = { SERVER_ORIGIN, GITHUB_REPO, isMpolUrl,
  canOpenExternal, safeFilename, normalizeMediaTypes, mediaKey };
