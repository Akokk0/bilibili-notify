import { createHash, sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateSettings } from "@bilibili-notify/internal";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createUpdateService } from "../service.js";

/**
 * 把已经分别钉好的几块(取清单 → 决策 → 下载 → 落盘 → 钉版本)串成用户看得见的
 * 那条流程。
 *
 * 这一层真正要守的是**错误怎么归因**:同样是「升不上去」,连不上代理站、我们自己
 * 签错了东西、和有人在中间改包,是三件完全不同的事。混成一句「更新失败」的话,
 * 代理站抽风会被当成安全事件,而真篡改会被当成小毛病 —— 两种都比不报错更糟。
 */

const MANIFEST_URLS = {
	stable: "https://github.com/o/r/releases/download/update-channel/stable.json",
	prerelease: "https://github.com/o/r/releases/download/update-channel/alpha.json",
};
const RELEASES_PAGE = "https://github.com/o/r/releases";

const created: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "bn-update-svc-"));
	created.push(dir);
	return dir;
}

function makeKey(): { privateKey: KeyObject; spkiBase64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		spkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

/** 一份最小但能真的装起来的载荷 zip。 */
function makePayloadZip(version: string): Uint8Array {
	return zipSync({
		"index.mjs": new TextEncoder().encode(`// bn ${version}\n`),
		"package.json": new TextEncoder().encode(JSON.stringify({ version })),
		"web-dist/index.html": new TextEncoder().encode("<!doctype html><title>bn</title>"),
	});
}

interface StubWorld {
	manifestBody?: string;
	payload?: Uint8Array;
	/** 命中就抛(模拟代理站卡死 / 连不上)。 */
	failUrls?: RegExp;
}

function stubNetwork({ manifestBody, payload, failUrls }: StubWorld): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: unknown) => {
		const url = String(input);
		if (failUrls?.test(url)) throw new Error(`boom ${url}`);
		if (url.endsWith(".json")) {
			if (manifestBody === undefined) return new Response("nope", { status: 404 });
			return new Response(manifestBody, { status: 200 });
		}
		if (payload === undefined) return new Response("nope", { status: 404 });
		return new Response(payload, { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function envelope(
	key: KeyObject,
	manifest: Record<string, unknown>,
	overrides: { signWith?: KeyObject } = {},
): string {
	const inner = JSON.stringify(manifest, null, 2);
	const signature = cryptoSign(null, Buffer.from(inner, "utf8"), overrides.signWith ?? key);
	return JSON.stringify({ manifest: inner, signature: signature.toString("base64") });
}

function manifestFor(version: string, zip: Uint8Array, extra: Record<string, unknown> = {}) {
	return {
		version,
		payload: {
			url: `https://github.com/o/r/releases/download/v${version}/payload.zip`,
			sha256: createHash("sha256").update(zip).digest("hex"),
			size: zip.byteLength,
		},
		releaseUrl: `https://github.com/o/r/releases/tag/v${version}`,
		...extra,
	};
}

const SETTINGS: UpdateSettings = { channel: "stable", autoDownload: true, mirrors: [] };

function makeService(
	overrides: {
		root?: string;
		currentVersion?: string;
		imageVersion?: string;
		trustedKeys?: readonly string[];
		settings?: Partial<UpdateSettings>;
		nodeMajor?: number;
	} = {},
) {
	const root = overrides.root ?? tempRoot();
	const versionsRoot = join(root, "versions");
	mkdirSync(versionsRoot, { recursive: true });
	return {
		versionsRoot,
		service: createUpdateService({
			currentVersion: overrides.currentVersion ?? "0.8.0",
			imageVersion: overrides.imageVersion ?? "0.8.0",
			versionsRoot,
			nodeMajor: overrides.nodeMajor ?? 24,
			trustedKeys: overrides.trustedKeys ?? [],
			manifestUrls: MANIFEST_URLS,
			releasesPageUrl: RELEASES_PAGE,
			readSettings: () => ({ ...SETTINGS, ...overrides.settings }),
		}),
	};
}

describe("createUpdateService —— 没有内置公钥时", () => {
	it("整个功能是关的,不是『验签失败』", async () => {
		// 公钥列表空 = 这个构建根本没打算做自主升级(比如自己 fork 出去构建的)。
		// 报「签名不对」会让用户以为有人在中间做手脚,然后去查一个根本不存在的
		// 安全问题;而且他怎么改配置都不会好。
		const fetchMock = stubNetwork({});
		const { service } = makeService({ trustedKeys: [] });

		const status = await service.check();

		expect(status.state.phase).toBe("disabled");
		// 也别去打扰网络 —— 没有钥匙,拿回来也验不了。
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("createUpdateService —— 检查更新", () => {
	it("有新版且开了自动下载 → 一路装到『可以重启了』", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
		});
		const { service, versionsRoot } = makeService({ trustedKeys: [key.spkiBase64] });

		const status = await service.check();

		expect(status.state).toMatchObject({
			phase: "ready",
			target: "0.9.0",
			releaseUrl: "https://github.com/o/r/releases/tag/v0.9.0",
		});
		// 真的落到盘上了,而且是一个完整的版本目录 —— 下次启动就是靠它选版的。
		expect(existsSync(join(versionsRoot, "0.9.0", "index.mjs"))).toBe(true);
		expect(existsSync(join(versionsRoot, "0.9.0", "web-dist", "index.html"))).toBe(true);
	});

	it("关掉自动下载 → 只告诉你有新版,不动手", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
		});
		const { service, versionsRoot } = makeService({
			trustedKeys: [key.spkiBase64],
			settings: { autoDownload: false },
		});

		const status = await service.check();

		expect(status.state).toMatchObject({ phase: "available", target: "0.9.0" });
		expect(existsSync(join(versionsRoot, "0.9.0"))).toBe(false);

		// 用户自己按下下载,才动手。
		const after = await service.download();
		expect(after.state).toMatchObject({ phase: "ready", target: "0.9.0" });
	});

	it("已经是最新 → up-to-date", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.8.0");
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.8.0", zip)),
			payload: zip,
		});
		const { service } = makeService({ trustedKeys: [key.spkiBase64], currentVersion: "0.8.0" });

		expect((await service.check()).state.phase).toBe("up-to-date");
	});

	it("预发布渠道默认不吃预发布版本,开了才吃", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0-alpha.1");
		const body = envelope(key.privateKey, manifestFor("0.9.0-alpha.1", zip));

		stubNetwork({ manifestBody: body, payload: zip });
		const closed = makeService({ trustedKeys: [key.spkiBase64] });
		expect((await closed.service.check()).state.phase).toBe("up-to-date");

		stubNetwork({ manifestBody: body, payload: zip });
		const open = makeService({
			trustedKeys: [key.spkiBase64],
			settings: { channel: "prerelease" },
		});
		expect((await open.service.check()).state).toMatchObject({ phase: "ready" });
	});

	it("按渠道取不同的清单地址 —— 正式版用户永远看不到预发布那份", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		const fetchMock = stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
		});
		const { service } = makeService({
			trustedKeys: [key.spkiBase64],
			settings: { channel: "prerelease" },
		});

		await service.check();

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(MANIFEST_URLS.prerelease);
	});

	it("新版要更高的 Node → 明说要重拉镜像,并给出那一版的发布页", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		stubNetwork({
			manifestBody: envelope(
				key.privateKey,
				manifestFor("0.9.0", zip, { requires: { nodeMajor: 26 } }),
			),
			payload: zip,
		});
		const { service, versionsRoot } = makeService({
			trustedKeys: [key.spkiBase64],
			nodeMajor: 24,
		});

		const status = await service.check();

		expect(status.state).toMatchObject({
			phase: "needs-image-pull",
			target: "0.9.0",
			releaseUrl: "https://github.com/o/r/releases/tag/v0.9.0",
		});
		// 载荷能比镜像新,但 Node 来自镜像 —— 下下来也跑不起来,别下。
		expect(existsSync(join(versionsRoot, "0.9.0"))).toBe(false);
	});
});

