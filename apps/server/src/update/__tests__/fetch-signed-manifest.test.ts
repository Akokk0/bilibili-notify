import { sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchSignedManifest } from "../fetch-signed-manifest.js";

/**
 * 一次往返拿到**已验签**的清单。
 *
 * 信封形如 `{ manifest: "<原始清单内容,当字符串>", signature: "<base64>" }` ——
 * 外层信封从不被签,被签的是 `manifest` 那串字符。它是文件的真子集且不含签名,
 * 所以没有「文件包含自己的签名」那种循环。
 */
const RELEASE_URL =
	"https://github.com/Akokk0/bilibili-notify/releases/download/latest/latest.json";

afterEach(() => {
	vi.unstubAllGlobals();
});

function makeKey(): { privateKey: KeyObject; spkiBase64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		spkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

function signText(privateKey: KeyObject, text: string): string {
	return cryptoSign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
}

function serveOnce(body: string): void {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
}

describe("fetchSignedManifest", () => {
	it("内层字符串排版再怪也验得过 —— 验的是解析出来的那串字符,不是重新序列化的结果", async () => {
		const key = makeKey();
		// 键序反着、缩进乱七八糟。任何「把 manifest 展开成对象、验签时再重新序列化」
		// 的实现都会在这里算出不同的字节而验不过 —— 而 JSON 的重新序列化根本不唯一
		// (键序/空白/数字写法/unicode 转义),那条路会带来一种查都没法查的验签失败。
		const inner =
			'{\n  "revoked" : [],\n\t"version":   "0.9.0",\n "releaseUrl":"https://github.com/o/r/releases/tag/v0.9.0",\n\t\t"payload"  : {"size":1,"sha256":"' +
			"a".repeat(64) +
			'","url":"https://github.com/o/r/p.zip"}\n}';
		serveOnce(JSON.stringify({ manifest: inner, signature: signText(key.privateKey, inner) }));

		const result = await fetchSignedManifest({
			url: RELEASE_URL,
			mirrors: [""],
			trustedKeys: [key.spkiBase64],
			timeoutMs: 1000,
			maxBytes: 64 * 1024,
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(result.manifest.version).toBe("0.9.0");
	});

	it("签名验过了但内层不是一份清单 → 报 malformed,不能报成 untrusted", async () => {
		// 这种情况是**我们自己发错了东西**,不是有人在中间做手脚。报成 untrusted 会
		// 给用户弹一个「这个更新包不可信」的红色警告 —— 吓人,而且把排查方向指反了。
		const key = makeKey();
		const inner = '{"notAManifest":true}';
		serveOnce(JSON.stringify({ manifest: inner, signature: signText(key.privateKey, inner) }));

		const result = await fetchSignedManifest({
			url: RELEASE_URL,
			mirrors: [""],
			trustedKeys: [key.spkiBase64],
			timeoutMs: 1000,
			maxBytes: 64 * 1024,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("malformed");
	});

	it("所有候选站都拿不到 → unreachable,和「不可信」分得清清楚楚", async () => {
		// 用户看到的东西完全不同:「网络不通,稍后再试」是无害的日常,「这个更新包
		// 不可信」是要弹红字的安全事件。混成一个,代理站抽风会天天吓用户,而真正
		// 被掉包的那次会被当成网络问题放过去。
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("网络不通")));

		const result = await fetchSignedManifest({
			url: RELEASE_URL,
			mirrors: ["https://a.example", "https://b.example"],
			trustedKeys: [makeKey().spkiBase64],
			timeoutMs: 1000,
			maxBytes: 64 * 1024,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("unreachable");
	});

	it("内层被人改过 → untrusted", async () => {
		const key = makeKey();
		const signed = '{"version":"0.9.0"}';
		// 签名是对上面那串签的,送来的却是下面这串。
		serveOnce(
			JSON.stringify({
				manifest: '{"version":"9.9.9"}',
				signature: signText(key.privateKey, signed),
			}),
		);

		const result = await fetchSignedManifest({
			url: RELEASE_URL,
			mirrors: [""],
			trustedKeys: [key.spkiBase64],
			timeoutMs: 1000,
			maxBytes: 64 * 1024,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("untrusted");
	});

	it("信封本身就不成形 → malformed,不抛", async () => {
		const key = makeKey();
		const broken = [
			"这不是 JSON",
			JSON.stringify({ manifest: '{"version":"0.9.0"}' }), // 缺签名
			JSON.stringify({ signature: "AAAA" }), // 缺清单
			JSON.stringify({ manifest: { version: "0.9.0" }, signature: "AAAA" }), // 展开成了对象
		];

		for (const body of broken) {
			serveOnce(body);
			const result = await fetchSignedManifest({
				url: RELEASE_URL,
				mirrors: [""],
				trustedKeys: [key.spkiBase64],
				timeoutMs: 1000,
				maxBytes: 64 * 1024,
			});
			expect(result.ok, `should reject ${body.slice(0, 40)}`).toBe(false);
			expect(result.ok === false && result.reason).toBe("malformed");
		}
	});
});
