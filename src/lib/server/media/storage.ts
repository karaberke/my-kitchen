import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { serverEnv } from '$lib/server/env';

export interface StoredObject {
	stream: ReadableStream<Uint8Array>;
	size: number | null;
	contentType: string | null;
}

/** Same interface for local disk and private S3 so the app never cares which is active. */
export interface StorageAdapter {
	readonly name: 'local' | 's3';
	put(key: string, body: Buffer, contentType: string): Promise<void>;
	get(key: string): Promise<StoredObject | null>;
	delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;
export function assertKey(key: string): string {
	if (!KEY_RE.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
	return key;
}

class LocalStorage implements StorageAdapter {
	readonly name = 'local' as const;
	constructor(private readonly root: string) {}

	private resolve(key: string): string {
		const full = path.resolve(this.root, assertKey(key));
		if (!full.startsWith(path.resolve(this.root) + path.sep))
			throw new Error('Storage key escapes upload directory');
		return full;
	}

	async put(key: string, body: Buffer): Promise<void> {
		const full = this.resolve(key);
		await mkdir(path.dirname(full), { recursive: true });
		const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
		await pipeline(Readable.from(body), createWriteStream(tmp, { mode: 0o640 }));
		await rename(tmp, full);
	}

	async get(key: string): Promise<StoredObject | null> {
		const full = this.resolve(key);
		try {
			const info = await stat(full);
			if (!info.isFile()) return null;
			const nodeStream = createReadStream(full);
			return {
				stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
				size: info.size,
				contentType: null
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
	}

	async delete(key: string): Promise<void> {
		await rm(this.resolve(key), { force: true });
	}
}

class S3Storage implements StorageAdapter {
	readonly name = 's3' as const;
	private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;
	constructor(private readonly bucket: string) {}

	private async client() {
		if (!this.clientPromise) {
			this.clientPromise = (async () => {
				const env = serverEnv();
				const { S3Client } = await import('@aws-sdk/client-s3');
				return new S3Client({
					region: env.S3_REGION,
					endpoint: env.S3_ENDPOINT || undefined,
					forcePathStyle: env.S3_FORCE_PATH_STYLE,
					credentials: env.S3_ACCESS_KEY_ID
						? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
						: undefined
				});
			})();
		}
		return this.clientPromise;
	}

	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		const { PutObjectCommand } = await import('@aws-sdk/client-s3');
		await (
			await this.client()
		).send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: assertKey(key),
				Body: body,
				ContentType: contentType
			})
		);
	}

	async get(key: string): Promise<StoredObject | null> {
		const { GetObjectCommand } = await import('@aws-sdk/client-s3');
		try {
			const res = await (
				await this.client()
			).send(new GetObjectCommand({ Bucket: this.bucket, Key: assertKey(key) }));
			if (!res.Body) return null;
			// Streamed, never buffered: the SDK body becomes a web stream directly.
			const stream = res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
			return { stream, size: res.ContentLength ?? null, contentType: res.ContentType ?? null };
		} catch (err) {
			if ((err as { name?: string }).name === 'NoSuchKey') return null;
			throw err;
		}
	}

	async delete(key: string): Promise<void> {
		const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
		await (
			await this.client()
		).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: assertKey(key) }));
	}
}

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
	if (adapter) return adapter;
	const env = serverEnv();
	adapter =
		env.STORAGE_BACKEND === 's3' ? new S3Storage(env.S3_BUCKET) : new LocalStorage(env.UPLOAD_DIR);
	return adapter;
}
