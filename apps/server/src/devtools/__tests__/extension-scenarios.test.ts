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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
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

function scenarios(over: { reload?: (id: string) => Promise<void> } = {}) {
	return extensionScenarios({
		repoDir,
		installRoot,
		extensions: () => (over.reload ? { reload: over.reload } : undefined),
	});
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
		// 装载不是热的 —— 不说这句,主人会以为拓展页刷新一下就有了。
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
		await expect(must("ext.reload").run({ ext: "bridge" })).rejects.toThrow(/还没起来/);
	});
});

describe("软链进去的那份,装载器认得", () => {
	/**
	 * 接线守卫:场景把链建对了、装载器却不认软链的话,拓展在页面上**一声不响地不出现**。
	 * 两边各自的测试都不会红 —— 所以这条从「装完之后 discover 扫得到」这个角度再钉一遍。
	 */
	it("装完之后 discoverExtensions 扫得到它", async () => {
		await plantRepo("bridge", true);
		await writeFile(
			join(repoDir, "bridge", "dist", "extension.json"),
			JSON.stringify({
				id: "bridge",
				name: "桥",
				description: "测试用",
				version: "1.0.0",
				apiVersion: 1,
				provides: ["push"],
			}),
		);
		await must("ext.install").run({ ext: "bridge" });
		const { discoverExtensions } = await import("../../extensions/discover.js");
		const found = await discoverExtensions(installRoot);
		expect(found.map((r) => [r.id, r.state])).toEqual([["bridge", "ready"]]);
	});
});
