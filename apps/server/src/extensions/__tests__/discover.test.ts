/**
 * 开机扫拓展根 —— **在 import 任何一行拓展代码之前**把每个目录看一遍。
 *
 * 这一步的产物就是拓展页那张列表:装了什么、能不能加载、不能的话为什么。三种「不能」都
 * 必须**列得出来**而不是消失(ADR-0012 决策 8):
 * 清单坏了、清单与目录对不上、为别的宿主版本写的。
 *
 * ⚠️ 拿不到清单时**身份取目录名** —— 失败记账要有个键,而最容易炸的恰恰是读清单这一步。
 *
 * ⛔ **只有一个根**:`<dataDir>/extensions/`。本体一个拓展都不带;仓里那个源码根也去掉了
 * (2026-09-10)—— 开发版改由 devtools 把仓里的 `dist` **装**进这个根(软链)。
 * 于是没有优先级、没有「同一个 id 有两份」,入口也只剩 `index.mjs` 一种。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_RANGE } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { discoverExtensions, readExtensionDir } from "../discover.js";

let root: string;

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "bridge",
		name: "机器人框架桥接",
		description: "把 koishi / AstrBot 里已经配好的机器人借给 BN 用。",
		version: "1.0.0",
		apiVersion: 1,
		provides: ["push"],
		...over,
	};
}

/** 一份 v2 清单(ADR-0019 决策 16):静态声明全住清单。 */
function manifestV2(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "douyin",
		name: "抖音订阅",
		description: "盯着抖音作者的新作品与开播。",
		version: "0.1.0",
		apiVersion: 2,
		contributes: {
			subscription: {
				display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
				events: ["post"],
			},
		},
		...over,
	};
}

