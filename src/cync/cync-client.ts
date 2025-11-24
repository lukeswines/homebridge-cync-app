// src/cync/cync-client.ts
import {
	ConfigClient,
	CyncCloudConfig,
	CyncLoginSession,
	CyncLogger,
} from './config-client.js';
import { TcpClient } from './tcp-client.js';
import { CyncTokenStore, CyncTokenData } from './token-store.js';


type SessionWithPossibleTokens = {
	accessToken?: string;
	jwt?: string;
	refreshToken?: string;
	refreshJwt?: string;
	expiresAt?: number;
};

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-client]', ...args),
	info: (...args: unknown[]) => console.info('[cync-client]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-client]', ...args),
	error: (...args: unknown[]) => console.error('[cync-client]', ...args),
};

export class CyncClient {
	private readonly log: CyncLogger;
	private readonly configClient: ConfigClient;
	private readonly tcpClient: TcpClient;

	private readonly tokenStore: CyncTokenStore;
	private tokenData: CyncTokenData | null = null;

	// Populated after successful login.
	private session: CyncLoginSession | null = null;
	private cloudConfig: CyncCloudConfig | null = null;

	// Credentials from config.json, used to drive 2FA bootstrap.
	private readonly loginConfig: { email: string; password: string; twoFactor?: string };

	constructor(
		configClient: ConfigClient,
		tcpClient: TcpClient,
		loginConfig: { email: string; password: string; twoFactor?: string },
		storagePath: string,
		logger?: CyncLogger,
	) {
		this.configClient = configClient;
		this.tcpClient = tcpClient;
		this.log = logger ?? defaultLogger;

		this.loginConfig = loginConfig;
		this.tokenStore = new CyncTokenStore(storagePath);
	}

	/**
		 * Ensure we are logged in:
		 * 1) Try stored token.
		 * 2) If none/invalid, run 2FA flow (request or complete).
		 * Returns true on successful login, false if we need user input (2FA).
		 */
	public async ensureLoggedIn(): Promise<boolean> {
		// 1) Try stored token/session
		const stored = await this.tokenStore.load();
		if (stored) {
			this.log.info(
				'CyncClient: using stored token for userId=%s (expiresAt=%s)',
				stored.userId,
				stored.expiresAt ? new Date(stored.expiresAt).toISOString() : 'unknown',
			);

			this.tokenData = stored;

			// Hydrate ConfigClient + session snapshot.
			this.applyAccessToken(stored);

			return true;
		}

		// 2) No stored token – run 2FA bootstrap
		const { email, password, twoFactor } = this.loginConfig;

		if (!email || !password) {
			this.log.error('CyncClient: email and password are required to obtain a new token.');
			return false;
		}

		if (!twoFactor || String(twoFactor).trim() === '') {
			// No 2FA code – request one
			this.log.info('Cync: starting 2FA handshake for %s', email);
			await this.requestTwoFactorCode(email);
			this.log.info(
				'Cync: 2FA code sent to your email. Enter the code as "twoFactor" in the plugin config and restart Homebridge to complete login.',
			);
			return false;
		}

		// We have a 2FA code – complete login and persist token
		this.log.info('Cync: completing 2FA login for %s', email);
		const loginResult = await this.completeTwoFactorLogin(
			email,
			password,
			String(twoFactor).trim(),
		);

		const tokenData: CyncTokenData = {
			userId: String(loginResult.userId),
			accessToken: loginResult.accessToken,
			refreshToken: loginResult.refreshToken,
			expiresAt: loginResult.expiresAt ?? undefined,
		};

		await this.tokenStore.save(tokenData);
		this.tokenData = tokenData;

		// Hydrate ConfigClient + session snapshot from the freshly obtained token.
		this.applyAccessToken(tokenData);

		this.log.info('Cync login successful; userId=%s (token stored)', tokenData.userId);
		return true;
	}


