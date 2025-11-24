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
	};
	[key: string]: unknown;
}

/**
 * CyncAppPlatform
 *
 * Homebridge platform class responsible for:
 * - Initializing the Cync client
 * - Managing cached accessories
 * - Kicking off device discovery from Cync cloud
 */
export class CyncAppPlatform implements DynamicPlatformPlugin {
	public readonly accessories: PlatformAccessory[] = [];

	private readonly log: Logger;
	private readonly api: API;
	private readonly config: PlatformConfig;
	private readonly client: CyncClient;

	private cloudConfig: CyncCloudConfig | null = null;

	constructor(log: Logger, config: PlatformConfig, api: API) {
		this.log = log;
		this.config = config;
		this.api = api;

		// Extract login config from platform config
		const cfg = this.config as Record<string, unknown>;
		const username = (cfg.username ?? cfg.email) as string | undefined;
		const password = cfg.password as string | undefined;
		const twoFactor = cfg.twoFactor as string | undefined;

		// Initialize the Cync client with platform logger so all messages
		// appear in the Homebridge log.
		this.client = new CyncClient(
			new ConfigClient(toCyncLogger(this.log)),
			new TcpClient(toCyncLogger(this.log)),
			{
				email: username ?? '',
				password: password ?? '',
				twoFactor,
			},
			this.api.user.storagePath(),
			toCyncLogger(this.log),
		);

		this.log.info(this.config.name ?? PLATFORM_NAME, 'initialized');

		this.api.on('didFinishLaunching', () => {
			this.log.info(PLATFORM_NAME, 'didFinishLaunching');
			void this.loadCync();
		});
	}

	/**
	 * Called when cached accessories are restored from disk.
	 */
	configureAccessory(accessory: PlatformAccessory): void {
		this.log.info('Restoring cached accessory', accessory.displayName);
		this.accessories.push(accessory);
	}

	private async loadCync(): Promise<void> {
		try {
			const cfg = this.config as Record<string, unknown>;
			const username = (cfg.username ?? cfg.email) as string | undefined;
			const password = cfg.password as string | undefined;

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
				cloudConfig?.meshes?.length ?? 0,
			);

			this.discoverDevices(cloudConfig);
		} catch (err) {
			this.log.error(
				'Cync: cloud login failed: %s',
				(err as Error).message ?? String(err),
			);
		}
	}

	/**
	 * Discover devices from the Cync cloud config and register them as
	 * Homebridge accessories. For now, each device is exposed as a simple
	 * dummy Switch that logs state changes.
	 */
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
				const deviceId = `${device.id ??
					device.device_id ??
					device.mac ??
					device.sn ??
					`${mesh.id}-${device.product_id ?? 'unknown'}`}`;

				const preferredName =
					(device.name as string | undefined) ??
					(device.displayName as string | undefined) ??
					undefined;

				const deviceName = preferredName || `Cync Device ${deviceId}`;
				const uuidSeed = `cync-${mesh.id}-${deviceId}`;
				const uuid = this.api.hap.uuid.generate(uuidSeed);

				const existing = this.accessories.find(acc => acc.UUID === uuid);
				if (existing) {
					this.log.info('Cync: using cached accessory for %s (%s)', deviceName, uuidSeed);
					continue;
				}

				this.log.info('Cync: registering new accessory for %s (%s)', deviceName, uuidSeed);

				const accessory = new this.api.platformAccessory(deviceName, uuid);

				// Simple Switch service for now
				const service =
					accessory.getService(this.api.hap.Service.Switch) ||
					accessory.addService(this.api.hap.Service.Switch, deviceName);

				service
					.getCharacteristic(this.api.hap.Characteristic.On)
					.onGet(() => {
						this.log.info('Cync: On.get -> false for %s', deviceName);
						return false;
					})
					.onSet((value) => {
						this.log.info('Cync: On.set -> %s for %s', String(value), deviceName);
					});

				// Context for later TCP control
				const ctx = accessory.context as CyncAccessoryContext;
				ctx.cync = {
					meshId: mesh.id,
					deviceId,
					productId: device.product_id,
				};

				this.api.registerPlatformAccessories(
					'homebridge-cync-app',
					'CyncAppPlatform',
					[accessory],
				);

				this.accessories.push(accessory);
			}
		}
	}
}
