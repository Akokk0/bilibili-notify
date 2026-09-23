/**
 * 「设置读不了」(ADR-0019 决策 36)—— 存着的设置过不了拓展自己交的那份 zod 时,拓展**不起**,
 * 那一行说清哪一格、为什么;设置照样能改,改对了自己起来。
 *
 * 从前是「解不开记一行、按没有算」—— 对桥是灾难:名单一空,插件来连收 401,按协议**永久**不再
 * 重连,修好设置还得逐个去插件那头重连。不起的话插件收 404、退避重连,修好了自己回来。
 *
 * 钉的几条:
 * - 开机时存着的那份就坏 → `settings-invalid` + 点名到那一项那一格;🔴 **不累进失败记账**
 *   (这不是拓展崩了,不能几次之后被自动停用)
 * - 拓展自己 try/catch 吞了 `ctx.settings()` 那一抛 → 照样作数
 * - 清单声明了设置项,activate 里却一份 zod 都没交 → 按加载失败算(v1 不受这条管)
 * - 跑着时被旁路写坏 → 🔴 **拓展看不到那一份**:订阅者不被叫,那一行变 `settings-invalid`
 * - 设置再变:解得开就在队里起起来;还解不开只更新原因,一行拓展代码都不重跑
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createAdapterRegistry } from "../../platforms/registry.js";
import type { ExtensionContext } from "../context.js";
import { readLoadLedger } from "../load-ledger.js";
import { type LoadedExtensions, loadExtensions } from "../loader.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

/** 照清单 v2 写的一个订阅源:一格间隔、一格接入列表(标题是名字)。 */
const MANIFEST = {
	id: "douyin",
	name: "抖音订阅",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 2,
	settings: {
		fields: [
			{ key: "interval", type: "number", label: "间隔", min: 30, max: 600, default: 60 },
			{
				key: "links",
				type: "list",
				label: "接入",
				title: "name",
				fields: [
					{ key: "name", type: "string", label: "名字", required: true },
					{ key: "token", type: "string", label: "token", secret: true, default: "" },
					{ key: "enabled", type: "boolean", label: "启用", default: true },
				],
			},
		],
	},
	contributes: {
		subscription: {
			display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
			events: ["post"],
		},
	},
};

/**
 * 拓展自己那份 zod —— 比清单多两道清单表达不了的规矩:间隔必须是**整数**,名字里不许有「坏」字。
 * 同步的:这一摞钉的是装载器,异步 refine 那条路在设置路由的测试里走。
 */
const SCHEMA = z.object({
	interval: z.number().int().min(30).max(600).default(60),
	links: z
		.array(
			z.object({
				id: z.string().min(1),
				name: z
					.string()
					.min(1)
					.refine((name) => !name.includes("坏"), "名字里不许有「坏」字"),
				token: z.string().default(""),
				enabled: z.boolean().default(true),
			}),
		)
		.default([]),
});

const GOOD = { id: "good-1", name: "家里那台", token: "t", enabled: true };
const ROTTEN = { id: "rotten-1", name: "坏掉的那台", token: "t", enabled: true };

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-settings-invalid-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 一份清单(写进 `extension.json` 的原样),只要求有 id —— 其余交给装载器去认。 */
type PlantedManifest = { id: string } & Record<string, unknown>;

async function plant(manifest: PlantedManifest = MANIFEST): Promise<void> {
	const dir = join(root, manifest.id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "extension.json"), JSON.stringify(manifest));
	// 入口的内容无所谓:import 那一步换成了 importModule(真拓展会把 zod 内联进产物,裸 mjs 拿不到)。
	await writeFile(join(dir, "index.mjs"), "export function activate() {}");
}

/** 拓展这一侧看见了什么:activate 跑了几次、每次变更通知时 `get()` 交出来的是哪一份。 */
interface Seen {
	activations: number;
	changes: unknown[];
	/** 拓展手里那个把手的 `get()` —— 「它此刻读到的是哪一份」。 */
	read?: () => unknown;
}

/** 一个守规矩的拓展:先起一只定时器(好让「收没收摊」看得见),再拿设置、订变更。 */
function standard(ctx: ExtensionContext, seen: Seen): void {
	ctx.setInterval(() => {}, 1000);
	const settings = ctx.settings(SCHEMA);
	seen.read = () => settings.get();
	settings.onChange(() => seen.changes.push(settings.get()));
}

