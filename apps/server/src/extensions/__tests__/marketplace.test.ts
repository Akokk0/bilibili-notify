/**
 * 拓展市场(ADR-0013):一个内置的官方源(签名索引、走加速镜像)+ 主人自己加的第三方源
 * (裸 JSON、不签、不走镜像),每个源列它能装的拓展;装 = 下载 → 对索引里的 sha256 → 走
 * 上传装包那同一段落地逻辑 → 记下「从哪个源装的哪一版」→ 让装载器重扫。
 *
 * 🔴 这里最要紧的是**每条条目的状态**:能装 / 已装 / 有新版 / 契约不合 / 从别处装的 /
 * 已撤回 —— 面板上那颗钮画什么、能不能按,全看这一格。
 */

import { createHash, sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_VERSION } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMarketplace, MARKETPLACE_PROVENANCE_FILE } from "../marketplace.js";

const OFFICIAL_URL =
	"https://github.com/Akokk0/bilibili-notify/releases/download/extension-marketplace/marketplace.json";
const ZIP_URL = "https://github.com/Akokk0/bilibili-notify/releases/download/ext/bridge-0.0.2.zip";
const THIRD_URL = "https://alice.example/bn/marketplace.json";
const THIRD_ZIP = "https://alice.example/bn/douyin-1.0.0.zip";
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