	/**
		 * Internal helper: request a 2FA email code using existing authenticate().
		 */
	private async requestTwoFactorCode(email: string): Promise<void> {
		await this.authenticate(email);
	}

	/**
		 * Internal helper: complete 2FA login using existing submitTwoFactor().
		 * This converts CyncLoginSession into the richer shape we want for token storage.
		 */
	private async completeTwoFactorLogin(
		email: string,
		password: string,
		code: string,
	): Promise<
		CyncLoginSession & {
			accessToken: string;
			refreshToken?: string;
			expiresAt?: number;
		}
	> {
		const session = await this.submitTwoFactor(email, password, code);

		const s = session as unknown as SessionWithPossibleTokens;

		const access = s.accessToken ?? s.jwt;
		if (!access) {
			throw new Error('CyncClient: login session did not return an access token.');
		}

		return {
			...session,
			accessToken: access,
			refreshToken: s.refreshToken ?? s.refreshJwt,
			expiresAt: s.expiresAt,
		};
	}

	/**
	 * Apply an access token (and associated metadata) to the underlying ConfigClient,
	 * and hydrate our local session snapshot so ensureSession() passes.
	 */
	private applyAccessToken(tokenData: CyncTokenData): void {
		if (!tokenData.accessToken || !tokenData.userId) {
			this.log.warn(
				'CyncClient: applyAccessToken called with missing userId or accessToken; tokenData=%o',
				{
					userId: tokenData.userId,
					hasAccessToken: !!tokenData.accessToken,
					expiresAt: tokenData.expiresAt,
				},
			);
			return;
		}

		// Push into ConfigClient so cloud calls can use it.
		this.configClient.restoreSession(tokenData.accessToken, tokenData.userId);

		// Hydrate our own session snapshot so ensureSession() passes.
		this.session = {
			accessToken: tokenData.accessToken,
			userId: tokenData.userId,
			raw: {
				source: 'tokenStore',
				expiresAt: tokenData.expiresAt,
			},
		};

		this.log.debug(
			'CyncClient: access token applied from %s; userId=%s, expiresAt=%s',
			'tokenStore',
			tokenData.userId,
			tokenData.expiresAt ? new Date(tokenData.expiresAt).toISOString() : 'unknown',
		);
	}


	/**
	 * Step 1 of 2FA flow:
	 *
	 * Trigger an email with a one-time code to the Cync account email.
	 *
	 * Call sequence:
	 *   await client.authenticate(username, password);  // sends email
	 *   // user reads email, gets code…
	 *   await client.submitTwoFactor(username, password, code); // completes login
	 */
	public async authenticate(username: string): Promise<void> {
		const email = username.trim();

		this.log.info('CyncClient: requesting 2FA code for %s', email);
		await this.configClient.sendTwoFactorCode(email);
		this.log.info(
			'CyncClient: 2FA email requested; call submitTwoFactor() once the user has the code.',
		);
	}

	/**
	 * Step 2 of 2FA flow:
	 *
	 * Use the emailed OTP code to complete login.
	 * This method is stateless: it does not rely on prior calls to authenticate()
	 * in the same process, so it works across Homebridge restarts.
	 */
	public async submitTwoFactor(
		email: string,
		password: string,
		code: string,
	): Promise<CyncLoginSession> {
		const trimmedEmail = email.trim();
		const trimmedCode = code.trim();

		this.log.info('CyncClient: completing 2FA login for %s', trimmedEmail);

		const session = await this.configClient.loginWithTwoFactor(
			trimmedEmail,
			password,
			trimmedCode,
		);

		this.session = session;

		this.log.debug(
			'CyncClient: session snapshot after login; hasAccessToken=%s userId=%s',
			!!session.accessToken,
			session.userId,
		);

		this.log.info(
			'CyncClient: login successful; userId=%s',
			session.userId,
		);

		return session;
	}