describe("createUpdateService —— 面板一打开就查一次,所以查得起", () => {
	function payloadFetches(fetchMock: ReturnType<typeof vi.fn>): number {
		return fetchMock.mock.calls.filter(([u]) => String(u).endsWith("payload.zip")).length;
	}

	it("同一份新版已经装好 → 再查一次不再下第二遍", async () => {
		// 面板每次打开都会触发一次检查。装好了还没重启的这段时间里,每开一次面板
		// 就重下 7MB 是说不过去的 —— 尤其对走加速前缀的用户。
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		const fetchMock = stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
		});
		const { service } = makeService({ trustedKeys: [key.spkiBase64] });

		await service.check();
		const again = await service.check();

		expect(again.state).toMatchObject({ phase: "ready", target: "0.9.0" });
		expect(payloadFetches(fetchMock)).toBe(1);
	});

	it("同一个版本号但清单里的包换了 → 还是要重下,别只认版本号", async () => {
		const key = makeKey();
		const zipA = makePayloadZip("0.9.0");
		const world: { body: string; payload: Uint8Array } = {
			body: envelope(key.privateKey, manifestFor("0.9.0", zipA)),
			payload: zipA,
		};
		const fetchMock = vi.fn(async (input: unknown) => {
			const url = String(input);
			if (url.endsWith(".json")) return new Response(world.body, { status: 200 });
			return new Response(world.payload, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { service } = makeService({ trustedKeys: [key.spkiBase64] });

		await service.check();
		// 同版本号、不同内容(发版侧重传了资产)。
		const zipB = zipSync({
			"index.mjs": new TextEncoder().encode("// bn 0.9.0 rebuilt\n"),
			"package.json": new TextEncoder().encode(JSON.stringify({ version: "0.9.0" })),
			"web-dist/index.html": new TextEncoder().encode("<!doctype html>"),
		});
		world.body = envelope(key.privateKey, manifestFor("0.9.0", zipB));
		world.payload = zipB;
		const again = await service.check();

		expect(again.state).toMatchObject({ phase: "ready", target: "0.9.0" });
		expect(payloadFetches(fetchMock)).toBe(2);
	});

	it("关着自动下载、手动下完之后再查一次 → 还是 ready,重启按钮不能因为开了次面板就没了", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		const fetchMock = stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
		});
		const { service } = makeService({
			trustedKeys: [key.spkiBase64],
			settings: { autoDownload: false },
		});

		await service.check();
		await service.download();
		const again = await service.check();

		expect(again.state).toMatchObject({ phase: "ready", target: "0.9.0" });
		expect(payloadFetches(fetchMock)).toBe(1);
	});

	it("检查还在跑的时候又来一次 → 共用同一趟,不并发下两份", async () => {
		// 打开面板那次自动检查还在下载,用户走到系统页又按了「检查更新」—— 两趟
		// 并发各下一份、各解一次压,最后谁写盘谁赢。让第二趟搭第一趟的车。
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		const fetchMock = stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
		});
		const { service } = makeService({ trustedKeys: [key.spkiBase64] });

		const [a, b] = await Promise.all([service.check(), service.check()]);

		expect(a.state).toMatchObject({ phase: "ready", target: "0.9.0" });
		expect(b).toEqual(a);
		expect(payloadFetches(fetchMock)).toBe(1);
	});
});

