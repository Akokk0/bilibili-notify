/**
 * 皮肤库存储:`<dataDir>/skins/<id>/` 一皮肤一目录 + active.json 指针。
 * 契约:save/list/get/remove/setActive 全走盘,新实例 init() 后状态完整重建
 * (重启不丢);删除当前启用的皮肤时 active 归 null(逃生舱兜底)。
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkinManifest } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { MAX_SKIN_ASSETS, SkinStore } from "../store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeManifest(overrides?: Partial<SkinManifest>): SkinManifest {
	return {
		schemaVersion: 1,
		name: "樱花夜",
		author: "测试",
		modes: { light: { colors: { accent: "#fb7299" } } },
		...overrides,
	};
}

let dir: string;
let store: SkinStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-skins-"));
	store = new SkinStore({ skinsDir: dir });
	await store.init();
});

describe("SkinStore", () => {
	it("save → list 出现条目,manifest 与资产落盘", async () => {
		const { id } = await store.save({
			manifest: makeManifest({
				modes: { light: { wallpaper: { image: "assets/bg.png" } }, dark: {} },
			}),
			assets: new Map([["assets/bg.png", PNG]]),
		});
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id,
			name: "樱花夜",
			modes: ["light", "dark"],
			hasWallpaper: true,
		});
		const onDisk = JSON.parse(await readFile(join(dir, id, "skin.json"), "utf8"));
		expect(onDisk.name).toBe("樱花夜");
		expect((await stat(join(dir, id, "assets", "bg.png"))).size).toBe(PNG.byteLength);
	});

	it("get(id) 回读 manifest;get(不存在) → null", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		expect((await store.get(id))?.name).toBe("樱花夜");
		expect(await store.get("nope")).toBeNull();
	});

	it("setActiveSlot / getActive 双槽独立读写;槽皮肤没有该模式或 id 不存在 → 抛错", async () => {
		const { id: lightSkin } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const { id: darkSkin } = await store.save({
			manifest: makeManifest({ name: "夜装", modes: { dark: {} } }),
			assets: new Map(),
		});
		await store.setActiveSlot("light", lightSkin);
		await store.setActiveSlot("dark", darkSkin);
		expect(store.getActive()).toEqual({ light: lightSkin, dark: darkSkin });
		await store.setActiveSlot("dark", null);
		expect(store.getActive()).toEqual({ light: lightSkin, dark: null });
		// 纯亮皮肤不能进暗槽,反之亦然
		await expect(store.setActiveSlot("dark", lightSkin)).rejects.toThrow();
		await expect(store.setActiveSlot("light", darkSkin)).rejects.toThrow();
		await expect(store.setActiveSlot("light", "nope")).rejects.toThrow();
	});

	it("activate:按皮肤具备的模式落槽,不具备的槽保持原样;null 清空两槽", async () => {
		const { id: lightSkin } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const { id: darkSkin } = await store.save({
			manifest: makeManifest({ name: "夜装", modes: { dark: {} } }),
			assets: new Map(),
		});
		const { id: dual } = await store.save({
			manifest: makeManifest({ name: "双装", modes: { light: {}, dark: {} } }),
			assets: new Map(),
		});
		await store.activate(lightSkin);
		expect(store.getActive()).toEqual({ light: lightSkin, dark: null });
		// 启用纯暗皮肤,亮槽的青柠不被顶掉 —— 深浅色各自换装的核心语义
		await store.activate(darkSkin);
		expect(store.getActive()).toEqual({ light: lightSkin, dark: darkSkin });
		await store.activate(dual);
		expect(store.getActive()).toEqual({ light: dual, dark: dual });
		await store.activate(null);
		expect(store.getActive()).toEqual({ light: null, dark: null });
	});

	it("remove 删目录;占槽的被删 → 该槽归 null,另一槽保留", async () => {
		const { id: lightSkin } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const { id: darkSkin } = await store.save({
			manifest: makeManifest({ name: "夜装", modes: { dark: {} } }),
			assets: new Map(),
		});
		await store.activate(lightSkin);
		await store.activate(darkSkin);
		await store.remove(darkSkin);
		expect(await store.get(darkSkin)).toBeNull();
		expect(store.getActive()).toEqual({ light: lightSkin, dark: null });
	});

	it("重启(同目录新实例 init)→ 列表与双槽指针都还在", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([["assets/bg.png", PNG]]),
		});
		await store.setActiveSlot("light", id);

		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect((await reborn.list()).map((e) => e.id)).toEqual([id]);
		expect(reborn.getActive()).toEqual({ light: id, dark: null });
	});

	it("旧单指针 active.json({id}) → init 迁移:按皮肤具备的模式落槽", async () => {
		const { id: dual } = await store.save({
			manifest: makeManifest({ name: "双装", modes: { light: {}, dark: {} } }),
			assets: new Map(),
		});
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, "active.json"), JSON.stringify({ id: dual }));

		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect(reborn.getActive()).toEqual({ light: dual, dark: dual });
	});

	it("assetPath:合法资产名 → 绝对路径;白名单外 / 不存在 → null", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([["assets/bg.png", PNG]]),
		});
		expect(await store.assetPath(id, "assets/bg.png")).toContain(join(id, "assets", "bg.png"));
		expect(await store.assetPath(id, "assets/../skin.json")).toBeNull();
		expect(await store.assetPath(id, "assets/none.png")).toBeNull();
	});

	it("listAssets:按 assets/<名> 形式列出包内资产;无资产 / 不存在的 id → 空数组", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([
				["assets/bg.png", PNG],
				["assets/deco.webp", PNG],
			]),
		});
		expect((await store.listAssets(id)).sort()).toEqual(["assets/bg.png", "assets/deco.webp"]);

		const { id: bare } = await store.save({ manifest: makeManifest(), assets: new Map() });
		expect(await store.listAssets(bare)).toEqual([]);
		expect(await store.listAssets("nope")).toEqual([]);
	});

	it("updateManifest:落盘 + 索引即时可见,重启不丢;不存在的 id → 抛错", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([["assets/bg.png", PNG]]),
		});
		const next = makeManifest({
			name: "樱花夜·改",
			modes: { light: { colors: { accent: "#00aeec" } }, dark: {} },
		});
		await store.updateManifest(id, next);

		expect((await store.get(id))?.name).toBe("樱花夜·改");
		expect((await store.list())[0]).toMatchObject({
			id,
			name: "樱花夜·改",
			modes: ["light", "dark"],
		});

		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect((await reborn.get(id))?.name).toBe("樱花夜·改");
		// 资产原封不动
		expect(await reborn.assetPath(id, "assets/bg.png")).not.toBeNull();

		await expect(store.updateManifest("nope", next)).rejects.toThrow();
	});
});

describe("往已有皮肤里加图(addAsset)", () => {
	/**
	 * 编辑器里那个「传图」入口的落点。皮肤包做出来之后想换张壁纸,原先只能
	 * 导出 zip、塞图、改 JSON、再传回来 —— 而聊天里做的皮肤天生一张图都没有。
	 */
	it("加进去 → 出现在资产清单里,字节原样落盘", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const name = await store.addAsset(id, PNG, "png");

		expect(name).toMatch(/^assets\/[A-Za-z0-9._-]+\.png$/);
		expect(await store.listAssets(id)).toEqual([name]);
		const onDisk = await readFile(join(dir, id, name));
		expect(new Uint8Array(onDisk)).toEqual(PNG);
	});

	it("名字自己生成 —— 不拿上传的文件名拼路径", async () => {
		// 文件名是不可信输入(中文、空格、`../` 都可能),而这里要拼进磁盘路径。
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const a = await store.addAsset(id, PNG, "png");
		const b = await store.addAsset(id, PNG, "png");

		expect(a).not.toBe(b);
		expect((await store.listAssets(id)).sort()).toEqual([a, b].sort());
	});

	it("不认识的扩展名 → 抛错(SVG 能带脚本,永远不收)", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		await expect(store.addAsset(id, PNG, "svg")).rejects.toThrow();
	});

	it("皮肤不存在 → 抛错,不在库里凭空造目录", async () => {
		await expect(store.addAsset("nope", PNG, "png")).rejects.toThrow();
	});

	it("一套皮肤塞不下无限张图 —— 到上限就拒", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		for (let i = 0; i < MAX_SKIN_ASSETS; i++) await store.addAsset(id, PNG, "png");

		await expect(store.addAsset(id, PNG, "png")).rejects.toThrow(/最多|上限/);
	});
});

