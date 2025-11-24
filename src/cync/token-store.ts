// src/cync/token-store.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface CyncTokenData {
	userId: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number; // epoch ms, optional if Cync doesn't provide expiry
}

/**
 * Simple JSON token store under the Homebridge storage path.
 */
export class CyncTokenStore {
	private readonly filePath: string;

	public constructor(storagePath: string) {
		this.filePath = path.join(storagePath, 'cync-tokens.json');
	}

	public async load(): Promise<CyncTokenData | null> {
		try {
			const raw = await fs.readFile(this.filePath, 'utf8');
			const data = JSON.parse(raw) as CyncTokenData;

			// If expiresAt is set and in the past, treat as invalid
			if (data.expiresAt && data.expiresAt <= Date.now()) {
				return null;
			}

			return data;
		} catch {
			return null;
		}
	}

	public async save(data: CyncTokenData): Promise<void> {
		const json = JSON.stringify(data, null, 2);
		await fs.writeFile(this.filePath, json, 'utf8');
	}

	public async clear(): Promise<void> {
		try {
			await fs.unlink(this.filePath);
		} catch {
			// ignore if missing
		}
	}
}
