/**
 * 皮肤库存储:`<dataDir>/skins/<id>/` 一皮肤一目录 + active.json 指针。
 * 契约:save/list/get/remove/setActive 全走盘,新实例 init() 后状态完整重建
 * (重启不丢);删除当前启用的皮肤时 active 归 null(逃生舱兜底)。
 */

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkinManifest } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { SkinStore } from "../store.js";

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
