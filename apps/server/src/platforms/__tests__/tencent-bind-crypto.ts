/**
 * 测试替身:按**腾讯回传 AppSecret 的格式**加密,即 `decryptBindSecret` 的对手方。
 *
 * 不是 `*.test.ts`,vitest 不会当用例收(include 只认 `*.{test,spec}.*`)。
 *
 * 独立成文件的理由:平台层与路由层两套测试都要伪造完成态响应,各抄一份的话,
 * 腾讯哪天改了 payload 布局(nonce 长度、tag 位置),改动的人只会改到自己眼前
 * 那一份 —— 另一份继续对着旧线格式断言,绿得理直气壮。
 */
import { createCipheriv, randomBytes } from "node:crypto";

/**
 * @param plaintext 明文 AppSecret。
 * @param keyB64 create_bind_task 时预递的 base64 AES-256 密钥。
 * @returns base64 的 `nonce(12) + 密文 + GCM tag(16)`。
 */
export function encryptLikeTencent(plaintext: string, keyB64: string): string {
	const key = Buffer.from(keyB64, "base64");
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}
