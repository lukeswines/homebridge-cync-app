// src/platform.ts
import type {
	API,
	DynamicPlatformPlugin,
	Logger,
	PlatformAccessory,
	PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME } from './settings.js';
import { CyncClient } from './cync/cync-client.js';
import { ConfigClient } from './cync/config-client.js';
import type { CyncCloudConfig, CyncDevice, CyncDeviceMesh } from './cync/config-client.js';
import { TcpClient } from './cync/tcp-client.js';
import type { CyncLogger } from './cync/config-client.js';

// Narrowed view of the Cync device properties returned by getDeviceProperties()
type CyncDeviceRaw = {
	displayName?: string;
	firmwareVersion?: string;
	mac?: string;
	wifiMac?: string;
	deviceType?: number;
	deviceID?: number;
	commissionedDate?: string;
	[key: string]: unknown;
};

// CyncDevice as seen by the platform, possibly enriched with a `raw` block
type CyncDeviceWithRaw = CyncDevice & {
	raw?: CyncDeviceRaw;
};

const toCyncLogger = (log: Logger): CyncLogger => ({
	debug: log.debug.bind(log),
	info: log.info.bind(log),
	warn: log.warn.bind(log),
	error: log.error.bind(log),
});

interface CyncAccessoryContext {
	cync?: {
		meshId: string;
		deviceId: string;
		productId?: string;

		on?: boolean;
		brightness?: number; // 0–100 (LAN "level")

		// Color state (local cache, not yet read from LAN frames)
		hue?: number;          // 0–360
		saturation?: number;   // 0–100
		rgb?: { r: number; g: number; b: number };
		colorActive?: boolean; // true if we last set RGB color
	};
	[key: string]: unknown;
}

function hsvToRgb(hue: number, saturation: number, value: number): { r: number; g: number; b: number } {
	const h = ((hue % 360) + 360) % 360;
	const s = Math.max(0, Math.min(100, saturation)) / 100;
	const v = Math.max(0, Math.min(100, value)) / 100;

	if (s === 0) {
		const grey = Math.round(v * 255);
		return { r: grey, g: grey, b: grey };
	}

	const sector = h / 60;
	const i = Math.floor(sector);
	const f = sector - i;

	const p = v * (1 - s);
	const q = v * (1 - s * f);
	const t = v * (1 - s * (1 - f));

	let r = 0;
	let g = 0;
	let b = 0;

	switch (i) {
	case 0:
		r = v;
		g = t;
		b = p;
		break;
	case 1:
		r = q;
		g = v;
		b = p;
		break;
	case 2:
		r = p;
		g = v;
		b = t;
		break;
	case 3:
		r = p;
		g = q;
		b = v;
		break;
	case 4:
		r = t;
		g = p;
		b = v;
		break;
	default:
		r = v;
		g = p;
		b = q;
		break;
	}

	return {
		r: Math.round(r * 255),
		g: Math.round(g * 255),
		b: Math.round(b * 255),
	};
}

export class CyncAppPlatform implements DynamicPlatformPlugin {
	public readonly accessories: PlatformAccessory[] = [];
	public configureAccessory(accessory: PlatformAccessory): void {
		this.log.info('Restoring cached accessory', accessory.displayName);
		this.accessories.push(accessory);
	}
	private readonly log: Logger;
	private readonly api: API;
	private readonly config: PlatformConfig;
	private readonly client: CyncClient;
	private readonly tcpClient: TcpClient;

