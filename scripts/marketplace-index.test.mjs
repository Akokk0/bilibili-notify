import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { loadSignedJson } from "../apps/server/src/update/signed-manifest.js";
import { compareVersions } from "../apps/server/src/update/version-order.js";
import {
	checkMarketplaceIndex,
	MarketplaceIndexSchema,
} from "../packages/internal/src/schema/extension-marketplace.ts";
import { compareEntryVersions, mergeMarketplaceEntry } from "./marketplace-index.mjs";
import { signManifest } from "./sign-update-manifest.mjs";

/**
 * 发版侧的官方索引工具。同 sign-update-manifest 的测试:全部**跨到客户端那半边**去验 ——
 * 我们并出来、签出来的东西,客户端得验得过、读得出、过得了官方源那两条规矩。
 */

function makeKey() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		spkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

const entry = (over = {}) => ({
	id: "bridge",
	name: "机器人框架桥接",
	description: "把 koishi / AstrBot 里配好的机器人借给 BN 用。",
	version: "0.0.2",
	apiVersion: 1,
	package: {
		url: "https://github.com/o/r/releases/download/ext/bridge-0.0.2.zip",
		sha256: "a".repeat(64),
		size: 292_400,
	},
	releaseUrl: "https://github.com/o/r/releases/tag/x",
	notes: "第一版。",
	...over,
});

describe("mergeMarketplaceEntry", () => {
	it("第一次发:一条条目、官方名字、带 issuedAt", () => {
		const index = mergeMarketplaceEntry(undefined, entry(), { issuedAt: 100 });
		expect(index).toMatchObject({ name: "BN 官方拓展", issuedAt: 100 });
		expect(index.extensions.map((e) => e.id)).toEqual(["bridge"]);
		expect("revoked" in index).toBe(false);
	});

	it("同 id 换掉、别的照留、按 id 排;revoked 照抄再并上新撤的", () => {
		const current = mergeMarketplaceEntry(undefined, entry({ id: "zeta", version: "1.0.0" }), {
			issuedAt: 1,
		});
		const withBridge = mergeMarketplaceEntry(current, entry({ version: "0.0.1" }), { issuedAt: 2 });
		const next = mergeMarketplaceEntry(withBridge, entry({ version: "0.0.2" }), {
			issuedAt: 3,
			revoke: ["bridge@0.0.1"],
		});
		expect(next.extensions.map((e) => [e.id, e.version])).toEqual([
			["bridge", "0.0.2"],
			["zeta", "1.0.0"],
		]);
		expect(next.revoked).toEqual(["bridge@0.0.1"]);
		const again = mergeMarketplaceEntry(next, entry({ version: "0.0.3" }), {
			issuedAt: 4,
			revoke: ["bridge@0.0.1"],
		});
		expect(again.revoked).toEqual(["bridge@0.0.1"]);
	});

	it("官方索引里的 id 不许带命名空间;半截的条目当场拒", () => {
		expect(() => mergeMarketplaceEntry(undefined, entry({ id: "alice.douyin" }))).toThrow(
			/命名空间/,
		);
		expect(() =>
			mergeMarketplaceEntry(
				undefined,
				entry({ package: { url: "http://x/y.zip", sha256: "a".repeat(64), size: 1 } }),
			),
		).toThrow(/https/);
		expect(() => mergeMarketplaceEntry(undefined, entry({ version: "latest" }))).toThrow(/semver/);
	});

	it("可选字段没给就不写(写 null 会让客户端判 malformed)", () => {
		const index = mergeMarketplaceEntry(
			undefined,
			entry({ notes: undefined, releaseUrl: undefined, description: undefined }),
			{ issuedAt: 1 },
		);
		const only = index.extensions[0];
		expect("notes" in only).toBe(false);
		expect("releaseUrl" in only).toBe(false);
		expect(only.description).toBe("");
	});
});

