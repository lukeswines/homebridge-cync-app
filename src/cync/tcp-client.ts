// Thin TCP client stub for talking to Cync WiFi devices.
// The binary protocol is non-trivial; for now this class only logs calls so
// that higher layers can be wired up and tested without crashing.

import { CyncCloudConfig, CyncLogger } from './config-client';

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-tcp]', ...args),
	info: (...args: unknown[]) => console.info('[cync-tcp]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-tcp]', ...args),
	error: (...args: unknown[]) => console.error('[cync-tcp]', ...args),
};

export type DeviceUpdateCallback = (payload: unknown) => void;

export class TcpClient {
	private readonly log: CyncLogger;

	private deviceUpdateCb: DeviceUpdateCallback | null = null;
	private roomUpdateCb: DeviceUpdateCallback | null = null;
	private motionUpdateCb: DeviceUpdateCallback | null = null;
	private ambientUpdateCb: DeviceUpdateCallback | null = null;

	constructor(logger?: CyncLogger) {
		this.log = logger ?? defaultLogger;
	}

	/**
	 * Establish a TCP session to one or more Cync devices.
	 *
	 * In the full implementation, loginCode will be the authentication blob used
	 * by the LAN devices, and config will contain the mesh/network information
	 * needed to discover and connect to the correct hosts.
	 *
	 * For now this is a no-op that simply logs the request.
	 */
	public async connect(
		loginCode: Uint8Array,
		config: CyncCloudConfig,
	): Promise<void> {
		this.log.info(
			'TcpClient.connect() stub called with loginCode length=%d meshes=%d',
			loginCode.length,
			config.meshes.length,
		);
	}

	public async disconnect(): Promise<void> {
		this.log.info('TcpClient.disconnect() stub called.');
	}

	public onDeviceUpdate(cb: DeviceUpdateCallback): void {
		this.deviceUpdateCb = cb;
	}

	public onRoomUpdate(cb: DeviceUpdateCallback): void {
		this.roomUpdateCb = cb;
	}

	public onMotionUpdate(cb: DeviceUpdateCallback): void {
		this.motionUpdateCb = cb;
	}

	public onAmbientUpdate(cb: DeviceUpdateCallback): void {
		this.ambientUpdateCb = cb;
	}

	/**
	 * High-level API to change switch state. The actual encoding and TCP send
	 * will be filled in once the LAN protocol is implemented.
	 */
	public async setSwitchState(
		deviceId: string,
		params: { on: boolean; [key: string]: unknown },
	): Promise<void> {
		this.log.info(
			'TcpClient.setSwitchState() stub: deviceId=%s params=%o',
			deviceId,
			params,
		);

		// In a future implementation, this is where we would:
		// 1. Look up the device in the current CyncCloudConfig.
		// 2. Construct the appropriate binary payload.
		// 3. Send via a net.Socket and handle the response.
	}
}
