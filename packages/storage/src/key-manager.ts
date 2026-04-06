import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class KeyManager {
	constructor(private readonly keyPath: string) {}

	async loadOrCreate(): Promise<Buffer> {
		try {
			const hex = (await readFile(this.keyPath, "utf8")).trim();
			if (!/^[0-9a-f]{64}$/i.test(hex)) {
				throw new Error("key file format invalid");
			}
			return Buffer.from(hex, "hex");
		} catch {
			return this.createNew();
		}
	}

	async createNew(): Promise<Buffer> {
		const key = randomBytes(32);
		await mkdir(dirname(this.keyPath), { recursive: true });
		await writeFile(this.keyPath, key.toString("hex"), "utf8");
		return key;
	}
}