function makeKey(): { privateKey: KeyObject; spkiBase64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		spkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

function envelope(privateKey: KeyObject, body: unknown): string {
	const text = JSON.stringify(body);
	const signature = cryptoSign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
	return JSON.stringify({ manifest: text, signature });
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function pack(id: string, version: string): Uint8Array {
	return zipSync({
		"extension.json": strToU8(
			JSON.stringify({
				id,
				name: `拓展 ${id}`,
				description: "测试用",
				version,
				apiVersion: EXTENSION_API_VERSION,
				provides: ["push"],
			}),
		),
		"index.mjs": strToU8("export default { activate() {} };"),
	});
}

function entry(id: string, version: string, zip: Uint8Array, over: Record<string, unknown> = {}) {
	return {
		id,
		name: `拓展 ${id}`,
		description: "一句话",
		version,
		apiVersion: EXTENSION_API_VERSION,
		package: { url: ZIP_URL, sha256: sha256(zip), size: zip.byteLength },
		releaseUrl: "https://github.com/Akokk0/bilibili-notify/releases/tag/x",
		...over,
	};
}

/** 按地址分发的假网络:表里没有的地址 404。 */
function serve(
	table: Record<string, string | Uint8Array | (() => Response)>,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const hit = table[String(input)];
		if (hit === undefined) return new Response("not found", { status: 404 });
		if (typeof hit === "function") return hit();
		return new Response(typeof hit === "string" ? hit : Buffer.from(hit), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

let root: string;
const key = makeKey();
const bridgeZip = pack("bridge", "0.0.2");
const douyinZip = pack("alice.douyin", "1.0.0");

function official(over: Record<string, unknown> = {}) {
	return {
		name: "BN 官方拓展",
		issuedAt: 1_760_000_000,
		extensions: [entry("bridge", "0.0.2", bridgeZip)],
		...over,
	};
}

function third(over: Record<string, unknown> = {}) {
	return {
		name: "alice 的拓展",
		namespace: "alice",
		extensions: [
			entry("alice.douyin", "1.0.0", douyinZip, {
				package: { url: THIRD_ZIP, sha256: sha256(douyinZip), size: douyinZip.byteLength },
			}),
		],
		...over,
	};
}

interface HarnessOptions {
	installed?: { id: string; version?: string }[];
	sources?: { id: string; name: string; url: string }[];
	prerelease?: boolean;
	noOfficial?: boolean;
	mirrors?: string[];
}

function harness(opts: HarnessOptions = {}) {
	const rescan = vi.fn(async () => {});
	let installed = opts.installed ?? [];
	const marketplace = createMarketplace({
		root,
		official: opts.noOfficial ? undefined : { url: OFFICIAL_URL, trustedKeys: [key.spkiBase64] },
		sources: () => opts.sources ?? [],
		mirrors: () => opts.mirrors ?? [],
		prerelease: () => opts.prerelease ?? false,
		installed: () => installed,
		rescan,
		logger: SILENT,
		timeoutMs: 1_000,
	});
	return {
		marketplace,
		rescan,
		setInstalled(list: { id: string; version?: string }[]) {
			installed = list;
		},
	};
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-marketplace-"));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

describe("list():官方源", () => {
	it("签名索引验得过 → 源 ok,条目可装、标官方", async () => {
		serve({ [OFFICIAL_URL]: envelope(key.privateKey, official()) });
		const view = await harness().marketplace.list();
		expect(view.available).toBe(true);
		expect(view.sources).toEqual([
			expect.objectContaining({ id: "official", official: true, ok: true, name: "BN 官方拓展" }),
		]);
		expect(view.extensions).toEqual([
			expect.objectContaining({
				source: "official",
				official: true,
				id: "bridge",
				version: "0.0.2",
				state: "installable",
				size: bridgeZip.byteLength,
			}),
		]);
	});

	it("签名验不过 → 源报 untrusted,一条条目都不列", async () => {
		const other = makeKey();
		serve({ [OFFICIAL_URL]: envelope(other.privateKey, official()) });
		const view = await harness().marketplace.list();
		expect(view.sources[0]).toMatchObject({
			id: "official",
			ok: false,
			err: expect.stringContaining("签名"),
		});
		expect(view.extensions).toEqual([]);
	});

	it("拿不到 → 源报拿不到;这个构建没有信任公钥 → available=false 且不去拉", async () => {
		const fetchMock = serve({});
		expect((await harness().marketplace.list()).sources[0]).toMatchObject({ ok: false });
		fetchMock.mockClear();
		const view = await harness({ noOfficial: true }).marketplace.list();
		expect(view.available).toBe(false);
		expect(view.sources).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("比上次见过的旧 → stale(加速站回放旧索引);记住的 issuedAt 落在盘上", async () => {
		serve({ [OFFICIAL_URL]: envelope(key.privateKey, official({ issuedAt: 200 })) });
		const h = harness();
		await h.marketplace.list();
		serve({ [OFFICIAL_URL]: envelope(key.privateKey, official({ issuedAt: 100 })) });
		const view = await h.marketplace.list({ refresh: true });
		expect(view.sources[0]).toMatchObject({ ok: false, err: expect.stringContaining("旧") });
		const provenance = JSON.parse(await readFile(join(root, MARKETPLACE_PROVENANCE_FILE), "utf8"));
		expect(provenance.officialIssuedAt).toBe(200);
	});

	it("官方索引走加速镜像:先试镜像前缀,再直连", async () => {
		const fetchMock = serve({ [OFFICIAL_URL]: envelope(key.privateKey, official()) });
		await harness({ mirrors: ["https://mirror.example"] }).marketplace.list();
		const urls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(urls[0]).toBe(`https://mirror.example/${OFFICIAL_URL}`);
		expect(urls[1]).toBe(OFFICIAL_URL);
	});

	it("预发布条目只在 BN 自己是预发布渠道时才列", async () => {
		serve({
			[OFFICIAL_URL]: envelope(
				key.privateKey,
				official({
					extensions: [entry("bridge", "0.1.0-alpha.1", bridgeZip, { prerelease: true })],
				}),
			),
		});
		expect((await harness().marketplace.list()).extensions).toEqual([]);
		expect((await harness({ prerelease: true }).marketplace.list()).extensions).toHaveLength(1);
	});

	it("契约版本对不上 → incompatible(要先升级 BN)", async () => {
		serve({
			[OFFICIAL_URL]: envelope(
				key.privateKey,
				official({
					extensions: [
						entry("bridge", "0.0.2", bridgeZip, { apiVersion: EXTENSION_API_VERSION + 1 }),
					],
				}),
			),
		});
		expect((await harness().marketplace.list()).extensions[0]).toMatchObject({
			state: "incompatible",
		});
	});
});

describe("list():第三方源", () => {
	it("裸 JSON,不走镜像;条目标非官方、带源名;命名空间不对整个源拒", async () => {
		const fetchMock = serve({ [THIRD_URL]: JSON.stringify(third()) });
		const view = await harness({
			noOfficial: true,
			mirrors: ["https://mirror.example"],
			sources: [{ id: "s1", name: "alice", url: THIRD_URL }],
		}).marketplace.list();
		expect(view.sources).toEqual([
			expect.objectContaining({
				id: "s1",
				official: false,
				ok: true,
				namespace: "alice",
				url: THIRD_URL,
			}),
		]);
		expect(view.extensions).toEqual([
			expect.objectContaining({
				source: "s1",
				official: false,
				id: "alice.douyin",
				state: "installable",
			}),
		]);
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([THIRD_URL]);

		serve({
			[THIRD_URL]: JSON.stringify(third({ extensions: [entry("bridge", "9.9.9", bridgeZip)] })),
		});
		const bad = await harness({
			noOfficial: true,
			sources: [{ id: "s1", name: "alice", url: THIRD_URL }],
		}).marketplace.list({ refresh: true });
		expect(bad.sources[0]).toMatchObject({ ok: false, err: expect.stringContaining("bridge") });
		expect(bad.extensions).toEqual([]);
	});

	it("两个源撞了命名空间 → 后面那个拒,说清撞了谁", async () => {
		serve({
			[THIRD_URL]: JSON.stringify(third()),
			"https://bob.example/m.json": JSON.stringify(third({ name: "bob" })),
		});
		const view = await harness({
			noOfficial: true,
			sources: [
				{ id: "s1", name: "alice", url: THIRD_URL },
				{ id: "s2", name: "bob", url: "https://bob.example/m.json" },
			],
		}).marketplace.list();
		expect(view.sources[1]).toMatchObject({
			id: "s2",
			ok: false,
			err: expect.stringContaining("alice"),
		});
		expect(view.extensions.map((e) => e.source)).toEqual(["s1"]);
	});
});

describe("list():已装的怎么标", () => {
	it("从这个源装的:同版 installed、索引更新 updatable、那版被撤回 revoked", async () => {
		serve({ [OFFICIAL_URL]: envelope(key.privateKey, official()), [ZIP_URL]: bridgeZip });
		const h = harness();
		await h.marketplace.install("official", "bridge");
		h.setInstalled([{ id: "bridge", version: "0.0.2" }]);
		expect((await h.marketplace.list({ refresh: true })).extensions[0]).toMatchObject({
			state: "installed",
			installed: { version: "0.0.2", source: "official" },
		});

		serve({
			[OFFICIAL_URL]: envelope(
				key.privateKey,
				official({ extensions: [entry("bridge", "0.0.3", bridgeZip)] }),
			),
		});
		expect((await h.marketplace.list({ refresh: true })).extensions[0]).toMatchObject({
			state: "updatable",
		});

		serve({
			[OFFICIAL_URL]: envelope(
				key.privateKey,
				official({ revoked: ["bridge@0.0.2"], extensions: [entry("bridge", "0.0.3", bridgeZip)] }),
			),
		});
		expect((await h.marketplace.list({ refresh: true })).extensions[0]).toMatchObject({
			state: "revoked",
		});
	});

	it("手放进去的 / devtools 链的(没有来源记录)→ installed-elsewhere,不提示更新", async () => {
		serve({ [OFFICIAL_URL]: envelope(key.privateKey, official()) });
		const view = await harness({
			installed: [{ id: "bridge", version: "0.0.1" }],
		}).marketplace.list();
		expect(view.extensions[0]).toMatchObject({
			state: "installed-elsewhere",
			installed: { version: "0.0.1" },
		});
	});
});

describe("install()", () => {
	it("下载 → 对 sha256 → 落盘 → 记来源 → 重扫;新装的不用重启", async () => {
		serve({ [OFFICIAL_URL]: envelope(key.privateKey, official()), [ZIP_URL]: bridgeZip });
		const h = harness();
		const outcome = await h.marketplace.install("official", "bridge");
		expect(outcome).toEqual({
			ok: true,
			id: "bridge",
			name: "拓展 bridge",
			version: "0.0.2",
			needsRestart: false,
		});
		expect(JSON.parse(await readFile(join(root, "bridge", "extension.json"), "utf8")).version).toBe(
			"0.0.2",
		);
		const provenance = JSON.parse(await readFile(join(root, MARKETPLACE_PROVENANCE_FILE), "utf8"));
		expect(provenance.installed.bridge).toMatchObject({ source: "official", version: "0.0.2" });
		expect(h.rescan).toHaveBeenCalledTimes(1);
	});

	it("sha256 对不上 → 不落盘、说清是校验和", async () => {
		serve({
			[OFFICIAL_URL]: envelope(key.privateKey, official()),
			[ZIP_URL]: pack("bridge", "0.0.9"),
		});
		const h = harness();
		const outcome = await h.marketplace.install("official", "bridge");
		expect(outcome).toMatchObject({ ok: false, err: expect.stringContaining("校验") });
		await expect(readFile(join(root, "bridge", "extension.json"))).rejects.toThrow();
		expect(h.rescan).not.toHaveBeenCalled();
	});

	it("包里的清单与索引对不上(id 或版本)→ 拒 —— 源列的是 A,包里装的是 B", async () => {
		const wrong = pack("bridge", "0.0.1");
		serve({
			[OFFICIAL_URL]: envelope(
				key.privateKey,
				official({ extensions: [entry("bridge", "0.0.2", wrong)] }),
			),
			[ZIP_URL]: wrong,
		});
		const outcome = await harness().marketplace.install("official", "bridge");
		expect(outcome).toMatchObject({ ok: false, err: expect.stringContaining("0.0.1") });
	});

	it("不认识的源 / 源里没这个 id / 契约不合 / 撤回的 → 各自说清", async () => {
		serve({
			[OFFICIAL_URL]: envelope(
				key.privateKey,
				official({
					extensions: [
						entry("bridge", "0.0.2", bridgeZip, { apiVersion: EXTENSION_API_VERSION + 1 }),
					],
				}),
			),
		});
		const h = harness();
		expect(await h.marketplace.install("nope", "bridge")).toMatchObject({
			ok: false,
			err: expect.stringContaining("源"),
		});
		expect(await h.marketplace.install("official", "ghost")).toMatchObject({
			ok: false,
			err: expect.stringContaining("ghost"),
		});
		expect(await h.marketplace.install("official", "bridge")).toMatchObject({
			ok: false,
			err: expect.stringContaining("升级"),
		});
	});

	it("第三方源的包不走镜像,官方的走", async () => {
		const fetchMock = serve({
			[THIRD_URL]: JSON.stringify(third()),
			[THIRD_ZIP]: douyinZip,
			[OFFICIAL_URL]: envelope(key.privateKey, official()),
			[ZIP_URL]: bridgeZip,
		});
		const h = harness({
			mirrors: ["https://mirror.example"],
			sources: [{ id: "s1", name: "alice", url: THIRD_URL }],
		});
		await h.marketplace.install("s1", "alice.douyin");
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
			`https://mirror.example/${THIRD_ZIP}`,
		);
		fetchMock.mockClear();
		await h.marketplace.install("official", "bridge");
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
			`https://mirror.example/${ZIP_URL}`,
		);
	});
});
