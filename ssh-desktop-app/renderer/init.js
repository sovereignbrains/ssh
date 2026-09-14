"use strict";
/* ---------------- INIT ---------------- */
(async function init(){
  loadLocalPrefs();
  applyTheme(true);renderSettings();renderSessions();renderKeys();
  renderTunnelForm();renderTunnels();renderTabs();updateBadges();
  refreshShells();
  if(window.vaultAPI)await refreshVaultStatus();
  else{S.vaultOpen=true;renderVault();}
})();
