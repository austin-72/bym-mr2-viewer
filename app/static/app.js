// Module entry point. index.html loads this file; it boots the viewer and
// flips the watchdog flag so the non-module fallback in index.html knows the
// app is alive. (This file was missing from a previous release bundle, which
// left the page stuck on the watchdog error - keep it in the zip.)
import { ViewerApp } from "./js/viewer-app.js";

window.__BYM_MR2_APP_LOADED = true;
console.info("[BYM-MR2] App module loaded; starting viewer.");

const app = new ViewerApp();
window.__BYM_MR2_APP = app; // console access for debugging
app.start().catch((error) => {
  console.error("[BYM-MR2] Viewer failed to start:", error);
  const status = document.getElementById("session-status");
  if (status) {
    status.textContent = error?.message
      ? `Viewer failed to start: ${error.message}`
      : "Viewer failed to start. See the browser console for details.";
  }
});
