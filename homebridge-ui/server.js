// homebridge-ui/server.js
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import fetch from 'node-fetch';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

class PluginUiServer extends HomebridgePluginUiServer {
	constructor() {
		super();

		this.onRequest('/requestCode', this.handleRequestCode.bind(this));
		this.onRequest('/login', this.handleLogin.bind(this));

		this.ready();
	}

	// Resolve the Homebridge storage path for the token store
	getStoragePath() {
		if (this.homebridgeStoragePath && typeof this.homebridgeStoragePath === 'string') {
			return this.homebridgeStoragePath;
		}
		if (this.homebridgeConfigPath && typeof this.homebridgeConfigPath === 'string') {
			return path.dirname(this.homebridgeConfigPath);
		}
		throw new Error('Unable to resolve Homebridge storage path from UI server.');
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

		const res = await fetch(
			'https://api.gelighting.com/v2/two_factor/email/verifycode',
			{
				method: 'POST',
				body: JSON.stringify(requestBody),
				headers: { 'Content-Type': 'application/json' },
			},
		);

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(
				`Requesting 2FA code failed: HTTP ${res.status} ${res.statusText} ${text}`,
			);
		}
	}

	// Utility: random resource string (mirrors ConfigClient.randomLoginResource)
	randomLoginResource() {
		const chars = 'abcdefghijklmnopqrstuvwxyz';
		let out = '';
		for (let i = 0; i < 16; i += 1) {
			out += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return out;
	}

	// Build the LAN login code (same framing as ConfigClient.buildLanLoginCode)
	buildLanLoginCode(authorize, userId) {
		const authBytes = Buffer.from(authorize, 'ascii');
		const lengthByte = 10 + authBytes.length;

		if (lengthByte > 0xff) {
			throw new Error('Cync LAN authorize token too long to encode.');
		}

		const userIdNum = Number.parseInt(String(userId), 10);
		if (!Number.isFinite(userIdNum) || userIdNum < 0) {
			throw new Error(`Invalid Cync userId for LAN auth: ${userId}`);
		}

		const header = Buffer.from('13000000', 'hex');

		const lenBuf = Buffer.alloc(1);
		lenBuf.writeUInt8(lengthByte & 0xff, 0);

		const cmdBuf = Buffer.from('03', 'hex');

		const userIdBuf = Buffer.alloc(4);
		userIdBuf.writeUInt32BE(userIdNum >>> 0, 0);

		const authLenBuf = Buffer.alloc(2);
		authLenBuf.writeUInt16BE(authBytes.length, 0);

		const tail = Buffer.from('0000b4', 'hex');

		return Buffer.concat([
			header,
			lenBuf,
			cmdBuf,
			userIdBuf,
			authLenBuf,
			authBytes,
			tail,
		]);
	}

	// Perform 2FA login against Cync and write cync-tokens.json for the runtime
	async handleLogin(payload) {
		const email = (payload?.emailAddress || '').trim();
		const password = (payload?.password || '').trim();
		const mfaCode = (payload?.mfaCode || '').trim();

		if (!email || !password || !mfaCode) {
			return {
				ok: false,
				error: 'Email, password, and 2FA code are required.',
			};
		}

		const requestBody = {
			corp_id: '1007d2ad150c4000',
			email,
			password,
			two_factor: mfaCode,
			resource: this.randomLoginResource(),
		};

		let res;
		let json;
		try {
			res = await fetch(
				'https://api.gelighting.com/v2/user_auth/two_factor',
				{
					method: 'POST',
					body: JSON.stringify(requestBody),
					headers: { 'Content-Type': 'application/json' },
				},
			);

			json = await res.json().catch(async () => {
				const text = await res.text().catch(() => '');
				throw new Error(`Cync login returned non-JSON payload: ${text}`);
			});
		} catch (err) {
			console.error('[cync-ui] Login request failed:', err);
			return {
				ok: false,
				error:
					'Login failed due to a network or server error. Please try again.',
			};
		}

		if (!res.ok) {
			const msg =
				(json &&
					json.error &&
					typeof json.error.msg === 'string' &&
					json.error.msg) ||
				`Login failed with status ${res.status} ${res.statusText}`;
			console.error('[cync-ui] Login failed:', msg, json);
			return { ok: false, error: msg };
		}

		const accessTokenRaw = json.access_token ?? json.accessToken;
		const userIdRaw = json.user_id ?? json.userId;
		const authorizeRaw = json.authorize;

		const accessToken =
			typeof accessTokenRaw === 'string' && accessTokenRaw.length > 0
				? accessTokenRaw
				: undefined;

		const userId =
			userIdRaw !== undefined && userIdRaw !== null
				? String(userIdRaw)
				: undefined;

		const authorize =
			typeof authorizeRaw === 'string' && authorizeRaw.length > 0
				? authorizeRaw
				: undefined;

		if (!accessToken || !userId) {
			console.error(
				'[cync-ui] Login response missing access_token or user_id:',
				json,
			);
			return {
				ok: false,
				error: 'Login response was missing access token or user id.',
			};
		}

		let lanLoginCode;
		if (authorize) {
			try {
				const lanBuf = this.buildLanLoginCode(authorize, userId);
				lanLoginCode = lanBuf.toString('base64');
			} catch (e) {
				console.warn('[cync-ui] Failed to build LAN login code:', e);
			}
		}

		const tokenData = {
			userId,
			accessToken,
			authorize,
			lanLoginCode,
		};

		let filePath;
		try {
			const storagePath = this.getStoragePath();
			const dirPath = path.join(storagePath, 'homebridge-cync-app');
			filePath = path.join(dirPath, 'cync-tokens.json');

			console.info(
				'[cync-ui] Resolving token storage path:',
				JSON.stringify({ storagePath, dirPath, filePath }),
			);

			await fs.mkdir(dirPath, { recursive: true });
			await fs.writeFile(filePath, JSON.stringify(tokenData, null, 2), 'utf8');

			console.info('[cync-ui] Stored Cync token at', filePath);
		} catch (err) {
			console.error('[cync-ui] Failed to write token file:', err);
			return {
				ok: false,
				error:
					'Login succeeded, but the token could not be stored on disk. Check Homebridge logs for details.',
			};
		}

		return {
			ok: true,
			tokenPath: filePath,
			message:
				'Login successful. Click "Save" and restart Homebridge to finish setup.',
		};
	}
}

(() => new PluginUiServer())();
