/**
 * 拓展页要的两个只读口:装了什么,以及某个拓展自己交上来的那份面板数据。
 *
 * 🔴 状态那条走 `/api/*` 而不是 `/ext/<id>/*` —— 后者**刻意**在会话鉴权外
 * (ADR-0012 决策 36),把面板数据挂那儿等于公开出去。
 */

import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInstallResponse, ExtensionsResponse } from "@bilibili-notify/contract";
import { EXTENSION_API_VERSION, type GlobalConfig } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import type { MarketplaceInstallOutcome } from "../../extensions/marketplace.js";
import { createExtensionsRoute } from "../extensions.js";

let installRoot: string;
let rescan: ReturnType<typeof vi.fn<() => Promise<void>>>;
let patchGlobals: ReturnType<typeof vi.fn>;

function boot(
	over: {
		enabled?: boolean;
		connections?: unknown[];
		entries?: ExtensionEntry[] | (() => ExtensionEntry[]);
		status?: Record<string, unknown>;
		descriptor?: Record<string, unknown>;
		configFields?: Record<string, unknown[]>;
		bots?: Record<string, unknown[]>;
		settle?: () => Promise<void>;
		canRestart?: boolean;
		marketplace?: { list: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> };
	} = {},
) {
	const store = {
		getGlobals: () =>
			({ extensions: { bridge: { enabled: over.enabled ?? false } } }) as unknown as GlobalConfig,
		getConnections: () => over.connections ?? [],
		patchGlobals,
	} as unknown as ConfigStore;
	const entries = over.entries ?? [];
	return createExtensionsRoute({
		store,
		extensions: () => (typeof entries === "function" ? entries() : entries),
		status: (id) => over.status?.[id],
		descriptor: (id) => over.descriptor?.[id] as never,
		configFields: (id) => over.configFields?.[id] as never,
		bots: (id) => over.bots?.[id] as never,
		settle: over.settle,
		install: {
			root: installRoot,
			rescan,
			restartAbility:
				over.canRestart === false
					? { can: false, reason: "source-run" }
					: { can: true, how: "container" },
		},
		marketplace: over.marketplace as never,
	});
}

/** 一个装得进去的包:清单 + 入口,两个文件。 */
function pack(over: Record<string, unknown> = {}): Blob {
	const zip = zipSync({
		"extension.json": strToU8(
			JSON.stringify({
				id: "bridge",
				name: "机器人框架桥接",
				description: "测试用",
				version: "1.1.0",
				apiVersion: EXTENSION_API_VERSION,
				provides: ["push"],
				...over,
			}),
		),
		"index.mjs": strToU8("export function activate() {}"),
	});
	return new Blob([zip]);
}

async function upload(app: ReturnType<typeof boot>, body: FormData): Promise<Response> {
	return app.request("/install", { method: "POST", body });
}

function form(file: Blob | undefined): FormData {
	const fd = new FormData();
	if (file) fd.append("file", new File([file], "bridge.zip"));
	return fd;
}

beforeEach(async () => {
	installRoot = await mkdtemp(join(tmpdir(), "bn-ext-route-"));
	rescan = vi.fn(async () => {});
	patchGlobals = vi.fn(async () => ({}) as GlobalConfig);
});

afterEach(async () => {
	await rm(installRoot, { recursive: true, force: true });
});

/** 一条「装着、跑着」的拓展。 */
function running(id: string): ExtensionEntry {
	return {
		id,
		dir: `/data/extensions/${id}`,
		state: "running",
		manifest: {
			id,
			name: `${id} 拓展`,
			description: "一句话说明",
			version: "1.0.0",
			apiVersion: 1,
			provides: ["push"],
		},
	};
}

