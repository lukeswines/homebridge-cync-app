# Changelog

## v0.1.3

**Release Date:** 2025-11-28

### Added

- Integrated a custom Homebridge UI configuration panel for Cync login.
- Added a single-flow login experience: enter email/password and 2FA code in one place via the UI instead of multiple save/restart cycles.

### Changed

- Simplified initial setup: configuration now only requires one Homebridge restart after entering credentials and completing 2FA.
- Updated the Cync client/session setup flow to work with the new UI-driven login and token handling.
- Refined configuration handling so the plugin can go from “installed” to “discovering devices” with fewer manual steps.
- Moved storage directory under `homebridge-cync-app`.  If you installed a previous version, you may want to clean up the token that was stored in the root directory.

### Fixed

- Updated ESLint flat configuration to work with ESLint 9, including ignoring `homebridge-ui/server.js` while keeping plugin TypeScript linting intact.
- General tooling/housekeeping improvements to keep `npm run lint` and `npm run build` clean on current Node and Homebridge versions.

## 0.1.2 – 2025-11-26

### Fixes

- Improve reliability when HomeKit scenes toggle multiple Cync plugs at once.
- Serialize LAN power commands through a send queue so multiple `On.set` calls share a single TCP session instead of opening parallel connections.
- Reuse an existing LAN socket for burst traffic and pace packets slightly to avoid race conditions with the Cync bridge.
- Ensure per-device LAN updates are consistently received for both outlets after scene execution.

### Internal

- Add a queued send path to `TcpClient` with a `flushQueue()` helper that writes packets in order over one socket.
- Guard `ensureConnected()` with a shared `connecting` promise so concurrent calls don’t race separate `establishSocket()` attempts.
- Make the socket `close` handler only null out `this.socket` when it corresponds to the active instance (avoids stray listeners from older sockets).


## 0.1.0 – LAN Control Preview

- Implemented TCP client for Cync LAN bridge using the cloud-provided login code.
- Added real on/off control for Cync smart plugs directly from HomeKit.
- Wired HomeKit `On` characteristic handlers to TCP transport.
- Subscribed to Cync device updates and propagate state changes back into HomeKit.
- Improved logging around cloud configuration loading, LAN login, and TCP connection lifecycle.
- Known scope: tested only with Cync smart plugs; other device types are currently untested and may not appear or function correctly.

## v0.0.2 – Cloud 2FA + device discovery

**Release Date:** 2025-11-23

### Added
- Cync cloud 2FA login flow using email + password + one-time code.
- Persistent token storage and automatic session restore on Homebridge restart.
- Cloud configuration fetch via `/user/{userId}/subscribe/devices`.
- Per-mesh property probe via `/product/{productId}/device/{meshId}/property`.
- Device discovery from `bulbsArray` and mapping into Homebridge accessories.
- Accessory UUIDs seeded from mesh ID + stable device ID for consistent caching.
- Automatic accessory naming using Cync `displayName` (e.g. “Lower Outlet”, “Upper Outlet”).

### Changed
- Replaced the previous “dummy switch” with real Cync devices from the cloud.
- Tightened logging around login, token restore, and cloud configuration loading.
- Ensured all new TypeScript code is lint-clean (`no-explicit-any`, strict typing).

### Known limitations
- LAN / TCP control path is still stubbed: `On` characteristic logs requests but does not yet send real commands to devices.
- Only basic on/off outlets have been exercised; lights/scenes/groups are not yet modelled as HomeKit accessories.
- Token expiry / refresh is not yet implemented; a full re-login may be required if the token is revoked or expires.

## 0.0.1 – Initial Cync scaffold
**Release Date:** 2025-11-22

### Added
- Initial Homebridge platform plugin scaffold for controlling Cync devices via the Cync app account.
- Basic TypeScript project setup (ESLint, `tsconfig`, build scripts).
- Platform registration and minimal logging to verify plugin loads correctly in Homebridge.
- Configuration schema wiring for the Homebridge UI (basic fields for Cync account and options).