async function boot(
	opts: {
		settings?: unknown;
		enabled?: () => boolean;
		maxFailures?: number;
		manifest?: PlantedManifest;
		activate?: (ctx: ExtensionContext, seen: Seen) => void;
	} = {},
) {
	await plant(opts.manifest);
	/** 宿主那头存着的那份。⚠️ 与生产同形状:每问一次都是一份新拷贝。 */
	let stored = opts.settings;
	const listeners = new Set<() => void>();
	const timers = new Set<() => void>();
	const lines: string[] = [];
	const logger: Logger = {
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
		debug: (m) => lines.push(`debug ${m}`),
	};
	const host: ServiceContext = {
		logger,
		setInterval(fn) {
			timers.add(fn);
			return { dispose: () => timers.delete(fn) };
		},
		setTimeout(fn) {
			timers.add(fn);
			return { dispose: () => timers.delete(fn) };
		},
		onDispose() {},
	};
	const seen: Seen = { activations: 0, changes: [] };
	const activate = opts.activate ?? standard;
	const loaded: LoadedExtensions = await loadExtensions({
		root,
		host,
		mounts: createExtensionMounts(),
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		settings: () => structuredClone(stored),
		onSettingsChanged: (fn) => {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		inbound: {},
		upgrades: createExtensionUpgrades(),
		isEnabled: opts.enabled ?? (() => true),
		maxFailures: opts.maxFailures ?? 3,
		importModule: async () => ({
			activate(ctx: ExtensionContext) {
				seen.activations += 1;
				activate(ctx, seen);
			},
		}),
	});
	return {
		loaded,
		seen,
		lines,
		/** 还挂着的定时器 —— 收摊收干净了就是 0。 */
		pending: () => timers.size,
		/** 旁路写了一次(恢复备份 / 关着时之外的写入):宿主只发「globals 落盘了」。 */
		write(next: unknown) {
			stored = next;
			for (const fn of [...listeners]) fn();
		},
		entry: () => loaded.list()[0],
	};
}

describe("开机时存着的设置就过不了它自己的 zod", () => {
	it("不起;那一行是「设置读不了」,点名到那一项的哪一格、为什么", async () => {
		const h = await boot({ settings: { links: [GOOD, ROTTEN] } });
		expect(h.entry()?.state).toBe("settings-invalid");
		// 列表项按标题点名(下标对主人没有意义),格按清单里的名字。
		expect(h.entry()?.detail).toContain("「接入」里「坏掉的那台」这一项的「名字」");
		expect(h.entry()?.detail).toContain("名字里不许有「坏」字");
		// 起到一半注册的东西当场收掉 —— 面板写着没起,它的定时器就不许还在跑。
		expect(h.pending()).toBe(0);
		await h.loaded.dispose();
	});

	/**
	 * 🔴 **这不是拓展崩了。** 按加载失败记账的话,开机两三次它就被自动停用 —— 主人把设置改对了
	 * 它也起不来,还得换一版才解封。
	 */
	it("开机几次都不累进失败记账,不会被自动停用", async () => {
		for (let i = 0; i < 3; i++) {
			const h = await boot({ settings: { links: [ROTTEN] }, maxFailures: 2 });
			expect(h.entry()?.state).toBe("settings-invalid");
			await h.loaded.dispose();
		}
		expect(readLoadLedger(root).blocked).toEqual([]);
		const ledger = JSON.parse(await readFile(join(root, "load-state.json"), "utf8"));
		expect(ledger.attempts).toEqual({});
	});

	/**
	 * 标题本身就是坏的那一格(空名字)时拿不来点名,退到 id;手改坏的文件一口气能报一长串,原因只点名
	 * 前几处 —— 一整张卡被一句原因撑满,主人什么都看不清。
	 */
	it("项的标题是空的 → 按 id 点名;坏了一长串 → 只点名前几处,说还有几处", async () => {
		const blank = (n: number) => ({ id: `x${n}`, name: "", token: "t", enabled: true });
		const h = await boot({ settings: { links: [1, 2, 3, 4, 5].map(blank) } });
		const detail = h.entry()?.detail ?? "";
		expect(detail).toContain("「接入」里 id 为 x1 的那一项的「名字」");
		expect(detail).toContain("id 为 x3 的那一项");
		expect(detail).not.toContain("id 为 x4 的那一项");
		expect(detail).toContain("…另有 2 处");
		await h.loaded.dispose();
	});

	/**
	 * 宿主认的是记在 runtime 上的那一格,不是那一抛:拓展把它接住、记一行、照常往下起的话,它拿着
	 * 的是一个一读就抛的把手 —— 照跑只会换个地方炸,还是「按没有算」那条老路。
	 */
	it("拓展自己 try/catch 吞了 ctx.settings() 那一抛 —— 照样作数", async () => {
		const h = await boot({
			settings: { interval: 90.5 },
			activate(ctx) {
				ctx.setInterval(() => {}, 1000);
				try {
					ctx.settings(SCHEMA);
				} catch {
					ctx.logger.warn("设置读不了,先不管它");
				}
			},
		});
		expect(h.entry()?.state).toBe("settings-invalid");
		expect(h.entry()?.detail).toContain("「间隔」");
		expect(h.pending()).toBe(0);
		await h.loaded.dispose();
	});
});

describe("清单声明了设置项,activate 里就得交 zod(决策 35)", () => {
	it("v2 一份都没交 → 按加载失败算,说清要调 ctx.settings(schema)", async () => {
		const h = await boot({ activate: (ctx) => void ctx.setInterval(() => {}, 1000) });
		expect(h.entry()?.state).toBe("failed");
		expect(h.entry()?.detail).toContain("ctx.settings(schema)");
		expect(h.pending()).toBe(0);
		await h.loaded.dispose();
	});

	it("v2 清单里没声明设置项 → 不交也照常跑", async () => {
		const { settings: _dropped, ...bare } = MANIFEST;
		const h = await boot({ manifest: bare, activate: () => {} });
		expect(h.entry()?.state).toBe("running");
		await h.loaded.dispose();
	});

	it("v1 不受这条管 —— 它的设置不在清单里", async () => {
		const h = await boot({
			manifest: {
				id: "douyin",
				name: "老格式",
				description: "测试用",
				version: "1.0.0",
				apiVersion: 1,
				provides: ["subscription"],
			},
			activate: () => {},
		});
		expect(h.entry()?.state).toBe("running");
		await h.loaded.dispose();
	});
});

/**
 * 跑着时写入已经过了它的 zod(设置路由),撞上的只剩旁路:恢复备份、手改文件、关着时之外的写入。
 *
 * 🔴 **拓展永远看不到一份过不了它自己 zod 的设置**:先判再扇出,判坏了一个订阅者都不叫,`get()`
 * 也不换 —— 交给装载器在队里把它收掉。
 */
describe("跑着时设置被旁路写坏", () => {
	it("订阅者不被叫、get() 还是上一份好的;那一行变「设置读不了」,它注册的东西收掉", async () => {
		const h = await boot({ settings: { links: [GOOD] } });
		expect(h.entry()?.state).toBe("running");
		const before = h.seen.read?.();

		h.write({ links: [GOOD, ROTTEN] });
		// 收它要排队 —— 这一拍里它读到的仍是上一份好的,不是那份坏的,也不是「没有」。
		expect(h.seen.read?.()).toEqual(before);
		// 排在队里它后面的一件事回来了 = 收摊那一趟走完了。
		await h.loaded.sync();

		expect(h.seen.changes).toEqual([]);
		expect(h.entry()?.state).toBe("settings-invalid");
		expect(h.entry()?.detail).toContain("「坏掉的那台」这一项");
		expect(h.pending()).toBe(0);
		await h.loaded.dispose();
	});

	/** 对照:订阅真的接上了 —— 不然上面那条「没被叫」离了那道闸也是绿的。 */
	it("写的是好的那份 → 照常扇出,照跑", async () => {
		const h = await boot({ settings: { links: [GOOD] } });
		h.write({ links: [GOOD, { ...GOOD, id: "good-2", name: "机房那台" }] });
		await h.loaded.sync();
		expect(h.seen.changes).toHaveLength(1);
		expect(h.entry()?.state).toBe("running");
		await h.loaded.dispose();
	});
});

/**
 * 设置照样能改,改对了自己起来 —— 判「改对了没有」用的是它上次交过、宿主留着的那份 zod,
 * 🔴 **不为了看一眼再跑一遍 activate**:那样每存一次全局设置它就起一次、收一次。
 */
describe("「设置读不了」之后设置又变了", () => {
	it("改对了 → 在队里起起来,不用拨开关、不用重启", async () => {
		const h = await boot({ settings: { links: [ROTTEN] } });
		expect(h.entry()?.state).toBe("settings-invalid");

		h.write({ links: [{ ...ROTTEN, name: "修好的那台" }] });
		await h.loaded.sync();

		expect(h.entry()?.state).toBe("running");
		expect(h.entry()?.detail).toBeUndefined();
		expect(h.seen.activations).toBe(2);
		expect(h.pending()).toBe(1);
		await h.loaded.dispose();
	});

	it("还是坏的 → 只换原因,一行拓展代码都不重跑", async () => {
		const h = await boot({ settings: { links: [ROTTEN] } });
		h.write({ links: [ROTTEN], interval: 90.5 });
		await h.loaded.sync();

		expect(h.entry()?.state).toBe("settings-invalid");
		expect(h.entry()?.detail).toContain("「间隔」");
		expect(h.seen.activations).toBe(1);
		await h.loaded.dispose();
	});

	it("跑着时被写坏、收掉之后又改对 → 又起来", async () => {
		const h = await boot({ settings: { links: [GOOD] } });
		h.write({ links: [ROTTEN] });
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("settings-invalid");

		h.write({ links: [GOOD] });
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("running");
		expect(h.seen.activations).toBe(2);
		await h.loaded.dispose();
	});

	/** 同一次落盘里关了开关又改对了设置:别先起一下、再被开关那一趟收掉。 */
	it("开关关着 → 改对了也不起,那是开关的活", async () => {
		let on = true;
		const h = await boot({ settings: { links: [ROTTEN] }, enabled: () => on });
		on = false;
		h.write({ links: [GOOD] });
		await h.loaded.sync();

		expect(h.entry()?.state).toBe("disabled");
		expect(h.seen.activations).toBe(1);
		await h.loaded.dispose();
	});
});
