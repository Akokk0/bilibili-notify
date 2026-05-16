/**
 * 单元测试 — `secret-box`(AES-256-GCM 认证加密 + scrypt 派生)。
 *
 * 守护契约:
 *   - encrypt→decrypt round-trip(utf8 / unicode / 空串)
 *   - 错误 key / 篡改 data / 篡改 tag → decrypt 抛错(GCM 认证生效)
 *   - isGcmBlob 区分 v2 blob 与 legacy CBC {iv,data};gcmDecrypt 拒收 legacy
 *   - deriveKeyFromPassphrase 对 (passphrase,salt) 确定;换 salt/passphrase → 变;长度 32;空 passphrase 抛
 *   - 非 32 字节 key → encrypt/decrypt 抛
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	deriveKeyFromPassphrase,
	gcmDecrypt,
	gcmEncrypt,
	type GcmBlob,
	isGcmBlob,
} from "../secret-box";

const KEY = randomBytes(32);

describe("gcmEncrypt / gcmDecrypt", () => {
	it("round-trip:ascii / unicode / 空串", () => {
		for (const text of ["hello", "中文🔐 secret", ""]) {
			const blob = gcmEncrypt(KEY, text);
			expect(blob.v).toBe(2);
			expect(gcmDecrypt(KEY, blob)).toBe(text);
		}
	});

	it("每次 iv 随机:同明文两次密文不同", () => {
		const a = gcmEncrypt(KEY, "x");
		const b = gcmEncrypt(KEY, "x");
		expect(a.iv).not.toBe(b.iv);
		expect(a.data === b.data && a.tag === b.tag).toBe(false);
	});

	it("错误 key → decrypt 抛(认证失败)", () => {
		const blob = gcmEncrypt(KEY, "secret");
		expect(() => gcmDecrypt(randomBytes(32), blob)).toThrow();
	});

	it("篡改 data / tag → decrypt 抛", () => {
		const blob = gcmEncrypt(KEY, "secret");
		const flip = (b64: string) => Buffer.from(b64, "base64");
		const badData: GcmBlob = { ...blob, data: Buffer.concat([flip(blob.data), Buffer.from([1])]).toString("base64") };
		const badTag: GcmBlob = { ...blob, tag: randomBytes(16).toString("base64") };
		expect(() => gcmDecrypt(KEY, badData)).toThrow();
		expect(() => gcmDecrypt(KEY, badTag)).toThrow();
	});

	it("非 32 字节 key → 抛", () => {
		expect(() => gcmEncrypt(randomBytes(16), "x")).toThrow(/32 bytes/);
		expect(() => gcmDecrypt(randomBytes(31), gcmEncrypt(KEY, "x"))).toThrow(/32 bytes/);
	});
});

describe("isGcmBlob / legacy 拒收", () => {
	it("v2 blob → true;legacy CBC {iv,data} / 杂物 → false", () => {
		expect(isGcmBlob(gcmEncrypt(KEY, "x"))).toBe(true);
		expect(isGcmBlob({ iv: "aa", data: "bb" })).toBe(false); // legacy CBC
		expect(isGcmBlob({ v: 1, iv: "a", tag: "b", data: "c" })).toBe(false);
		expect(isGcmBlob(null)).toBe(false);
		expect(isGcmBlob("nope")).toBe(false);
	});

	it("gcmDecrypt 对 legacy/损坏 blob 抛带明确信息的错误", () => {
		expect(() => gcmDecrypt(KEY, { iv: "aa", data: "bb" })).toThrow(/legacy|GCM blob/i);
	});
});

describe("deriveKeyFromPassphrase", () => {
	const salt = randomBytes(16);

	it("同 (passphrase,salt) 确定,长度 32", () => {
		const k1 = deriveKeyFromPassphrase("hunter2", salt);
		const k2 = deriveKeyFromPassphrase("hunter2", salt);
		expect(k1).toEqual(k2);
		expect(k1.length).toBe(32);
	});

	it("换 salt 或 passphrase → 不同 key", () => {
		const base = deriveKeyFromPassphrase("hunter2", salt);
		expect(deriveKeyFromPassphrase("hunter2", randomBytes(16)).equals(base)).toBe(false);
		expect(deriveKeyFromPassphrase("hunter3", salt).equals(base)).toBe(false);
	});

	it("空 passphrase 抛", () => {
		expect(() => deriveKeyFromPassphrase("", salt)).toThrow(/empty passphrase/);
	});

	it("派生 key 可直接用于 GCM round-trip", () => {
		const k = deriveKeyFromPassphrase("a-strong-passphrase", salt);
		expect(gcmDecrypt(k, gcmEncrypt(k, "payload"))).toBe("payload");
	});
});
