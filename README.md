# Crave Saga Electron Client

This repo provides a third-party Electron wrapper for the game with added QoL features:

* Auto scaling
* Fullscreen toggling
* Muting
* Always on top
* Blackout (to reduce distraction)
* Ambient background
* Screenshot
* AP/RP trackers
* Notifications
  * Battle end
  * Expeditions
  * AP full
  * RP full
* Proxy support
* Provider selector (EROLABS, Johren, nutaku, DMM)

## Runtime Config Notes

* `web_security` (default `true`) keeps standard browser security enabled. This improves compatibility with Cloudflare Turnstile on provider login pages.
* If a provider flow requires relaxed cross-origin behavior, set `web_security = false` in `config.ini` (not recommended unless needed).
* `mask_electron_ua` (default `false`) removes the `Electron/...` token only on EROLABS domains when explicitly enabled.
* Cloudflare login-page script skipping is scoped to EROLABS provider pages only.