describe("出厂快照(default.json)", () => {
	it("上传即有快照 = 上传时的 manifest;编辑保存不动快照", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		expect((await store.getDefault(id))?.name).toBe("樱花夜");

		await store.updateManifest(id, makeManifest({ name: "樱花夜·改" }));
		// manifest 变了,快照还是出厂值
		expect((await store.get(id))?.name).toBe("樱花夜·改");
		expect((await store.getDefault(id))?.name).toBe("樱花夜");
	});

	it("setDefault:用当前 manifest 覆盖快照,重启后仍在", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		await store.updateManifest(id, makeManifest({ name: "樱花夜·改" }));
		await store.setDefault(id);
		expect((await store.getDefault(id))?.name).toBe("樱花夜·改");

		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect((await reborn.getDefault(id))?.name).toBe("樱花夜·改");
	});

	it("存量皮肤(目录里没有 default.json)→ getDefault null;setDefault 可补钉", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const { rm } = await import("node:fs/promises");
		await rm(join(dir, id, "default.json"));
		expect(await store.getDefault(id)).toBeNull();
		await store.setDefault(id);
		expect((await store.getDefault(id))?.name).toBe("樱花夜");
	});

	it("setDefault(不存在) 抛错;getDefault(不存在) → null", async () => {
		await expect(store.setDefault("nope")).rejects.toThrow();
		expect(await store.getDefault("nope")).toBeNull();
	});
});