describe("createUpdateService —— 装完顺手打扫", () => {
	it("清掉够不着的旧版,但**绝不动正在跑的那份**", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.11.0");
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.11.0", zip)),
			payload: zip,
		});
		const { service, versionsRoot } = makeService({
			trustedKeys: [key.spkiBase64],
			currentVersion: "0.10.0",
			imageVersion: "0.8.0",
		});
		mkdirSync(join(versionsRoot, "0.9.0"), { recursive: true });
		mkdirSync(join(versionsRoot, "0.10.0"), { recursive: true });

		await service.check();

		// 正在跑的 0.10.0 是我们此刻正在执行的代码,也是待会儿要退回去的地方。
		expect(existsSync(join(versionsRoot, "0.10.0"))).toBe(true);
		expect(existsSync(join(versionsRoot, "0.11.0"))).toBe(true);
		// 回退只退一步,0.9.0 从此没人够得着 —— 留着只是在小机器上白占 25MB。
		expect(existsSync(join(versionsRoot, "0.9.0"))).toBe(false);
	});
});

describe("createUpdateService —— 三种『升不上去』要分得清清楚楚", () => {
	it("连不上 → unreachable,并给一个用户自己能去下的页面", async () => {
		stubNetwork({ failUrls: /.*/ });
		const key = makeKey();
		const { service } = makeService({ trustedKeys: [key.spkiBase64] });

		const status = await service.check();

		expect(status.state).toMatchObject({ phase: "error", reason: "unreachable" });
		// 清单都没拿到,所以给不出「那一版」的发布页,只能给发布列表 —— 但**必须
		// 给得出**,「下不动就通知 + 给链接」是设计里的兜底出口。
		expect(status.state).toMatchObject({ helpUrl: RELEASES_PAGE });
	});

	it("签名验不过 → untrusted,这条才该弹红字", async () => {
		const ours = makeKey();
		const stranger = makeKey();
		const zip = makePayloadZip("0.9.0");
		stubNetwork({
			manifestBody: envelope(ours.privateKey, manifestFor("0.9.0", zip), {
				signWith: stranger.privateKey,
			}),
			payload: zip,
		});
		const { service } = makeService({ trustedKeys: [ours.spkiBase64] });

		expect((await service.check()).state).toMatchObject({ phase: "error", reason: "untrusted" });
	});

	it("签名没问题但清单不成形 → malformed:是我们自己发错了,别说成被人改过", async () => {
		const key = makeKey();
		stubNetwork({ manifestBody: envelope(key.privateKey, { version: "0.9.0" }) });
		const { service } = makeService({ trustedKeys: [key.spkiBase64] });

		expect((await service.check()).state).toMatchObject({ phase: "error", reason: "malformed" });
	});

	it("清单对但包对不上校验和 → checksum-mismatch,而且盘上不留半个版本", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		// 清单按真包算 sha256,实际发下来的是另一坨字节 —— 代理站掉包就是这个形状。
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: makePayloadZip("9.9.9"),
		});
		const { service, versionsRoot } = makeService({ trustedKeys: [key.spkiBase64] });

		const status = await service.check();

		expect(status.state).toMatchObject({ phase: "error", reason: "checksum-mismatch" });
		expect(readdirSync(versionsRoot).filter((n) => !n.startsWith("boot-state"))).toEqual([]);
	});

	it("清单拿到了但包下不动 → download-failed,并给那一版的发布页", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			failUrls: /payload\.zip$/,
		});
		const { service } = makeService({ trustedKeys: [key.spkiBase64] });

		const status = await service.check();

		// 这条比 unreachable 好:清单在手,能精确告诉用户去哪一版的发布页自己下。
		expect(status.state).toMatchObject({
			phase: "error",
			reason: "download-failed",
			helpUrl: "https://github.com/o/r/releases/tag/v0.9.0",
		});
	});
});

