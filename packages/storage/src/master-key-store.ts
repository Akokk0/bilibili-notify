import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "@bilibili-notify/internal";
import { packageText } from "@bilibili-notify/internal/texts";
import { atomicWriteFile } from "./atomic-file";

export class MasterKeyStore {
	constructor(
		private readonly keyPath: string,
		private readonly logger: Logger,
	) {}

	async loadOrCreate(): Promise<Buffer> {
		let hex: string | null = null;
		try {
			hex = (await readFile(this.keyPath, "utf8")).trim();
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				// 文件存在但读不了(EACCES/EIO/EBUSY…):绝不能静默重生成 —— 那会换
				// master.key,把所有已 GCM 加密的 cookie / AI apiKey 一次性变为无法
				// 解密(数据销毁)。与 key-provider.ts 的 salt loader 同策略。
				this.logger.error(
					packageText("storage.log.masterReadFailed"),
					{ event: "storage.master_key_read_failed", path: this.keyPath },
					e,
				);
				throw e;
			}
			// ENOENT → 首次运行,正常创建
		}
		if (hex !== null) {
			const key = parseMasterKeyHex(hex);
			if (key) {
				this.logger.info(packageText("storage.log.masterLoaded"), {
					event: "storage.master_key_loaded",
					path: this.keyPath,
				});
				return key;
			}
			this.logger.warn(packageText("storage.log.masterInvalid"), {
				event: "storage.master_key_invalid",
				path: this.keyPath,
			});
		}
		this.logger.info(packageText("storage.log.masterCreating"), {
			event: "storage.master_key_creating",
			path: this.keyPath,
		});
		return this.createNew();
	}

	private async createNew(): Promise<Buffer> {
		const key = randomBytes(32);
		// Atomic write: temp file (unique per pid + random, so concurrent first
		// starts never trample each other's temp) then rename, so an interrupted
		// write can never leave a partial key file (which would cause the next load
		// to silently regenerate the key and orphan all encrypted cookies).
		// 0o600: the key is a secret; nobody but the owner needs to read it.
		await atomicWriteFile(this.keyPath, key.toString("hex"), { mode: 0o600 });
		this.logger.info(packageText("storage.log.masterCreated"), {
			event: "storage.master_key_created",
			path: this.keyPath,
		});
		return key;
	}
}

/** 主密钥文件的内容:精确 64 位十六进制(32 字节)。别的一律不认。 */
export function parseMasterKeyHex(text: string): Buffer | null {
	const hex = text.trim();
	return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}