/** 摆一个拓展目录:`<in>/<dirName>/extension.json`(+ 默认摆一份 index.mjs)。 */
async function plant(
	dirName: string,
	content: string | Record<string, unknown> | null,
	opts: { entry?: boolean | "source"; in?: string } = {},
): Promise<string> {
	const dir = join(opts.in ?? root, dirName);
	await mkdir(dir, { recursive: true });
	if (content !== null) {
		await writeFile(
			join(dir, "extension.json"),
			typeof content === "string" ? content : JSON.stringify(content),
		);
	}
	if (opts.entry === "source") {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "index.ts"), "export function activate() {}");
	} else if (opts.entry !== false) {
		await writeFile(join(dir, "index.mjs"), "export function activate() {}");
	}
	return dir;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-discover-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("readExtensionDir", () => {
	it("清单齐、入口在 → ready,拿到清单本身与入口文件", async () => {
		const dir = await plant("bridge", manifest());
		const r = await readExtensionDir(dir);
		expect(r.state).toBe("ready");
		// 不是软链就没有落点这一格。
		if (r.state === "ready") expect(r.linkedTo).toBeUndefined();
		expect(r.id).toBe("bridge");
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.name).toBe("机器人框架桥接");
		expect(r.entry).toBe(join(dir, "index.mjs"));
	});

	/**
	 * 图标是**加载时**过白名单的(ADR-0012 决策 20),而这里就是那一刻:清单读出来立刻过
	 * 一遍,下游(面板、`/api/ext`)没有任何一条路能拿到原样的 SVG。
	 */
	it("清单里的图标过白名单:干净的留着", async () => {
		const icon = '<svg viewBox="0 0 24 24"><path d="M4 4h16"/></svg>';
		const r = await readExtensionDir(await plant("bridge", manifest({ icon })));
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.icon).toBe(icon);
	});

	it("清单里的图标过白名单:夹带脚本的整枚丢掉,但拓展本身照常加载", async () => {
		const r = await readExtensionDir(
			await plant(
				"bridge",
				manifest({ icon: '<svg viewBox="0 0 24 24"><script>x()</script></svg>' }),
			),
		);
		// 图标坏了不是拒绝加载的理由 —— 它退回灰方章,拓展该跑还是跑。
		expect(r.state).toBe("ready");
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.icon).toBeUndefined();
	});

	it("清单与目录名对不上 → 拒,而且说得出两边分别是什么", async () => {
		const r = await readExtensionDir(await plant("bridge", manifest({ id: "not-bridge" })));
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		// 身份取目录名 —— 挂载点与装载目录都按它算,清单说了不算。
		expect(r.id).toBe("bridge");
		expect(r.detail).toContain("not-bridge");
	});

	it("v2 清单 → ready(宿主认的是一个区间,不再只认一档)", async () => {
		const r = await readExtensionDir(await plant("douyin", manifestV2()));
		expect(r.state).toBe("ready");
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.apiVersion).toBe(2);
	});

	it("为更新的宿主写的 → incompatible,列得出来、带得上原因", async () => {
		const requires = EXTENSION_API_RANGE.current + 1;
		const r = await readExtensionDir(
			await plant("future", manifest({ id: "future", apiVersion: requires })),
		);
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.requires).toBe(requires);
		expect(r.range).toEqual(EXTENSION_API_RANGE);
		// 名字还在 —— 面板要印得出「谁没加载」。
		expect(r.identity.name).toBe("机器人框架桥接");
	});

	/**
	 * 为将来的宿主写的清单,格式本来就可能是我们不认识的 —— 按今天的规矩挑毛病只会报
	 * 「读不了」,而真正的原因只有一条:版本不合(ADR-0019 决策 18)。
	 */
	it("将来的格式我们不认识 → 照样是 incompatible,不是 unreadable", async () => {
		const r = await readExtensionDir(
			await plant("future", {
				id: "future",
				name: "未来的拓展",
				description: "用的是我们还不认识的清单格式。",
				version: "3.0.0",
				apiVersion: EXTENSION_API_RANGE.current + 1,
				contributes: { chat: { anything: true } },
				brandNewSection: {},
			}),
		);
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.identity.version).toBe("3.0.0");
	});

	it("低于宿主最低档的 → 同样 incompatible(抬过最低档之后,老拓展停在门外)", async () => {
		const r = await readExtensionDir(await plant("bridge", manifest()), {
			hostApiRange: { min: 2, current: 3 },
		});
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.requires).toBe(1);
	});

	it("版本不合、清单 id 又与目录名对不上 → unreadable(两个身份比版本更要紧)", async () => {
		const r = await readExtensionDir(
			await plant("future", manifest({ id: "other", apiVersion: EXTENSION_API_RANGE.current + 1 })),
		);
		expect(r.state).toBe("unreadable");
	});

	it("版本不合的拓展,图标一样过白名单", async () => {
		const r = await readExtensionDir(
			await plant(
				"future",
				manifest({
					id: "future",
					apiVersion: EXTENSION_API_RANGE.current + 1,
					icon: '<svg viewBox="0 0 24 24"><script>x()</script></svg>',
				}),
			),
		);
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.identity.icon).toBeUndefined();
	});

	/**
	 * 选项图标是图片 data URL,面板当 `<img>` 画(ADR-0019 决策 31)—— 它不进 SVG 白名单,
	 * 原样留着;塞一段 SVG 标记进来的清单在格式那一步就读不了。
	 */
	it("v2 设置项的选项图标:图片 data URL 原样留着;SVG 标记 —— 清单读不了", async () => {
		const png =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
		const withIcon = (icon: string) =>
			manifestV2({
				settings: {
					fields: [
						{
							key: "kind",
							type: "enum",
							label: "种类",
							options: [{ value: "a", label: "A", icon }],
						},
					],
				},
			});
		const r = await readExtensionDir(await plant("douyin", withIcon(png)));
		if (r.state !== "ready" || r.manifest.apiVersion !== 2) throw new Error("unreachable");
		expect(r.manifest.settings?.fields[0]).toMatchObject({ options: [{ icon: png }] });

		const bad = await readExtensionDir(
			await plant("douyin", withIcon('<svg viewBox="0 0 24 24"><script>x()</script></svg>')),
		);
		expect(bad.state).toBe("unreadable");
	});

	it("清单不是合法 JSON → unreadable,身份退回目录名", async () => {
		const r = await readExtensionDir(await plant("broken", "{ not json"));
		expect(r.state).toBe("unreadable");
		expect(r.id).toBe("broken");
	});

	it("清单缺字段 → unreadable,detail 指得出是哪一格", async () => {
		const r = await readExtensionDir(await plant("half", manifest({ id: "half", version: "v1" })));
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		expect(r.detail).toContain("version");
	});

	it("没有 extension.json → 根本不是拓展目录,回 absent(不记账、不报错)", async () => {
		const r = await readExtensionDir(await plant("junk", null));
		expect(r.state).toBe("absent");
	});

	it("有清单但没有 index.mjs → unreadable —— 别等到启用那一刻才发现没东西可加载", async () => {
		const r = await readExtensionDir(
			await plant("hollow", manifest({ id: "hollow" }), { entry: false }),
		);
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		expect(r.detail).toContain("index.mjs");
	});

	/**
	 * ⛔ **入口只认 `index.mjs`** —— 仓里那种「`src/index.ts` 的源码目录」不再是拓展。
	 * 开发版装的是 `vp pack` 出来的 `dist`(由 devtools 链进装载目录),与市场下载的、
	 * 主人手放的**形状完全一样**:清单 + 一个自包含的 `index.mjs`。
	 */
	it("只有 src/index.ts 的源码目录不算拓展 —— 入口固定 index.mjs", async () => {
		const dir = await plant("dev-ext", manifest({ id: "dev-ext" }), { entry: "source" });
		const r = await readExtensionDir(dir);
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		expect(r.detail).toContain("index.mjs");
	});
});

