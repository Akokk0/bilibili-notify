import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
/**
 * 开机扫拓展根 —— **在 import 任何一行拓展代码之前**把每个目录看一遍。
 *
 * 这一步的产物就是拓展页那张列表:装了什么、能不能加载、不能的话为什么。三种「不能」都
 * 必须**列得出来**而不是消失(ADR-0012 决策 8):
 * 清单坏了、清单与目录对不上、为别的宿主版本写的。
 *
 * ⚠️ 拿不到清单时**身份取目录名** —— 失败记账要有个键,而最容易炸的恰恰是读清单这一步。
 *
 * ⛔ **只有一个根**:`<数据根>/extensions/`。本体一个拓展都不带;仓里那个源码根也去掉了
 * (2026-09-10)—— 开发版改由 devtools 把仓里的 `dist` **装**进这个根(软链)。
 * 于是没有优先级、没有「同一个 id 有两份」,入口也只剩 `index.mjs` 一种。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_RANGE } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { apiVersionMismatch, discoverExtensions, readExtensionDir } from "../discover.js";

let root: string;

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "bridge",
		name: "机器人框架桥接",
		description: "把 koishi / AstrBot 里已经配好的机器人借给 BN 用。",
		version: "1.0.0",
		apiVersion: EXTENSION_API_RANGE.current,
		contributes: { push: { label: "测试", shortLabel: "测", color: "#000000" } },
		...over,
	};
}

/** 一份订阅源清单(ADR-0019 决策 16):静态声明全住清单。 */
function manifestSubscription(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "douyin",
		name: "抖音订阅",
		description: "盯着抖音作者的新作品与开播。",
		version: "0.1.0",
		apiVersion: EXTENSION_API_RANGE.current,
		contributes: {
			subscription: {
				label: "抖音",
				shortLabel: "抖",
				color: "#fe2c55",
				supportedFeatures: ["post"],
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
	i18n.set({ locale: "zh-CN", voice: "maid" });
	root = await mkdtemp(join(tmpdir(), "bn-ext-discover-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("readExtensionDir", () => {
	it.each([
		[
			"en",
			"extension.json is not valid JSON:",
			"extension.json is invalid —",
			"Manifest ID original-id does not match directory name original-dir.",
			"Entry file index.mjs is missing.",
		],
		[
			"ja",
			"extension.jsonは有効なJSONではありません：",
			"extension.jsonが無効です：",
			"マニフェストのidはoriginal-idですが、ディレクトリー名original-dirと一致しません。",
			"エントリーファイルindex.mjsがありません。",
		],
		[
			"zh-TW",
			"extension.json 不是有效的 JSON：",
			"extension.json 無效：",
			"資訊清單的 id 為 original-id，與目錄名稱 original-dir 不符。",
			"缺少進入點檔案 index.mjs。",
		],
	] as const)(
		"%s translates directory-read failures while retaining filenames, IDs and parser diagnostics",
		async (locale, jsonPrefix, schemaPrefix, mismatch, missing) => {
			const brokenJson = await plant("broken-json", "{");
			const brokenSchema = await plant("broken-schema", manifest({ id: "broken-schema", name: 0 }));
			const mismatched = await plant("original-dir", manifest({ id: "original-id" }));
			const noEntry = await plant("no-entry", manifest({ id: "no-entry" }), { entry: false });
			i18n.set({ locale, voice: "plain" });
			const options = { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS };
			const badJson = await readExtensionDir(brokenJson, options);
			expect(badJson).toMatchObject({
				state: "unreadable",
				id: "broken-json",
				detail: expect.stringContaining(jsonPrefix),
			});
			let parserMessage = "";
			try {
				JSON.parse("{");
			} catch (err) {
				parserMessage = (err as Error).message;
			}
			if (badJson.state === "unreadable") expect(badJson.detail).toContain(parserMessage);
			const badSchema = await readExtensionDir(brokenSchema, options);
			expect(badSchema).toMatchObject({
				state: "unreadable",
				id: "broken-schema",
				detail: expect.stringContaining(schemaPrefix),
			});
			if (badSchema.state === "unreadable") expect(badSchema.detail).toContain("name");
			expect(await readExtensionDir(mismatched, options)).toMatchObject({
				state: "unreadable",
				id: "original-dir",
				detail: mismatch,
			});
			expect(await readExtensionDir(noEntry, options)).toMatchObject({
				state: "unreadable",
				id: "no-entry",
				detail: missing,
			});
		},
	);

	it("清单齐、入口在 → ready,拿到清单本身与入口文件", async () => {
		const dir = await plant("bridge", manifest());
		const r = await readExtensionDir(dir, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS });
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
		const r = await readExtensionDir(await plant("bridge", manifest({ icon })), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.icon).toBe(icon);
	});

	it("清单里的图标过白名单:夹带脚本的整枚丢掉,但拓展本身照常加载", async () => {
		const r = await readExtensionDir(
			await plant(
				"bridge",
				manifest({ icon: '<svg viewBox="0 0 24 24"><script>x()</script></svg>' }),
			),
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
		);
		// 图标坏了不是拒绝加载的理由 —— 它退回灰方章,拓展该跑还是跑。
		expect(r.state).toBe("ready");
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.icon).toBeUndefined();
	});

	it("清单与目录名对不上 → 拒,而且说得出两边分别是什么", async () => {
		const r = await readExtensionDir(await plant("bridge", manifest({ id: "not-bridge" })), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		// 身份取目录名 —— 挂载点与装载目录都按它算,清单说了不算。
		expect(r.id).toBe("bridge");
		expect(r.detail).toContain("not-bridge");
	});

	it("当前档的清单 → ready", async () => {
		const r = await readExtensionDir(await plant("douyin", manifestSubscription()), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("ready");
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.apiVersion).toBe(EXTENSION_API_RANGE.current);
	});

	it("为更新的宿主写的 → incompatible,列得出来、带得上原因", async () => {
		const requires = EXTENSION_API_RANGE.current + 1;
		const r = await readExtensionDir(
			await plant("future", manifest({ id: "future", apiVersion: requires })),
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
		);
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.requires).toEqual({ apiVersion: requires });
		expect(r.range).toEqual(EXTENSION_API_RANGE);
		// 名字还在 —— 面板要印得出「谁没加载」。
		expect(r.identity.name).toBe("机器人框架桥接");
	});

	/** 档位对、要的契约小号比这台 BN 的高(ADR-0019 决策 59)—— 与档位不合同一条路。 */
	it("要更高契约小号的清单 → incompatible,记下要几号", async () => {
		const apiRevision = EXTENSION_API_RANGE.revision + 1;
		const r = await readExtensionDir(await plant("douyin", manifestSubscription({ apiRevision })), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.requires).toEqual({ apiVersion: EXTENSION_API_RANGE.current, apiRevision });
		expect(r.range).toEqual(EXTENSION_API_RANGE);
		expect(r.identity.name).toBe("抖音订阅");
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
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
		);
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.identity.version).toBe("3.0.0");
	});

	it.each([2, 3])("旧契约大档%s → incompatible,不靠数字大小推断年代", async (oldContract) => {
		const r = await readExtensionDir(await plant("bridge", manifest({ apiVersion: oldContract })), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("incompatible");
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.requires).toEqual({ apiVersion: oldContract });
		expect(apiVersionMismatch(r.requires, r.range)).not.toContain("升级 BN");
	});

	it("历史v1同号旧provides格式 → unreadable,不恢复旧格式", async () => {
		const r = await readExtensionDir(
			await plant("bridge", {
				id: "bridge",
				name: "old bridge",
				version: "0.0.1",
				apiVersion: 1,
				provides: ["push"],
			}),
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
		);
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		expect(r.detail).toContain("contributes");
	});

	it("版本不合、清单 id 又与目录名对不上 → unreadable(两个身份比版本更要紧)", async () => {
		const r = await readExtensionDir(
			await plant("future", manifest({ id: "other", apiVersion: EXTENSION_API_RANGE.current + 1 })),
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
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
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
		);
		if (r.state !== "incompatible") throw new Error("unreachable");
		expect(r.identity.icon).toBeUndefined();
	});

	/**
	 * 选项图标是图片 data URL,面板当 `<img>` 画(ADR-0019 决策 31)—— 它不进 SVG 白名单,
	 * 原样留着;塞一段 SVG 标记进来的清单在格式那一步就读不了。
	 */
	it("设置项的选项图标:图片 data URL 原样留着;SVG 标记 —— 清单读不了", async () => {
		const png =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
		const withIcon = (icon: string) =>
			manifestSubscription({
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
		const r = await readExtensionDir(await plant("douyin", withIcon(png)), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		if (r.state !== "ready") throw new Error("unreachable");
		expect(r.manifest.settings?.fields[0]).toMatchObject({ options: [{ icon: png }] });

		const bad = await readExtensionDir(
			await plant("douyin", withIcon('<svg viewBox="0 0 24 24"><script>x()</script></svg>')),
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
		);
		expect(bad.state).toBe("unreadable");
	});

	it("清单不是合法 JSON → unreadable,身份退回目录名", async () => {
		const r = await readExtensionDir(await plant("broken", "{ not json"), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("unreadable");
		expect(r.id).toBe("broken");
	});

	it("清单缺字段 → unreadable,detail 指得出是哪一格", async () => {
		const r = await readExtensionDir(await plant("half", manifest({ id: "half", version: "v1" })), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("unreadable");
		if (r.state !== "unreadable") throw new Error("unreachable");
		expect(r.detail).toContain("version");
	});

	it("没有 extension.json → 根本不是拓展目录,回 absent(不记账、不报错)", async () => {
		const r = await readExtensionDir(await plant("junk", null), {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(r.state).toBe("absent");
	});

	it("有清单但没有 index.mjs → unreadable —— 别等到启用那一刻才发现没东西可加载", async () => {
		const r = await readExtensionDir(
			await plant("hollow", manifest({ id: "hollow" }), { entry: false }),
			{ reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS },
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
		const r = await readExtensionDir(dir, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS });
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
		const found = await discoverExtensions(root, {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(found.map((e) => e.id)).toEqual(["bridge", "broken", "zeta"]);
	});

	it("没有清单的目录不进表 —— 它不是拓展,不该在面板上占一行", async () => {
		await plant("bridge", manifest());
		await plant("some-junk", null);
		const found = await discoverExtensions(root, {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(found.map((e) => e.id)).toEqual(["bridge"]);
	});

	/**
	 * 🔴 **软链要当目录看。** `readdir(withFileTypes)` 走的是 lstat 语义:一条指向目录的
	 * 软链 `isDirectory()` 是 **false**、`isSymbolicLink()` 才是 true —— 只认前者的话,
	 * 装进来的拓展在这一页上**根本不出现,而且不报错**。
	 *
	 * 开发版正是这么装的:devtools 把仓里那份 `dist` 软链进 `<数据根>/extensions/<id>`。
	 */
	it("软链进来的拓展照样扫得到 —— readdir 里它不是目录", async () => {
		const elsewhere = await mkdtemp(join(tmpdir(), "bn-ext-real-"));
		try {
			await plant("bridge", manifest(), { in: elsewhere });
			await symlink(join(elsewhere, "bridge"), join(root, "bridge"), "dir");
			const found = await discoverExtensions(root, {
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			});
			expect(found.map((r) => [r.id, r.state])).toEqual([["bridge", "ready"]]);
			// 🔴 **落点也要报出来**:装载目录里写着 `<数据根>/extensions/bridge`,而跑的
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
		const found = await discoverExtensions(root, {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		});
		expect(found.map((e) => e.id)).toEqual(["bridge"]);
	});

	it("目录压根不存在 → 空表,不是错误(头一次开机就是这样)", async () => {
		expect(
			await discoverExtensions(join(root, "nope"), {
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			}),
		).toEqual([]);
	});

	it("散在里面的文件跳过,不当成拓展目录", async () => {
		await writeFile(join(root, "README.txt"), "hi");
		expect(
			await discoverExtensions(root, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS }),
		).toEqual([]);
	});
});

describe("读目录时读译文(ADR-0037 决策 14)", () => {
	it("ready 的记录带上 locales/ 里读好的译文与问题", async () => {
		const dir = await plant("bridge", manifest());
		await mkdir(join(dir, "locales"));
		await writeFile(
			join(dir, "locales", "en.json"),
			JSON.stringify({ "a.b": "ok", "bad key": "x" }),
		);
		await writeFile(join(dir, "locales", "zh-CN.json"), "{ 坏的");

		const read = await readExtensionDir(dir, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS });
		if (read.state !== "ready") throw new Error("unreachable");
		expect(read.locales.files.en?.dict).toEqual({ "a.b": "ok" });
		expect(read.locales.files["zh-CN"]).toBeUndefined();
		expect(read.locales.issues).toEqual([
			{ locale: "zh-CN", code: "invalid-json", path: [] },
			{ locale: "en", code: "invalid-key", path: ["bad key"] },
		]);
	});

	it("没有 locales/ → 空译文", async () => {
		const dir = await plant("bridge", manifest());
		const read = await readExtensionDir(dir, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS });
		if (read.state !== "ready") throw new Error("unreachable");
		expect(read.locales).toEqual({ files: {}, issues: [] });
	});
});

it("新旧大档不匹配只说换适配包,同档小号不足才说升级,口吻现取", () => {
	try {
		i18n.set({ locale: "zh-CN", voice: "plain" });
		const plain = apiVersionMismatch({ apiVersion: 3 }, { min: 1, current: 1, revision: 0 });
		expect(plain).not.toContain("升级 BN");
		expect(plain).toContain("v3");
		expect(plain).toContain("v1");
		expect(plain).not.toContain("主人");
		i18n.set({ locale: "zh-CN", voice: "maid" });
		expect(apiVersionMismatch({ apiVersion: 3 }, { min: 1, current: 1, revision: 0 })).toContain(
			"主人",
		);
		expect(
			apiVersionMismatch({ apiVersion: 1, apiRevision: 1 }, { min: 1, current: 1, revision: 0 }),
		).toContain("升级 BN");
	} finally {
		i18n.set({ locale: "zh-CN", voice: "maid" });
	}
});

it.each(["bilibili", "onebot", "qq-official", "webhook"])(
	"内置键 %s 在兼容与不兼容清单中均不可加载",
	async (id) => {
		const dir = await plant(id, manifest({ id }));
		expect(
			await readExtensionDir(dir, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS }),
		).toMatchObject({ state: "unreadable", id });
		await plant(id, manifest({ id, apiVersion: 999 }));
		expect(
			await readExtensionDir(dir, { reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS }),
		).toMatchObject({ state: "unreadable", id });
	},
);
