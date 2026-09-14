"use strict";
/* ---------------- INIT ---------------- */
(async function init(){
  applyTheme(true);renderSettings();renderSessions();renderKeys();
  renderTunnelForm();renderTunnels();renderTabs();updateBadges();
  if(window.innerWidth<=1024&&window.innerWidth>720)setRail(true);
  refreshShells();
  if(window.vaultAPI)await refreshVaultStatus();
  else{S.vaultOpen=true;renderVault();}
})();
