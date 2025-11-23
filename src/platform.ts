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
import { TcpClient } from './cync/tcp-client.js';

/**
 * CyncAppPlatform
 *
 * Homebridge platform class responsible for:
 * - Initializing the Cync client
 * - Managing cached accessories
 * - Kicking off device discovery (future work)
 */
export class CyncAppPlatform implements DynamicPlatformPlugin {
	public readonly accessories: PlatformAccessory[] = [];

	private readonly log: Logger;
	private readonly api: API;
	private readonly config: PlatformConfig;
	private readonly client: CyncClient;

	constructor(log: Logger, config: PlatformConfig, api: API) {
		this.log = log;
		this.config = config;
		this.api = api;

		// Initialize the Cync client with placeholder instances.
		// These will be extended to use real configuration and TCP logic.
		this.client = new CyncClient(
	  new ConfigClient(),
	  new TcpClient(),
		);

		this.log.info(this.config.name ?? PLATFORM_NAME, 'initialized');

		this.api.on('didFinishLaunching', () => {
			this.log.info(PLATFORM_NAME, 'didFinishLaunching');
			this.discoverDevices();
	  // Device discovery and client bootstrap will be added here.
		});
	}

	/**
	 * Called when cached accessories are restored from disk.
	 * For now, accessories are simply tracked in memory.
	 */
	configureAccessory(accessory: PlatformAccessory) {
		this.log.info('Restoring cached accessory', accessory.displayName);
		this.accessories.push(accessory);
	}
	// 🧩 Dummy Device Discovery: Registers a fake accessory to test platform wiring
	private discoverDevices(): void {
		// Pretend we discovered a single device from the Cync cloud
		const uuid = this.api.hap.uuid.generate('cync-dev-dummy-switch-1');
		const existing = this.accessories.find(acc => acc.UUID === uuid);
	
		if (existing) {
			this.log.info('Using cached dummy accessory:', existing.displayName);
			return;
		}
	
		const accessory = new this.api.platformAccessory('Cync Dummy Switch', uuid);
	
		// Simple Switch service just to prove wiring works
		const service = accessory
			.getService(this.api.hap.Service.Switch)
			|| accessory.addService(this.api.hap.Service.Switch, 'Dummy Switch');
	
		service
			.getCharacteristic(this.api.hap.Characteristic.On)
			.onGet(() => {
				this.log.info('Dummy Switch On.get -> false');
				return false;
			})
			.onSet((value) => {
				this.log.info('Dummy Switch On.set ->', value);
			});
	
		this.log.info('Registering new dummy accessory with Homebridge');
		this.api.registerPlatformAccessories('homebridge-cync-app', 'CyncAppPlatform', [accessory]);
		this.accessories.push(accessory);
	}
}
