/**
 * 开发版装拓展的那三条 devtools 场景。
 *
 * 🔴 它们替掉的是**装载器里的一条特例**(仓里 `extensions/` 曾经是第二个根)。所以这里
 * 钉的不是「按钮能按」,而是那条特例消失之后剩下的三条硬规矩:
 * ① 装的是**构建产物**(没 build 就明说,别装一个空壳);
 * ② **只碰自己链进去的那条软链** —— 真目录可能是主人手放的包,不许删;
 * ③ 重载转给装载器,它说不行的理由要原样传到面板上。
 */

import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { loadExtensions } from "../../extensions/loader.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { createExtensionUpgrades } from "../../extensions/upgrade.js";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { extensionScenarios } from "../scenarios/extensions.js";

let repoDir: string;
let installRoot: string;

/** 摆一个仓里的拓展目录(有清单),`built` 时连 dist/index.mjs 一起摆。 */
async function plantRepo(id: string, built: boolean): Promise<void> {
	await mkdir(join(repoDir, id), { recursive: true });
	await writeFile(join(repoDir, id, "extension.json"), JSON.stringify({ id }));
	if (built) {
		await mkdir(join(repoDir, id, "dist"), { recursive: true });
		await writeFile(join(repoDir, id, "dist", "index.mjs"), "export function activate() {}");
	}
}

interface FakeLoader {
	reload?: (id: string) => Promise<void>;
	rescan?: () => Promise<void>;
	/** 装载器还没起来(devtools 比它先建)—— 那几条降级路径靠这个摆出来。 */
	down?: boolean;
}

function scenarios(over: FakeLoader = {}) {
	const loaded = {
		reload: over.reload ?? (async () => {}),
		rescan: over.rescan ?? (async () => {}),
	};
	return extensionScenarios({
		repoDir,
		installRoot,
		extensions: () => (over.down ? undefined : loaded),
	});
}

/** 往仓里那份 `dist` 里补一份**装载器读得懂**的清单 —— 装进去之后它就是拓展包本身。 */
async function plantManifest(id: string): Promise<void> {
	await writeFile(
		join(repoDir, id, "dist", "extension.json"),
		JSON.stringify({
			id,
			name: "桥",
			description: "测试用",
			version: "1.0.0",
			apiVersion: 1,
			provides: ["push"],
		}),
	);
}

/** 装载器要的那一圈核心零件 —— 这条测试只关心装 / 卸,它们给个能用的空壳就够。 */
function hostStubs() {
	const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
	const host: ServiceContext = {
		logger,
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
	};
	return {
		host,
		mounts: createExtensionMounts(),
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
	};
}

function must(id: string, over?: Parameters<typeof scenarios>[0]) {
	const def = scenarios(over).find((s) => s.id === id);
	if (!def) throw new Error(`没有场景 ${id}`);
	return def;
}

beforeEach(async () => {
	repoDir = await mkdtemp(join(tmpdir(), "bn-dev-repo-"));
	installRoot = await mkdtemp(join(tmpdir(), "bn-dev-data-"));
});

afterEach(async () => {
	await rm(repoDir, { recursive: true, force: true });
	await rm(installRoot, { recursive: true, force: true });
});

