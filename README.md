# homebridge-cync-app
Homebridge plugin that integrates your GE Cync account (via the Cync app/API) and exposes all supported devices: plugs, lights, switches, etc.

## Installation

1. Install via Homebridge UI (Plugins tab) or from the command line:

```
	npm install -g homebridge-cync-app
```
2. Restart Homebridge.

## Configuration

v0.0.1 is focused on validating login/config plumbing and platform registration.
 Device discovery and control are in progress and will land in later versions.

## Project Status & Roadmap
- **0.0.1** – Initial scaffold, basic Homebridge platform, config wiring, and logging.
- **0.1.0 (planned)** – Cync cloud login and device list discovery.
- **0.2.0+ (planned)** – Individual accessories for switches, plugs, and lights; per-device control.
