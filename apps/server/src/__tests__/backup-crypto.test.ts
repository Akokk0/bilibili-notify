import { describe, expect, it } from "vite-plus/test";
import { type BackupSecretBag, openSecrets, sealSecrets } from "../backup/crypto.js";

/**
 * 完整备份档的机密段:用主人的 6 位 PIN 经 scrypt 派生密钥、AES-256-GCM 封装。
 * 测试钉三条:正确 PIN 往返、错 PIN 抛错(GCM 认证失败)、每次封装换新 salt
 * (同 bag+PIN 也产不同密文,防重放/关联)。
 */
const BAG: BackupSecretBag = {
	aiApiKey: "sk-1",
	cookiesJson: '{"SESSDATA":"abc"}',
	refreshToken: "rt-1",
	adapterConfigs: { a1: { transport: "ws", url: "ws://x", accessToken: "tok" } },
};

describe("backup secrets crypto (PIN seal/open)", () => {
	it("round-trips a secret bag through seal → open with the correct PIN", () => {
		const enc = sealSecrets("123456", BAG);
		expect(openSecrets("123456", enc)).toEqual(BAG);
	});

	it("throws on the wrong PIN (GCM auth failure)", () => {
		const enc = sealSecrets("123456", { aiApiKey: "sk-1" });
		expect(() => openSecrets("0000", enc)).toThrow();
	});

	it("uses a fresh salt per seal (same bag+PIN → different ciphertext)", () => {
		const a = sealSecrets("123456", BAG);
		const b = sealSecrets("123456", BAG);
		expect(a.kdf.salt).not.toBe(b.kdf.salt);
		expect(a.cipher.data).not.toBe(b.cipher.data);
	});
});
