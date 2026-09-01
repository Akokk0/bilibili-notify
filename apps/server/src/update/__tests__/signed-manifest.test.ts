import { sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { loadSignedManifest } from "../signed-manifest.js";

/**
 * 升级清单的信任入口。**未验签的字节永远变不成 Manifest** —— 解析与验签合成
 * 一扇门,调用方手里不存在「已解析但没验证」的中间态,「忘了验签」这类 bug
 * 从源头就不可能发生。
 */

/** 客户端内置的信任列表就是这个形状:Ed25519 公钥的 SPKI DER,base64。 */
function makeKey(): { privateKey: KeyObject; spkiBase64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		spkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

function signBytes(privateKey: KeyObject, bytes: Uint8Array): string {
	return cryptoSign(null, bytes, privateKey).toString("base64");
}

/** 一份**完整**的清单长这样 —— 少了任何一块,客户端都不知道该去下什么。 */
function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: "0.9.0",
		payload: {
			url: "https://github.com/o/r/releases/download/v0.9.0/payload-0.9.0.zip",
			sha256: "a".repeat(64),
			size: 26_214_400,
		},
		releaseUrl: "https://github.com/o/r/releases/tag/v0.9.0",
		...overrides,
	};
}

describe("loadSignedManifest", () => {
	it("备用公钥签的 manifest 照样验得过 —— 双密钥保险的命门", () => {
		const primary = makeKey();
		const backup = makeKey();
		const bytes = Buffer.from(JSON.stringify(makeManifest()), "utf8");

		// 主用私钥泄露时,唯一的退路是用**从未进过 CI** 的备用私钥签一版、把主用公钥
		// 踢掉。所以备用公钥必须从第一版起就躺在信任列表里 —— 公钥列表冻在已发出的
		// 安装里,后加的救不了存量用户。
		const result = loadSignedManifest(bytes, signBytes(backup.privateKey, bytes), [
			primary.spkiBase64,
			backup.spkiBase64,
		]);

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(result.manifest.version).toBe("0.9.0");
	});

	it("签名验过了但内容不是合法 JSON → 拒绝,不抛异常", () => {
		const key = makeKey();
		// 清单是从网上下来的。任何让它把进程带走的路径,都等于给了分发链一个
		// 拒绝服务的开关 —— 而分发链上站着的是我们不控制的代理站。
		const bytes = Buffer.from("{ 这不是 JSON", "utf8");

		const result = loadSignedManifest(bytes, signBytes(key.privateKey, bytes), [key.spkiBase64]);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("malformed");
	});

	it("签名验过了但不是一份清单的形状 → 拒绝,不把垃圾当 Manifest 交出去", () => {
		const key = makeKey();
		// 验签只证明「这是我们签的、没被改过」,**不证明内容是对的**。我们自己签错
		// 一次东西,下游就会拿着一个 version 是 undefined 的清单去比版本 —— 那正是
		// NapCat 更新完显示 0.0.0 的那一类症状。
		const notManifests = [
			makeManifest({ version: undefined }), // 缺 version
			makeManifest({ version: 900 }), // version 不是字符串
			[makeManifest()], // 顶层是数组
			null, // 合法 JSON,但什么都不是
		];

		for (const shape of notManifests) {
			const bytes = Buffer.from(JSON.stringify(shape), "utf8");
			const result = loadSignedManifest(bytes, signBytes(key.privateKey, bytes), [key.spkiBase64]);
			expect(result.ok, `should reject ${JSON.stringify(shape)}`).toBe(false);
			expect(result.ok === false && result.reason).toBe("malformed");
		}
	});

	it("签名字段本身是垃圾 → 拒绝,不抛异常", () => {
		const key = makeKey();
		const bytes = Buffer.from(JSON.stringify(makeManifest()), "utf8");
		// 签名和清单走同一条路从代理站下来,一样是不可信输入。长度不对、根本不是
		// base64、空串 —— 都只能是「验不过」,不能是「进程没了」。
		const garbage = ["", "not base64 !!!", "AAAA", "x".repeat(200)];

		for (const signature of garbage) {
			const result = loadSignedManifest(bytes, signature, [key.spkiBase64]);
			expect(result.ok, `should reject signature ${JSON.stringify(signature)}`).toBe(false);
			expect(result.ok === false && result.reason).toBe("bad-signature");
		}
	});

	it("内容被改过一个字节 → 拒绝", () => {
		const key = makeKey();
		const original = Buffer.from(JSON.stringify(makeManifest()), "utf8");
		const signature = signBytes(key.privateKey, original);

		// 代理站是**设计上的中间人** —— 它终止 TLS、把字节重新发给我们。签名是我们
		// 唯一能确认「这坨字节没被那个中间人动过」的手段。
		const tampered = Buffer.from(JSON.stringify(makeManifest({ version: "9.9.9" })), "utf8");

		const result = loadSignedManifest(tampered, signature, [key.spkiBase64]);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("bad-signature");
	});

	it("读得出载荷描述:去哪下、多大、校验和是多少", () => {
		const key = makeKey();
		const bytes = Buffer.from(JSON.stringify(makeManifest()), "utf8");

		const result = loadSignedManifest(bytes, signBytes(key.privateKey, bytes), [key.spkiBase64]);

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(result.manifest.payload).toEqual({
			url: "https://github.com/o/r/releases/download/v0.9.0/payload-0.9.0.zip",
			sha256: "a".repeat(64),
			size: 26_214_400,
		});
		// 「下不动就给个链接让用户自己去下」是设计里的兜底出口,链接得在清单里。
		expect(result.manifest.releaseUrl).toBe("https://github.com/o/r/releases/tag/v0.9.0");
	});

	it("载荷描述残缺或不合规 → malformed,别等下完了再说校验失败", () => {
		const key = makeKey();
		// 这几条挡的都是**我们自己发版侧写错**。它们签得过、下得动,最后死在
		// installPayload 的 sha256 比对上 —— 用户看到的是「下载完了升级失败」,
		// 一条完全指错方向的错误信息,而真正错的是清单本身。
		const bad = [
			makeManifest({ payload: undefined }), // 不告诉你去哪下
			makeManifest({ payload: { sha256: "a".repeat(64), size: 1 } }), // 缺 url
			makeManifest({ payload: { url: "https://x/p.zip", size: 1 } }), // 缺校验和
			// http 会让代理站能明文改包。签名保护的是清单,不是这条链接指向的东西 ——
			// 真正拦住改包的是 sha256,但没有理由把 https 这道免费的门也让出去。
			makeManifest({
				payload: { url: "http://x/p.zip", sha256: "a".repeat(64), size: 1 },
			}),
			// 大小写混着的 hex:比对是字符串相等,大写永远匹配不上算出来的小写摘要。
			makeManifest({
				payload: { url: "https://x/p.zip", sha256: "A".repeat(64), size: 1 },
			}),
			// 长度不对的摘要:同理,永远匹配不上,只是死得更晚。
			makeManifest({
				payload: { url: "https://x/p.zip", sha256: "abc", size: 1 },
			}),
			// 体积用来做流式熔断上限,0 / 负数会让每次下载都当场超限。
			makeManifest({
				payload: { url: "https://x/p.zip", sha256: "a".repeat(64), size: 0 },
			}),
			makeManifest({ releaseUrl: undefined }), // 兜底出口没了
		];

		for (const shape of bad) {
			const bytes = Buffer.from(JSON.stringify(shape), "utf8");
			const result = loadSignedManifest(bytes, signBytes(key.privateKey, bytes), [key.spkiBase64]);
			expect(result.ok, `should reject ${JSON.stringify(shape)}`).toBe(false);
			expect(result.ok === false && result.reason).toBe("malformed");
		}
	});

	it("签名本身合法,但不是信任列表里的钥匙签的 → 拒绝", () => {
		const ours = makeKey();
		const stranger = makeKey();
		const bytes = Buffer.from(JSON.stringify(makeManifest()), "utf8");

		// 一个自洽的签名不代表什么 —— 谁都能生成一对密钥去签。**只有信任列表里
		// 那几把**说了算。
		const result = loadSignedManifest(bytes, signBytes(stranger.privateKey, bytes), [
			ours.spkiBase64,
		]);

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("bad-signature");
	});
});
