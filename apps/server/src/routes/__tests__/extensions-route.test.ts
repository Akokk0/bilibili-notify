/**
 * 拓展页要的两个只读口:装了什么,以及某个拓展自己交上来的那份面板数据。
 *
 * 🔴 状态那条走 `/api/*` 而不是 `/ext/<id>/*` —— 后者**刻意**在会话鉴权外
 * (ADR-0012 决策 36),把面板数据挂那儿等于公开出去。
 */

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInstallResponse, ExtensionsResponse } from "@bilibili-notify/contract";
import type { GlobalConfig, ServiceContext } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import type { ActionOutcome } from "../../extensions/context.js";
import {
	type ExtensionEntry,
	type LoadedExtensions,
	loadExtensions,
} from "../../extensions/loader.js";
import type { MarketplaceInstallOutcome } from "../../extensions/marketplace.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { createExtensionUpgrades } from "../../extensions/upgrade.js";
import { createAdapterRegistry } from "../../platforms/registry.js";
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
		push?: Record<string, unknown>;
		bots?: Record<string, unknown[]>;
		settle?: () => Promise<void>;
		canRestart?: boolean;
		marketplace?: { list: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> };
		/** `<id>/<动作名>` → 那一次跑的结果;没有的就当拓展没在跑。 */
		actions?: Record<string, ActionOutcome>;
		/**
		 * 接一个**真的**装载器(装载根就是 `installRoot`):名单、装完重扫、只重载都走它 ——
		 * 「盖掉之后换不换得上」是装载器按指纹判的,拿假名单钉等于替它把答案写好了。
		 */
		loader?: LoadedExtensions;
		/** 换掉「在装载器那条队里改盘」那一口 —— 只有要看「写是不是在队里」的用例给。 */
		changeDisk?: <T>(write: () => Promise<T>) => Promise<T>;
	} = {},
) {
	const store = {
		getGlobals: () =>
			({ extensions: { bridge: { enabled: over.enabled ?? false } } }) as unknown as GlobalConfig,
		getConnections: () => over.connections ?? [],
		patchGlobals,
	} as unknown as ConfigStore;
	const entries = over.entries ?? [];
	const loader = over.loader;
	return createExtensionsRoute({
		store,
		extensions: () =>
			loader ? loader.list() : typeof entries === "function" ? entries() : entries,
		status: (id) => over.status?.[id],
		pushSource: (id) => over.push?.[id] as never,
		bots: (id) => over.bots?.[id] as never,
		settle: over.settle,
		install: {
			root: installRoot,
			changeDisk:
				over.changeDisk ??
				(loader
					? (write) => loader.changeDisk(write)
					: async (write) => {
							try {
								return await write();
							} finally {
								await rescan();
							}
						}),
			restartAbility:
				over.canRestart === false
					? { can: false, reason: "source-run" }
					: { can: true, how: "container" },
		},
		marketplace: over.marketplace as never,
		runAction: async (id, name) => over.actions?.[`${id}/${name}`],
		...(loader ? { swap: (id: string) => loader.swap(id) } : {}),
	});
}

/** 一个什么都不说的宿主 —— 这里只关心装载器认的是哪一份代码。 */
function quietHost(): ServiceContext {
	const noop = () => {};
	return {
		logger: { info: noop, warn: noop, error: noop, debug: noop },
		setInterval: () => ({ dispose: noop }),
		setTimeout: () => ({ dispose: noop }),
		onDispose: noop,
	};
}

/** 在 `installRoot` 上起一个真的装载器。开关只有一格:全开或全关(给函数就现读,好中途拨)。 */
function realLoader(enabled: boolean | (() => boolean) = true): Promise<LoadedExtensions> {
	return loadExtensions({
		root: installRoot,
		host: quietHost(),
		mounts: createExtensionMounts(),
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		isEnabled: typeof enabled === "function" ? enabled : () => enabled,
		maxFailures: 3,
	});
}

