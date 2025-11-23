// Cync cloud configuration & login client.
// Handles 2FA email flow and basic device/config queries against api.gelighting.com.
//
// This is intentionally low-level and stateless-ish: CyncClient is expected to
// own an instance of this class and persist the resulting session info.

const CYNC_API_BASE = 'https://api.gelighting.com/v2/';
const CORP_ID = '1007d2ad150c4000';

// Node 18+ exposes a global fetch() at runtime. Declare it as any so TypeScript
// does not complain even when the DOM lib is not enabled in tsconfig.
declare const fetch: any;

export interface CyncLoginSession {
	accessToken: string;
	userId: string;
	raw: unknown;
}

export interface CyncDeviceMesh {
	id: string;
	name?: string;
	product_id: string;
	access_key?: string;
	mac?: string;
	properties?: Record<string, unknown>;
	// The cloud API returns many more fields; we keep this loose for now.
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

		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

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

		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		const json = (await res.json().catch(async () => {
			const text = await res.text().catch(() => '');
			throw new Error(`Cync login returned non-JSON payload: ${text}`);
		})) as any;

		if (!res.ok) {
			this.log.error(
				'Cync login failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			throw new Error(
				json?.error?.msg ??
					`Cync login failed with status ${res.status} ${res.statusText}`,
			);
		}

		const accessToken = json?.access_token as string | undefined;
		const userId = json?.user_id as string | undefined;

		if (!accessToken || !userId) {
			this.log.error('Cync login missing access_token or user_id: %o', json);
			throw new Error('Cync login response missing access_token or user_id');
		}

		this.accessToken = accessToken;
		this.userId = userId;

		this.log.info('Cync login successful; userId=%s', userId);

		return {
			accessToken,
			userId,
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

		const res = await fetch(devicesUrl, {
			method: 'GET',
			headers,
		});

		const json = (await res.json().catch(async () => {
			const text = await res.text().catch(() => '');
			throw new Error(`Cync devices returned non-JSON payload: ${text}`);
		})) as any;

		if (!res.ok) {
			this.log.error(
				'Cync devices call failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const msg = json?.error?.msg ?? 'Unknown error from Cync devices API';
			throw new Error(msg);
		}

		if (json?.error) {
			this.log.error('Cync devices API error: %o', json.error);
			throw new Error(json.error.msg ?? 'Cync devices API error');
		}

		// The cloud returns an array of mesh networks; we normalise to our interface.
		const meshes: CyncDeviceMesh[] = Array.isArray(json)
			? (json as CyncDeviceMesh[])
			: [];

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

		const url = `https://api.gelighting.com/v2/product/${encodeURIComponent(
			productId,
		)}/device/${encodeURIComponent(deviceId)}/property`;

		const res = await fetch(url, {
			method: 'GET',
			headers: {
				'Access-Token': this.accessToken as string,
			},
		});

		const json = (await res.json().catch(async () => {
			const text = await res.text().catch(() => '');
			throw new Error(`Cync properties returned non-JSON payload: ${text}`);
		})) as any;

		if (!res.ok) {
			this.log.error(
				'Cync properties call failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const msg =
				json?.error?.msg ?? `Cync properties failed with ${res.status}`;
			throw new Error(msg);
		}

		if (json?.error) {
			this.log.warn('Cync properties API error: %o', json.error);
		}

		return json as Record<string, unknown>;
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

	private static randomLoginResource(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz';
		let out = '';
		for (let i = 0; i < 16; i += 1) {
			out += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return out;
	}
}
