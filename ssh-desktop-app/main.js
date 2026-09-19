'use strict';
// Thin loader. Everything the app does lives in app-main.js; this file exists so that a release
// which cannot even load its own modules still has somewhere to land - see aegis.js.
const { app } = require('electron');
const aegis = require('./aegis');

// The lock is taken before the health beacon on purpose: a second copy exits without ever
// showing a window, and that must not read back as a failed start.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (aegis.begin()) {
  try {
    require('./app-main');
  } catch (err) {
    aegis.crashed(err);
  }
}
