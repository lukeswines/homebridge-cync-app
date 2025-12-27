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
import type { CyncCloudConfig } from './cync/config-client.js';
import { TcpClient } from './cync/tcp-client.js';
import type { CyncLogger } from './cync/config-client.js';
import {
	type CyncAccessoryContext,
	type CyncAccessoryEnv,
	resolveDeviceType,
} from './cync/cync-accessory-helpers.js';
import { configureCyncLightAccessory } from './cync/cync-light-accessory.js';
import { configureCyncSwitchAccessory } from './cync/cync-switch-accessory.js';

const toCyncLogger = (log: Logger): CyncLogger => ({
	debug: log.debug.bind(log),
	info: log.info.bind(log),
	warn: log.warn.bind(log),
	error: log.error.bind(log),
});

function isCyncLightDeviceType(deviceType: number | undefined): boolean {
	return deviceType === 46 || deviceType === 137 || deviceType === 171;
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
	private readonly accessoryEnv: CyncAccessoryEnv;

	private cloudConfig: CyncCloudConfig | null = null;
	private readonly deviceIdToAccessory = new Map<string, PlatformAccessory>();
	private readonly deviceLastSeen = new Map<string, number>();
	private readonly devicePollTimers = new Map<string, NodeJS.Timeout>();

	private readonly offlineTimeoutMs = 30 * 60 * 1000;
	private readonly pollIntervalMs = 60_000; // 60 seconds

	private markDeviceSeen(deviceId: string): void {
		this.deviceLastSeen.set(deviceId, Date.now());
	}

	private isDeviceProbablyOffline(deviceId: string): boolean {
		const last = this.deviceLastSeen.get(deviceId);
		if (!last) {
			// No data yet; treat as online until we know better
			return false;
		}
		return Date.now() - last > this.offlineTimeoutMs;
	}

	private startPollingDevice(deviceId: string): void {
		// For now this is just a placeholder hook. We keep a timer per device so
		// you can later add a real poll (e.g. TCP “ping” or cloud get) here if you want.
		const existing = this.devicePollTimers.get(deviceId);
		if (existing) {
			clearInterval(existing);
		}

		const timer = setInterval(() => {
			// Optional future hook:
			// - Call a "getDeviceState" or similar on tcpClient/client
			// - On success, call this.markDeviceSeen(deviceId)
			// - On failure, optionally log or mark offline
		}, this.pollIntervalMs);

		this.devicePollTimers.set(deviceId, timer);
	}

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
		this.markDeviceSeen(payload.deviceId);
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
		this.accessoryEnv = {
		  log: this.log,
		  api: this.api,
		  tcpClient: this.tcpClient,
		  isDeviceProbablyOffline: this.isDeviceProbablyOffline.bind(this),
		  markDeviceSeen: this.markDeviceSeen.bind(this),
		  startPollingDevice: this.startPollingDevice.bind(this),
		  registerAccessoryForDevice: (deviceId, accessory) => {
		    this.deviceIdToAccessory.set(deviceId, accessory);
		  },
		};
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

				const deviceType = resolveDeviceType(device);
				const deviceTypeStr =
					typeof deviceType === 'number' ? String(deviceType) : 'unknown';

				if (isCyncLightDeviceType(deviceType)) {
					this.log.info(
						'Cync: configuring %s as Lightbulb (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					configureCyncLightAccessory(
						this.accessoryEnv,
						mesh,
						device,
						accessory,
						deviceName,
						deviceId,
					);
				} else {
					this.log.info(
						'Cync: configuring %s as Switch (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					configureCyncSwitchAccessory(
						this.accessoryEnv,
						mesh,
						device,
						accessory,
						deviceName,
						deviceId,
					);
				}
			}
		}
	}
}