describe("discoverExtensions", () => {
	it("扫一遍装载根,按 id 排好 —— 顺序稳定,面板列表才不会每次开机乱跳", async () => {
		await plant("zeta", manifest({ id: "zeta" }));
		await plant("bridge", manifest());
		await plant("broken", "{ not json");
		const found = await discoverExtensions(root);
		expect(found.map((e) => e.id)).toEqual(["bridge", "broken", "zeta"]);
	});

	it("没有清单的目录不进表 —— 它不是拓展,不该在面板上占一行", async () => {
		await plant("bridge", manifest());
		await plant("some-junk", null);
		const found = await discoverExtensions(root);
		expect(found.map((e) => e.id)).toEqual(["bridge"]);
	});

	/**
	 * 🔴 **软链要当目录看。** `readdir(withFileTypes)` 走的是 lstat 语义:一条指向目录的
	 * 软链 `isDirectory()` 是 **false**、`isSymbolicLink()` 才是 true —— 只认前者的话,
	 * 装进来的拓展在这一页上**根本不出现,而且不报错**。
	 *
	 * 开发版正是这么装的:devtools 把仓里那份 `dist` 软链进 `<dataDir>/extensions/<id>`。
	 */
	it("软链进来的拓展照样扫得到 —— readdir 里它不是目录", async () => {
		const elsewhere = await mkdtemp(join(tmpdir(), "bn-ext-real-"));
		try {
			await plant("bridge", manifest(), { in: elsewhere });
			await symlink(join(elsewhere, "bridge"), join(root, "bridge"), "dir");
			const found = await discoverExtensions(root);
			expect(found.map((r) => [r.id, r.state])).toEqual([["bridge", "ready"]]);
			// 🔴 **落点也要报出来**:装载目录里写着 `<dataDir>/extensions/bridge`,而跑的
			// 其实是主人正在改的那份工作树 —— 少了这一句,「我改的是不是它」没法回答。
			const only = found[0];
			if (only?.state !== "ready") throw new Error("unreachable");
			expect(only.linkedTo).toBe(join(elsewhere, "bridge"));
		} finally {
			await rm(elsewhere, { recursive: true, force: true });
		}
	});

	/**
	 * 🔴 安装的暂存目录 `.staging-<id>-xxxx` 就建在装载根里;进程在 rename 之前被杀,它就带着
	 * 一份合法清单留在盘上 —— 清单 id 与目录名对不上,每次开机多一张删不掉的 unreadable 卡。
	 * 点开头的目录一律不当拓展看。
	 */
	it("点开头的目录不进表 —— 那是装到一半留下的暂存,不是拓展", async () => {
		await plant("bridge", manifest());
		await plant(".staging-bridge-abc123", manifest());
		const found = await discoverExtensions(root);
		expect(found.map((e) => e.id)).toEqual(["bridge"]);
	});

	it("目录压根不存在 → 空表,不是错误(头一次开机就是这样)", async () => {
		expect(await discoverExtensions(join(root, "nope"))).toEqual([]);
	});

	it("散在里面的文件跳过,不当成拓展目录", async () => {
		await writeFile(join(root, "README.txt"), "hi");
		expect(await discoverExtensions(root)).toEqual([]);
	});
});
