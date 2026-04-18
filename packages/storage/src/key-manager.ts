import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
		await writeFile(this.keyPath, key.toString("hex"), "utf8");
		this.logger.info("[key] 新密钥已生成并写入磁盘");
		return key;
	}
}
