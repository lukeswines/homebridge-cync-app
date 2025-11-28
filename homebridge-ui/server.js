// homebridge-ui/server.js
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import fetch from 'node-fetch';

class PluginUiServer extends HomebridgePluginUiServer {
	constructor() {
		super();

		this.onRequest('/requestCode', this.handleRequestCode.bind(this));
		this.onRequest('/login', this.handleLogin.bind(this));

		// Tell Homebridge UI that we’re ready
		this.ready();
	}

	// Request a 2FA code via email
	async handleRequestCode(payload) {
		const email = (payload?.emailAddress || '').trim();
		if (!email) {
			throw new Error('Email address is required to request a 2FA code.');
		}

		const requestBody = {
			corp_id: '1007d2ad150c4000',
			email,
			local_lang: 'en-us',
		};

		await fetch(
			'https://api.gelighting.com/v2/two_factor/email/verifycode',
			{
				method: 'POST',
				body: JSON.stringify(requestBody),
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Validate email + password + 2FA against Cync and return platform config
	async handleLogin(payload) {
		const email = (payload?.emailAddress || '').trim();
		const password = (payload?.password || '').trim();
		const mfaCode = (payload?.mfaCode || '').trim();

		if (!email || !password || !mfaCode) {
			return {
				error: 'Email, password, and 2FA code are required.',
			};
		}

		const requestBody = {
			corp_id: '1007d2ad150c4000',
			email,
			password,
			two_factor: mfaCode,
			resource: 'abcdefghijk',
		};

		try {
			const response = await fetch(
				'https://api.gelighting.com/v2/user_auth/two_factor',
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
					headers: { 'Content-Type': 'application/json' },
				},
			);

			const data = await response.json();
			if (data && data.error) {
				return {
					error:
						'Login failed. Please check your password and 2FA code.',
				};
			}
		} catch (err) {
			console.error('[cync-ui] Login request failed:', err);
			return {
				error:
					'Login failed due to a network or server error. Please try again.',
			};
		}

		// At this point, Cync accepted the credentials.
		// Return the platform config that your platform.ts expects.
		return {
			platform: 'CyncAppPlatform',
			name: 'Cync App',
			username: email,
			password,
			twoFactor: mfaCode,
		};
	}
}

// Start the instance
(() => new PluginUiServer())();
