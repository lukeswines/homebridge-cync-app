// src/cync/tcp-client.ts

import { CyncCloudConfig, CyncLogger } from './config-client.js';
import net from 'net';
import tls from 'tls';

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-tcp]', ...args),
	info: (...args: unknown[]) => console.info('[cync-tcp]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-tcp]', ...args),
	error: (...args: unknown[]) => console.error('[cync-tcp]', ...args),
};

export type DeviceUpdateCallback = (payload: unknown) => void;
export type RawFrameListener = (frame: Buffer) => void;

export class TcpClient {
	public registerSwitchMapping(controllerId: number, deviceId: string): void {
		if (!Number.isFinite(controllerId)) {
			return;
		}
		this.controllerToDevice.set(controllerId, deviceId);
	}
	private homeDevices: Record<string, string[]> = {};
	private switchIdToHomeId = new Map<number, string>();
	private readonly log: CyncLogger;
	private loginCode: Uint8Array | null = null;
	private config: CyncCloudConfig | null = null;
	private meshSockets = new Map<string, net.Socket>();
	private deviceUpdateCb: DeviceUpdateCallback | null = null;
	private roomUpdateCb: DeviceUpdateCallback | null = null;
	private motionUpdateCb: DeviceUpdateCallback | null = null;
	private ambientUpdateCb: DeviceUpdateCallback | null = null;
	private socket: net.Socket | null = null;
	private seq = 0;
	private readBuffer = Buffer.alloc(0);
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private rawFrameListeners: RawFrameListener[] = [];
	private controllerToDevice = new Map<number, string>();
	private parseSwitchStateFrame(frame: Buffer): { controllerId: number; on: boolean; level: number } | null {
		if (frame.length < 16) {
			return null;
		}

		// First 4 bytes are the controller ID (big-endian)
		const controllerId = frame.readUInt32BE(0);

		// Look for the marker sequence db 11 02 01
		const marker = Buffer.from('db110201', 'hex');
		const idx = frame.indexOf(marker);

		if (idx === -1) {
			return null;
		}

		// We need at least two bytes following the marker: onFlag + level
		const onIndex = idx + marker.length;
		const levelIndex = onIndex + 1;

		if (levelIndex >= frame.length) {
			return null;
		}

		const onFlag = frame[onIndex];
		const level = frame[levelIndex];

		const on = onFlag === 0x01 && level > 0;

		return { controllerId, on, level };
	}

	private parseLanSwitchUpdate(frame: Buffer): {
		controllerId: number;
		deviceId?: string;
		on: boolean;
		level: number;
	} | null {
		// Need at least enough bytes for the HA layout:
		// switch_id(4) ... type(1) ... deviceIndex(1) ... state(1) ... brightness(1)
		if (frame.length < 29) {
			return null;
		}

		const controllerId = frame.readUInt32BE(0);

		const homeId = this.switchIdToHomeId.get(controllerId);
		if (!homeId) {
			return null;
		}

		const devices = this.homeDevices[homeId];
		if (!devices || devices.length === 0) {
			return null;
		}

		// HA checks: packet_length >= 33 and packet[13] == 219 (0xdb)
		const typeByte = frame[13];
		if (typeByte !== 0xdb) {
			return null;
		}

		const deviceIndex = frame[21];
		const stateByte = frame[27];
		const levelByte = frame[28];

		const on = stateByte > 0;
		const level = on ? levelByte : 0;

		const deviceId = deviceIndex < devices.length ? devices[deviceIndex] : undefined;

		return {
			controllerId,
			deviceId,
			on,
			level,
		};
	}

	constructor(logger?: CyncLogger) {
		this.log = logger ?? defaultLogger;
	}

	/**
	 * Establish a TCP session to one or more Cync devices.
	 *
	 * For Homebridge:
	 * - We cache loginCode + config here.
	 * - Actual socket creation happens in ensureConnected()/establishSocket().
	 */
	public async connect(
		loginCode: Uint8Array,
		config: CyncCloudConfig,
	): Promise<void> {
		this.loginCode = loginCode;
		this.config = config;

		if (!loginCode.length) {
			this.log.warn(
				'[Cync TCP] connect() called with empty loginCode; LAN control will remain disabled.',
			);
			return;
		}

		// Optional eager connect at startup; failures are logged and we rely
		// on ensureConnected() to reconnect on demand later.
		await this.ensureConnected();
	}


	public applyLanTopology(topology: {
		homeDevices: Record<string, string[]>;
		switchIdToHomeId: Record<number, string>;
	}): void {
		this.homeDevices = topology.homeDevices ?? {};

		this.switchIdToHomeId = new Map<number, string>();
		for (const [key, homeId] of Object.entries(topology.switchIdToHomeId ?? {})) {
			const num = Number(key);
			if (Number.isFinite(num)) {
				this.switchIdToHomeId.set(num, homeId);
			}
		}

		this.log.info(
			'[Cync TCP] LAN topology applied: homes=%d controllers=%d',
			Object.keys(this.homeDevices).length,
			this.switchIdToHomeId.size,
		);
	}

