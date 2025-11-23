// High-level Cync coordinator.
// Orchestrates cloud login (via ConfigClient) and, later, local TCP control (via TcpClient).

import {
	ConfigClient,
	CyncCloudConfig,
	CyncLoginSession,
	CyncLogger,
} from './config-client';
import { TcpClient } from './tcp-client';

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-client]', ...args),
	info: (...args: unknown[]) => console.info('[cync-client]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-client]', ...args),
	error: (...args: unknown[]) => console.error('[cync-client]', ...args),
};

export class CyncClient {
	private readonly log: CyncLogger;

	private pendingEmail: string | null = null;
	private pendingPassword: string | null = null;

	private session: CyncLoginSession | null = null;
	private cloudConfig: CyncCloudConfig | null = null;

	constructor(
		private readonly configClient: ConfigClient,
		private readonly tcpClient: TcpClient,
		logger?: CyncLogger,
	) {
		this.log = logger ?? defaultLogger;
	}

	/**
	 * Begin the 2FA login flow.
	 *
	 * 1. Call authenticate(email, password) to trigger an emailed OTP code.
	 * 2. Prompt the user for the code.
	 * 3. Call submitTwoFactor(code) to complete login and capture the session.
	 */
	public async authenticate(username: string, password: string): Promise<void> {
		const email = username.trim();
		this.pendingEmail = email;
		this.pendingPassword = password;

		this.log.info('Requesting Cync 2FA code…');
		await this.configClient.sendTwoFactorCode(email);
		this.log.info(
			'Cync 2FA code requested; call submitTwoFactor() once the user has the emailed code.',
		);
	}

	/**
	 * Finish the 2FA login flow using the emailed OTP code.
	 */
	public async submitTwoFactor(code: string): Promise<CyncLoginSession> {
		if (!this.pendingEmail || !this.pendingPassword) {
			throw new Error(
				'CyncClient.submitTwoFactor() called before authenticate().',
			);
		}

		this.log.info('Completing Cync 2FA login…');
		const session = await this.configClient.loginWithTwoFactor(
			this.pendingEmail,
			this.pendingPassword,
			code.trim(),
		);

		this.session = session;
		this.log.info('Cync session established for userId=%s', session.userId);

		return session;
	}

	/**
	 * Retrieve the current cloud configuration (mesh networks & devices) for the
	 * logged-in user.
	 */
	public async loadConfiguration(): Promise<CyncCloudConfig> {
		this.ensureSession();

		this.log.info('Fetching Cync cloud configuration…');
		const cfg = await this.configClient.getCloudConfig();
		this.cloudConfig = cfg;

		this.log.debug('Fetched %d mesh networks from Cync cloud.', cfg.meshes.length);

		return cfg;
	}

	/**
	 * Placeholder for starting the TCP transport layer.
	 *
	 * For now this just wires through to TcpClient.connect() with a helpful log.
	 * The loginCode is the binary blob the LAN devices expect when we open a
	 * TCP session; we will obtain/derive it later from the cloud config.
	 */
	public async startTransport(
		config: CyncCloudConfig,
		loginCode: Uint8Array,
	): Promise<void> {
		this.ensureSession();

		this.log.info('Starting Cync TCP transport (stub implementation)…');
		await this.tcpClient.connect(loginCode, config);
	}

	public async stopTransport(): Promise<void> {
		this.log.info('Stopping Cync TCP transport…');
		await this.tcpClient.disconnect();
	}

	/**
	 * High-level wrapper for toggling a switch/plug. This will eventually encode
	 * and send the appropriate TCP command via TcpClient.
	 */
	public async setSwitchState(
		deviceId: string,
		params: { on: boolean; [key: string]: unknown },
	): Promise<void> {
		this.ensureSession();

		this.log.debug(
			'Setting Cync switch state (stub): deviceId=%s params=%o',
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
			throw new Error('Cync session not initialised; complete 2FA login first.');
		}
	}
}
