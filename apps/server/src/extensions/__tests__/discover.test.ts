/**
 * 开机扫拓展根 —— **在 import 任何一行拓展代码之前**把每个目录看一遍。
 *
 * 这一步的产物就是拓展页那张列表:装了什么、能不能加载、不能的话为什么。三种「不能」都
 * 必须**列得出来**而不是消失(ADR-0012 决策 8):
 * 清单坏了、清单与目录对不上、为别的宿主版本写的。
 *
 * ⚠️ 拿不到清单时**身份取目录名** —— 失败记账要有个键,而最容易炸的恰恰是读清单这一步。
 *
 * 根有两个:仓里源码(**只在源码运行时**) > `<dataDir>/extensions/`,**先命中先用**。
 * ⛔ 没有「载荷自带」那一档 —— 本体一个拓展都不带,拓展只有下载与手放两条来路。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_API_VERSION } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	discoverExtensions,
	type ExtensionRoot,
	extensionRootsFor,
	readExtensionDir,
	type ShadowedExtension,
} from "../discover.js";

let root: string;

function dataRoot(dir: string = root): ExtensionRoot {
	return { kind: "data", dir };
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "bridge",
		name: "机器人框架桥接",
		description: "把 koishi / AstrBot 里已经配好的机器人借给 BN 用。",
		version: "1.0.0",
		apiVersion: EXTENSION_API_VERSION,
		provides: ["push"],
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

	it("为别的宿主版本写的 → incompatible,列得出来、带得上原因", async () => {
		const r = await readExtensionDir(
			await plant("future", manifest({ id: "future", apiVersion: EXTENSION_API_VERSION + 1 })),
		);
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.requires).toBe(EXTENSION_API_VERSION + 1);
		expect(r.host).toBe(EXTENSION_API_VERSION);
		// 名字还在 —— 面板要印得出「谁没加载」。
		expect(r.manifest.name).toBe("机器人框架桥接");
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
	 * 源码根那份的入口是 `src/index.ts` —— **宿主自己判,清单说了不算**(决策 35:
	 * 清单进签名摘要,加一格 `entry` 等于让分发出去的拓展指定加载哪个文件)。
	 */
	it("源码根:入口认 src/index.ts,不认平级的 index.mjs", async () => {
		const dir = await plant("dev-ext", manifest({ id: "dev-ext" }), { entry: "source" });
		const r = await readExtensionDir(dir, { kind: "source" });
		expect(r.state).toBe("ready");
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.entry).toBe(join(dir, "src", "index.ts"));
		expect(r.origin).toBe("source");

		// 反过来:只有 index.mjs 的目录在源码根里不算数 —— 那是构建产物的形状。
		const built = await plant("built", manifest({ id: "built" }));
		const b = await readExtensionDir(built, { kind: "source" });
		expect(b.state).toBe("unreadable");
		if (b.state !== "unreadable") throw new Error("unreachable");
		expect(b.detail).toContain("src/index.ts");
	});
});

describe("discoverExtensions", () => {
	it("扫一遍装载根,按 id 排好 —— 顺序稳定,面板列表才不会每次开机乱跳", async () => {
		await plant("zeta", manifest({ id: "zeta" }));
		await plant("bridge", manifest());
		await plant("broken", "{ not json");
		const found = await discoverExtensions([dataRoot()]);
		expect(found.map((e) => e.id)).toEqual(["bridge", "broken", "zeta"]);
	});

	it("没有清单的目录不进表 —— 它不是拓展,不该在面板上占一行", async () => {
		await plant("bridge", manifest());
		await plant("some-junk", null);
		const found = await discoverExtensions([dataRoot()]);
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
			const found = await discoverExtensions([dataRoot()]);
			expect(found.map((r) => [r.id, r.state])).toEqual([["bridge", "ready"]]);
		} finally {
			await rm(elsewhere, { recursive: true, force: true });
		}
	});

	it("目录压根不存在 → 空表,不是错误(头一次开机就是这样)", async () => {
		expect(await discoverExtensions([dataRoot(join(root, "nope"))])).toEqual([]);
	});

	it("散在里面的文件跳过,不当成拓展目录", async () => {
		await writeFile(join(root, "README.txt"), "hi");
		expect(await discoverExtensions([dataRoot()])).toEqual([]);
	});
});

