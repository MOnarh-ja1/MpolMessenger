'use strict';
/* MPOL web client update notifier. Never changes user data or auth state. */
(() => {
  const POLL_MS = 5 * 60 * 1000;
  let deployedVersion = null;
  let notifiedVersion = null;
  async function check() {
    try {
      const res = await fetch('/version.json?t=' + Date.now(), {cache:'no-store', credentials:'same-origin'});
      if (!res.ok) return;
      const data = await res.json();
      const version = typeof data.version === 'string' ? data.version.slice(0,48) : '';
      if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i.test(version)) return;
      if (deployedVersion === null) { deployedVersion = version; return; }
      if (version === deployedVersion || version === notifiedVersion) return;
      notifiedVersion = version;
      const notice = document.createElement('aside');
      notice.style.cssText = 'position:fixed;z-index:99999;bottom:20px;right:20px;left:auto;max-width:min(390px,calc(100vw - 40px));background:#1d1d20;color:#f4f4f5;border:1px solid #55545b;border-radius:14px;padding:18px;box-shadow:0 15px 50px #000b;font:14px system-ui';
      notice.setAttribute('role','status');
      const text = document.createElement('div');
      text.textContent = 'Доступно обновление MPOL Messenger ' + version + '. Обновить интерфейс?';
      const controls = document.createElement('div'); controls.style.cssText='display:flex;gap:8px;margin-top:12px';
      const action = document.createElement('button');
      action.textContent = 'Обновить';
      action.style.cssText='background:#f4f4f5;color:#111;padding:10px 14px;border-radius:9px;border:0;cursor:pointer';
      action.onclick = () => { window.location.reload(); };
      const later = document.createElement('button');
      later.textContent = 'Позже';
      later.style.cssText='background:#333338;color:#f4f4f5;padding:10px 14px;border-radius:9px;border:0;cursor:pointer';
      later.onclick = () => notice.remove();
      controls.append(action,later); notice.append(text,controls); document.body.append(notice);
    } catch { /* Offline: keep using cached interface. */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check, {once:true});
  else check();
  setInterval(check,POLL_MS);
})();