/** 手放一份拓展进装载根(清单 + 入口)。`word` 进代码里,好让两份代码的指纹不一样。 */
async function plant(id: string, word: string, version = "1.0.0"): Promise<void> {
	await mkdir(join(installRoot, id), { recursive: true });
	await writeFile(
		join(installRoot, id, "extension.json"),
		JSON.stringify({
			id,
			name: `${id} 拓展`,
			description: "测试用",
			version,
			apiVersion: 1,
			provides: ["push"],
		}),
	);
	await writeFile(
		join(installRoot, id, "index.mjs"),
		`export function activate() { return ${JSON.stringify(word)}; }`,
	);
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
				apiVersion: 1,
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

	/** v2 清单不再单写 provides(ADR-0019 决策 16),面板要的那一格由 contributes 推出来。 */
	it("v2 拓展开哪一口由清单的 contributes 推出来", async () => {
		const douyin: ExtensionEntry = {
			id: "douyin",
			dir: "/data/extensions/douyin",
			state: "disabled",
			manifest: {
				id: "douyin",
				name: "抖音订阅",
				description: "一句话说明",
				version: "0.1.0",
				apiVersion: 2,
				contributes: {
					subscription: {
						display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
						events: ["post"],
					},
				},
			},
		};
		const body = (await (
			await boot({ entries: [douyin] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.provides).toEqual(["subscription"]);
	});

	/**
	 * 面板照清单画设置表单(ADR-0019 决策 17 / 30),而「装好 → 填 → 启用」要求**没在跑**的
	 * 拓展也拿得到这份声明 —— 它来自清单,不来自代码。
	 */
	it("v2 拓展的设置项声明随列表下发,没在跑也有;v1 没有这一格", async () => {
		const fields = [
			{ key: "cookie", type: "string", label: "Cookie", required: true, secret: true },
		];
		const douyin: ExtensionEntry = {
			id: "douyin",
			dir: "/data/extensions/douyin",
			state: "disabled",
			manifest: {
				id: "douyin",
				name: "抖音订阅",
				description: "一句话说明",
				version: "0.1.0",
				apiVersion: 2,
				settings: { fields: fields as never },
				contributes: {
					subscription: {
						display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
						events: ["post"],
					},
				},
			},
		};
		const body = (await (
			await boot({ entries: [douyin, running("bridge")] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions.find((e) => e.id === "douyin")?.settings).toEqual({ fields });
		expect(body.extensions.find((e) => e.id === "bridge")?.settings).toBeUndefined();
		// 面板靠这一格分:v2 照声明画,v1 还是桥那一页手写的。
		expect(body.extensions.find((e) => e.id === "douyin")?.apiVersion).toBe(2);
		expect(body.extensions.find((e) => e.id === "bridge")?.apiVersion).toBe(1);
	});

	it("版本不合的拓展照样有名字与版本 —— 格式不认识,身份那几格也读得出来", async () => {
		const future: ExtensionEntry = {
			id: "future",
			dir: "/data/extensions/future",
			state: "incompatible",
			identity: { id: "future", name: "未来的拓展", description: "一句话", version: "3.0.0" },
			detail: "它要宿主契约 v3",
		};
		const body = (await (
			await boot({ entries: [future] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]).toMatchObject({
			name: "未来的拓展",
			version: "3.0.0",
			state: "incompatible",
		});
		expect(body.extensions[0]?.provides).toBeUndefined();
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
	 * 🔴 v1 拓展在 `activate` 里报了短名与标识色,而面板此前**手抄了一份**
	 * (`platform-meta.tsx` 里那行躺了整整一片)。字段不下发的话,那份手抄就是唯一出路,
	 * 而它迟早跟拓展报的漂开 —— 且那种漂移门禁一片绿。
	 */
	it("跑着的 v1 把它在代码里报的外观一并交出去", async () => {
		const body = (await (
			await boot({
				entries: [running("bridge")],
				push: { bridge: { display: { shortLabel: "桥接", color: "#a855f7" } } },
			}).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.push?.display).toMatchObject({
			shortLabel: "桥接",
			color: "#a855f7",
		});
	});

	/** 连接配置项随推送源那一口下发 —— 推送目标页照它画「新建连接」的表单(决策 33 的最后一跳)。 */
	it("跑着的 v1 带它在代码里报的连接配置项", async () => {
		const fields = [{ type: "string", key: "token", label: "token", secret: true }];
		const res = await boot({
			entries: [running("bridge")],
			push: { bridge: { connectionFields: fields } },
		}).request("/");
		const body = (await res.json()) as ExtensionsResponse;
		expect(body.extensions[0]?.push?.connectionFields).toEqual(fields);
	});

	/**
	 * 🔴 ADR-0019 决策 41:v2 的外观与连接配置项写在清单里,**跑没跑都交给面板**。只从跑着的
	 * 代码拿的话,拓展一停,它借来的连接在推送目标页就退成灰方章 —— 而清单搬出代码的初衷
	 * 就是不跑代码也知道。这里不给 `push` 的假口子:v2 那一份不该去问代码。
	 */
	it("停着的 v2 照清单交出推送源那一口(外观 + 连接配置项);只开订阅那口的没有", async () => {
		const display = { label: "机器人框架桥接", shortLabel: "桥接", color: "#a855f7" };
		const fields = [{ type: "string", key: "room", label: "房间" }];
		const bridge: ExtensionEntry = {
			id: "bridge",
			dir: "/data/extensions/bridge",
			state: "disabled",
			manifest: {
				id: "bridge",
				name: "机器人框架桥接",
				description: "一句话说明",
				version: "0.0.1",
				apiVersion: 2,
				contributes: { push: { display, connection: { fields: fields as never } } },
			},
		};
		const douyin: ExtensionEntry = {
			id: "douyin",
			dir: "/data/extensions/douyin",
			state: "disabled",
			manifest: {
				id: "douyin",
				name: "抖音订阅",
				description: "一句话说明",
				version: "0.1.0",
				apiVersion: 2,
				contributes: {
					subscription: {
						display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
						events: ["post"],
					},
				},
			},
		};
		const body = (await (
			await boot({ entries: [bridge, douyin] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions.find((e) => e.id === "bridge")?.push).toEqual({
			display,
			connectionFields: fields,
		});
		expect(body.extensions.find((e) => e.id === "douyin")?.push).toBeUndefined();
	});

	/** 连接是挑出来的(桥)那种清单里不写 `connection` —— 连接配置项照样是一张空表,不是缺一格。 */
	it("停着的 v2 没写连接配置项 → 空表", async () => {
		const bridge: ExtensionEntry = {
			id: "bridge",
			dir: "/data/extensions/bridge",
			state: "blocked",
			manifest: {
				id: "bridge",
				name: "机器人框架桥接",
				description: "一句话说明",
				version: "0.0.1",
				apiVersion: 2,
				contributes: {
					push: { display: { label: "机器人框架桥接", shortLabel: "桥接", color: "#a855f7" } },
				},
			},
		};
		const body = (await (
			await boot({ entries: [bridge] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.push?.connectionFields).toEqual([]);
	});

	/** v1 的外观写在代码里,只有跑着的交得出来 —— 停着的问不出,不替它编一份。 */
	it("停着的 v1 没有推送源那一口", async () => {
		const body = (await (
			await boot({
				entries: [{ ...running("bridge"), state: "disabled" }],
				push: {},
			}).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.push).toBeUndefined();
	});

	it("清单读不出来的那条没有推送源那一口", async () => {
		const body = (await (
			await boot({ entries: [{ id: "x", dir: "/d/x", state: "unreadable" }] }).request("/")
		).json()) as ExtensionsResponse;
		expect(body.extensions[0]?.push).toBeUndefined();
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
			pushSource: () => undefined,
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
		expect(body.staged).toBe(false);
		// 🔴 装完不重扫的话,它要等下一次开机才出现在拓展页 —— 那正是这一整片要去掉的。
		expect(rescan).toHaveBeenCalledOnce();
		expect(await readFile(join(installRoot, "bridge", "index.mjs"), "utf8")).toContain("activate");
	});

	/**
	 * 盖掉一份**跑着的**、代码换了 → 这个进程干净地换不上(ESM 按 URL 认模块,决策 10 / 47),
	 * 旧的照跑。回答要照**重扫之后装载器那一行**说,并带上这台机器给不给重启按钮。
	 */
	it("盖掉一份跑着的、代码换了 → 说「新版等着换上」,并带上这台机器给不给按钮", async () => {
		await plant("bridge", "旧的");
		const loader = await realLoader();

		const body = (await (
			await upload(boot({ enabled: true, loader }), form(pack()))
		).json()) as ExtensionInstallResponse;

		expect(body.staged).toBe(true);
		expect(body.restart).toEqual({ can: true, how: "container" });
		await loader.dispose();
	});

	/** 拉不起来的机器上也照装,只是那句提示里不能有按钮 —— 判据原样交出去就行。 */
	it("这台机器重启不回来 → 照样装,判据说清为什么没按钮", async () => {
		await plant("bridge", "旧的");
		const loader = await realLoader();

		const body = (await (
			await upload(boot({ enabled: true, canRestart: false, loader }), form(pack()))
		).json()) as ExtensionInstallResponse;

		expect(body.staged).toBe(true);
		expect(body.restart).toEqual({ can: false, reason: "source-run" });
		await loader.dispose();
	});

	/**
	 * 🔴 **「盖掉了一份」≠「换不上」**:关着、这个进程里一行代码都没跑过的那份,盘上换了就是
	 * 换了 —— 装载器重读清单、下次打开跑的就是新的。照旧说「要重启」的话,主人会白白重启一次。
	 */
	it("盖掉一份关着、从没跑过的 → 不是「等着换上」", async () => {
		await plant("bridge", "旧的");
		const loader = await realLoader(false);

		const body = (await (
			await upload(boot({ loader }), form(pack()))
		).json()) as ExtensionInstallResponse;

		expect(body.staged).toBe(false);
		expect(loader.list()[0]).toMatchObject({ state: "disabled", manifest: { version: "1.1.0" } });
		await loader.dispose();
	});

	/**
	 * 🔴 **关着,但这个进程跑过它的另一份代码**:盘上这份拨开开关也跑不上(ESM 缓存里那份
	 * 删不掉,决策 47)。装完那一刻就得说 —— 回「装好了,还关着」的话,主人拨开开关才撞见
	 * 「换不上」,而那时已经不知道是哪一步出的事。
	 */
	it("盖掉一份关着、但这个进程跑过它别的代码的 → 是「等着换上」", async () => {
		await plant("bridge", "旧的");
		let on = true;
		const loader = await realLoader(() => on);
		expect(loader.list()[0]?.state).toBe("running");
		on = false;
		await loader.sync();
		expect(loader.list()[0]?.state).toBe("disabled");

		const body = (await (
			await upload(boot({ loader }), form(pack()))
		).json()) as ExtensionInstallResponse;

		expect(body.staged).toBe(true);
		expect(body.enabled).toBe(false);
		await loader.dispose();
	});

	/** 同一个包再传一遍:盘上那份就是跑着的那份,没有什么可换的。 */
	it("把跑着的那份原样再传一遍 → 不是「等着换上」", async () => {
		const loader = await realLoader();
		const app = boot({ enabled: true, loader });
		await upload(app, form(pack()));
		expect(loader.list()[0]?.state).toBe("running");

		const body = (await (await upload(app, form(pack()))).json()) as ExtensionInstallResponse;

		expect(body.staged).toBe(false);
		await loader.dispose();
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

	/**
	 * 🔴 **落盘在装载器那条队里**(ADR-0019 决策 45):解包写目录与随后那一遍重扫是一件事,写到一半
	 * 时并发的开关 / 重扫 / 只重载不许插进来看见半个目录。
	 */
	it("包是在装载器那条队里写进去的 —— 写之前盘上没有,写完才有", async () => {
		const landed: boolean[] = [];
		const onDisk = async () =>
			(await lstat(join(installRoot, "bridge", "index.mjs")).catch(() => null)) !== null;
		const app = boot({
			changeDisk: async (write) => {
				landed.push(await onDisk());
				const out = await write();
				landed.push(await onDisk());
				return out;
			},
		});

		expect((await upload(app, form(pack()))).status).toBe(200);
		expect(landed).toEqual([false, true]);
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
 * 盘上换了代码、这个进程干净地换不上(ADR-0012 决策 47)。面板要并排给两个出口 —— 重启 BN,
 * 或只重载这个拓展 —— 所以列表要说清「哪一个在等、等的是哪一版」与「这台机器能不能自己重启」,
 * 另开一口真去换。这几条接的是**真的**装载器:要钉的正是真模块缓存的行为。
 */
describe("新代码等着换上 + POST /api/ext/:id/swap", () => {
	it("列表说得出这台机器能不能自己重启 —— 详情页据此给不给「重启 BN」", async () => {
		const can = (await (await boot().request("/")).json()) as ExtensionsResponse;
		expect(can.restart).toEqual({ can: true, how: "container" });
		const cannot = (await (
			await boot({ canRestart: false }).request("/")
		).json()) as ExtensionsResponse;
		expect(cannot.restart).toEqual({ can: false, reason: "source-run" });
	});

	/**
	 * 没接装载器的构建一个拓展都列不出来,这一格其实没人读;答「拉不起来」是**不会坑人**的那
	 * 一边 —— 反过来答「能」,哪天有人读了,按下去就是把 BN 关了而没人拉。
	 */
	it("没接装载器 → 保守地答「拉不起来」", async () => {
		const app = createExtensionsRoute({
			store: {
				getGlobals: () => ({ extensions: {} }) as unknown as GlobalConfig,
				getConnections: () => [],
			} as unknown as ConfigStore,
			extensions: () => [],
			status: () => undefined,
			pushSource: () => undefined,
			bots: () => undefined,
		});
		const body = (await (await app.request("/")).json()) as ExtensionsResponse;
		expect(body.restart).toEqual({ can: false, reason: "unsupervised" });
	});

	it("跑着的被盖掉 → 那一行带上盘上那份的版本号,跑的仍是旧的", async () => {
		await plant("bridge", "旧的");
		const loader = await realLoader();
		await plant("bridge", "新的", "2.0.0");
		await loader.rescan();

		const body = (await (
			await boot({ enabled: true, loader }).request("/")
		).json()) as ExtensionsResponse;

		expect(body.extensions[0]).toMatchObject({
			state: "running",
			version: "1.0.0",
			staged: { version: "2.0.0" },
		});
		await loader.dispose();
	});

	it("只重载 → 200;列表里跑的换成新版,「等着换上」撤掉", async () => {
		await plant("bridge", "旧的");
		const loader = await realLoader();
		await plant("bridge", "新的", "2.0.0");
		await loader.rescan();
		const app = boot({ enabled: true, loader });

		const res = await app.request("/bridge/swap", { method: "POST" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const body = (await (await app.request("/")).json()) as ExtensionsResponse;
		expect(body.extensions[0]).toMatchObject({ state: "running", version: "2.0.0" });
		expect(body.extensions[0]?.staged).toBeUndefined();
		await loader.dispose();
	});

	/**
	 * 🔴 生产上**不给随手重载的口子**:每换一份新代码漏一份旧模块,没有新代码时白漏(决策 47)。
	 * 装载器那句「为什么不给」原样交出去,别自编一句「重载失败」。
	 */
	it("没有等着换上的 → 409,装载器那句原话", async () => {
		await plant("bridge", "旧的");
		const loader = await realLoader();

		const res = await boot({ enabled: true, loader }).request("/bridge/swap", { method: "POST" });

		expect(res.status).toBe(409);
		const body = (await res.json()) as { ok: boolean; err: string };
		expect(body.ok).toBe(false);
		expect(body.err).toContain("没有等着换上");
		await loader.dispose();
	});

	/**
	 * 关着、这个进程跑过它别的代码:那一行也带着「等着换上」(详情页据此说清拨开也换不上),可
	 * 只重载按下去就是把它跑起来 —— 409,装载器那句原话。
	 */
	it("关着的被盖掉 → 那一行带上新版本号;只重载 409,说它关着", async () => {
		await plant("bridge", "旧的");
		let on = true;
		const loader = await realLoader(() => on);
		on = false;
		await loader.sync();
		await plant("bridge", "新的", "2.0.0");
		await loader.rescan();
		const app = boot({ loader });

		const body = (await (await app.request("/")).json()) as ExtensionsResponse;
		expect(body.extensions[0]).toMatchObject({
			state: "disabled",
			enabled: false,
			staged: { version: "2.0.0" },
		});
		const res = await app.request("/bridge/swap", { method: "POST" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { err: string }).err).toContain("关着");
		await loader.dispose();
	});

	it("没装这个 id → 404", async () => {
		const loader = await realLoader();
		const res = await boot({ loader }).request("/nobody/swap", { method: "POST" });
		expect(res.status).toBe(404);
		await loader.dispose();
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
	 * 🔴 **配置那一格必须跟着删**。装载器注释写得很清楚:盘上没了而它那一格还留着的话,
	 * 下一次 `sync()` 会把它从 ESM 模块缓存里装回来 —— 留配置等于留一个
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

	/** 抹盘也在那条队里 —— 与装包同一条理由。 */
	it("目录是在装载器那条队里抹掉的", async () => {
		await installed();
		const gone: boolean[] = [];
		const onDisk = async () =>
			(await lstat(join(installRoot, "bridge")).catch(() => null)) !== null;
		const app = boot({
			changeDisk: async (write) => {
				gone.push(!(await onDisk()));
				const out = await write();
				gone.push(!(await onDisk()));
				return out;
			},
		});

		expect((await app.request("/bridge", { method: "DELETE" })).status).toBe(200);
		expect(gone).toEqual([false, true]);
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
					docs: { readme: true, changelog: false },
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

	/**
	 * 「等着换上」照**装载器那一行**说(市场装完已经重扫过了)—— 与上传装包同一把尺子,市场
	 * 自己不必认得模块缓存这回事。
	 */
	it("POST 装:回答与上传装包同一个形状(含这台机器的重启能力)", async () => {
		const m = market();
		const app = boot({
			marketplace: m,
			entries: [{ ...running("bridge"), staged: { version: "0.0.2" } }],
		});
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
			staged: true,
			docs: { readme: true, changelog: false },
			enabled: false,
			restart: { can: true, how: "container" },
		});
		expect(m.install).toHaveBeenCalledWith("official", "bridge");
	});

	it("POST 装:装载器那一行没标「等着换上」→ staged 是 false", async () => {
		const app = boot({ marketplace: market(), entries: [running("bridge")] });
		const res = await app.request("/marketplace/install", {
			method: "POST",
			body: JSON.stringify({ source: "official", id: "bridge" }),
			headers: { "content-type": "application/json" },
		});
		expect(((await res.json()) as ExtensionInstallResponse).staged).toBe(false);
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

describe("装完那一刻就说清有没有文档", () => {
	/**
	 * 🔴 服务端**拆包时就知道**包里有没有那两份 —— 让界面去猜(或者先装完再拉一次)只会
	 * 多一条会说谎的路。装完那句话后面要不要挂「看看说明」,凭的就是这一格。
	 */
	it("包里带 README → 回应里说有;没带 CHANGELOG → 说没有", async () => {
		const zip = zipSync({
			"extension.json": strToU8(
				JSON.stringify({
					id: "bridge",
					name: "机器人框架桥接",
					description: "测试用",
					version: "1.1.0",
					apiVersion: 1,
					provides: ["push"],
				}),
			),
			"index.mjs": strToU8("export function activate() {}"),
			"README.md": strToU8("# 桥接"),
		});
		const res = await upload(boot(), form(new Blob([zip])));

		expect(res.status).toBe(200);
		const body = (await res.json()) as ExtensionInstallResponse;
		expect(body.docs).toEqual({ readme: true, changelog: false });
	});

	/**
	 * 🔴 **两头得用同一把尺子。** 面板那头 `trim()` 过才画,只有空白的一份它整块不画;
	 * 服务端这头要是只看「文件在不在」,就会挂出一颗「看看说明」,人点进去什么都没有 ——
	 * 正是这一格存在的理由(别让界面猜)反过来咬自己。
	 */
	it("README 只有空白 → 说没有,别挂一颗点进去什么都没有的钮", async () => {
		const zip = zipSync({
			"extension.json": strToU8(
				JSON.stringify({
					id: "bridge",
					name: "机器人框架桥接",
					description: "测试用",
					version: "1.1.0",
					apiVersion: 1,
					provides: ["push"],
				}),
			),
			"index.mjs": strToU8("export function activate() {}"),
			"README.md": strToU8("   \n\n\t\n"),
		});
		const res = await upload(boot(), form(new Blob([zip])));

		expect(res.status).toBe(200);
		expect(((await res.json()) as ExtensionInstallResponse).docs).toEqual({
			readme: false,
			changelog: false,
		});
	});
});

describe("拓展自己的文档", () => {
	async function writeDocs(id: string, docs: Record<string, string>): Promise<void> {
		await mkdir(join(installRoot, id), { recursive: true });
		for (const [name, text] of Object.entries(docs)) {
			await writeFile(join(installRoot, id, name), text);
		}
	}

	/**
	 * 🔴 **读的是磁盘,不是活着的那个实例。** 关着的、甚至加载失败的拓展照样交得出说明 ——
	 * 而那恰恰是人最想读它的时候(「这到底是干嘛的」「为什么起不来」)。挂 `/api/*` 下,
	 * 与 `/:id/status` 同一道会话鉴权;`/ext/<id>/*` 是刻意在鉴权外的,不能挂那儿。
	 */
	it("拓展关着 → README 与 CHANGELOG 照样读得到", async () => {
		await writeDocs("bridge", {
			"README.md": "# 桥接\n\n借 koishi 的 bot。",
			"CHANGELOG.md": "## [0.0.1]",
		});

		const res = await boot({ enabled: false, entries: [] }).request("/bridge/docs");

		expect(res.status).toBe(200);
		const body = (await res.json()) as { readme?: string; changelog?: string };
		expect(body.readme).toContain("借 koishi 的 bot");
		expect(body.changelog).toContain("[0.0.1]");
	});

	/**
	 * 🔴 **这条是挡住路径穿越的唯一那扇门。** 读回那头是直白的 `join(root, id)`,落盘那侧
	 * 对 `..` 的检查在这条路上一点忙都帮不上 —— 校验一撤,下面这个请求就会 200 着把装载根
	 * 外面那份文件整份交出去(实测过)。所以不能只断状态码,得连内容一起断。
	 */
	it("id 不合法 → 400,装载根外面那份文件一个字都出不来", async () => {
		const sibling = join(installRoot, "..", "bn-ext-route-sibling");
		await mkdir(sibling, { recursive: true });
		await writeFile(join(sibling, "README.md"), "SIBLING-SECRET");
		try {
			const res = await boot().request("/..%2Fbn-ext-route-sibling/docs");

			expect(res.status).toBe(400);
			expect(await res.text()).not.toContain("SIBLING-SECRET");
		} finally {
			await rm(sibling, { recursive: true, force: true });
		}
	});

	/**
	 * 文档本身是条软链 → 不读。拆包那条路建不出软链(落盘只写四个常量文件名),所以这只可能
	 * 来自手放的目录 —— 但 `install.ts` 对同一个目录就是 `lstat` + 拒软链的,同类判据不该
	 * 两副面孔。目录那一层照旧跟随:devtools 把仓里的 dist 软链进装载根,全靠它。
	 */
	it("README 是条软链 → 不读它", async () => {
		const outside = join(installRoot, "..", "bn-ext-route-outside.md");
		await writeFile(outside, "OUTSIDE-SECRET");
		await mkdir(join(installRoot, "bridge"), { recursive: true });
		await symlink(outside, join(installRoot, "bridge", "README.md"));
		try {
			const res = await boot().request("/bridge/docs");

			expect(res.status).toBe(200);
			expect(await res.text()).not.toContain("OUTSIDE-SECRET");
		} finally {
			await rm(outside, { force: true });
		}
	});

	/** 「没装这个」与「装了但没写」是两回事 —— 面板正是靠这两档分开的。 */
	it("没装这个拓展 → 404", async () => {
		expect((await boot().request("/nobody/docs")).status).toBe(404);
	});

	it("装了但两份都没写 → 200,交一个空的回去(不是 404)", async () => {
		await writeDocs("bridge", {});

		const res = await boot().request("/bridge/docs");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});

	/** 没接装载器的构建(没有装载根)读不了文档,但得说清是为什么,别装作没这个拓展。 */
	it("这个构建没接装载器 → 404,并说清原因", async () => {
		const app = createExtensionsRoute({
			store: {
				getGlobals: () => ({ extensions: {} }) as unknown as GlobalConfig,
				getConnections: () => [],
			} as unknown as ConfigStore,
			extensions: () => [],
			status: () => undefined,
			pushSource: () => undefined,
			bots: () => undefined,
		});

		const res = await app.request("/bridge/docs");

		expect(res.status).toBe(404);
		expect(((await res.json()) as { errors: string[] }).errors[0]).toContain("装载器");
	});
});

/**
 * 面板上的「调拓展」按钮(ADR-0019 决策 22)。走 `/api/*`,吃面板会话鉴权 —— **绝不走
 * `/ext/<id>`**(那里刻意在鉴权外)。每种失败各有自己的状态码与原话,别并成「出错了」。
 */
describe("POST /api/ext/:id/actions/:name", () => {
	const call = (app: ReturnType<typeof boot>, path: string) =>
		app.request(path, { method: "POST" });

	it("跑成了 —— 200", async () => {
		const res = await call(
			boot({ actions: { "douyin/poll.now": { ok: true } } }),
			"/douyin/actions/poll.now",
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it.each<[string, ActionOutcome | undefined, number, string]>([
		["拓展没在跑", undefined, 404, "没在跑"],
		["清单里没这个动作", { ok: false, reason: "undeclared" }, 404, "没有"],
		["声明了、代码没接", { ok: false, reason: "unhandled" }, 501, "没接"],
		[
			"拓展抛了",
			{ ok: false, reason: "failed", message: "抖音网关回了 403" },
			500,
			"抖音网关回了 403",
		],
		["超时", { ok: false, reason: "timeout" }, 504, "秒"],
		// 决策 42:同一个动作在跑时再按,不排队、不并发 —— 说清「还在跑」,不是笼统的失败。
		["同一个动作还在跑", { ok: false, reason: "busy", aborted: false }, 409, "还没回来"],
		["上一发超时叫停了却还没停", { ok: false, reason: "busy", aborted: true }, 409, "已经叫它停下"],
	])("%s —— %s", async (_label, outcome, status, text) => {
		const res = await call(
			boot({ actions: outcome ? { "douyin/poll.now": outcome } : {} }),
			"/douyin/actions/poll.now",
		);
		expect(res.status).toBe(status);
		const body = (await res.json()) as { ok: boolean; err: string };
		expect(body.ok).toBe(false);
		expect(body.err).toContain(text);
	});

	it("拓展 id 或动作名不合规矩 —— 400,不往下问", async () => {
		expect((await call(boot(), "/Douyin/actions/poll.now")).status).toBe(400);
		expect((await call(boot(), "/douyin/actions/Poll%20Now")).status).toBe(400);
	});

	/**
	 * 🔴 门口先拒,不指望往下问。拓展那头「清单里有没有这个动作」哪天退回按普通对象查表,
	 * `toString` 顺着原型链一查就是有、代码却没接 —— 回 501,看着像拓展漏接了一个它根本没声明
	 * 的动作。桩模拟的就是那种情况。
	 */
	it("动作名是 Object.prototype 上的名字(toString)—— 400,不往下问", async () => {
		const res = await call(
			boot({ actions: { "douyin/toString": { ok: false, reason: "unhandled" } } }),
			"/douyin/actions/toString",
		);
		expect(res.status).toBe(400);
	});
});
