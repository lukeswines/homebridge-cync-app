// homebridge-ui/server.js
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { ConfigClient } from '../dist/cync/config-client.js';
import { CyncTokenStore } from '../dist/cync/token-store.js';

class CyncUiServer extends HomebridgePluginUiServer {
	constructor() {
		super();

		this.configClient = new ConfigClient({
			debug: (...a) => console.debug('[cync-ui-config]', ...a),
			info:  (...a) => console.info('[cync-ui-config]', ...a),
			warn:  (...a) => console.warn('[cync-ui-config]', ...a),
			error: (...a) => console.error('[cync-ui-config]', ...a),
		});

		this.tokenStore = new CyncTokenStore(this.homebridgeStoragePath);

		this.onRequest('/request-otp', this.handleRequestOtp.bind(this));
		this.onRequest('/sign-out', this.handleSignOut.bind(this));
		this.onRequest('/status', this.handleStatus.bind(this));

		this.ready();
	}

	async handleRequestOtp(payload) {
		const email = typeof payload?.email === 'string' ? payload.email.trim() : '';
		if (!email) {
			return { ok: false, error: 'Missing email' };
		}

		await this.configClient.sendTwoFactorCode(email);
		return { ok: true };
	}

	// Delete token file
	async handleSignOut() {
		await this.tokenStore.clear();
		return { ok: true };
	}

	// Report whether a token exists
	async handleStatus() {
		try {
			const token = await this.tokenStore.load();
			if (!token) {
				return { ok: true, hasToken: false };
			}
			return {
				ok: true,
				hasToken: true,
				userId: token.userId,
				expiresAt: token.expiresAt ?? null,
			};
		} catch {
			// On error, just say "no token"
			return { ok: true, hasToken: false };
		}
	}
}

(() => new CyncUiServer())();
