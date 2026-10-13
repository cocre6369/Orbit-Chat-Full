/* Orbit — side panel host. Used as the fallback UI on pages where content scripts cannot run
 * (chrome://, the Web Store, PDF viewer, other extensions' pages) and as a regular docked view.
 * It mounts the very same panel UI as the in-page overlay, in "embedded" mode. */
(function () {
  'use strict';
  const t = globalThis.OrbitStrings.t;
  const bridge = globalThis.OrbitBridge.create({ context: 'sidepanel', host: '', mode: 'panel' });
  const controller = globalThis.OrbitPanel.mount({
    root: document.getElementById('app'),
    bridge,
    env: { context: 'sidepanel', host: '', url: '' },
    hooks: {}
  });

  bridge.on('open-room', (m) => { if (m && m.roomId) controller.openRoom(m.roomId); });
  bridge.on('dead', () => { note(t('extension_reloaded', { brand: t('brand') })); });
  document.addEventListener('visibilitychange', () => controller.setVisible(!document.hidden));

  // Explain why we are here when opened as a fallback for a restricted page.
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && (!tab.url || globalThis.ORBIT.RESTRICTED_URL_RE.test(tab.url))) note(t('restricted_note', { brand: t('brand') }), 6000);
    } catch (e) { /* tabs may be unavailable */ }
  })();

  function note(text, ms) {
    const n = document.getElementById('note');
    n.textContent = text; n.classList.add('show');
    if (ms) setTimeout(() => n.classList.remove('show'), ms);
  }
})();