describe("createUpdateService —— 加速前缀", () => {
	it("按用户给的顺序试,直连永远排在最后", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.9.0");
		const fetchMock = stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.9.0", zip)),
			payload: zip,
			failUrls: /^https:\/\/fast\.example/,
		});
		const { service } = makeService({
			trustedKeys: [key.spkiBase64],
			settings: { mirrors: ["https://fast.example"] },
		});

		await service.check();

		// 填了加速前缀的人多半是直连根本走不通的人,所以他填的排前面;而直连**必须
		// 留在列表里**,否则一个填错的前缀就把人彻底锁死在「检查更新失败」上。
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls[0]).toBe(`https://fast.example/${MANIFEST_URLS.stable}`);
		expect(urls[1]).toBe(MANIFEST_URLS.stable);
	});
});

describe("createUpdateService —— 回退", () => {
	it("退一步 = 钉住上一版,并把之前钉的痕迹换掉", async () => {
		const key = makeKey();
		const { service, versionsRoot } = makeService({
			trustedKeys: [key.spkiBase64],
			currentVersion: "0.10.0",
			imageVersion: "0.8.0",
		});
		mkdirSync(join(versionsRoot, "0.9.0"), { recursive: true });
		mkdirSync(join(versionsRoot, "0.10.0"), { recursive: true });

		const status = service.rollback();

		expect(status.rollbackTarget).toBe("0.9.0");
		expect(status.state).toMatchObject({ phase: "rolled-back", target: "0.9.0" });
	});

	it("只升过一次 → 退回镜像自带那版", async () => {
		const key = makeKey();
		const { service, versionsRoot } = makeService({
			trustedKeys: [key.spkiBase64],
			currentVersion: "0.9.0",
			imageVersion: "0.8.0",
		});
		mkdirSync(join(versionsRoot, "0.9.0"), { recursive: true });

		expect(service.rollback().state).toMatchObject({ phase: "rolled-back", target: "0.8.0" });
	});

	it("已经在镜像那版上 → 没得退,别给用户一个按了没反应的按钮", async () => {
		const { service } = makeService({ currentVersion: "0.8.0", imageVersion: "0.8.0" });

		expect(service.getStatus().rollbackTarget).toBeNull();
		expect(service.rollback().state).toMatchObject({
			phase: "error",
			reason: "nothing-to-roll-back",
		});
	});

	it("退回去之后又装了新版 → 钉子必须拔掉,否则永远停在退回去那一版", async () => {
		const key = makeKey();
		const zip = makePayloadZip("0.11.0");
		stubNetwork({
			manifestBody: envelope(key.privateKey, manifestFor("0.11.0", zip)),
			payload: zip,
		});
		const { service, versionsRoot } = makeService({
			trustedKeys: [key.spkiBase64],
			currentVersion: "0.9.0",
			imageVersion: "0.8.0",
		});
		mkdirSync(join(versionsRoot, "0.9.0"), { recursive: true });
		service.rollback();

		await service.check();

		// 装完新版还留着钉子的话,用户点了「立即更新」、重启、然后发现版本号没变,
		// 而且界面上一切正常 —— 最难查的一类症状。
		const bootState = JSON.parse(readFileSync(join(versionsRoot, "boot-state.json"), "utf8"));
		expect(bootState.pinned).toBeUndefined();
	});
});