describe("remove 的 id 不可信", () => {
	/**
	 * 路由把 `:id` 原样交进来,而 `%2e%2e%2f` 这种写法 URL 解析器不会折叠、Hono 的
	 * param 却会解码 —— `join(skinsDir, "../..")` 直接跑出皮肤目录。remove() 是
	 * 全店**唯一**没有 `index.has(id)` 守卫的方法,而它干的是 `rm -rf`。
	 *
	 * 实测(2026-08-19 审计):`DELETE /%2e%2e%2fconversations` 回 200,
	 * `<dataDir>/conversations` 整个没了 —— 全部聊天记录。
	 */
	it("不认识的 id 一律不动手,哪怕它指得出一个真目录", async () => {
		const outsider = join(dir, "..", "conversations");
		await mkdir(outsider, { recursive: true });
		await writeFile(join(outsider, "a.json"), "{}");

		await store.remove("../conversations");

		expect(existsSync(outsider)).toBe(true);
	});

	it("真皮肤照删不误", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		await store.remove(id);
		expect(await store.get(id)).toBeNull();
	});
});

describe("ensureReady:一份两处用,谁先来谁补上", () => {
	/**
	 * 这家店 `/api/skins` 与聊天里的 create_skin 共用一个实例,而读盘重建索引原先
	 * 只挂在前者的中间件上。主人一进 dashboard 就直奔聊天做皮肤时,店里的 active
	 * 还是构造函数那份空的 —— activate() 一落盘就把重启前启用着的槽清掉了。
	 * 索引下次 init 能自愈,active.json 不能。
	 */
	it("没人显式 init 过 → 自己补,重启前的启用槽保得住", async () => {
		const { id } = await store.save({
			manifest: makeManifest({ modes: { light: {}, dark: {} } }),
			assets: new Map(),
		});
		await store.setActiveSlot("dark", id);

		// 换一个实例 = 重启后的进程,这次没人调 init。
		const restarted = new SkinStore({ skinsDir: dir });
		await restarted.ensureReady();
		expect(restarted.getActive().dark).toBe(id);
	});

	it("幂等 —— 两处都调也只读一次盘", async () => {
		const fresh = new SkinStore({ skinsDir: dir });
		await Promise.all([fresh.ensureReady(), fresh.ensureReady()]);
		expect(fresh.getActive()).toEqual({ light: null, dark: null });
	});
});
