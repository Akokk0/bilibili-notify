import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "koishi";

export class KeyManager {
	constructor(
		private readonly keyPath: string,
		private readonly logger: Logger,
	) {}

	async loadOrCreate(): Promise<Buffer> {
		try {
			const hex = (await readFile(this.keyPath, "utf8")).trim();
			if (!/^[0-9a-f]{64}$/i.test(hex)) {
				throw new Error("key file format invalid");
			}
			this.logger.info("[key] 主密钥加载成功");
			return Buffer.from(hex, "hex");
		} catch {
			this.logger.info("[key] 未找到有效密钥，生成新密钥");
			return this.createNew();
		}
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
