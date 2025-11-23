import type { API } from 'homebridge';

import { CyncAppPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Homebridge entry point.
 * Registers the CyncAppPlatform with Homebridge under PLATFORM_NAME.
 */
export default (api: API) => {
	api.registerPlatform(PLATFORM_NAME, CyncAppPlatform);
};