describe("issuedAt 与版本只许往前走", () => {
	it("手传的 issuedAt 不比当前那份新 → 当场红(runner 时钟回拨 / 手抖)", () => {
		const current = mergeMarketplaceEntry(undefined, entry(), { issuedAt: 100 });
		expect(() =>
			mergeMarketplaceEntry(current, entry({ version: "0.0.3" }), { issuedAt: 100 }),
		).toThrow(/issuedAt/);
		expect(() =>
			mergeMarketplaceEntry(current, entry({ version: "0.0.3" }), { issuedAt: 99 }),
		).toThrow(/issuedAt/);
	});

	it("不传就取 max(现在, 当前 + 1) —— 时钟回拨也不会发出一份客户端会判 stale 的索引", () => {
		const current = mergeMarketplaceEntry(undefined, entry(), { issuedAt: 9_000_000_000 });
		const next = mergeMarketplaceEntry(current, entry({ version: "0.0.3" }));
		expect(next.issuedAt).toBe(9_000_000_001);
		const first = mergeMarketplaceEntry(undefined, entry());
		expect(first.issuedAt).toBeGreaterThan(1_700_000_000);
		expect(first.issuedAt).toBeLessThan(1e11);
	});

	it("issuedAt 误传毫秒 → 拒(发出去就把客户端永久钉死在这一份上)", () => {
		expect(() =>
			mergeMarketplaceEntry(undefined, entry(), { issuedAt: 1_760_000_000_000 }),
		).toThrow(/秒/);
	});

	it("同 id 的版本不许降回去(重跑一个旧 tag);重发同一版放行", () => {
		const current = mergeMarketplaceEntry(undefined, entry({ version: "0.0.2" }), {
			issuedAt: 100,
		});
		expect(() =>
			mergeMarketplaceEntry(current, entry({ version: "0.0.1" }), { issuedAt: 101 }),
		).toThrow(/0\.0\.1/);
		expect(() =>
			mergeMarketplaceEntry(current, entry({ version: "0.0.2-alpha.1" }), { issuedAt: 101 }),
		).toThrow(/0\.0\.2-alpha\.1/);
		expect(
			mergeMarketplaceEntry(current, entry({ version: "0.0.2" }), { issuedAt: 101 }).extensions[0]
				.version,
		).toBe("0.0.2");
	});

	it("并索引用的那把版本尺子与客户端的是同一把(手抄了一份,别让它漂)", () => {
		const pairs = [
			["0.9.0", "0.10.0"],
			["0.0.2", "0.0.2"],
			["1.0.0", "1.0.0-alpha.1"],
			["1.0.0-alpha.9", "1.0.0-alpha.10"],
			["1.0.0-alpha", "1.0.0-alpha.1"],
			["1.0.0-beta", "1.0.0-alpha"],
			["2.0.0", "10.0.0"],
		];
		for (const [a, b] of pairs) {
			expect([a, b, Math.sign(compareEntryVersions(a, b))]).toEqual([
				a,
				b,
				Math.sign(compareVersions(a, b)),
			]);
		}
	});
});

describe("签出来的索引,客户端验得过、读得出、过得了官方源的规矩", () => {
	it("round-trip", () => {
		const key = makeKey();
		const index = mergeMarketplaceEntry(undefined, entry(), { issuedAt: 1_760_000_000 });
		const { envelopeJson } = signManifest(index, key.privateKeyPem);
		const envelope = JSON.parse(envelopeJson);
		const loaded = loadSignedJson(
			Buffer.from(envelope.manifest, "utf8"),
			envelope.signature,
			[key.spkiBase64],
			MarketplaceIndexSchema,
		);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(checkMarketplaceIndex(loaded.value, { official: true })).toEqual({ ok: true });
		expect(loaded.value.extensions[0]).toMatchObject({
			id: "bridge",
			version: "0.0.2",
			notes: "第一版。",
		});
	});
});
