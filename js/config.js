// Deployment config. `relay` is the base URL of an ADS-B relay (see server.mjs / api/ / worker/).
// Leave empty to auto-detect: same-origin /api when served by `node server.mjs` or Vercel.
window.ARGUS_CONFIG = {
  relay: '',
};