describe("装", () => {
	it("仓里一个拓展都没有 → 这几条场景压根不注册", async () => {
		expect(scenarios()).toEqual([]);
	});

	it("链进装载根,盘上真是一条指向 dist 的软链", async () => {
		await plantRepo("bridge", true);
		const out = await must("ext.install").run({ ext: "bridge" });
		const at = join(installRoot, "bridge");
		expect((await lstat(at)).isSymbolicLink()).toBe(true);
		expect(await readlink(at)).toBe(join(repoDir, "bridge", "dist"));
		expect(out.summary).toContain("bridge");
	});

	/**
	 * 🔴 **装完就得能用。** 链建好了却不重扫的话,装载器名单还是开机那一份 —— 症状是
	 * 「装完了拓展页上没有」,而唯一的出路是重启,那正是这一整片要去掉的东西。
	 */
	it("装完当场重扫一遍 —— 不用重启,也别再叫主人去重启", async () => {
		await plantRepo("bridge", true);
		let rescanned = 0;
		const out = await must("ext.install", {
			rescan: async () => {
				rescanned++;
			},
		}).run({ ext: "bridge" });
		expect(rescanned).toBe(1);
		expect(out.summary).toMatch(/已装上/);
		expect(out.summary).not.toMatch(/重启/);
	});

	/**
	 * 降级路径:devtools 比装载器先建起来。链照建,但这一次它确实要等重启 ——
	 * 说成「已生效」就是骗人,主人会去拓展页上找一个不存在的东西。
	 */
	it("装载器还没起来 → 链照建,但把「要重启一次」说明白", async () => {
		await plantRepo("bridge", true);
		const out = await must("ext.install", { down: true }).run({ ext: "bridge" });
		expect((await lstat(join(installRoot, "bridge"))).isSymbolicLink()).toBe(true);
		expect(out.summary).toMatch(/重启/);
	});

	/** 装的是**构建产物**:装载器只认 `index.mjs`,链一个没 build 的目录进去等于装了个空壳。 */
	it("没 build → 明说要先构建,而且一条链都不建", async () => {
		await plantRepo("bridge", false);
		await expect(must("ext.install").run({ ext: "bridge" })).rejects.toThrow(/build/);
		await expect(lstat(join(installRoot, "bridge"))).rejects.toThrow();
	});

	it("已经装着 → 说一声就算了,不重复建", async () => {
		await plantRepo("bridge", true);
		await must("ext.install").run({ ext: "bridge" });
		const again = await must("ext.install").run({ ext: "bridge" });
		expect(again.summary).toMatch(/早就装着/);
	});

	/** 🔴 那可能是主人手放的包 —— devtools 不许覆盖,更不许删。 */
	it("装载根里已经有个真目录 → 拒绝,原样留着", async () => {
		await plantRepo("bridge", true);
		await mkdir(join(installRoot, "bridge"), { recursive: true });
		await writeFile(join(installRoot, "bridge", "index.mjs"), "// 主人手放的");
		await expect(must("ext.install").run({ ext: "bridge" })).rejects.toThrow(/真目录/);
		expect((await lstat(join(installRoot, "bridge"))).isDirectory()).toBe(true);
	});
});

describe("卸", () => {
	it("卸完当场重扫一遍 —— 它当场从拓展页上消失", async () => {
		await plantRepo("bridge", true);
		let rescanned = 0;
		const rescan = async () => {
			rescanned++;
		};
		await must("ext.install", { rescan }).run({ ext: "bridge" });
		rescanned = 0;
		const out = await must("ext.uninstall", { rescan }).run({ ext: "bridge" });
		expect(rescanned).toBe(1);
		expect(out.summary).not.toMatch(/重启/);
	});

	it("删掉自己链进去的那条,仓里那份一根汗毛都不少", async () => {
		await plantRepo("bridge", true);
		await must("ext.install").run({ ext: "bridge" });
		await must("ext.uninstall").run({ ext: "bridge" });
		await expect(lstat(join(installRoot, "bridge"))).rejects.toThrow();
		expect((await lstat(join(repoDir, "bridge", "dist", "index.mjs"))).isFile()).toBe(true);
	});

	/** 🔴 `rm -rf` 一个真目录 = 把主人手放的包删了。宁可让他自己动手。 */
	it("那是个真目录 → 拒绝,一个文件都不动", async () => {
		await plantRepo("bridge", true);
		await mkdir(join(installRoot, "bridge"), { recursive: true });
		await writeFile(join(installRoot, "bridge", "index.mjs"), "// 主人手放的");
		await expect(must("ext.uninstall").run({ ext: "bridge" })).rejects.toThrow(/真目录/);
		expect((await lstat(join(installRoot, "bridge", "index.mjs"))).isFile()).toBe(true);
	});

	it("压根没装 → 说没装,不装作卸过了", async () => {
		await plantRepo("bridge", true);
		await expect(must("ext.uninstall").run({ ext: "bridge" })).rejects.toThrow(/没装/);
	});
});

describe("重载", () => {
	it("转给装载器", async () => {
		await plantRepo("bridge", true);
		const seen: string[] = [];
		const out = await must("ext.reload", {
			reload: async (id) => {
				seen.push(id);
			},
		}).run({ ext: "bridge" });
		expect(seen).toEqual(["bridge"]);
		expect(out.summary).toContain("bridge");
	});

	/** 「它关着」「没这个拓展」都是装载器判的 —— 那句话要原样到面板上,别吞成 500。 */
	it("装载器说不行的理由原样传出去", async () => {
		await plantRepo("bridge", true);
		await expect(
			must("ext.reload", {
				reload: async () => {
					throw new Error("bridge 的开关关着");
				},
			}).run({ ext: "bridge" }),
		).rejects.toThrow(/开关关着/);
	});

	it("装载器还没起来 → 说清楚,不是崩一个 500", async () => {
		await plantRepo("bridge", true);
		await expect(must("ext.reload", { down: true }).run({ ext: "bridge" })).rejects.toThrow(
			/还没起来/,
		);
	});
});