	/**
	 * Ensure we have an open, logged-in socket.
	 * If the socket is closed or missing, attempt to reconnect.
	 */
	private async ensureConnected(): Promise<boolean> {
		if (this.socket && !this.socket.destroyed) {
			return true;
		}

		if (!this.loginCode || !this.loginCode.length || !this.config) {
			this.log.warn(
				'[Cync TCP] ensureConnected() called without loginCode/config; cannot open socket.',
			);
			return false;
		}

		await this.establishSocket();
		return !!(this.socket && !this.socket.destroyed);
	}

	/**
	 * Open a new socket to cm.gelighting.com and send the loginCode,
	 * mirroring the HA integration’s behavior.
	 */
	private async establishSocket(): Promise<void> {
		const host = 'cm.gelighting.com';
		const portTLS = 23779;
		const portTCP = 23778;

		this.log.info('[Cync TCP] Connecting to %s…', host);

		let socket: net.Socket | null = null;

		try {
			// 1. Try strict TLS
			try {
				socket = await this.openTlsSocket(host, portTLS, true);
			} catch (e1) {
				this.log.warn('[Cync TCP] TLS strict failed, trying relaxed TLS…');
				try {
					socket = await this.openTlsSocket(host, portTLS, false);
				} catch (e2) {
					this.log.warn(
						'[Cync TCP] TLS relaxed failed, falling back to plain TCP…',
					);
					socket = await this.openTcpSocket(host, portTCP);
				}
			}
		} catch (err) {
			this.log.error(
				'[Cync TCP] Failed to connect to %s: %s',
				host,
				String(err),
			);
			this.socket = null;
			return;
		}

		if (!socket) {
			this.log.error('[Cync TCP] Socket is null after connect attempts.');
			this.socket = null;
			return;
		}

		this.socket = socket;
		this.attachSocketListeners(this.socket);

		// Send loginCode immediately, as HA does.
		if (this.loginCode && this.loginCode.length > 0) {
			this.socket.write(Buffer.from(this.loginCode));
			this.log.info(
				'[Cync TCP] Login code sent (%d bytes).',
				this.loginCode.length,
			);
		} else {
			this.log.warn(
				'[Cync TCP] establishSocket() reached with no loginCode; skipping auth write.',
			);
		}

		// Start heartbeat: every 180 seconds send d3 00 00 00 00
		this.startHeartbeat();
	}

