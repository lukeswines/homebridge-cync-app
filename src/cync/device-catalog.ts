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
	// Legacy C by GE On/Off Smart Plug — original hardware
	64: {
		deviceType: 64,
		modelName: 'Indoor Smart Plug (CPLGSTDBLW1)',
		marketingName: 'On/Off Smart Plug (CPLGSTDBLW1)',
		notes: 'Legacy C by GE plug. FCC ID PUU-CPLGSTDBLW1. Original hardware revision. Final firmware 1.x.',
		// defaultCategory: Categories.OUTLET,
	},
	// Legacy C by GE On/Off Smart Plug — revised hardware ("T" revision)
	65: {
		deviceType: 65,
		modelName: 'Indoor Smart Plug (CPLGSTDBLW1-T)',
		marketingName: 'On/Off Smart Plug (CPLGSTDBLW1-T)',
		notes: 'Legacy C by GE plug. FCC ID PUU-CPLGSTDBLW1T / HVIN CPLGSTDBLW1T. Revised hardware. Final firmware 2.x.',
		// defaultCategory: Categories.OUTLET,
	},
	137: {
		deviceType: 137,
		modelName: 'A19 Full Color Direct Connect Smart Bulb (3-in-1)',
		marketingName: 'GE Cync A19 Smart LED Light Bulb, Color Changing Smart WiFi Light',
		notes: 'Reported by users as full color + dimming bulbs; must be Lightbulb, not Switch.',
	},
	171: {
		deviceType: 171,
		modelName: 'A19 Full Color Direct Connect Smart Bulb (3-in-1)',
		marketingName: 'GE Cync A19 Smart LED Light Bulb, Color Changing Smart WiFi Light',
		notes: 'Reported alongside deviceType=137 in the same home; appears to be same class of bulb.',
	},
	172: {
		deviceType: 172,
		modelName: 'Indoor Smart Plug (3in1)',
		marketingName: 'Cync Indoor Smart Plug',
		notes: 'Matter-capable hardware. Replaces legacy C by GE On/Off Smart Plug.',
		// defaultCategory: Categories.OUTLET,
	},
};

export function lookupDeviceModel(deviceType: number): CyncDeviceModel | undefined {
	return DEVICE_CATALOG[deviceType];
}
