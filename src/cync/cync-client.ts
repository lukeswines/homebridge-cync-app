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

	// ### 🧩 LAN Topology Cache: mirrors HA's home_devices / home_controllers / switchID_to_homeID
	private homeDevices: Record<string, string[]> = {};
	private homeControllers: Record<string, number[]> = {};
	private switchIdToHomeId: Record<number, string> = {};

	// Optional LAN update hook for the platform
	private lanUpdateHandler: ((update: unknown) => void) | null = null;

	// ### 🧩 LAN Update Bridge: allow platform to handle device updates
	public onLanDeviceUpdate(handler: (update: unknown) => void): void {
		this.lanUpdateHandler = handler;
	}

	// ### 🧩 LAN Auth Blob Getter: Returns the LAN login code if available
	public getLanLoginCode(): Uint8Array {
		if (!this.tokenData?.lanLoginCode) {
			this.log.debug('CyncClient: getLanLoginCode() → no LAN blob in token store.');
			return new Uint8Array();
		}

		try {
			return Uint8Array.from(Buffer.from(this.tokenData.lanLoginCode, 'base64'));
		} catch {
			this.log.warn('CyncClient: stored LAN login code is invalid base64.');
			return new Uint8Array();
		}
	}

	constructor(
		configClient: ConfigClient,
		tcpClient: TcpClient,
		storagePath: string,
		logger?: CyncLogger,
	) {
		this.configClient = configClient;
		this.tcpClient = tcpClient;
		this.log = logger ?? defaultLogger;

		this.tokenStore = new CyncTokenStore(storagePath);
	}
	// ### 🧩 LAN Login Code Builder
	private buildLanLoginCode(authorize: string, userId: number): Uint8Array {
		const authorizeBytes = Buffer.from(authorize, 'ascii');

		const head = Buffer.from('13000000', 'hex');
		const lengthByte = Buffer.from([10 + authorizeBytes.length]);
		const tag = Buffer.from('03', 'hex');

		const userIdBytes = Buffer.alloc(4);
		userIdBytes.writeUInt32BE(userId);

		const authLenBytes = Buffer.alloc(2);
		authLenBytes.writeUInt16BE(authorizeBytes.length);

		const tail = Buffer.from('0000b4', 'hex');

		return Buffer.concat([
			head,
			lengthByte,
			tag,
			userIdBytes,
			authLenBytes,
			authorizeBytes,
			tail,
		]);
	}

	/**
		 * Ensure we are logged in:
		 * 1) Try stored token.
		 * 2) If none/invalid, run 2FA flow (request or complete).
		 * Returns true on successful login, false if we need user input (2FA).
		 */
	/**
	 * Ensure we are logged in using a stored token only.
	 *
	 * UI (homebridge-ui) is responsible for performing 2FA and writing
	 * <storagePath>/homebridge-cync-app/cync-tokens.json.
	 *
	 * Returns true if a valid token was loaded and applied, false otherwise.
	 */
	public async ensureLoggedIn(): Promise<boolean> {
		const stored = await this.tokenStore.load();
		if (!stored) {
			this.log.error(
				'CyncClient: no stored token found; complete login from the Homebridge UI first.',
			);
			return false;
		}

		this.log.info(
			'CyncClient: using stored token for userId=%s (expiresAt=%s)',
			stored.userId,
			stored.expiresAt ? new Date(stored.expiresAt).toISOString() : 'unknown',
		);

		this.tokenData = stored;
		this.applyAccessToken(stored);
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
		// Extract authorize field from session.raw (Cync returns it)
		const raw = session.raw as Record<string, unknown>;
		const authorize = typeof raw?.authorize === 'string' ? raw.authorize : undefined;

		if (!authorize) {
			throw new Error('CyncClient: missing "authorize" field from login response; LAN login cannot be generated.');
		}

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
			authorize,
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
		// Restore LAN auth blob into memory
		if (tokenData.authorize && tokenData.lanLoginCode) {
			this.log.debug('CyncClient: LAN login code restored from token store.');
			// nothing else needed — getLanLoginCode() will use it
		} else {
			this.log.debug('CyncClient: token store missing LAN login fields.');
		}

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
	 * Also builds HA-style LAN topology mappings:
	 *  - homeDevices[homeId][meshIndex] -> deviceId
	 *  - homeControllers[homeId] -> controllerIds[]
	 *  - switchIdToHomeId[controllerId] -> homeId
	 */
	public async loadConfiguration(): Promise<CyncCloudConfig> {
		this.ensureSession();

		this.log.info('CyncClient: loading Cync cloud configuration…');
		const cfg = await this.configClient.getCloudConfig();

		// Reset LAN topology caches on each reload
		this.homeDevices = {};
		this.homeControllers = {};
		this.switchIdToHomeId = {};

		// Debug: inspect per-mesh properties so we can find the real devices.
		for (const mesh of cfg.meshes) {
			const meshName = mesh.name ?? mesh.id;
			const homeId = String(mesh.id);

			this.log.debug(
				'CyncClient: probing properties for mesh %s (id=%s, product_id=%s)',
				meshName,
				mesh.id,
				mesh.product_id,
			);

			// Per-home maps, mirroring HA's CyncUserData.get_cync_config()
			const homeDevices: string[] = [];
			const homeControllers: number[] = [];

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

					const devicesForMesh: unknown[] = [];

					for (const raw of rawDevices) {
						const d = raw as RawDevice;

						const displayName = d.displayName as string | undefined;

						// deviceID can be number or string – normalize to string
						const deviceIdRaw = (d.deviceID ?? d.deviceId) as string | number | undefined;
						const deviceIdStr =
							deviceIdRaw !== undefined && deviceIdRaw !== null
								? String(deviceIdRaw)
								: undefined;

						const wifiMac = d.wifiMac as string | undefined;
						const productId =
							(d.product_id as string | undefined) ?? mesh.product_id;

						// Reproduce HA's mesh index calculation:
						// current_index = ((deviceID % home_id) % 1000) + (int((deviceID % home_id) / 1000) * 256)
						const homeIdNum = Number(mesh.id);
						const deviceIdNum =
							typeof deviceIdRaw === 'number'
								? deviceIdRaw
								: deviceIdRaw !== undefined && deviceIdRaw !== null
									? Number(deviceIdRaw)
									: NaN;

						let meshIndex: number | undefined;
						if (!Number.isNaN(homeIdNum) && !Number.isNaN(deviceIdNum) && homeIdNum !== 0) {
							const mod = deviceIdNum % homeIdNum;
							meshIndex = (mod % 1000) + Math.floor(mod / 1000) * 256;
						}

						// Controller ID used by LAN packets (HA's switch_controller)
						const switchController = d.switchID as number | undefined;

						// Use deviceID first, then wifiMac (stripped), then a mesh-based fallback.
						const id =
							deviceIdStr ??
							(wifiMac ? wifiMac.replace(/:/g, '') : undefined) ??
							`${mesh.id}-${productId ?? 'unknown'}`;

						// Mirror HA's home_devices[homeId][meshIndex] = deviceId
						if (meshIndex !== undefined && deviceIdStr) {
							while (homeDevices.length <= meshIndex) {
								homeDevices.push('');
							}
							homeDevices[meshIndex] = deviceIdStr;
						}

						// Mirror HA's switchID_to_homeID + home_controllers
						if (switchController !== undefined && Number.isFinite(switchController) && switchController > 0) {
							if (!this.switchIdToHomeId[switchController]) {
								this.switchIdToHomeId[switchController] = homeId;
							}
							if (!homeControllers.includes(switchController)) {
								homeControllers.push(switchController);
							}
						}

						devicesForMesh.push({
							id,
							name: displayName ?? undefined,
							product_id: productId,
							device_id: deviceIdStr,
							mac: wifiMac,
							mesh_id: meshIndex,
							switch_controller: switchController,
							raw: d,
						});
					}

					// Attach per-mesh devices to the cloud config (what platform.ts already uses)
					(mesh as Record<string, unknown>).devices = devicesForMesh;

					// Persist per-home topology maps for TCP parsing later
					if (homeDevices.length > 0) {
						this.homeDevices[homeId] = homeDevices;
					}
					if (homeControllers.length > 0) {
						this.homeControllers[homeId] = homeControllers;
					}

					// Maintain the legacy controller→device mapping for now so existing TCP code keeps working.
					for (const dev of devicesForMesh) {
						const record = dev as Record<string, unknown>;
						const controllerId = record.switch_controller as number | undefined;

						const deviceId =
							(record.device_id as string | undefined) ??
							(record.id as string | undefined);

						if (controllerId !== undefined && deviceId) {
							this.tcpClient.registerSwitchMapping(controllerId, deviceId);
						}
					}
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

	public async startTransport(
		config: CyncCloudConfig,
		loginCode: Uint8Array,
	): Promise<void> {
		this.ensureSession();
		this.log.info('CyncClient: starting TCP transport…');

		// Push current LAN topology (built in loadConfiguration) into the TCP client
		const topology = this.getLanTopology();
		this.tcpClient.applyLanTopology(topology);

		// Optional: dump all frames as hex for debugging
		this.tcpClient.onRawFrame((frame) => {
			this.log.debug(
				'[Cync TCP] raw frame (%d bytes): %s',
				frame.byteLength,
				frame.toString('hex'),
			);
		});

		// REQUIRED: subscribe to parsed device updates
		this.tcpClient.onDeviceUpdate((update) => {
			if (this.lanUpdateHandler) {
				this.lanUpdateHandler(update);
			} else {
				// Fallback: log only
				this.log.info('[Cync TCP] device update callback fired; payload=%o', update);
			}
		});

		await this.tcpClient.connect(loginCode, config);
	}

	public getSessionSnapshot(): CyncLoginSession | null {
		return this.session;
	}

	public getCloudConfigSnapshot(): CyncCloudConfig | null {
		return this.cloudConfig;
	}

	public getLanTopology(): {
		homeDevices: Record<string, string[]>;
		homeControllers: Record<string, number[]>;
		switchIdToHomeId: Record<number, string>;
		} {
		return {
			homeDevices: this.homeDevices,
			homeControllers: this.homeControllers,
			switchIdToHomeId: this.switchIdToHomeId,
		};
	}

	private ensureSession(): void {
		if (!this.session) {
			throw new Error(
				'Cync session not initialised; complete 2FA login first.',
			);
		}
	}
}
