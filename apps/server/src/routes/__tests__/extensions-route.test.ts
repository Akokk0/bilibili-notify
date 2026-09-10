/**
 * 拓展页要的两个只读口:装了什么,以及某个拓展自己交上来的那份面板数据。
 *
 * 🔴 状态那条走 `/api/*` 而不是 `/ext/<id>/*` —— 后者**刻意**在会话鉴权外
 * (ADR-0012 决策 36),把面板数据挂那儿等于公开出去。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionInstallResponse, ExtensionsResponse } from "@bilibili-notify/contract";
import { EXTENSION_API_VERSION, type GlobalConfig } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createExtensionsRoute } from "../extensions.js";

let installRoot: string;
let rescan: ReturnType<typeof vi.fn<() => Promise<void>>>;

function boot(
	over: {
		enabled?: boolean;
		entries?: ExtensionEntry[] | (() => ExtensionEntry[]);
		status?: Record<string, unknown>;
		settle?: () => Promise<void>;
		canRestart?: boolean;
	} = {},
) {
	const store = {
		getGlobals: () =>
			({ extensions: { bridge: { enabled: over.enabled ?? false } } }) as unknown as GlobalConfig,
		getConnections: () => [],
	} as unknown as ConfigStore;
	const entries = over.entries ?? [];
	return createExtensionsRoute({
		store,
		extensions: () => (typeof entries === "function" ? entries() : entries),
		status: (id) => over.status?.[id],
		settle: over.settle,
		install: {
			root: installRoot,
			rescan,
			restartAbility:
				over.canRestart === false
					? { can: false, reason: "source-run" }
					: { can: true, how: "container" },
		},
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
