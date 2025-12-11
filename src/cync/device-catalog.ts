// src/cync/device-catalog.ts

import type { Categories } from 'homebridge';

export interface CyncDeviceModel {
	/** Raw deviceType from the Cync API */
	deviceType: number;

	/** Model name as shown in the Cync app (what you want HomeKit to show) */
	modelName: string;

	/** Optional marketing / retail name if you want to surface it somewhere else */
	marketingName?: string;

	/** Optional suggested HomeKit category override */
	defaultCategory?: Categories;

	/** Free-form notes for you / debugging */
	notes?: string;
}

/**
 * Device catalog keyed by deviceType.
 * Extend this as you discover more types.
 */
export const DEVICE_CATALOG: Record<number, CyncDeviceModel> = {
	46: {
		deviceType: 46,
		modelName: '6" Recessed Can Retrofit Fixture (Matter)',
		marketingName: 'Cync reveal HD+',
		// defaultCategory: Categories.LIGHTBULB,
	},
	64: {
		deviceType: 64,
		modelName: 'Indoor Smart Plug',
		marketingName: 'On/Off Smart Plug',
		// defaultCategory: Categories.OUTLET,
	},
	65: {
		deviceType: 65,
		modelName: 'Indoor Smart Plug',
		marketingName: 'Cync Indoor Plug',
		// defaultCategory: Categories.OUTLET,
	},
	172: {
		deviceType: 172,
		modelName: 'Indoor Smart Plug (3in1)',
		marketingName: 'Cync Indoor Smart Plug',
		// defaultCategory: Categories.OUTLET,
	},
};

export function lookupDeviceModel(deviceType: number): CyncDeviceModel | undefined {
	return DEVICE_CATALOG[deviceType];
}
