// src/cync/config-client.ts
// Cync cloud configuration & login client.
// Handles 2FA email flow and basic device/config queries against api.gelighting.com.
//
// This is intentionally low-level and stateless-ish: CyncClient is expected to
// own an instance of this class and persist the resulting session info.

const CYNC_API_BASE = 'https://api.gelighting.com/v2/';
const CORP_ID = '1007d2ad150c4000';

// Minimal fetch/response typing for Node 18+, without depending on DOM lib types.
type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

declare const fetch: FetchLike;

type HttpResponse = {
	ok: boolean;
	status: number;
	statusText: string;
	json(): Promise<unknown>;
	text(): Promise<string>;
};

type CyncErrorBody = {
	error?: {
		msg?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

export interface CyncLoginSession {
	accessToken: string;
	userId: string;
	authorize?: string;
	raw: unknown;
}

export interface CyncDevice {
	id: string;
	name?: string;
	product_id?: string;
	device_id?: string;
	mac?: string;
	sn?: string;
	switch_id?: string;
	switch_controller?: number | string;
	mesh_id?: number | string;

	[key: string]: unknown;
}

export interface CyncDeviceMesh {
	id: string;
	name?: string;
	product_id: string;
	access_key?: string;
	mac?: string;
	properties?: Record<string, unknown>;
	devices?: CyncDevice[];
	[key: string]: unknown;
}

export interface CyncCloudConfig {
	meshes: CyncDeviceMesh[];
}

/**
 * Very small logger interface so we can accept either the Homebridge log
 * object or console.* functions in tests.
 */
export interface CyncLogger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-config]', ...args),
	info: (...args: unknown[]) => console.info('[cync-config]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-config]', ...args),
	error: (...args: unknown[]) => console.error('[cync-config]', ...args),
};

export class ConfigClient {
	private readonly log: CyncLogger;

	// These are populated after a successful 2FA login.
	private accessToken: string | null = null;
	private userId: string | null = null;
	private authorize: string | null = null;

	constructor(logger?: CyncLogger) {
		this.log = logger ?? defaultLogger;
	}

