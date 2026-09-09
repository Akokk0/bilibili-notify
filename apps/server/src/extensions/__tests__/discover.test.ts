/**
 * 开机扫拓展根 —— **在 import 任何一行拓展代码之前**把每个目录看一遍。
 *
 * 这一步的产物就是拓展页那张列表:装了什么、能不能加载、不能的话为什么。三种「不能」都
 * 必须**列得出来**而不是消失(ADR-0012 决策 8):
 * 清单坏了、清单与目录对不上、为别的宿主版本写的。
 *
 * ⚠️ 拿不到清单时**身份取目录名** —— 失败记账要有个键,而最容易炸的恰恰是读清单这一步。
 *
 * 根有三个(决策 34):仓里源码 > `<dataDir>/extensions/` > 载荷自带,**先命中先用**。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

	it("目录压根不存在 → 空表,不是错误(头一次开机就是这样)", async () => {
		expect(await discoverExtensions([dataRoot(join(root, "nope"))])).toEqual([]);
	});

	it("散在里面的文件跳过,不当成拓展目录", async () => {
		await writeFile(join(root, "README.txt"), "hi");
		expect(await discoverExtensions([dataRoot()])).toEqual([]);
	});
});

describe("discoverExtensions · 多根", () => {
	let payload: string;

	beforeEach(async () => {
		payload = await mkdtemp(join(tmpdir(), "bn-ext-payload-"));
	});

	afterEach(async () => {
		await rm(payload, { recursive: true, force: true });
	});

	it("几个根的拓展合成一张表,仍按 id 排", async () => {
		await plant("zeta", manifest({ id: "zeta" }));
		await plant("bridge", manifest(), { in: payload });
		const found = await discoverExtensions([dataRoot(), { kind: "payload", dir: payload }]);
		expect(found.map((e) => [e.id, e.origin])).toEqual([
			["bridge", "payload"],
			["zeta", "data"],
		]);
	});

	/**
	 * 🔴 **先命中先用,而且被盖住要说一声。**
	 *
	 * 悄悄盖掉正是「我明明改了怎么没生效」最难查的原因 —— 载荷自带一份桥、主人自己又
	 * 装了一份,两份都在盘上、面板上只有一行,不出声的话根本无从判断跑的是哪个。
	 */
	it("同一个 id 在两个根里 → 高优先级那份赢,而且**叫一声**说清盖住了谁", async () => {
		const winner = await plant("bridge", manifest({ version: "2.0.0" }));
		const loser = await plant("bridge", manifest({ version: "1.0.0" }), { in: payload });

		const shadows: ShadowedExtension[] = [];
		const found = await discoverExtensions([dataRoot(), { kind: "payload", dir: payload }], {
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
				winner: { kind: "data", dir: winner },
				shadowed: { kind: "payload", dir: loser },
			},
		]);
	});

	it("低优先级那个目录没有清单 → 它本来就不是拓展,不叫", async () => {
		await plant("bridge", manifest());
		await plant("bridge", null, { in: payload });
		const shadows: ShadowedExtension[] = [];
		await discoverExtensions([dataRoot(), { kind: "payload", dir: payload }], {
			onShadowed: (s) => shadows.push(s),
		});
		expect(shadows).toEqual([]);
	});

	it("坏掉的那份照样赢 —— 先命中先用不因为它坏了就跳过(不然「怎么没生效」更难查)", async () => {
		await plant("bridge", "{ not json");
		await plant("bridge", manifest(), { in: payload });
		const shadows: ShadowedExtension[] = [];
		const found = await discoverExtensions([dataRoot(), { kind: "payload", dir: payload }], {
			onShadowed: (s) => shadows.push(s),
		});
		expect(found.map((e) => [e.id, e.state])).toEqual([["bridge", "unreadable"]]);
		expect(shadows).toHaveLength(1);
	});
});

describe("extensionRootsFor", () => {
	/**
	 * 「属于载荷的东西相对入口解析,属于用户的东西用固定绝对路径」—— 与 web-dist 同一条
	 * 规矩(见 `config/web-dist.ts`)。
	 */
	it("构建产物:`<dataDir>` 那份盖过载荷自带的,没有源码根", () => {
		const roots = extensionRootsFor({
			dataDir: "/data",
			bundleUrl: pathToFileURL("/app/index.mjs").href,
		});
		expect(roots).toEqual([
			{ kind: "data", dir: join("/data", "extensions") },
			{ kind: "payload", dir: join("/app", "extensions") },
		]);
	});

	/**
	 * 源码运行时**多一个仓里的根**,而且**没有载荷根** —— 那时 `dirname(入口)/extensions`
	 * 指的是宿主自己那个 `apps/server/src/extensions/`(装载器的代码),扫它毫无意义。
	 */
	it("源码运行:多出仓里 extensions/ 且排在最前,载荷根整个不存在", () => {
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
