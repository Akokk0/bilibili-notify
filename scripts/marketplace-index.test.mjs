import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { loadSignedJson } from "../apps/server/src/update/signed-manifest.js";
import { compareVersions } from "../apps/server/src/update/version-order.js";
import {
	checkMarketplaceIndex,
	MarketplaceIndexSchema,
} from "../packages/internal/src/schema/extension-marketplace.ts";
import {
	compareEntryVersions,
	ID_SEGMENT,
	mergeMarketplaceEntry,
	SEMVER,
} from "./marketplace-index.mjs";
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

	/** 预发布档的一条。 */
	const alpha = (version) => entry({ version, prerelease: true });
	/** 依次并进去,issuedAt 自动往前走(这几条测的不是 issuedAt)。 */
	const merged = (...list) =>
		list.reduce((cur, e, i) => mergeMarketplaceEntry(cur, e, { issuedAt: i + 1 }), undefined);
	/** 索引里每条的 [版本, 是否预发布]。 */
	const tiers = (index) => index.extensions.map((e) => [e.version, e.prerelease === true]);

	it("预发布并进去不碰正式档 —— 打一个 alpha tag 不该让稳定渠道看不见这个拓展", () => {
		const next = merged(entry({ version: "0.0.2" }), alpha("0.1.0-alpha.1"));
		expect(tiers(next)).toEqual([
			["0.0.2", false],
			["0.1.0-alpha.1", true],
		]);
		// 再发一版预发布只换预发布那一条。
		expect(tiers(mergeMarketplaceEntry(next, alpha("0.1.0-alpha.2"), { issuedAt: 3 }))).toEqual([
			["0.0.2", false],
			["0.1.0-alpha.2", true],
		]);
	});

	it("正式版并进去,比它旧的预发布档一并删掉;比它新的留着", () => {
		// 0.1.0 正式发了,0.1.0-alpha.1 比它旧,留着只会让预发布渠道看见一个更旧的版本。
		const released = merged(
			entry({ version: "0.0.2" }),
			alpha("0.1.0-alpha.1"),
			entry({ version: "0.1.0" }),
		);
		expect(tiers(released)).toEqual([["0.1.0", false]]);
		// 下一轮的 alpha 比正式版新,发一个补丁正式版不该把它抹掉。
		const patched = merged(
			entry({ version: "0.1.0" }),
			alpha("0.2.0-alpha.1"),
			entry({ version: "0.1.1" }),
		);
		expect(tiers(patched)).toEqual([
			["0.1.1", false],
			["0.2.0-alpha.1", true],
		]);
	});

	it("预发布不许比同档旧(重跑旧 tag);等于放行", () => {
		const current = merged(entry({ version: "0.1.0" }), alpha("0.2.0-alpha.2"));
		expect(() => mergeMarketplaceEntry(current, alpha("0.2.0-alpha.1"), { issuedAt: 3 })).toThrow(
			/0\.2\.0-alpha\.1/,
		);
		expect(
			mergeMarketplaceEntry(current, alpha("0.2.0-alpha.2"), { issuedAt: 3 }).extensions.map(
				(e) => e.version,
			),
		).toEqual(["0.1.0", "0.2.0-alpha.2"]);
	});

	it("预发布比正式档还旧 → 拒(发进去也没人看得见)", () => {
		// 预发布档这会儿是空的,所以拦住它的只可能是「比正式档旧」那一条。
		const current = merged(entry({ version: "0.1.0" }));
		expect(() => mergeMarketplaceEntry(current, alpha("0.0.9-alpha.1"), { issuedAt: 2 })).toThrow(
			/正式版 0\.1\.0/,
		);
		// 正式版之后的预发布照收。
		expect(
			mergeMarketplaceEntry(current, alpha("0.1.1-alpha.1"), { issuedAt: 2 }).extensions.map(
				(e) => e.version,
			),
		).toEqual(["0.1.0", "0.1.1-alpha.1"]);
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

	it("同 id 两档(正式 + 预发布)的索引,客户端那两条规矩照样过", () => {
		const stable = mergeMarketplaceEntry(undefined, entry({ version: "0.0.2" }), { issuedAt: 1 });
		const both = mergeMarketplaceEntry(
			stable,
			entry({ version: "0.1.0-alpha.1", prerelease: true }),
			{ issuedAt: 2 },
		);
		const parsed = MarketplaceIndexSchema.parse(both);
		expect(checkMarketplaceIndex(parsed, { official: true })).toEqual({ ok: true });
		expect(parsed.extensions).toHaveLength(2);
	});
});

/**
 * tag 守卫(`.github/scripts/assert-extension-tag.sh`)里那两条 id / semver 正则是这边的
 * **手抄**——它是 bash 的 `[[ =~ ]]`,import 不进来。松紧漂开的代价不对称:守卫**松**了,
 * 包会先被传上一个不可变 release,然后在并索引这一步才炸,市场上那条还停在老版本;
 * 守卫**紧**了,一个合法的 tag 打了等于没打,而错误信息说的是「id 不合规」。
 *
 * 所以这里去读 `.sh` 的原文,把两条 ERE 取出来当 JS 正则跑同一批样本 —— 改了任何一边、
 * 或者把那两行挪走改名,这一段当场红。(同 `release-urls.test.mjs` 那几条跨文件核对。)
 */
describe("tag 守卫里那两条正则没跟这边漂开", () => {
	const shell = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", ".github/scripts/assert-extension-tag.sh"),
		"utf8",
	);

	/** 取 `[[ "$x" =~ <这里> ]]` 里的那一段。取不到就说明那行被改写了 —— 也该红。 */
	const ereFor = (variable) => {
		const found = shell.match(new RegExp(`\\[\\[ "\\$${variable}" =~ (\\S+) \\]\\]`));
		if (!found) throw new Error(`assert-extension-tag.sh 里找不到对 $${variable} 的正则判断`);
		return new RegExp(found[1]);
	};

	it("id:两边对同一批样本给同样的答案", () => {
		const shellId = ereFor("id");
		for (const sample of ["bridge", "a", "a-b", "x9-y", "a--b", "0"])
			expect([sample, shellId.test(sample), ID_SEGMENT.test(sample)]).toEqual([sample, true, true]);
		// 带命名空间的、大写的、两头挂连字符的都得一样地拒。
		for (const sample of ["alice.douyin", "Bridge", "-a", "a-", "a_b", ""])
			expect([sample, shellId.test(sample), ID_SEGMENT.test(sample)]).toEqual([
				sample,
				false,
				false,
			]);
	});

	it("version:两边对同一批样本给同样的答案", () => {
		const shellVersion = ereFor("version");
		for (const sample of ["0.0.1", "1.2.3", "10.20.30", "0.1.0-alpha.7"])
			expect([sample, shellVersion.test(sample), SEMVER.test(sample)]).toEqual([
				sample,
				true,
				true,
			]);
		// `1.0.0+build.1`:build 元数据两边一起拒。tag 里的 `+` 到不了并索引这一步(守卫先
		// 红),而这边收着的话,手跑一次脚本就能把一个 tag 打不出来的版本发进索引。
		for (const sample of [
			"v1.0.0",
			"1.0",
			"01.0.0",
			"1.0.0-",
			"1.0.0.0",
			"latest",
			"1.0.0+build.1",
		])
			expect([sample, shellVersion.test(sample), SEMVER.test(sample)]).toEqual([
				sample,
				false,
				false,
			]);
	});
});