describe("改完自动重载", () => {
	/** 盯的是**装进来那份**的 `index.mjs` —— 也就是软链指过去的仓里那个 dist。 */
	async function installed(id: string): Promise<string> {
		await plantRepo(id, true);
		await must("ext.install").run({ ext: id });
		return join(repoDir, id, "dist", "index.mjs");
	}

	it("盯上之后,代码一变就自己重载一次", async () => {
		const entry = await installed("bridge");
		const reloaded: string[] = [];
		const over = {
			reload: async (id: string) => {
				reloaded.push(id);
			},
		};
		const watch = must("ext.watch", over);
		await watch.run({ ext: "bridge" });
		try {
			// 重建一次:内容换掉(`vp pack -w` 干的就是这件事)。
			await writeFile(entry, "export function activate() {/* v2 */}");
			await waitFor(() => reloaded.length > 0);
			expect(reloaded).toEqual(["bridge"]);
		} finally {
			await watch.reset?.();
		}
	});

	it("盯着的时候进「当前生效」条,收摊就不盯了", async () => {
		const entry = await installed("bridge");
		const reloaded: string[] = [];
		const over = {
			reload: async (id: string) => {
				reloaded.push(id);
			},
		};
		const watch = must("ext.watch", over);
		await watch.run({ ext: "bridge" });
		expect(watch.active?.()).toMatchObject({ scenarioId: "ext.watch" });

		await watch.reset?.();
		expect(watch.active?.()).toBeNull();
		// 收摊之后再改一次,不该再有动静。
		await writeFile(entry, "export function activate() {/* v3 */}");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(reloaded).toEqual([]);
	});

	/**
	 * 🔴 重载失败(拓展关着、代码崩了)**不许把监听掐掉** —— 改一行崩一次就得重新去点一遍,
	 * 开发循环当场卡死。那句理由挂到「当前生效」条上,主人看得见。
	 */
	it("重载失败照样盯着,理由挂到生效条上", async () => {
		const entry = await installed("bridge");
		const watch = must("ext.watch", {
			reload: async () => {
				throw new Error("bridge 的开关关着");
			},
		});
		await watch.run({ ext: "bridge" });
		try {
			await writeFile(entry, "export function activate() {/* v2 */}");
			await waitFor(() => /开关关着/.test(watch.active?.()?.label ?? ""));
			expect(watch.active?.()).toMatchObject({ scenarioId: "ext.watch" });
		} finally {
			await watch.reset?.();
		}
	});

	it("没装进来的拓展盯不了 —— 说清楚先装", async () => {
		await plantRepo("bridge", true);
		await expect(must("ext.watch").run({ ext: "bridge" })).rejects.toThrow(/装/);
	});
});

async function waitFor(ok: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (ok()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("等超时了");
}

describe("软链进去的那份,装载器认得", () => {
	/**
	 * 接线守卫:场景把链建对了、装载器却不认软链的话,拓展在页面上**一声不响地不出现**。
	 * 两边各自的测试都不会红 —— 所以这条从「装完之后 discover 扫得到」这个角度再钉一遍。
	 */
	it("装完之后 discoverExtensions 扫得到它", async () => {
		await plantRepo("bridge", true);
		await plantManifest("bridge");
		await must("ext.install").run({ ext: "bridge" });
		const { discoverExtensions } = await import("../../extensions/discover.js");
		const found = await discoverExtensions(installRoot);
		expect(found.map((r) => [r.id, r.state])).toEqual([["bridge", "ready"]]);
	});

	/**
	 * 🔴 **端到端,因为两半各自绿证明不了接上了**:场景老老实实调了 `rescan()`,装载器
	 * 也认得软链 —— 可只要中间那根线接错(传进去的不是真装载器、或者装完才建的链),
	 * 症状仍旧是主人报的那一句「装了拓展要重启,可它没重启」。这里用**真装载器**走一遍。
	 */
	it("按一下装 → 真装载器当场把它跑起来;按一下卸 → 当场没了", async () => {
		await plantRepo("bridge", true);
		await plantManifest("bridge");
		const loaded = await loadExtensions({
			root: installRoot,
			isEnabled: () => true,
			maxFailures: 3,
			...hostStubs(),
		});
		// 开机那一眼:装载根还是空的 —— 之后的变化只可能来自那两下按钮。
		expect(loaded.list()).toEqual([]);
		const rescan = () => loaded.rescan();

		await must("ext.install", { rescan }).run({ ext: "bridge" });
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "running"]]);

		await must("ext.uninstall", { rescan }).run({ ext: "bridge" });
		expect(loaded.list()).toEqual([]);
		await loaded.dispose();
	});
});