	/**
	 * Fetch and cache the cloud configuration (meshes/devices) for the logged-in user.
	 */
	public async loadConfiguration(): Promise<CyncCloudConfig> {
		this.ensureSession();

		this.log.info('CyncClient: loading Cync cloud configuration…');
		const cfg = await this.configClient.getCloudConfig();

		// Debug: inspect per-mesh properties so we can find the real devices.
		for (const mesh of cfg.meshes) {
			const meshName = mesh.name ?? mesh.id;
			this.log.debug(
				'CyncClient: probing properties for mesh %s (id=%s, product_id=%s)',
				meshName,
				mesh.id,
				mesh.product_id,
			);

			try {
				const props = await this.configClient.getDeviceProperties(
					mesh.product_id,
					mesh.id,
				);

				this.log.debug(
					'CyncClient: mesh %s properties keys=%o',
					meshName,
					Object.keys(props),
				);

				type DeviceProps = Record<string, unknown>;
				const bulbsArray = (props as DeviceProps).bulbsArray as unknown;
				if (Array.isArray(bulbsArray)) {
					this.log.info(
						'CyncClient: mesh %s bulbsArray length=%d; first item keys=%o',
						meshName,
						bulbsArray.length,
						bulbsArray[0] ? Object.keys(bulbsArray[0] as Record<string, unknown>) : [],
					);

					type RawDevice = Record<string, unknown>;

					const rawDevices = bulbsArray as unknown[];

					(mesh as Record<string, unknown>).devices = rawDevices.map((raw: unknown) => {
						const d = raw as RawDevice;

						const displayName = d.displayName as string | undefined;
						const deviceID = (d.deviceID ?? d.deviceId) as string | undefined;
						const wifiMac = d.wifiMac as string | undefined;
						const productId = (d.product_id as string | undefined) ?? mesh.product_id;

						// Use deviceID first, then wifiMac (stripped), then a mesh-based fallback.
						const id =
							deviceID ??
							(wifiMac ? wifiMac.replace(/:/g, '') : undefined) ??
							`${mesh.id}-${productId ?? 'unknown'}`;

						return {
							id,
							name: displayName ?? undefined,
							product_id: productId,
							device_id: deviceID,
							mac: wifiMac,
							raw: d,
						};
					});
				} else {
					this.log.info(
						'CyncClient: mesh %s has no bulbsArray in properties; props keys=%o',
						meshName,
						Object.keys(props),
					);
				}
			} catch (err) {
				this.log.warn(
					'CyncClient: getDeviceProperties failed for mesh %s (%s): %s',
					meshName,
					mesh.id,
					(err as Error).message ?? String(err),
				);
			}
		}

		this.cloudConfig = cfg;
		this.log.info(
			'CyncClient: cloud configuration loaded; meshes=%d',
			cfg.meshes.length,
		);

		return cfg;
	}

	/**
	 * Start the LAN/TCP transport (stub for now).
	 */
	public async startTransport(
		config: CyncCloudConfig,
		loginCode: Uint8Array,
	): Promise<void> {
		this.ensureSession();
		this.log.info('CyncClient: starting TCP transport (stub)…');

		await this.tcpClient.connect(loginCode, config);
	}

	public async stopTransport(): Promise<void> {
		this.log.info('CyncClient: stopping TCP transport…');
		await this.tcpClient.disconnect();
	}

	/**
	 * High-level helper for toggling a switch/plug.
	 */
	public async setSwitchState(
		deviceId: string,
		params: { on: boolean; [key: string]: unknown },
	): Promise<void> {
		this.ensureSession();

		this.log.debug(
			'CyncClient: setSwitchState stub; deviceId=%s params=%o',
			deviceId,
			params,
		);

		await this.tcpClient.setSwitchState(deviceId, params);
	}

	public getSessionSnapshot(): CyncLoginSession | null {
		return this.session;
	}

	public getCloudConfigSnapshot(): CyncCloudConfig | null {
		return this.cloudConfig;
	}

	private ensureSession(): void {
		if (!this.session) {
			throw new Error(
				'Cync session not initialised; complete 2FA login first.',
			);
		}
	}
}