describe("discoverExtensions · 多根", () => {
	/** 仓里那个源码根 —— 只有开发时才有它,入口是 `src/index.ts`。 */
	let sourceDir: string;

	beforeEach(async () => {
		sourceDir = await mkdtemp(join(tmpdir(), "bn-ext-source-"));
	});

	afterEach(async () => {
		await rm(sourceDir, { recursive: true, force: true });
	});

	function sourceRoot(): ExtensionRoot {
		return { kind: "source", dir: sourceDir };
	}

	it("几个根的拓展合成一张表,仍按 id 排", async () => {
		await plant("zeta", manifest({ id: "zeta" }));
		await plant("bridge", manifest(), { in: sourceDir, entry: "source" });
		const found = await discoverExtensions([sourceRoot(), dataRoot()]);
		expect(found.map((e) => [e.id, e.origin])).toEqual([
			["bridge", "source"],
			["zeta", "data"],
		]);
	});

	/**
	 * 🔴 **先命中先用,而且被盖住要说一声。**
	 *
	 * 悄悄盖掉正是「我明明改了怎么没生效」最难查的原因 —— 仓里改着一份桥,`<dataDir>` 里
	 * 还放着一份装过的,两份都在盘上、面板上只有一行,不出声的话根本无从判断跑的是哪个。
	 */
	it("同一个 id 在两个根里 → 高优先级那份赢,而且**叫一声**说清盖住了谁", async () => {
		const winner = await plant("bridge", manifest({ version: "2.0.0" }), {
			in: sourceDir,
			entry: "source",
		});
		const loser = await plant("bridge", manifest({ version: "1.0.0" }));

		const shadows: ShadowedExtension[] = [];
		const found = await discoverExtensions([sourceRoot(), dataRoot()], {
			onShadowed: (s) => shadows.push(s),
		});

		expect(found.map((e) => e.id)).toEqual(["bridge"]);
		const only = found[0];
		if (only?.state !== "ready") throw new Error("unreachable");
		expect(only.manifest.version).toBe("2.0.0");
		expect(only.dir).toBe(winner);

		expect(shadows).toEqual([
			{
				id: "bridge",
				winner: { kind: "source", dir: winner },
				shadowed: { kind: "data", dir: loser },
			},
		]);
	});

	it("低优先级那个目录没有清单 → 它本来就不是拓展,不叫", async () => {
		await plant("bridge", manifest(), { in: sourceDir, entry: "source" });
		await plant("bridge", null);
		const shadows: ShadowedExtension[] = [];
		await discoverExtensions([sourceRoot(), dataRoot()], {
			onShadowed: (s) => shadows.push(s),
		});
		expect(shadows).toEqual([]);
	});

	it("坏掉的那份照样赢 —— 先命中先用不因为它坏了就跳过(不然「怎么没生效」更难查)", async () => {
		await plant("bridge", "{ not json", { in: sourceDir, entry: "source" });
		await plant("bridge", manifest());
		const shadows: ShadowedExtension[] = [];
		const found = await discoverExtensions([sourceRoot(), dataRoot()], {
			onShadowed: (s) => shadows.push(s),
		});
		expect(found.map((e) => [e.id, e.state])).toEqual([["bridge", "unreadable"]]);
		expect(shadows).toHaveLength(1);
	});
});

describe("extensionRootsFor", () => {
	/**
	 * ⛔ **构建产物里只有一个根**:`<dataDir>/extensions/`。本体一个拓展都不带(主人
	 * 2026-09-09 拍板推翻 ADR-0012 决策 34 的「随载荷预装」)—— 与入口平级的
	 * `extensions/` 这条路**结构上不存在**,不是「有但空着」。
	 */
	it("构建产物:只有 `<dataDir>` 那一个根", () => {
		const roots = extensionRootsFor({
			dataDir: "/data",
			bundleUrl: pathToFileURL("/app/index.mjs").href,
		});
		expect(roots).toEqual([{ kind: "data", dir: join("/data", "extensions") }]);
	});

	/**
	 * 源码运行时**多一个仓里的根**并排在最前(决策 35)—— 那是我们自己开发拓展的路:
	 * 改一行 `tsx watch` 就重启,不必打包、也不必往 `<dataDir>` 里拷。
	 */
	it("源码运行:多出仓里 extensions/ 且排在最前", () => {
		const roots = extensionRootsFor({
			dataDir: "/data",
			bundleUrl: pathToFileURL("/repo/apps/server/src/index.ts").href,
		});
		expect(roots).toEqual([
			{ kind: "source", dir: join("/repo", "extensions") },
			{ kind: "data", dir: join("/data", "extensions") },
		]);
	});
});
