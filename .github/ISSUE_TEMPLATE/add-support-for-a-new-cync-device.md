---
name: Add Support for a New Cync Device
about: Request adding support for a Cync device
title: Add Cync Device [MODEL]
labels: enhancement
assignees: dash16

---

Thank you for helping expand device support in **homebridge-cync-app**.
To add a new device model, I need diagnostic info from your plugin installation.
Please fill out all sections below.

---

## 1. Device Information

**1.1 Product name as shown in the Cync app:**
(e.g., “6" Recessed Can Retrofit Fixture (Matter)”, “Indoor Smart Plug (3in1)”, “Indoor Smart Plug”)

**1.2 What kind of device is this?**

* Plug (on/off only)
* Dimmer
* Tunable white
* Full color light
* Multi-zone light
* Switch
* Downlight
* Other (describe)

---

## 2. Discovery Logs (Required)

Please enable **Homebridge Debug Mode** (`-D` or toggle in UI), restart Homebridge, and paste the *full debug block* for this device.

Look for log lines like:

```
[Cync App] Fetched device: {
  deviceId: …,
  productId: …,
  model: …,
  capabilities: …,
  raw: …
}
```

Paste them here (sanitize serial numbers if you want):

```
<insert logs>
```

---

## 3. Cloud `/property` Responses

To understand how the device reports its state, please:

1. Turn the device **on**, **off**, adjust **brightness**, or change **color** in the Cync app.
2. Copy all log lines showing cloud property fetches, for example:

```
[Cync App] [cloud] GET /product/.../device/.../property → …
```

Paste them here:

```
<insert logs>
```

---

## 4. LAN / TCP Logs (If Available)

Some Cync devices support LAN connections for faster updates.
If you see logs like `[Cync TCP] Connecting…`, please provide:

```
[Cync TCP][recv] …
[Cync TCP][send] …
```

Paste:

```
<insert logs>
```

If your device does *not* show TCP lines, say so:

```
No TCP messages observed.
```

---

## 5. Homebridge JSON View (Optional but Helpful)

In Homebridge UI:

**Plugins → Cync App → JSON Config Viewer (or Device Viewer)**

Copy the JSON block for this device:

```
<insert JSON>
```

---

## 6. Screenshots (Optional)

If possible, attach screenshots from the Cync app showing:

* Device settings panel
* Color/white mode UI
* Any advanced options

These help determine supported capabilities.

---

## 7. Anything Else?

If the device behaves strangely (multiple endpoints, only some colors work, etc.), describe it here.

```
<notes>
```

---

## Thank You!

Once you submit this, I’ll map the device’s capabilities, determine its proper HomeKit service type, and add support to the plugin.
