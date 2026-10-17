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
 * - 清单声明了设置项,activate 里却一份 zod 都没交 → 按加载失败算
 * - 跑着时被旁路写坏 → 🔴 **拓展看不到那一份**:`get()` 回 `invalid` 带原因、订阅者被叫一次,
 *   那一行变 `settings-invalid`
 * - 没设过不算坏:空对象过得了规则就成功拿默认值,过不了回 `not_configured`、拓展照跑
 * - 设置再变:解得开就在队里起起来;还解不开只更新原因,一行拓展代码都不重跑
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createProblemTable, type ProblemTable } from "../../problems/problem-table.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
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
		/** 配置仓报「设置文件读不懂」的那张表:id → 原因。 */
		issues?: Record<string, Issue>;
		/** 同目录里另外装的拓展。 */
		others?: PlantedManifest[];
		/** 问题表的写口;不给就是什么都不记的那份。 */
		problems?: Pick<ProblemTable, "report" | "resolve" | "clearReporter">;
	} = {},
) {
	await plant(opts.manifest);
	for (const other of opts.others ?? []) await plant(other);
	const issues = new Map(Object.entries(opts.issues ?? {}));
	const imported: string[] = [];
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
		signal: new AbortController().signal,
		track: () => {},
	};
	const seen: Seen = { activations: 0, changes: [] };
	const activate = opts.activate ?? standard;
	const loaded: LoadedExtensions = await loadExtensions({
		root,
		host,
		loggerOf: () => logger,
		integrationStore: memoryIntegrationStore(),
		problems: opts.problems ?? ignoredProblems,
		mounts: createExtensionMounts({ logger: silentLogger }),
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		subscriptions: () => [],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		settings: () => structuredClone(stored),
		onSettingsChanged: (fn) => {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		inbound: {},
		upgrades: createExtensionUpgrades(),
		isEnabled: opts.enabled ?? (() => true),
		maxFailures: opts.maxFailures ?? 3,
		settingsIssue: (id) => issues.get(id),
		importModule: async (url: string) => {
			imported.push(url);
			return {
				activate(ctx: ExtensionContext) {
					seen.activations += 1;
					activate(ctx, seen);
				},
			};
		},
	});
	return {
		loaded,
		seen,
		lines,
		/** 还挂着的定时器 —— 收摊收干净了就是 0。 */
		pending: () => timers.size,
		/** 真 import 过几次。 */
		imports: () => imported.length,
		/** 配置仓那头原因变了(重存清掉 / 又读不懂了)。 */
		setIssue(id: string, issue: Issue | undefined) {
			if (issue) issues.set(id, issue);
			else issues.delete(id);
		},
		/** 旁路写了一次(恢复备份 / 关着时之外的写入):宿主只发「globals 落盘了」。 */
		write(next: unknown) {
			stored = next;
			for (const fn of [...listeners]) fn();
		},
		entry: () => loaded.list()[0],
		entryOf: (id: string) => loaded.list().find((e) => e.id === id),
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
});

/**
 * 跑着时写入已经过了它的 zod(设置路由),撞上的只剩旁路:恢复备份、手改文件、关着时之外的写入。
 *
 * 🔴 **拓展永远拿不到一份过不了它自己 zod 的值**:先判再扇出,判坏了 `get()` 回 `invalid`(不是那份
 * 坏值),并叫一次订阅者(读得懂与读不懂之间翻了) —— 同时交给装载器在队里把它收掉。
 */
