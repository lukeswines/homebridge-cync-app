# homebridge-cync-app
Homebridge plugin that integrates your GE Cync account (via the Cync app/API) and exposes all supported devices: plugs, lights, switches, etc.

It currently supports:

- Email + password + 2FA (one-time code) login
- Persistent token storage in the Homebridge storage path
- Discovery of Cync “meshes” and devices from the cloud
- Exposing Cync outlets as HomeKit switches with their Cync `displayName`

> Status: **Early LAN preview.** Tested with Cync smart plugs only. Other device types may not appear or may behave incorrectly.

## Installation

1. Install via Homebridge UI (Plugins tab) or from the command line:

```
	npm install -g homebridge-cync-app
```
2. Restart Homebridge.

## Configuration

Add a platform entry to your Homebridge `config.json`:

```
{
  "platforms": [
    {
      "platform": "CyncAppPlatform",
      "name": "Cync App (Dev)",
      "username": "you@example.com",
      "password": "your-cync-password",
      "twoFactor": "123456"
    }
  ]
}
```
## Cync Login / 2FA Flow

1. Open the plugin settings in Homebridge UI.
2. Enter your Cync **Email** and **Password**.
3. Click **Request Verification Code**.
4. Check your email for the 6-digit Cync verification code.
5. Enter the code in **Verification Code (OTP)**.
6. Click the Homebridge **Save** button.
7. Restart Homebridge.

On successful login, a token will be stored in `cync-tokens.json` under the Homebridge storage path.
While a valid token exists, the login fields are locked. Click **Sign Out** in the plugin UI to clear the token and re-enter credentials.

## Project Status & Roadmap
- **0.0.1** – Initial scaffold, basic Homebridge platform, config wiring, and logging.
- **0.0.2** - Cync cloud login and device list discovery.
  - ✅ 2FA cloud login and token persistence
  - ✅ Cloud discovery of meshes and outlets
  - ✅ Basic HomeKit switch accessories with real Cync names
- **0.1.0** – Individual accessories for plugs; per-device control.  Switches, sensors and lights have not yet been tested and may not work.
- HomeKit can now control Cync smart plugs directly over the Cync LAN bridge.
- Switch states update independently and stay in sync between the Cync app and HomeKit.
- Cloud config is still used for login + topology, but ongoing control is via TCP.
- **0.1.1 - 0.1.3** - Failed experiment to incorporate custom UI.
- **0.1.4** - Codebase restored to v0.1.0
- **0.1.5** - Successful Custom UI implementation, improved 2FA login flow.