describe("GET /api/ext", () => {
	/**
	 * 🔴 热装卸是异步的,而 `PATCH /api/globals` 在它落地之前就回 200 了 —— 面板紧接着
	 * 刷这一口。不先落实的话,拨完开关刷出来的是**上一秒**的状态,而且不会自己好。
	 */
	it("先把还没落地的开关落实掉,再报状态", async () => {
		let entry = { ...running("bridge"), state: "disabled" } as ExtensionEntry;
		const app = boot({
			enabled: true,
			entries: () => [entry],
			settle: async () => {
				entry = running("bridge");
			},
		});
		const body = (await (await app.request("/")).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.state).toBe("running");
	});

	it("列的是**真装着的**那些,带上主人的开关与它现在的状态", async () => {
		const body = (await (
			await boot({ enabled: true, entries: [running("bridge")] }).request("/")
		).json()) as ExtensionsResponse;
		const bridge = body.extensions.find((e) => e.id === "bridge");
		expect(bridge?.enabled).toBe(true);
		expect(bridge?.state).toBe("running");
		expect(bridge?.version).toBe("1.0.0");
		expect(bridge?.provides).toEqual(["push"]);
	});

	/** 「我改的是不是跑着的那个」只有全路径答得了。 */
	it("每条都说得出自己在盘上的哪儿", async () => {
		const body = (await (
			await boot({ entries: [running("bridge")] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.dir).toBe("/data/extensions/bridge");
		expect(body.extensions[0]?.linkedTo).toBeUndefined();
	});

	/**
	 * 🔴 开发版的拓展是 devtools **链**进装载目录的 —— 面板上写着 `<dataDir>/…`,而跑的
	 * 其实是主人正在改的工作树。落点不交出来,「我改的是不是它」就没法回答。
	 */
	it("软链进来的那条把落点也交出来", async () => {
		const linked: ExtensionEntry = {
			...running("bridge"),
			linkedTo: "/repo/extensions/bridge/dist",
		};
		const body = (await (
			await boot({ entries: [linked] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.linkedTo).toBe("/repo/extensions/bridge/dist");
	});

	/**
	 * 🔴 拓展自己在 `activate` 里报了短名与标识色,而面板此前**手抄了一份**
	 * (`platform-meta.tsx` 里那行躺了整整一片)。字段不下发的话,那份手抄就是唯一出路,
	 * 而它迟早跟拓展报的漂开 —— 且那种漂移门禁一片绿。
	 */
	it("跑着的那条把它自报的面板元信息一并交出去", async () => {
		const body = (await (
			await boot({
				entries: [running("bridge")],
				descriptor: { bridge: { shortLabel: "桥接", tint: "#a855f7" } },
			}).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.descriptor).toMatchObject({ shortLabel: "桥接", tint: "#a855f7" });
	});

	/** 字段表随清单下发 —— 推送目标页照它画「新建连接」的表单(决策 33 的最后一跳)。 */
	it("跑着的那条带字段表", async () => {
		const fields = [{ kind: "text", code: "token", label: "token", secret: true }];
		const res = await boot({
			entries: [running("bridge")],
			configFields: { bridge: fields },
		}).request("/");
		const body = (await res.json()) as ExtensionsResponse;
		expect(body.extensions[0]?.configFields).toEqual(fields);
	});

	it("没跑起来的那条没有 descriptor —— 那是 activate 里才报的", async () => {
		const body = (await (
			await boot({ entries: [{ id: "x", dir: "/d/x", state: "disabled" }] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.descriptor).toBeUndefined();
	});

	it("一个都没装 → 空表。**没有写死的清单了** —— 拓展是装进来的", async () => {
		const body = (await (await boot().request("/")).json()) as ExtensionsResponse;
		expect(body.extensions).toEqual([]);
	});

	it("开关开着、却因为连败被自动停用 —— 两件事都要看得见", async () => {
		const body = (await (
			await boot({
				enabled: true,
				entries: [
					{
						id: "bridge",
						dir: "/data/extensions/bridge",
						state: "blocked",
						detail: "连续加载失败 3 次",
					},
				],
			}).request("/")
		).json()) as ExtensionsResponse;
		const bridge = body.extensions[0];
		expect(bridge?.enabled).toBe(true);
		expect(bridge?.state).toBe("blocked");
		expect(bridge?.detail).toContain("连续");
	});

	it("清单读不出来的那条:名字退回目录名,原因带着 —— 消失的东西没法排查", async () => {
		const body = (await (
			await boot({
				entries: [
					{
						id: "junk",
						dir: "/data/extensions/junk",
						state: "unreadable",
						detail: "不是合法 JSON",
					},
				],
			}).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.name).toBe("junk");
		expect(body.extensions[0]?.detail).toContain("JSON");
	});

	it("每张卡都有名字 —— 卡片上总得印点什么", async () => {
		const body = (await (
			await boot({
				entries: [
					running("bridge"),
					{ id: "junk", dir: "/data/extensions/junk", state: "unreadable" },
				],
			}).request("/")
		).json()) as ExtensionsResponse;
		for (const ext of body.extensions) expect(ext.name.length).toBeGreaterThan(0);
	});
});

describe("GET /api/ext/:id/bots", () => {
	it("列现在能借来当连接的 bot —— 拓展交什么(含它自己那份 config)就原样下发", async () => {
		const bots = [
			{
				config: { link: "l1", botId: "onebot:1" },
				platform: "onebot",
				name: "阿库娅",
				via: "家里那台",
			},
		];
		const res = await boot({
			entries: [running("bridge")],
			bots: { bridge: bots },
		}).request("/bridge/bots");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bots });
	});

	it("没跑 / 没这个口 → 404,不是空名单 —— 面板要分得开「没 bot」与「问不到」", async () => {
		expect((await boot({ entries: [running("bridge")] }).request("/bridge/bots")).status).toBe(404);
	});
});

describe("GET /api/ext/:id/status", () => {
	it("拓展交上来什么就下发什么 —— 形状第一版不约束(决策 36)", async () => {
		const res = await boot({
			entries: [running("bridge")],
			status: { bridge: { sessions: [{ connectionId: "a", connected: false }] } },
		}).request("/bridge/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sessions: [{ connectionId: "a", connected: false }] });
	});

	/**
	 * 「没这个拓展」与「它没交过数据」都是 404 而不是空对象 —— 面板要能把这两件事
	 * 与「交上来的就是一张空表」分开说。
	 */
	it("没跑 / 没交过 → 404,不是空对象", async () => {
		expect((await boot({ entries: [running("bridge")] }).request("/bridge/status")).status).toBe(
			404,
		);
		expect((await boot().request("/nobody/status")).status).toBe(404);
	});

	it("**现取** —— 拓展给的是个函数,两次问拿到的是两次的真相", async () => {
		let n = 0;
		const app = createExtensionsRoute({
			store: {
				getGlobals: () => ({ extensions: {} }) as unknown as GlobalConfig,
				getConnections: () => [],
			} as unknown as ConfigStore,
			extensions: () => [],
			status: () => ({ n: ++n }),
			descriptor: () => undefined,
			configFields: () => undefined,
			bots: () => undefined,
		});
		expect(await (await app.request("/x/status")).json()).toEqual({ n: 1 });
		expect(await (await app.request("/x/status")).json()).toEqual({ n: 2 });
	});
});

/**
 * 面板上传装拓展。**这条路把「往装载目录放代码」降到了一次面板会话**,所以路由这一层
 * 钉三件事:拆包那句拒绝要原样送到面板上、装完要**当场重扫**、以及**覆盖 ≠ 新装**——
 * 后者是热的,前者要重启,而说错任何一边主人都会以为面板在骗他。
 */
describe("POST /api/ext/install", () => {
	it("传一个新拓展 → 装进装载根,当场重扫,不必重启", async () => {
		const res = await upload(boot(), form(pack()));

		expect(res.status).toBe(200);
		const body = (await res.json()) as ExtensionInstallResponse;
		expect(body).toMatchObject({ id: "bridge", name: "机器人框架桥接", version: "1.1.0" });
		expect(body.needsRestart).toBe(false);
		// 🔴 装完不重扫的话,它要等下一次开机才出现在拓展页 —— 那正是这一整片要去掉的。
		expect(rescan).toHaveBeenCalledOnce();
		expect(await readFile(join(installRoot, "bridge", "index.mjs"), "utf8")).toContain("activate");
	});

	/** 覆盖 = 换掉已经加载过的代码,ESM 在这个进程里换不掉(决策 10)。 */
	it("盖掉一份已经装着的 → 说得出「要重启一次」,并带上这台机器给不给按钮", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(installRoot, "bridge"), { recursive: true });
		await writeFile(join(installRoot, "bridge", "index.mjs"), "// 旧的");

		const body = (await (await upload(boot(), form(pack()))).json()) as ExtensionInstallResponse;

		expect(body.needsRestart).toBe(true);
		expect(body.restart).toEqual({ can: true, how: "container" });
	});

	/** 拉不起来的机器上也照装,只是那句提示里不能有按钮 —— 判据原样交出去就行。 */
	it("这台机器重启不回来 → 照样装,判据说清为什么没按钮", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(installRoot, "bridge"), { recursive: true });
		await writeFile(join(installRoot, "bridge", "index.mjs"), "// 旧的");

		const body = (await (
			await upload(boot({ canRestart: false }), form(pack()))
		).json()) as ExtensionInstallResponse;

		expect(body.needsRestart).toBe(true);
		expect(body.restart).toEqual({ can: false, reason: "source-run" });
	});

	/**
	 * 🔴 **装这个动作不碰开关**:头一回装进来的一律是关着的(`enabled` 缺失即关)。
	 * 面板那句「装完那句话」照这一格说 —— 一律说「已经在跑」的话,主人转头在卡片上
	 * 看到「已停用」,两句话当场打架。
	 */
	it("头一回装进来 → 回答里的开关是关着的", async () => {
		const body = (await (await upload(boot(), form(pack()))).json()) as ExtensionInstallResponse;

		expect(body.enabled).toBe(false);
	});

	/** 重装一份从前开过的:配置里那一格不随目录删掉,它是真在跑,就得照说。 */
	it("配置里本来就开着 → 回答里的开关是开着的", async () => {
		const body = (await (
			await upload(boot({ enabled: true }), form(pack()))
		).json()) as ExtensionInstallResponse;

		expect(body.enabled).toBe(true);
	});

	it("包不合规 → 400,拆包那几句原样送到面板上,而且一个字节都没落盘", async () => {
		const res = await upload(boot(), form(new Blob([strToU8("这不是 zip")])));

		expect(res.status).toBe(400);
		expect(((await res.json()) as { errors: string[] }).errors.join()).toContain("zip");
		expect(rescan).not.toHaveBeenCalled();
	});

	it("压根没带文件 → 400,说清楚少的是哪个字段", async () => {
		const res = await upload(boot(), form(undefined));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { errors: string[] }).errors.join()).toContain("file");
	});
});

/**
 * 拓展市场(ADR-0013)的两口:列索引、按 source + id 装。逻辑全在 `extensions/marketplace.ts`,
 * 这里只钉 wire:参数怎么传、结果怎么翻成 HTTP、装完的回答与上传装包**同一个形状**(面板
 * 复用同一段「装完那句话」)。
 */
describe("DELETE /api/ext/:id", () => {
	/** 装一份在盘上,好让删有东西可删。 */
	async function installed(): Promise<void> {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(installRoot, "bridge"), { recursive: true });
		await writeFile(join(installRoot, "bridge", "index.mjs"), "export function activate() {}");
	}

	/**
	 * 🔴 **配置那一格必须跟着删**。装载器注释写得很清楚:盘上没了而 `ready` 里还留着
	 * 一格的话,下一次 `sync()` 会把它从 ESM 模块缓存里装回来 —— 留配置等于留一个
	 * 诈尸的口子。而且桥的接入里存的是长期 token,那是凭据。
	 */
	it("删掉 → 目录没了,配置里那一格也清了,并当场重扫", async () => {
		await installed();

		const res = await boot().request("/bridge", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await lstat(join(installRoot, "bridge")).catch(() => null)).toBeNull();
		expect(patchGlobals).toHaveBeenCalledWith({ extensions: { bridge: null } });
		expect(rescan).toHaveBeenCalled();
	});

	/**
	 * 🔴 推送目标是用户亲手配的。连带删掉太狠,留着悬空又会让推送静默失败 —— 所以
	 * 拦住,并说清楚还有几条、去哪删。
	 */
	it("还有连接在用它 → 拦住,一个字节都不动", async () => {
		await installed();
		const app = boot({
			connections: [
				{ id: "c1", kind: "extension", extensionId: "bridge" },
				{ id: "c2", kind: "extension", extensionId: "bridge" },
				{ id: "c3", kind: "onebot" },
			],
		});

		const res = await app.request("/bridge", { method: "DELETE" });

		expect(res.status).toBe(409);
		expect(((await res.json()) as { errors: string[] }).errors[0]).toContain("2");
		expect(await lstat(join(installRoot, "bridge")).catch(() => null)).not.toBeNull();
		expect(patchGlobals).not.toHaveBeenCalled();
	});

	/** 别家拓展的连接不算数 —— 拦的是**指着这一个**的那些。 */
	it("别的拓展的连接不挡路", async () => {
		await installed();
		const app = boot({ connections: [{ id: "c1", kind: "extension", extensionId: "douyin" }] });

		expect((await app.request("/bridge", { method: "DELETE" })).status).toBe(200);
	});

	/**
	 * 🔴 开发版里装载根下那条 `bridge` 是 devtools **软链**进来的仓库工作树。
	 * 顺着删下去就是删主人的源码 —— 同传包装那头,认出软链就拒。
	 */
	it("软链(devtools 链进来的工作树)→ 拒,并说清去哪卸", async () => {
		const { symlink, mkdir } = await import("node:fs/promises");
		const target = join(installRoot, "__worktree");
		await mkdir(target, { recursive: true });
		await symlink(target, join(installRoot, "bridge"));

		const res = await boot().request("/bridge", { method: "DELETE" });

		expect(res.status).toBe(400);
		expect(((await res.json()) as { errors: string[] }).errors[0]).toContain("devtools");
		// 软链的落点还在 —— 没顺着删下去。
		expect(await lstat(target).catch(() => null)).not.toBeNull();
		// 🔴 拒了就什么都别动:先清配置再抹盘的话,这条路上配置已经没了而拓展还在。
		expect(patchGlobals).not.toHaveBeenCalled();
	});

	/** 面板上的列表可能是上一秒的。盘上早就没了也当删成功,别让人对着一个删不掉的幽灵。 */
	it("盘上本来就没有 → 照样把配置清掉,回 200", async () => {
		const res = await boot().request("/bridge", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(patchGlobals).toHaveBeenCalledWith({ extensions: { bridge: null } });
	});

	it("id 不合法 → 400,不碰盘", async () => {
		const res = await boot().request("/..%2F..%2Fetc", { method: "DELETE" });

		expect(res.status).toBe(400);
		expect(patchGlobals).not.toHaveBeenCalled();
	});
});

describe("GET /marketplace + POST /marketplace/install", () => {
	function market() {
		return {
			list: vi.fn(async () => ({ available: true, sources: [], extensions: [], fetchedAt: 1 })),
			install: vi.fn(
				async (): Promise<MarketplaceInstallOutcome> => ({
					ok: true,
					id: "bridge",
					name: "桥",
					version: "0.0.2",
					needsRestart: true,
				}),
			),
		};
	}

	it("没接市场的构建 → 404", async () => {
		const app = boot();
		expect((await app.request("/marketplace")).status).toBe(404);
		expect(
			(
				await app.request("/marketplace/install", {
					method: "POST",
					body: "{}",
					headers: { "content-type": "application/json" },
				})
			).status,
		).toBe(404);
	});

	it("GET 原样下发 list();?refresh=1 无视缓存", async () => {
		const m = market();
		const app = boot({ marketplace: m });
		const res = await app.request("/marketplace");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ available: true, fetchedAt: 1 });
		expect(m.list).toHaveBeenLastCalledWith({ refresh: false });
		await app.request("/marketplace?refresh=1");
		expect(m.list).toHaveBeenLastCalledWith({ refresh: true });
	});

	it("POST 装:回答与上传装包同一个形状(含这台机器的重启能力)", async () => {
		const m = market();
		const app = boot({ marketplace: m });
		const res = await app.request("/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ source: "official", id: "bridge" }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ExtensionInstallResponse;
		expect(body).toEqual({
			id: "bridge",
			name: "桥",
			version: "0.0.2",
			needsRestart: true,
			enabled: false,
			restart: { can: true, how: "container" },
		});
		expect(m.install).toHaveBeenCalledWith("official", "bridge");
	});

	it("POST 装不了 → 400,原因原样;缺参数 → 400", async () => {
		const m = market();
		m.install.mockResolvedValueOnce({ ok: false, err: "下载到的包校验和与索引写的对不上" });
		const app = boot({ marketplace: m });
		const res = await app.request("/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ source: "official", id: "bridge" }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ errors: ["下载到的包校验和与索引写的对不上"] });
		const bad = await app.request("/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ id: "bridge" }),
			headers: { "content-type": "application/json" },
		});
		expect(bad.status).toBe(400);
		expect(m.install).toHaveBeenCalledTimes(1);
	});
});