	private cloudConfig: CyncCloudConfig | null = null;
	private readonly deviceIdToAccessory = new Map<string, PlatformAccessory>();
	private handleLanUpdate(update: unknown): void {
		// Parsed 0x83 frames from TcpClient.parseLanSwitchUpdate look like:
		// { controllerId: number, deviceId?: string, on: boolean, level: number }
		const payload = update as {
			deviceId?: string;
			on?: boolean;
			level?: number;
		};

		if (!payload || typeof payload.deviceId !== 'string') {
			return;
		}

		const accessory = this.deviceIdToAccessory.get(payload.deviceId);
		if (!accessory) {
			this.log.debug(
				'Cync: LAN update for unknown deviceId=%s; no accessory mapping',
				payload.deviceId,
			);
			return;
		}

		const Service = this.api.hap.Service;
		const Characteristic = this.api.hap.Characteristic;

		const lightService = accessory.getService(Service.Lightbulb);
		const switchService = accessory.getService(Service.Switch);
		const primaryService = lightService || switchService;

		if (!primaryService) {
			this.log.debug(
				'Cync: accessory %s has no Lightbulb or Switch service for deviceId=%s',
				accessory.displayName,
				payload.deviceId,
			);
			return;
		}

		// Update cached context state
		const ctx = accessory.context as CyncAccessoryContext;
		ctx.cync = ctx.cync ?? {
			meshId: '',
			deviceId: payload.deviceId,
		};

		// ----- On/off -----
		if (typeof payload.on === 'boolean') {
			ctx.cync.on = payload.on;

			this.log.info(
				'Cync: LAN update -> %s is now %s (deviceId=%s)',
				accessory.displayName,
				payload.on ? 'ON' : 'OFF',
				payload.deviceId,
			);

			primaryService.updateCharacteristic(Characteristic.On, payload.on);
		}

		// ----- Brightness (LAN "level" 0–100) -----
		if (typeof payload.level === 'number' && lightService) {
			const brightness = Math.max(
				0,
				Math.min(100, Math.round(payload.level)),
			);

			ctx.cync.brightness = brightness;

			this.log.debug(
				'Cync: LAN update -> %s brightness=%d (deviceId=%s)',
				accessory.displayName,
				brightness,
				payload.deviceId,
			);

			if (lightService.testCharacteristic(Characteristic.Brightness)) {
				lightService.updateCharacteristic(
					Characteristic.Brightness,
					brightness,
				);
			}
		}
	}