describe("跑着时设置被旁路写坏", () => {
	it("get() 回 invalid 带原因、订阅者被叫一次;那一行变「设置读不了」,它注册的东西收掉", async () => {
		const h = await boot({ settings: { links: [GOOD] } });
		expect(h.entry()?.state).toBe("running");

		h.write({ links: [GOOD, ROTTEN] });
		// 收它要排队 —— 这一拍里它读到的是 invalid(带原因),不是那份坏的值,也不是「没有」。
		expect(h.seen.read?.()).toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("「坏掉的那台」这一项"),
			// SettingsReader 的约定:invalid 带逐条原因(路径从设置那一层往下数)。
			issues: [{ path: ["links", 1, "name"], message: "名字里不许有「坏」字" }],
		});
		// 排在队里它后面的一件事回来了 = 收摊那一趟走完了。
		await h.loaded.sync();

		// 订阅者被叫的那一下读到的也是 invalid(读得懂与读不懂之间翻了就叫)。
		expect(h.seen.changes).toHaveLength(1);
		expect(h.seen.changes[0]).toMatchObject({ ok: false, code: "invalid" });
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

	/**
	 * 没设过不算坏:设置文件被删成没设过、而规则收不下空对象 → 起得来,`get()` 回 `not_configured`
	 * (extension-contract「设置」第二条)。
	 */
	it("设置被删成没设过、规则收不下空对象 → 起起来,get() 回 not_configured", async () => {
		const STRICT = z.object({ token: z.string().min(1) });
		const strictManifest: PlantedManifest = {
			...MANIFEST,
			settings: { fields: [{ key: "token", type: "string", label: "token", required: true }] },
		};
		const h = await boot({
			manifest: strictManifest,
			settings: { token: "" },
			activate(ctx, seen) {
				const settings = ctx.settings(STRICT);
				seen.read = () => settings.get();
			},
		});
		expect(h.entry()?.state).toBe("settings-invalid");

		h.write(undefined);
		await h.loaded.sync();

		expect(h.entry()?.state).toBe("running");
		expect(h.seen.activations).toBe(2);
		expect(h.seen.read?.()).toMatchObject({ ok: false, code: "not_configured" });
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

/**
 * 设置文件不是合法 JSON(配置仓记下了原因,拓展拿到的设置与「没设过」同形)—— 带默认值的拓展照常起
 * 的话会拿默认值盖掉那份坏文件,所以起之前先看这一口:有原因就不起,只停这一个。
 */
describe("设置文件读不懂(不是合法 JSON)", () => {
	const BROKEN: Issue = { message: "Unexpected end of JSON input" };
	const { settings: _declared, ...withoutSettings } = MANIFEST;
	const OTHER: PlantedManifest = { ...withoutSettings, id: "other", name: "别的拓展" };

	it("不 import、不 activate;那一行是「设置读不了」带那句话;不累进失败账;别的拓展照常起", async () => {
		for (let i = 0; i < 3; i++) {
			const h = await boot({
				issues: { douyin: BROKEN },
				others: [OTHER],
				activate: () => {},
				maxFailures: 2,
			});
			const entry = h.entryOf("douyin");
			expect(entry?.state).toBe("settings-invalid");
			expect(entry?.detail).toContain("不是合法的 JSON");
			expect(entry?.detail).toContain(BROKEN.message);
			// 只有别的拓展被 import 过。
			expect(h.imports()).toBe(1);
			expect(h.seen.activations).toBe(1);
			expect(h.entryOf("other")?.state).toBe("running");
			await h.loaded.dispose();
		}
		expect(readLoadLedger(root).blocked).toEqual([]);
	});

	it("设置变了、原因还在 → 不起,原因不变;原因没了 → 起", async () => {
		const h = await boot({ issues: { douyin: BROKEN } });
		const detail = h.entry()?.detail;
		expect(h.entry()?.state).toBe("settings-invalid");
		const parked = () => h.lines.filter((line) => line.includes("设置文件读不懂")).length;
		expect(parked()).toBe(1);

		h.write({ links: [GOOD] });
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("settings-invalid");
		expect(h.entry()?.detail).toBe(detail);
		// 原因还在就根本不动它:不重走一遍 start(那会再停一次、再记一行)。
		expect(parked()).toBe(1);
		expect(h.imports()).toBe(0);
		expect(h.seen.activations).toBe(0);

		h.setIssue("douyin", undefined);
		h.write({ links: [GOOD] });
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("running");
		expect(h.entry()?.detail).toBeUndefined();
		expect(h.seen.activations).toBe(1);
		await h.loaded.dispose();
	});
});

/**
 * 「设置读不了」同时记在问题表里(extension-contract「问题上报」):宿主替拓展报,报的人是拓展 id,
 * code `settings_invalid`,不带 `about`、不私聊;改好起来、停用、卸载时清。走真问题表。
 */
describe("设置读不了记进问题表", () => {
	const BROKEN: Issue = { message: "Unexpected end of JSON input" };

	/** 真表 + 一份记 `report` 入参的包装(要看有没有带 `notify`)。 */
	function tableWithReports() {
		const table = createProblemTable({ logger: silentLogger });
		const reports: Parameters<ProblemTable["report"]>[0][] = [];
		const problems: Pick<ProblemTable, "report" | "resolve" | "clearReporter"> = {
			report(input) {
				reports.push(input);
				table.report(input);
			},
			resolve: (key, options) => table.resolve(key, options),
			clearReporter: (reporter) => table.clearReporter(reporter),
		};
		const mine = () => table.list().filter((problem) => problem.reporter === "douyin");
		return { problems, reports, mine };
	}

	it("开机存着的设置过不了 zod → 正好一条 settings_invalid,不带 about、不私聊,话里有拓展名和原因", async () => {
		const t = tableWithReports();
		const h = await boot({ settings: { links: [GOOD, ROTTEN] }, problems: t.problems });
		expect(t.mine()).toHaveLength(1);
		expect(t.mine()[0]).toMatchObject({ reporter: "douyin", code: "settings_invalid" });
		expect(t.mine()[0]?.about).toBeUndefined();
		expect(t.mine()[0]?.message).toContain("「抖音订阅」");
		expect(t.mine()[0]?.message).toContain("名字里不许有「坏」字");
		expect(t.reports).toHaveLength(1);
		expect(t.reports[0]).not.toHaveProperty("notify");
		await h.loaded.dispose();
	});

	it("设置文件读不懂 → 同样一条,话是文件读不懂那一句", async () => {
		const t = tableWithReports();
		const h = await boot({ issues: { douyin: BROKEN }, problems: t.problems });
		expect(t.mine()).toHaveLength(1);
		expect(t.mine()[0]).toMatchObject({ code: "settings_invalid" });
		expect(t.mine()[0]?.message).toContain("「抖音订阅」");
		expect(t.mine()[0]?.message).toContain("不是合法的 JSON");
		expect(t.mine()[0]?.message).toContain(BROKEN.message);
		await h.loaded.dispose();
	});

	it("跑着时被旁路写坏、收掉之后 → 一条(收摊清掉的是它旧上下文名下的,不能连这一条一起清)", async () => {
		const t = tableWithReports();
		const h = await boot({ settings: { links: [GOOD] }, problems: t.problems });
		expect(t.mine()).toHaveLength(0);
		h.write({ links: [ROTTEN] });
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("settings-invalid");
		expect(t.mine()).toHaveLength(1);
		expect(t.mine()[0]?.message).toContain("「坏掉的那台」这一项");
		await h.loaded.dispose();
	});

	it("还是坏的、再存一次别的坏法 → 仍是一条,话换了、since 不动", async () => {
		const t = tableWithReports();
		const h = await boot({ settings: { links: [ROTTEN] }, problems: t.problems });
		const first = t.mine()[0];
		h.write({ links: [ROTTEN], interval: 90.5 });
		await h.loaded.sync();
		expect(t.mine()).toHaveLength(1);
		expect(t.mine()[0]?.message).toContain("「间隔」");
		expect(t.mine()[0]?.message).not.toBe(first?.message);
		expect(t.mine()[0]?.since).toBe(first?.since);
		await h.loaded.dispose();
	});

	it("改对起起来 → 没了", async () => {
		const t = tableWithReports();
		const h = await boot({ settings: { links: [ROTTEN] }, problems: t.problems });
		expect(t.mine()).toHaveLength(1);
		h.write({ links: [GOOD] });
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("running");
		expect(t.mine()).toHaveLength(0);
		await h.loaded.dispose();
	});

	it("停用 → 没了", async () => {
		const t = tableWithReports();
		let on = true;
		const h = await boot({
			settings: { links: [ROTTEN] },
			enabled: () => on,
			problems: t.problems,
		});
		expect(t.mine()).toHaveLength(1);
		on = false;
		await h.loaded.sync();
		expect(h.entry()?.state).toBe("disabled");
		expect(t.mine()).toHaveLength(0);
		await h.loaded.dispose();
	});

	it("卸载 → 没了", async () => {
		const t = tableWithReports();
		const h = await boot({ settings: { links: [ROTTEN] }, problems: t.problems });
		expect(t.mine()).toHaveLength(1);
		await rm(join(root, "douyin"), { recursive: true, force: true });
		await h.loaded.rescan();
		expect(h.entry()).toBeUndefined();
		expect(t.mine()).toHaveLength(0);
		await h.loaded.dispose();
	});

	it("对照:设置是好的、activate 抛了(failed)→ 表里没有 settings_invalid", async () => {
		const t = tableWithReports();
		const h = await boot({
			settings: { links: [GOOD] },
			problems: t.problems,
			activate() {
				throw new Error("activate 炸了");
			},
		});
		expect(h.entry()?.state).toBe("failed");
		expect(t.mine().filter((problem) => problem.code === "settings_invalid")).toEqual([]);
		await h.loaded.dispose();
	});
});