	/**
	 * Request that Cync send a one-time 2FA verification code to the given email.
	 *
	 * This MUST be called before loginWithTwoFactor() for accounts that require 2FA.
	 * The user reads the code from their email and provides it to loginWithTwoFactor.
	 */
	public async sendTwoFactorCode(email: string): Promise<void> {
		const url = `${CYNC_API_BASE}two_factor/email/verifycode`;
		this.log.debug(`Requesting Cync 2FA code for ${email}…`);

		const body = {
			corp_id: CORP_ID,
			email,
			local_lang: 'en-us',
		};

		const res = (await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})) as HttpResponse;

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			this.log.error(
				`Cync 2FA request failed: HTTP ${res.status} ${res.statusText} ${text}`,
			);
			throw new Error(`Cync 2FA request failed with status ${res.status}`);
		}

		this.log.info('Cync 2FA email request succeeded.');
	}

	/**
	 * Perform the actual 2FA login and capture the access token + userId.
	 *
	 * You are expected to first call sendTwoFactorCode(), then prompt the user
	 * for the emailed OTP code, then call loginWithTwoFactor() with that code.
	 *
	 * The access token is used for subsequent getCloudConfig() / getDeviceProperties() calls.
	 */
	public async loginWithTwoFactor(
		email: string,
		password: string,
		otpCode: string,
	): Promise<CyncLoginSession> {
		const url = `${CYNC_API_BASE}user_auth/two_factor`;
		this.log.debug('Logging into Cync with 2FA for %s…', email);

		const body = {
			corp_id: CORP_ID,
			email,
			password,
			two_factor: otpCode,
			// Matches the reference implementations: random 16-char string.
			resource: ConfigClient.randomLoginResource(),
		};

		const res = (await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})) as HttpResponse;

		const json: unknown = await res.json().catch(async () => {
			const text = await res.text().catch(() => '');
			throw new Error(`Cync login returned non-JSON payload: ${text}`);
		});

		if (!res.ok) {
			this.log.error(
				'Cync login failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			throw new Error(
				errBody.error?.msg ??
				`Cync login failed with status ${res.status} ${res.statusText}`,
			);
		}

		const obj = json as Record<string, unknown>;
		this.log.debug('Cync login response: keys=%o', Object.keys(obj));

		// Accept both snake_case and camelCase, and both string/number user_id.
		const accessTokenRaw = obj.access_token ?? obj.accessToken;
		const userIdRaw = obj.user_id ?? obj.userId;
		const authorizeRaw = obj.authorize;

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
			this.log.error('Cync login missing access_token or user_id: %o', json);
			throw new Error('Cync login response missing access_token or user_id');
		}

		this.accessToken = accessToken;
		this.userId = userId;
		this.authorize = authorize ?? null;

		this.log.info('Cync login successful; userId=%s', userId);

		return {
			accessToken,
			userId,
			authorize,
			raw: json,
		};
	}

	/**
	 * Fetch the list of meshes/devices for the current user from the cloud.
	 *
	 * This roughly matches CyncCloudAPI.get_devices() from cync-lan, but in a
	 * simplified, single-call interface.
	 */
	public async getCloudConfig(): Promise<CyncCloudConfig> {
		this.ensureSession();

		const devicesUrl = `${CYNC_API_BASE}user/${this.userId}/subscribe/devices`;
		const headers = {
			'Access-Token': this.accessToken as string,
		};

		this.log.debug('Fetching Cync devices from %s', devicesUrl);

		const res = (await fetch(devicesUrl, {
			method: 'GET',
			headers,
		})) as HttpResponse;

		const json: unknown = await res.json().catch(async () => {
			const text = await res.text().catch(() => '');
			throw new Error(`Cync devices returned non-JSON payload: ${text}`);
		});

		if (!res.ok) {
			this.log.error(
				'Cync devices call failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			const msg = errBody.error?.msg ?? 'Unknown error from Cync devices API';
			throw new Error(msg);
		}

		// DEBUG: log high-level shape without dumping any secrets.
		if (Array.isArray(json)) {
			this.log.debug(
				'Cync devices payload: top-level array length=%d; first item keys=%o',
				json.length,
				json.length > 0 ? Object.keys((json as Record<string, unknown>[])[0]) : [],
			);
		} else if (json && typeof json === 'object') {
			this.log.debug(
				'Cync devices payload: top-level object keys=%o',
				Object.keys(json as Record<string, unknown>),
			);
		} else {
			this.log.debug(
				'Cync devices payload: top-level type=%s',
				typeof json,
			);
		}

		// Some Cync responses wrap arrays; others are raw arrays.
		let meshes: CyncDeviceMesh[] = [];

		if (Array.isArray(json)) {
			meshes = json as CyncDeviceMesh[];
		} else if (json && typeof json === 'object') {
			const obj = json as Record<string, unknown>;

			// Best guess: devices may be under a named property.
			// We just log for now; once we see the payload, we can wire this properly.
			this.log.debug(
				'Cync devices payload (object) example values for known keys=%o',
				{
					dataType: typeof obj.data,
					devicesType: typeof (obj.devices as unknown),
					meshesType: typeof (obj.meshes as unknown),
				},
			);

			// Temporary: if there's a "data" array, treat that as meshes.
			if (Array.isArray(obj.data)) {
				meshes = obj.data as CyncDeviceMesh[];
			} else if (Array.isArray(obj.meshes)) {
				meshes = obj.meshes as CyncDeviceMesh[];
			}
		}

		return { meshes };

	}

	/**
	 * Convenience to fetch the properties object for a single device.
	 */
	public async getDeviceProperties(
		productId: string,
		deviceId: string,
	): Promise<Record<string, unknown>> {
		this.ensureSession();

		const url = `${CYNC_API_BASE}product/${encodeURIComponent(
			productId,
		)}/device/${encodeURIComponent(deviceId)}/property`;

		const res = (await fetch(url, {
			method: 'GET',
			headers: {
				'Access-Token': this.accessToken as string,
			},
		})) as HttpResponse;

		const json: unknown = await res.json().catch(async () => {
			const text = await res.text().catch(() => '');
			throw new Error(`Cync properties returned non-JSON payload: ${text}`);
		});

		if (!res.ok) {
			this.log.error(
				'Cync properties call failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			const msg =
				errBody.error?.msg ?? `Cync properties failed with ${res.status}`;
			throw new Error(msg);
		}

		// We keep this as a loose record; callers can shape it as needed.
		return json as Record<string, unknown>;
	}

	public restoreSession(accessToken: string, userId: string): void {
		this.accessToken = accessToken;
		this.userId = userId;
		this.log.info('Cync: restored session from stored token; userId=%s', userId);
	}

	public getSessionSnapshot(): { accessToken: string | null; userId: string | null } {
		return {
			accessToken: this.accessToken,
			userId: this.userId,
		};
	}

	private ensureSession(): void {
		if (!this.accessToken || !this.userId) {
			throw new Error('Cync session not initialised. Call loginWithTwoFactor() first.');
		}
	}
	// ### 🧩 LAN Login Blob Builder: Generates the auth_code payload used by Cync LAN TCP
	public static buildLanLoginCode(userId: string, authorize: string): Uint8Array {
		const authBytes = Buffer.from(authorize, 'ascii');
		const lengthByte = 10 + authBytes.length;

		if (lengthByte > 0xff) {
			throw new Error('Cync LAN authorize token too long to encode.');
		}

		const userIdNum = Number.parseInt(userId, 10);
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

		const loginBuf = Buffer.concat([
			header,
			lenBuf,
			cmdBuf,
			userIdBuf,
			authLenBuf,
			authBytes,
			tail,
		]);

		return new Uint8Array(loginBuf);
	}

	private static randomLoginResource(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz';
		let out = '';
		for (let i = 0; i < 16; i += 1) {
			out += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return out;
	}
}