	private configureCyncSwitchAccessory(
		mesh: CyncDeviceMesh,
		device: CyncDevice,
		accessory: PlatformAccessory,
		deviceName: string,
		deviceId: string,
	): void {
		const service =
			accessory.getService(this.api.hap.Service.Switch) ||
			accessory.addService(this.api.hap.Service.Switch, deviceName);
		const existingLight = accessory.getService(this.api.hap.Service.Lightbulb);
		if (existingLight) {
			this.log.info(
				'Cync: removing stale Lightbulb service from %s (deviceId=%s) before configuring as Switch',
				deviceName,
				deviceId,
			);
			accessory.removeService(existingLight);
		}
		// Ensure context is initialized
		const ctx = accessory.context as CyncAccessoryContext;
		ctx.cync = ctx.cync ?? {
			meshId: mesh.id,
			deviceId,
			productId: device.product_id,
			on: false,
		};

		// Remember mapping for LAN updates
		this.deviceIdToAccessory.set(deviceId, accessory);

		service
			.getCharacteristic(this.api.hap.Characteristic.On)
			.onGet(() => {
				const currentOn = !!ctx.cync?.on;
				this.log.info(
					'Cync: On.get -> %s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return currentOn;
			})
			.onSet(async (value) => {
				const cyncMeta = ctx.cync;

				if (!cyncMeta?.deviceId) {
					this.log.warn(
						'Cync: Light On.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const on = value === true || value === 1;

				this.log.info(
					'Cync: Light On.set -> %s for %s (deviceId=%s)',
					String(on),
					deviceName,
					cyncMeta.deviceId,
				);

				cyncMeta.on = on;

				if (!on) {
					// Off is always a plain power packet
					await this.tcpClient.setSwitchState(cyncMeta.deviceId, { on: false });
					return;
				}

				// Turning on:
				// - If we were in color mode with a known RGB + brightness, restore color.
				// - Otherwise, just send a basic power-on packet.
				if (cyncMeta.colorActive && cyncMeta.rgb && typeof cyncMeta.brightness === 'number') {
					await this.tcpClient.setColor(cyncMeta.deviceId, cyncMeta.rgb, cyncMeta.brightness);
				} else {
					await this.tcpClient.setSwitchState(cyncMeta.deviceId, { on: true });
				}
			});
	}

	private configureCyncLightAccessory(
		mesh: CyncDeviceMesh,
		device: CyncDevice,
		accessory: PlatformAccessory,
		deviceName: string,
		deviceId: string,
	): void {
		// If this accessory used to be a switch, remove that service
		const existingSwitch = accessory.getService(this.api.hap.Service.Switch);
		if (existingSwitch) {
			this.log.info(
				'Cync: removing stale Switch service from %s (deviceId=%s) before configuring as Lightbulb',
				deviceName,
				deviceId,
			);
			accessory.removeService(existingSwitch);
		}

		const service =
			accessory.getService(this.api.hap.Service.Lightbulb) ||
			accessory.addService(this.api.hap.Service.Lightbulb, deviceName);

		// Optionally update accessory category so UIs treat it as a light
		if (accessory.category !== this.api.hap.Categories.LIGHTBULB) {
			accessory.category = this.api.hap.Categories.LIGHTBULB;
		}

		// NEW: populate Accessory Information from Cync metadata
		this.applyAccessoryInformationFromCyncDevice(accessory, device, deviceName, deviceId);

		// Ensure context is initialized
		const ctx = accessory.context as CyncAccessoryContext;
		ctx.cync = ctx.cync ?? {
			meshId: mesh.id,
			deviceId,
			productId: device.product_id,
			on: false,
		};

		// Remember mapping for LAN updates
		this.deviceIdToAccessory.set(deviceId, accessory);

		const Characteristic = this.api.hap.Characteristic;

		// ----- On/Off -----
		service
			.getCharacteristic(Characteristic.On)
			.onGet(() => {
				const currentOn = !!ctx.cync?.on;
				this.log.info(
					'Cync: Light On.get -> %s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return currentOn;
			})
			.onSet(async (value) => {
				const cyncMeta = ctx.cync;

				if (!cyncMeta?.deviceId) {
					this.log.warn(
						'Cync: Light On.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const on = value === true || value === 1;

				this.log.info(
					'Cync: Light On.set -> %s for %s (deviceId=%s)',
					String(on),
					deviceName,
					cyncMeta.deviceId,
				);

				// Optimistic local cache; LAN update will confirm
				cyncMeta.on = on;

				await this.tcpClient.setSwitchState(cyncMeta.deviceId, { on });
			});

		// ----- Brightness (dimming via LAN combo_control) -----
		service
			.getCharacteristic(Characteristic.Brightness)
			.onGet(() => {
				const current = ctx.cync?.brightness;

				// If we have a cached LAN level, use it; otherwise infer from On.
				if (typeof current === 'number') {
					return current;
				}

				const on = ctx.cync?.on ?? false;
				return on ? 100 : 0;
			})
			.onSet(async (value) => {
				const cyncMeta = ctx.cync;

				if (!cyncMeta?.deviceId) {
					this.log.warn(
						'Cync: Light Brightness.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const brightness = Math.max(
					0,
					Math.min(100, Number(value)),
				);

				if (!Number.isFinite(brightness)) {
					this.log.warn(
						'Cync: Light Brightness.set received invalid value=%o for %s (deviceId=%s)',
						value,
						deviceName,
						cyncMeta.deviceId,
					);
					return;
				}

				// Optimistic cache
				cyncMeta.brightness = brightness;
				cyncMeta.on = brightness > 0;

				this.log.info(
					'Cync: Light Brightness.set -> %d for %s (deviceId=%s)',
					brightness,
					deviceName,
					cyncMeta.deviceId,
				);

				// If we're in "color mode", keep the existing RGB and scale brightness via setColor();
				// otherwise treat this as a white-brightness change.
				if (cyncMeta.colorActive && cyncMeta.rgb) {
					await this.tcpClient.setColor(cyncMeta.deviceId, cyncMeta.rgb, brightness);
				} else {
					await this.tcpClient.setBrightness(cyncMeta.deviceId, brightness);
				}
			});
		// ----- Hue -----
		service
			.getCharacteristic(Characteristic.Hue)
			.onGet(() => {
				const hue = ctx.cync?.hue;
				if (typeof hue === 'number') {
					return hue;
				}
				// Default to 0° (red) if we have no color history
				return 0;
			})
			.onSet(async (value) => {
				const cyncMeta = ctx.cync;

				if (!cyncMeta?.deviceId) {
					this.log.warn(
						'Cync: Light Hue.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const hue = Math.max(0, Math.min(360, Number(value)));
				if (!Number.isFinite(hue)) {
					this.log.warn(
						'Cync: Light Hue.set received invalid value=%o for %s (deviceId=%s)',
						value,
						deviceName,
						cyncMeta.deviceId,
					);
					return;
				}

				// Use cached saturation/brightness if available, otherwise sane defaults
				const saturation = typeof cyncMeta.saturation === 'number'
					? cyncMeta.saturation
					: 100;

				const brightness = typeof cyncMeta.brightness === 'number'
					? cyncMeta.brightness
					: 100;

				const rgb = hsvToRgb(hue, saturation, brightness);

				// Optimistic cache
				cyncMeta.hue = hue;
				cyncMeta.saturation = saturation;
				cyncMeta.rgb = rgb;
				cyncMeta.colorActive = true;
				cyncMeta.on = brightness > 0;
				cyncMeta.brightness = brightness;

				this.log.info(
					'Cync: Light Hue.set -> %d for %s (deviceId=%s) -> rgb=(%d,%d,%d) brightness=%d',
					hue,
					deviceName,
					cyncMeta.deviceId,
					rgb.r,
					rgb.g,
					rgb.b,
					brightness,
				);

				await this.tcpClient.setColor(cyncMeta.deviceId, rgb, brightness);
			});

		// ----- Saturation -----
		service
			.getCharacteristic(Characteristic.Saturation)
			.onGet(() => {
				const sat = ctx.cync?.saturation;
				if (typeof sat === 'number') {
					return sat;
				}
				return 100;
			})
			.onSet(async (value) => {
				const cyncMeta = ctx.cync;

				if (!cyncMeta?.deviceId) {
					this.log.warn(
						'Cync: Light Saturation.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const saturation = Math.max(0, Math.min(100, Number(value)));
				if (!Number.isFinite(saturation)) {
					this.log.warn(
						'Cync: Light Saturation.set received invalid value=%o for %s (deviceId=%s)',
						value,
						deviceName,
						cyncMeta.deviceId,
					);
					return;
				}

				const hue = typeof cyncMeta.hue === 'number'
					? cyncMeta.hue
					: 0;

				const brightness = typeof cyncMeta.brightness === 'number'
					? cyncMeta.brightness
					: 100;

				const rgb = hsvToRgb(hue, saturation, brightness);

				// Optimistic cache
				cyncMeta.hue = hue;
				cyncMeta.saturation = saturation;
				cyncMeta.rgb = rgb;
				cyncMeta.colorActive = true;
				cyncMeta.on = brightness > 0;
				cyncMeta.brightness = brightness;

				this.log.info(
					'Cync: Light Saturation.set -> %d for %s (deviceId=%s) -> rgb=(%d,%d,%d) brightness=%d',
					saturation,
					deviceName,
					cyncMeta.deviceId,
					rgb.r,
					rgb.g,
					rgb.b,
					brightness,
				);

				await this.tcpClient.setColor(cyncMeta.deviceId, rgb, brightness);
			});
	}

	private applyAccessoryInformationFromCyncDevice(
		accessory: PlatformAccessory,
		device: CyncDevice,
		deviceName: string,
		deviceId: string,
	): void {
		const infoService = accessory.getService(this.api.hap.Service.AccessoryInformation);
		if (!infoService) {
			return;
		}

		const Characteristic = this.api.hap.Characteristic;
		const deviceWithRaw = device as CyncDeviceWithRaw;
		const rawDevice = deviceWithRaw.raw ?? {};

		// Name: keep in sync with how we present the accessory
		const name = deviceName || accessory.displayName;
		infoService.updateCharacteristic(Characteristic.Name, name);

		// Manufacturer: fixed for all Cync devices
		infoService.updateCharacteristic(Characteristic.Manufacturer, 'GE Lighting');

		// Model: use the device's displayName + type if available
		const modelBase =
			typeof rawDevice.displayName === 'string' && rawDevice.displayName.trim().length > 0
				? rawDevice.displayName.trim()
				: 'Cync Device';

		const modelSuffix =
			typeof rawDevice.deviceType === 'number'
				? ` (Type ${rawDevice.deviceType})`
				: '';

		infoService.updateCharacteristic(
			Characteristic.Model,
			modelBase + modelSuffix,
		);

		// Serial: prefer wifiMac, then mac, then deviceID, then the string deviceId
		const serial =
			(typeof rawDevice.wifiMac === 'string' && rawDevice.wifiMac.trim().length > 0)
				? rawDevice.wifiMac.trim()
				: (typeof rawDevice.mac === 'string' && rawDevice.mac.trim().length > 0)
					? rawDevice.mac.trim()
					: (rawDevice.deviceID !== undefined
						? String(rawDevice.deviceID)
						: deviceId);

		infoService.updateCharacteristic(Characteristic.SerialNumber, serial);

		// Firmware revision, if present
		if (typeof rawDevice.firmwareVersion === 'string' && rawDevice.firmwareVersion.trim().length > 0) {
			infoService.updateCharacteristic(
				Characteristic.FirmwareRevision,
				rawDevice.firmwareVersion.trim(),
			);
		}
	}

	constructor(log: Logger, config: PlatformConfig, api: API) {
		this.log = log;
		this.config = config;
		this.api = api;

		// Extract login config from platform config
		const raw = this.config as Record<string, unknown>;

		// Canonical config keys: username, password, twoFactor
		const username =
			typeof raw.username === 'string'
				? raw.username
				: typeof raw.email === 'string'
					? raw.email
					: '';

		const password =
			typeof raw.password === 'string'
				? raw.password
				: '';

		const twoFactor =
			typeof raw.twoFactor === 'string'
				? raw.twoFactor
				: undefined;

		const cyncLogger = toCyncLogger(this.log);
		const tcpClient = new TcpClient(cyncLogger);

		this.client = new CyncClient(
			new ConfigClient(cyncLogger),
			tcpClient,
			{
				username,
				password,
				twoFactor,
			},
			this.api.user.storagePath(),
			cyncLogger,
		);

		this.tcpClient = tcpClient;

		// Bridge LAN updates into Homebridge
		this.client.onLanDeviceUpdate((update) => {
			this.handleLanUpdate(update);
		});

		this.log.info(this.config.name ?? PLATFORM_NAME, 'initialized');

		this.api.on('didFinishLaunching', () => {
			this.log.info(PLATFORM_NAME, 'didFinishLaunching');
			void this.loadCync();
		});
	}

	private async loadCync(): Promise<void> {
		try {
			const raw = this.config as Record<string, unknown>;

			const username =
				typeof raw.username === 'string'
					? raw.username
					: typeof raw.email === 'string'
						? raw.email
						: '';

			const password =
				typeof raw.password === 'string'
					? raw.password
					: '';

			if (!username || !password) {
				this.log.warn('Cync: credentials missing in config.json; skipping cloud login.');
				return;
			}

			// Let CyncClient handle 2FA bootstrap + token persistence.
			const loggedIn = await this.client.ensureLoggedIn();
			if (!loggedIn) {
				// We either just requested a 2FA code or hit a credential error.
				// In the "code requested" case, the log already tells the user
				// to add it to config and restart.
				return;
			}

			const cloudConfig = await this.client.loadConfiguration();
			this.cloudConfig = cloudConfig;

			this.log.info(
				'Cync: cloud configuration loaded; mesh count=%d',
				cloudConfig.meshes.length,
			);

			// Ask the CyncClient for the LAN login code derived from stored session.
			let loginCode: Uint8Array = new Uint8Array();
			try {
				loginCode = this.client.getLanLoginCode();
			} catch (err) {
				this.log.warn(
					'Cync: getLanLoginCode() failed: %s',
					(err as Error).message ?? String(err),
				);
			}

			if (loginCode.length > 0) {
				this.log.info(
					'Cync: LAN login code available (%d bytes); starting TCP transport…',
					loginCode.length,
				);

				await this.client.startTransport(cloudConfig, loginCode);
			} else {
				this.log.info(
					'Cync: LAN login code unavailable; TCP control disabled (cloud-only).',
				);
			}

			this.discoverDevices(cloudConfig);

		} catch (err) {
			this.log.error(
				'Cync: cloud login failed: %s',
				(err as Error).message ?? String(err),
			);
		}
	}

	private discoverDevices(cloudConfig: CyncCloudConfig): void {
		if (!cloudConfig.meshes?.length) {
			this.log.warn('Cync: no meshes returned from cloud; nothing to discover.');
			return;
		}

		for (const mesh of cloudConfig.meshes) {
			const meshName = mesh.name || mesh.id;
			this.log.info('Cync: processing mesh %s', meshName);

			const devices = mesh.devices ?? [];
			if (!devices.length) {
				this.log.info('Cync: mesh %s has no devices.', meshName);
				continue;
			}

			for (const device of devices) {
				const deviceId =
					(device.device_id as string | undefined) ??
					(device.id as string) ??
					(device.mac as string | undefined) ??
					(device.sn as string | undefined) ??
					`${mesh.id}-${device.product_id ?? 'unknown'}`;

				const preferredName =
					(device.name as string | undefined) ??
					(device.displayName as string | undefined) ??
					undefined;

				const deviceName = preferredName || `Cync Device ${deviceId}`;
				const uuidSeed = `cync-${mesh.id}-${deviceId}`;
				const uuid = this.api.hap.uuid.generate(uuidSeed);

				let accessory = this.accessories.find(acc => acc.UUID === uuid);

				if (accessory) {
					this.log.info('Cync: using cached accessory for %s (%s)', deviceName, uuidSeed);
				} else {
					this.log.info('Cync: registering new accessory for %s (%s)', deviceName, uuidSeed);

					accessory = new this.api.platformAccessory(deviceName, uuid);

					this.api.registerPlatformAccessories(
						'homebridge-cync-app',
						'CyncAppPlatform',
						[accessory],
					);

					this.accessories.push(accessory);
				}

				// Decide how to expose this device in HomeKit based on device_type / raw.deviceType
				const typedDevice = device as unknown as {
					device_type?: number;
					raw?: { deviceType?: number | string };
				};

				let deviceType: number | undefined;

				if (typeof typedDevice.device_type === 'number') {
					deviceType = typedDevice.device_type;
				} else if (typedDevice.raw && typeof typedDevice.raw.deviceType === 'number') {
					deviceType = typedDevice.raw.deviceType;
				} else if (
					typedDevice.raw &&
					typeof typedDevice.raw.deviceType === 'string' &&
					typedDevice.raw.deviceType.trim() !== ''
				) {
					const parsed = Number(typedDevice.raw.deviceType);
					if (!Number.isNaN(parsed)) {
						deviceType = parsed;
					}
				}

				const isDownlight = deviceType === 46;

				if (isDownlight) {
					this.log.info(
						'Cync: configuring %s as Lightbulb (deviceType=%s, deviceId=%s)',
						deviceName,
						String(deviceType),
						deviceId,
					);
					this.configureCyncLightAccessory(mesh, device, accessory, deviceName, deviceId);
				} else {
					this.log.info(
						'Cync: configuring %s as Switch (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceType ?? 'unknown',
						deviceId,
					);
					this.configureCyncSwitchAccessory(mesh, device, accessory, deviceName, deviceId);
				}
			}
		}
	}
}