	private openTlsSocket(host: string, port: number, strict: boolean): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const sock = tls.connect(
				{
					host,
					port,
					rejectUnauthorized: strict,
				},
				() => resolve(sock),
			);
			sock.once('error', reject);
		});
	}

	private openTcpSocket(host: string, port: number): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const sock = net.createConnection({ host, port }, () => resolve(sock));
			sock.once('error', reject);
		});
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
		}
		this.heartbeatTimer = setInterval(() => {
			if (!this.socket || this.socket.destroyed) {
				return;
			}
			this.socket.write(Buffer.from('d300000000', 'hex'));
		}, 180_000);
	}

	private nextSeq(): number {
		if (this.seq === 65535) {
			this.seq = 1;
		} else {
			this.seq++;
		}
		return this.seq;
	}

	private buildPowerPacket(
		controllerId: number,
		meshId: number,
		on: boolean,
		seq: number,
	): Buffer {
		const header = Buffer.from('730000001f', 'hex');

		const switchBytes = Buffer.alloc(4);
		switchBytes.writeUInt32BE(controllerId, 0);

		const seqBytes = Buffer.alloc(2);
		seqBytes.writeUInt16BE(seq, 0);

		const middle = Buffer.from('007e00000000f8d00d000000000000', 'hex');

		const meshBytes = Buffer.alloc(2);
		meshBytes.writeUInt16LE(meshId, 0);

		const tail = Buffer.from(on ? 'd00000010000' : 'd00000000000', 'hex');

		const checksumSeed = on ? 430 : 429;
		const checksumByte =
			(checksumSeed + meshBytes[0] + meshBytes[1]) & 0xff;
		const checksum = Buffer.from([checksumByte]);

		const end = Buffer.from('7e', 'hex');

		return Buffer.concat([
			header,
			switchBytes,
			seqBytes,
			middle,
			meshBytes,
			tail,
			checksum,
			end,
		]);
	}

	public async disconnect(): Promise<void> {
		this.log.info('[Cync TCP] disconnect() called.');
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
	}

	public onDeviceUpdate(cb: DeviceUpdateCallback): void {
		this.log.info('[Cync TCP] device update subscriber registered.');
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

	public onRawFrame(listener: RawFrameListener): void {
		this.rawFrameListeners.push(listener);
	}

	/**
	 * High-level API to change switch state.
	 * Ensures we have a live socket before sending.
	 */
	public async setSwitchState(
		deviceId: string,
		params: { on: boolean },
	): Promise<void> {
		if (!this.config) {
			this.log.warn('[Cync TCP] No config available.');
			return;
		}

		const connected = await this.ensureConnected();
		if (!connected || !this.socket || this.socket.destroyed) {
			this.log.warn(
				'[Cync TCP] Cannot send, socket not ready even after reconnect attempt.',
			);
			return;
		}

		const device = this.findDevice(deviceId);
		if (!device) {
			this.log.warn('[Cync TCP] Unknown deviceId=%s', deviceId);
			return;
		}

		const controllerId = Number((device as Record<string, unknown>).switch_controller);
		const meshIndex = Number((device as Record<string, unknown>).mesh_id);

		if (!Number.isFinite(controllerId) || !Number.isFinite(meshIndex)) {
			this.log.warn(
				'[Cync TCP] Device %s is missing LAN fields (switch_controller=%o mesh_id=%o)',
				deviceId,
				(device as Record<string, unknown>).switch_controller,
				(device as Record<string, unknown>).mesh_id,
			);
			return;
		}

		const seq = this.nextSeq();
		const packet = this.buildPowerPacket(controllerId, meshIndex, params.on, seq);

		this.socket.write(packet);
		this.log.info(
			'[Cync TCP] Sent power packet: device=%s on=%s seq=%d',
			deviceId,
			String(params.on),
			seq,
		);
	}

	private findDevice(deviceId: string) {
		for (const mesh of this.config?.meshes ?? []) {
			for (const dev of mesh.devices ?? []) {
				const record = dev as Record<string, unknown>;
				const devDeviceId = record.device_id !== undefined && record.device_id !== null
					? String(record.device_id)
					: undefined;
				const devId = record.id !== undefined && record.id !== null
					? String(record.id)
					: undefined;

				if (devDeviceId === deviceId || devId === deviceId) {
					return dev;
				}
			}
		}
		return null;
	}

	private attachSocketListeners(socket: net.Socket): void {
		socket.on('data', (chunk) => {
			this.log.debug('[Cync TCP] received %d bytes from server', chunk.byteLength);
			this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
			this.processIncoming();
		});

		socket.on('close', () => {
			this.log.warn('[Cync TCP] Socket closed.');
			this.socket = null;
		});

		socket.on('error', (err) => {
			this.log.error('[Cync TCP] Socket error:', String(err));
		});
	}

	private processIncoming(): void {
		while (this.readBuffer.length >= 5) {
			const type = this.readBuffer.readUInt8(0);
			const len = this.readBuffer.readUInt32BE(1);
			const total = 5 + len;

			if (this.readBuffer.length < total) {
				return;
			}

			const body = this.readBuffer.subarray(5, total);

			// Debug log with full hex dump so we can reverse-engineer the protocol
			this.log.debug(
				'[Cync TCP] frame type=0x%s len=%d body=%s',
				type.toString(16).padStart(2, '0'),
				len,
				body.toString('hex'),
			);

			if (type === 0x7b && body.length >= 6) {
				const seq = body.readUInt16BE(4);
				this.log.debug('[Cync TCP] ACK for seq=%d', seq);
			} else {
				this.handleIncomingFrame(body, type);
			}

			this.readBuffer = this.readBuffer.subarray(total);
		}
	}

	private async sendRawCommand(
		deviceId: string,
		command: string,
		params: Record<string, unknown>,
	): Promise<void> {
		if (!this.config || !this.loginCode) {
			this.log.warn(
				'TcpClient.sendRawCommand() called before connect(); deviceId=%s command=%s params=%o',
				deviceId,
				command,
				params,
			);
			return;
		}

		this.log.info(
			'TcpClient.sendRawCommand() stub: deviceId=%s command=%s params=%o',
			deviceId,
			command,
			params,
		);
	}

	// ### 🧩 Incoming Frame Handler: routes LAN messages to raw + parsed callbacks
	private handleIncomingFrame(frame: Buffer, type: number): void {
		// Fan out raw frame to higher layers (CyncClient) for debugging
		for (const listener of this.rawFrameListeners) {
			try {
				listener(frame);
			} catch (err) {
				this.log.error(
					'[Cync TCP] raw frame listener threw: %s',
					String(err),
				);
			}
		}

		// Default payload is the raw frame
		let payload: unknown = frame;

		if (type === 0x83) {
			// Preferred path: HA-style per-device parsing using homeDevices + switchIdToHomeId
			const lanParsed = this.parseLanSwitchUpdate(frame);
			if (lanParsed) {
				payload = lanParsed;
			} else {
				// Fallback to legacy controller-level parsing
				const parsed = this.parseSwitchStateFrame(frame);
				if (parsed) {
					const deviceId = this.controllerToDevice.get(parsed.controllerId);
					payload = {
						...parsed,
						deviceId,
					};
				}
			}
		}

		if (this.deviceUpdateCb) {
			this.deviceUpdateCb(payload);
		} else {
			this.log.debug(
				'[Cync TCP] Dropping device update frame (no subscriber).',
			);
		}
	}
}
