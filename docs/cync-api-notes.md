# **docs/cync-api-notes.md**

## **Cync Cloud API Notes**

This document summarizes the Cync cloud authentication flow, device configuration endpoints, and the cloud-derived data structures used by the Cync platform. All details were extracted by analyzing the `cync_lights` Home Assistant integration.

---

## **1. API Base Endpoints**

Defined in the upstream integration:

```
API_AUTH                = https://api.gelighting.com/v2/user_auth
API_REQUEST_CODE        = https://api.gelighting.com/v2/two_factor/email/verifycode
API_2FACTOR_AUTH        = https://api.gelighting.com/v2/user_auth/two_factor
API_DEVICES             = https://api.gelighting.com/v2/user/{user}/subscribe/devices
API_DEVICE_INFO         = https://api.gelighting.com/v2/product/{product_id}/device/{device_id}/property
```

The cloud API provides:

* Authentication (username/password, optional 2FA)
* Device enumeration across all homes
* Room/group enumeration
* Ability to retrieve device-level capability information

All control operations occur through the TCP protocol, not the cloud API.

---

## **2. Authentication Flow**

### **2.1 Primary Authentication**

`POST /v2/user_auth`

**Request fields:**

* `corp_id` — fixed string `"1007d2ad150c4000"`
* `email`
* `password`

**Success response includes:**

* `access_token`
* `authorize`
* `user_id`

These values are used to construct a **binary login code** for the TCP session.

### **2.2 Two-Factor Initiation**

If authentication returns HTTP 400:

`POST /v2/two_factor/email/verifycode`

**Request fields:**

* `corp_id`
* `email`
* `local_lang` (`"en-us"`)

If successful, a verification code is emailed to the user.

### **2.3 Two-Factor Completion**

`POST /v2/user_auth/two_factor`

**Request fields:**

* `corp_id`
* `email`
* `password`
* `two_factor` — verification code
* `resource` — fixed value `"abcdefghijklmnop"`

On success, the response includes the same fields as primary authentication and allows creation of the TCP login code.

---

## **3. Cloud Configuration Retrieval**

### **3.1 Retrieve Homes**

`GET /v2/user/{user_id}/subscribe/devices`

**Headers:**
`Access-Token: <access_token>`

Each home entry includes:

* `id`
* `product_id`
* `name`

### **3.2 Retrieve Devices Within Home**

`GET /v2/product/{product_id}/device/{device_id}/property`

**Returned fields include:**

* `groupsArray` — rooms
* `bulbsArray` — devices

Devices represent switches, plugs, bulbs, sensors, and controllers.

---

## **4. Configuration Assembly Process**

The integration processes cloud data into the following components:

### **4.1 Device Lookup Tables**

* `home_devices[home_id]`:
  Maps mesh index → device ID using a deterministic function based on `deviceID` and `home.id`.

* `home_controllers[home_id]`:
  Controller devices associated with each home. Homes without controllers are discarded.

* `switchID_to_homeID`:
  Reverse mapping from controller identifier → home identifier.

### **4.2 Device Records**

Each device is assigned a normalized structure containing:

* Name
* Home affiliation
* Room affiliation (if known)
* `mesh_id`
* `switch_id`
* Capability flags (on/off, brightness, color temp, rgb, motion, ambient light, multielement, wifi control, plug, fan)

### **4.3 Room Records**

Each room record includes:

* `room_id`
* `name`
* `mesh_id`
* `room_controller`
* `home_name`
* List of switches in the room
* Subgroups and parent relationships

Subgroup relationships are validated after all rooms are constructed.

---

## **5. Configuration Output**

The upstream integration returns the following final structure:

```
{
  rooms,
  devices,
  home_devices,
  home_controllers,
  switchID_to_homeID
}
```

This dataset defines the full set of controllable Cync devices and establishes the mesh addressing required for TCP commands.


