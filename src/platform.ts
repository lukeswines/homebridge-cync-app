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
	private readonly tcpClient: TcpClient;

	private cloudConfig: CyncCloudConfig | null = null;
	private readonly deviceIdToAccessory = new Map<string, PlatformAccessory>();
	private handleLanUpdate(update: unknown): void {
		// We only care about parsed 0x83 frames that look like:
		// { controllerId: number, on: boolean, level: number, deviceId?: string }
		const payload = update as { deviceId?: string; on?: boolean };

		if (!payload || typeof payload.deviceId !== 'string' || typeof payload.on !== 'boolean') {
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

		const service = accessory.getService(this.api.hap.Service.Switch);
		if (!service) {
			this.log.debug(
				'Cync: accessory %s has no Switch service for deviceId=%s',
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
		ctx.cync.on = payload.on;

		this.log.info(
			'Cync: LAN update -> %s is now %s (deviceId=%s)',
			accessory.displayName,
			payload.on ? 'ON' : 'OFF',
			payload.deviceId,
		);

		// Push the new state into HomeKit
		service.updateCharacteristic(this.api.hap.Characteristic.On, payload.on);
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
						'Cync: On.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const on = value === true || value === 1;

				this.log.info(
					'Cync: On.set -> %s for %s (deviceId=%s)',
					String(on),
					deviceName,
					cyncMeta.deviceId,
				);

				// Optimistic local cache; LAN update will confirm
				cyncMeta.on = on;

				await this.tcpClient.setSwitchState(cyncMeta.deviceId, { on });
			});
	}

	constructor(log: Logger, config: PlatformConfig, api: API) {
		this.log = log;
		this.config = config;
		this.api = api;

		// Extract login config from platform config
		const cfg = this.config as Record<string, unknown>;
		const username = (cfg.username ?? cfg.email) as string | undefined;
		const password = cfg.password as string | undefined;
		const twoFactor = cfg.twoFactor as string | undefined;

		const cyncLogger = toCyncLogger(this.log);
		const tcpClient = new TcpClient(cyncLogger);

		this.client = new CyncClient(
			new ConfigClient(cyncLogger),
			tcpClient,
			{
				email: username ?? '',
				password: password ?? '',
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
				cloudConfig.meshes.length,
			);

			// Ask the CyncClient for the LAN login code derived from stored session.
			// If it returns an empty blob, LAN is disabled but cloud still works.
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

				// ### 🧩 LAN Transport Bootstrap: wire frame listeners via CyncClient
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

	/**
	 * Discover devices from the Cync cloud config and register them as
	 * Homebridge accessories.
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

				this.configureCyncSwitchAccessory(mesh, device, accessory, deviceName, deviceId);
			}
		}
	}

}
