import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bilibili-notify/internal";

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
			if (/^[0-9a-f]{64}$/i.test(hex)) {
				this.logger.info("[key] 主密钥加载成功");
				return Buffer.from(hex, "hex");
			}
			this.logger.warn(
				"[key] 主密钥文件格式非法（非 64 位十六进制），将重新生成 —— " +
					"既有用该密钥加密的 secrets（B 站 cookie / AI apiKey）届时无法解密、需重新登录。",
			);
		}
		this.logger.info("[key] 未找到有效密钥，生成新密钥");
		return this.createNew();
	}

	async createNew(): Promise<Buffer> {
		const key = randomBytes(32);
		await mkdir(dirname(this.keyPath), { recursive: true });
		// Atomic write: write to .tmp then rename, so an interrupted write
		// can never leave a partial key file (which would cause the next load
		// to silently regenerate the key and orphan all encrypted cookies).
		const tmpPath = `${this.keyPath}.tmp`;
		await writeFile(tmpPath, key.toString("hex"), "utf8");
		try {
			await rename(tmpPath, this.keyPath);
		} catch (e) {
			await unlink(tmpPath).catch(() => {});
			throw e;
		}
		this.logger.info("[key] 新密钥已生成并写入磁盘");
		return key;
	}
}
