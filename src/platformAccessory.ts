// src/cync/PlatformAccessory.ts

import type { PlatformAccessory } from 'homebridge';
import type { CyncAppPlatform } from './platform.js';

/**
 * CyncAccessory
 *
 * Placeholder accessory class for future Cync devices.
 * Currently unused; exists only to provide a typed scaffold.
 */
export class CyncAccessory {
	constructor(
		private readonly platform: CyncAppPlatform,
		private readonly accessory: PlatformAccessory,
	) {
		// TODO: implement Cync-specific services and characteristics.
		// This placeholder exists to keep the project compiling during early scaffolding.
	}
}
