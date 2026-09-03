import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { loadSignedManifest } from "../apps/server/src/update/signed-manifest.js";
import { buildManifest, signManifest } from "./sign-update-manifest.mjs";

/**
 * 发版侧的签名工具。
 *
 * 测试全部**跨到客户端那半边**去验(`loadSignedManifest`):签名机制的价值完全建立
 * 在「我们签的」和「它认的」是同一件事上。两边各测各的,等于两边各自复述自己的
 * 想法 —— 而这个契约一旦对不上,症状是全世界的客户端一起报「签名不对」,看起来
 * 像被人做了手脚,实际是我们自己签错了东西。
 */

function makeKey() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		spkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

const FULL = {
	version: "0.9.0",
	payload: {
		url: "https://github.com/o/r/releases/download/v0.9.0/payload-0.9.0.zip",
		sha256: "b".repeat(64),
		size: 26_214_400,
	},
	releaseUrl: "https://github.com/o/r/releases/tag/v0.9.0",
	issuedAt: 1_756_800_000,
};

describe("signManifest", () => {
	it("签出来的信封,客户端验得过、读得出", () => {
		const key = makeKey();

		const { envelopeJson } = signManifest(buildManifest(FULL), key.privateKeyPem);
		const envelope = JSON.parse(envelopeJson);

		const result = loadSignedManifest(Buffer.from(envelope.manifest, "utf8"), envelope.signature, [
			key.spkiBase64,
		]);
		if (!result.ok) throw new Error(`client rejected our own manifest: ${result.reason}`);
		expect(result.manifest.version).toBe("0.9.0");
		expect(result.manifest.payload.sha256).toBe("b".repeat(64));
		expect(result.manifest.releaseUrl).toBe(FULL.releaseUrl);
	});

	it("信封整个重新排版一遍,签名照样成立", () => {
		const key = makeKey();
		const { envelopeJson } = signManifest(buildManifest(FULL), key.privateKeyPem);

		// 信封本身**从不被签**,被签的是里头那串字符。所以谁把这个文件重新缩进、
		// 换键序、过一遍 formatter,都不该影响验签 —— 这正是清单以字符串而不是
		// 对象存放的理由。反过来:一旦哪天有人「顺手」把它展开成对象,这条会红。
		const reformatted = JSON.stringify(
			{
				signature: JSON.parse(envelopeJson).signature,
				manifest: JSON.parse(envelopeJson).manifest,
			},
			null,
			4,
		);
		const envelope = JSON.parse(reformatted);

		const result = loadSignedManifest(Buffer.from(envelope.manifest, "utf8"), envelope.signature, [
			key.spkiBase64,
		]);
		expect(result.ok).toBe(true);
	});

	it("清单内容被改一个字,验签就不过", () => {
		const key = makeKey();
		const { envelopeJson } = signManifest(buildManifest(FULL), key.privateKeyPem);
		const envelope = JSON.parse(envelopeJson);

		const tampered = envelope.manifest.replace('"0.9.0"', '"9.9.9"');
		expect(tampered).not.toBe(envelope.manifest);

		const result = loadSignedManifest(Buffer.from(tampered, "utf8"), envelope.signature, [
			key.spkiBase64,
		]);
		expect(result.ok).toBe(false);
	});

	it("私钥缺失或不是 Ed25519 → 当场抛,绝不产出一个没签好的信封", () => {
		const manifest = buildManifest(FULL);
		expect(() => signManifest(manifest, "")).toThrow();
		expect(() => signManifest(manifest, "not a key")).toThrow();
		// RSA 私钥是合法 PEM,但签出来的东西 Ed25519 公钥验不了 —— 与其发出去
		// 让所有人验签失败,不如在发版机上死。
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
		expect(() =>
			signManifest(manifest, rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
		).toThrow(/ed25519/i);
	});

	it("base64 包过一层的私钥也认 —— CI secret 里 PEM 的换行最容易丢", () => {
		const key = makeKey();

		const { envelopeJson } = signManifest(
			buildManifest(FULL),
			Buffer.from(key.privateKeyPem, "utf8").toString("base64"),
		);
		const envelope = JSON.parse(envelopeJson);

		const result = loadSignedManifest(Buffer.from(envelope.manifest, "utf8"), envelope.signature, [
			key.spkiBase64,
		]);
		expect(result.ok).toBe(true);
	});
});

describe("buildManifest", () => {
	it("没传的可选字段一个都不出现 —— 不留 null 让客户端的 schema 拒掉", () => {
		const manifest = buildManifest(FULL);

		// zod 的 `.optional()` 收 undefined 不收 null。写 `"notes": null` 会让整份清单
		// 变成 malformed,而它签得过 —— 用户看到的是「清单损坏」,查不到是这里。
		expect(Object.hasOwn(manifest, "notes")).toBe(false);
		expect(Object.hasOwn(manifest, "requires")).toBe(false);
		expect(Object.hasOwn(manifest, "revoked")).toBe(false);
	});

	it("撤回名单与运行时门槛传了就带上,且客户端认得出", () => {
		const key = makeKey();
		const { envelopeJson } = signManifest(
			buildManifest({
				...FULL,
				revoked: ["0.8.9", "0.8.8"],
				requires: { nodeMajor: 22 },
				notes: "修了个大的",
			}),
			key.privateKeyPem,
		);
		const envelope = JSON.parse(envelopeJson);

		const result = loadSignedManifest(Buffer.from(envelope.manifest, "utf8"), envelope.signature, [
			key.spkiBase64,
		]);
		if (!result.ok) throw new Error(`client rejected: ${result.reason}`);
		expect(result.manifest.revoked).toEqual(["0.8.9", "0.8.8"]);
		expect(result.manifest.requires).toEqual({ nodeMajor: 22 });
		expect(result.manifest.notes).toBe("修了个大的");
	});

	it("签发时间:不传就是现在(整数秒),传了就用传的 —— 客户端靠它拒绝被回放的旧清单", () => {
		const { issuedAt: _dropped, ...withoutIssuedAt } = FULL;
		const before = Math.floor(Date.now() / 1000);
		const stamped = buildManifest(withoutIssuedAt);
		expect(Number.isInteger(stamped.issuedAt)).toBe(true);
		expect(stamped.issuedAt).toBeGreaterThanOrEqual(before);

		expect(buildManifest({ ...FULL, issuedAt: 42 }).issuedAt).toBe(42);
		expect(() => buildManifest({ ...FULL, issuedAt: 0 })).toThrow();
		expect(() => buildManifest({ ...FULL, issuedAt: 1.5 })).toThrow();
	});

	it("客户端会拒的东西,这里就该拒 —— 别等发出去才发现", () => {
		// 发版侧多一道同样的门:清单一旦发出去就收不回来了,而客户端拒绝的表现是
		// 「所有人都升不上去」。在打包机上炸的成本是重跑一次 CI。
		expect(() => buildManifest({ ...FULL, version: "" })).toThrow();
		expect(() =>
			buildManifest({ ...FULL, payload: { ...FULL.payload, url: "http://x/p.zip" } }),
		).toThrow();
		expect(() =>
			buildManifest({ ...FULL, payload: { ...FULL.payload, sha256: "B".repeat(64) } }),
		).toThrow();
		expect(() => buildManifest({ ...FULL, releaseUrl: "not-a-url" })).toThrow();
	});
});
