import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "@bilibili-notify/internal";
import { atomicWriteFile } from "./atomic-file";

export class KeyManager {
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
				this.logger.error(`[key] 主密钥读取失败（非缺失）: ${(e as Error).message}`);
				throw e;
			}
			// ENOENT → 首次运行,正常创建
		}
		if (hex !== null) {
			const key = parseMasterKeyHex(hex);
			if (key) {
				this.logger.info("[key] 主密钥加载成功");
				return key;
			}
			this.logger.warn(
				"[key] 主密钥文件格式非法（非 64 位十六进制），将重新生成 —— " +
					"既有用该密钥加密的 secrets（来源凭据 / AI apiKey）届时无法解密、需重新登录。",
			);
		}
		this.logger.info("[key] 未找到有效密钥，生成新密钥");
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
		this.logger.info("[key] 新密钥已生成并写入磁盘");
		return key;
	}
}

/** 主密钥文件的内容:精确 64 位十六进制(32 字节)。别的一律不认。 */
export function parseMasterKeyHex(text: string): Buffer | null {
	const hex = text.trim();
	return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}
