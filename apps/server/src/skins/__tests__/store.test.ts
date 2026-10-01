/**
 * 皮肤库存储:`<数据根>/skins/dashboard/<id>/` 一皮肤一目录 + active.json 指针。
 * 契约:save/list/get/remove/setActive 全走盘,新实例 init() 后状态完整重建
 * (重启不丢);删除当前启用的皮肤时 active 归 null(逃生舱兜底)。
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkinManifest } from "@bilibili-notify/contract";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { MAX_SKIN_ASSETS, SkinStore, SkinStoreError } from "../store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** woff2 魔数 `wOF2`;store 不解析内容,只看扩展名。 */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

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
	it("skin.json 缺 modes(旧格式/手改)→ init 不抛不丢,皮肤仍进索引", async () => {
		// 迁移清洁工若对缺 modes 的 manifest 直接解引用会抛 TypeError,被 init 的
		// catch 当「写入中断的残缺目录」—— 整套皮肤从索引里无声消失(改动前这种
		// 文件是能进索引的);default.json 同理令「恢复默认值」静默失效。
		await mkdir(join(dir, "legacy"), { recursive: true });
		await writeFile(
			join(dir, "legacy", "skin.json"),
			JSON.stringify({ schemaVersion: 1, name: "老皮肤" }),
		);
		const fresh = new SkinStore({ skinsDir: dir });
		await fresh.init();

		expect(await fresh.get("legacy")).not.toBeNull();
	});

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

	it("皮肤库不认旧单指针 active.json({id}) —— 那是迁移器的活,这里两个槽都是空的", async () => {
		// 0.x 的单指针由 `migration/skins.ts` 在搬家时改成深浅两个槽;皮肤库读盘不再翻译它。哪天有人把读时翻译
		// 加回来,迁移器就成了摆设,而「读时翻、不回写」的老毛病(盘上永远是旧形状)也跟着回来。
		const { id: dual } = await store.save({
			manifest: makeManifest({ name: "双装", modes: { light: {}, dark: {} } }),
			assets: new Map(),
		});
		await writeFile(join(dir, "active.json"), JSON.stringify({ id: dual }));

		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect(reborn.getActive()).toEqual({ light: null, dark: null });
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

	it("包里带的字体:save 要落盘、listAssets 要列、assetPath 要给得出路径", async () => {
		// 三道白名单闸各写各的话,漏掉哪一道都是「装上去没报错、字就是不生效」——
		// 而且导出 zip 也会静静把它丢掉,主人拿到的包比传进去的少一个文件。
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([
				["assets/bg.png", PNG],
				["assets/font-a1b2c3d4.woff2", WOFF2],
			]),
		});
		expect((await store.listAssets(id)).sort()).toEqual([
			"assets/bg.png",
			"assets/font-a1b2c3d4.woff2",
		]);
		expect(await store.assetPath(id, "assets/font-a1b2c3d4.woff2")).toContain(
			join(id, "assets", "font-a1b2c3d4.woff2"),
		);
		expect(await store.assetPath(id, "assets/font-../../skin.json")).toBeNull();
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

describe("资产原名清单(assetNames)", () => {
	/**
	 * 盘上的名字是随机生成的,主人在下拉里只看得到一串 hex。原名另存一份清单,
	 * 而**目录才是真相** —— 与卡片字体图廊同一条纪律。
	 */
	it("传的时候带上原名 → assetNames 里查得到", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const name = await store.addAsset(id, WOFF2, "woff2", "霞鹜文楷 Light.woff2");
		expect(await store.assetNames(id)).toEqual({ [name]: "霞鹜文楷 Light.woff2" });
	});

	it("不带原名 → 清单里就没这条(前端回落成生成名)", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		await store.addAsset(id, PNG, "png");
		expect(await store.assetNames(id)).toEqual({});
	});

	it("两次上传各记各的,不会互相顶掉", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const a = await store.addAsset(id, PNG, "png", "樱花.png");
		const b = await store.addAsset(id, WOFF2, "woff2", "文楷.woff2");
		expect(await store.assetNames(id)).toEqual({ [a]: "樱花.png", [b]: "文楷.woff2" });
	});

	it("包里带的清单随 save 落盘", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([["assets/bg.png", PNG]]),
			names: { "assets/bg.png": "主人的壁纸.png" },
		});
		expect(await store.assetNames(id)).toEqual({ "assets/bg.png": "主人的壁纸.png" });
	});

	it("清单里记着盘上没有的文件 → 不列出来(目录才是真相)", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([["assets/bg.png", PNG]]),
			names: { "assets/bg.png": "在.png", "assets/gone.png": "不在.png" },
		});
		expect(await store.assetNames(id)).toEqual({ "assets/bg.png": "在.png" });
	});

	it("清单文件损坏 / 不存在 → 空表,资产照列(名字丢了不该让图廊瘫掉)", async () => {
		const { id } = await store.save({
			manifest: makeManifest(),
			assets: new Map([["assets/bg.png", PNG]]),
		});
		await writeFile(join(dir, id, "assets", "index.json"), "{坏掉的 JSON");
		expect(await store.assetNames(id)).toEqual({});
		expect(await store.listAssets(id)).toEqual(["assets/bg.png"]);
	});

	it("清单文件自己不算一份资产 —— .json 不在白名单上,列不出也 serve 不了", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		await store.addAsset(id, PNG, "png", "樱花.png");
		expect(await store.listAssets(id)).toHaveLength(1);
		expect(await store.assetPath(id, "assets/index.json")).toBeNull();
	});

	it("皮肤不存在 → 空表", async () => {
		expect(await store.assetNames("nope")).toEqual({});
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

	it("字体文件同样收 —— 名字带 font- 前缀,和图分得开", async () => {
		// 前缀不是装饰:editor 的「壁纸图片」下拉与「自带字体」下拉读的是同一份
		// 清单,靠后缀分流;前缀只是让盘上一眼看得出哪份是哪份。
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const name = await store.addAsset(id, WOFF2, "woff2");

		expect(name).toMatch(/^assets\/font-[A-Za-z0-9]+\.woff2$/);
		expect(await store.listAssets(id)).toEqual([name]);
		const onDisk = await readFile(join(dir, id, name));
		expect(new Uint8Array(onDisk)).toEqual(WOFF2);
	});

	it("字体走 20MB 那条线,图片仍旧 5MB", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const sixMB = new Uint8Array(6 * 1024 * 1024);
		await expect(store.addAsset(id, sixMB, "woff2")).resolves.toMatch(/\.woff2$/);
		await expect(store.addAsset(id, sixMB, "png")).rejects.toThrow();
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

describe("init 跳过落盘底层留下的残骸", () => {
	it("暂存目录与整目录替换换下来的旧目录(bn-tmp / bn-old)不进索引,哪怕里面是一份合格的清单", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const good = await readFile(join(dir, id, "skin.json"), "utf8");
		for (const name of [`${id}.bn-tmp.123.abcdef`, `${id}.bn-old.123.abcdef`]) {
			await mkdir(join(dir, name), { recursive: true });
			await writeFile(join(dir, name, "skin.json"), good);
		}

		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();

		expect((await reborn.list()).map((e) => e.id)).toEqual([id]);
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

describe("removeMode —— 只删一色", () => {
	/** 建一套深浅都有的皮肤,返回 id。 */
	async function makeDual(): Promise<string> {
		const { id } = await store.save({
			manifest: makeManifest({
				modes: {
					light: { colors: { accent: "#fb7299" } },
					dark: { colors: { accent: "#00e5ff" } },
				},
			}),
			assets: new Map(),
		});
		return id;
	}

	it("删掉那一色,另一色一字不动", async () => {
		const id = await makeDual();
		await store.removeMode(id, "light");
		const m = await store.get(id);
		expect(m?.modes.light).toBeUndefined();
		expect(m?.modes.dark).toEqual({ colors: { accent: "#00e5ff" } });
	});

	it("落的是盘,重开一家店照样只剩一色", async () => {
		const id = await makeDual();
		await store.removeMode(id, "dark");
		const reopened = new SkinStore({ skinsDir: dir });
		await reopened.init();
		expect((await reopened.get(id))?.modes.dark).toBeUndefined();
		expect((await reopened.get(id))?.modes.light).toBeDefined();
	});

	it("出厂快照里也一并删 —— 否则「恢复默认值」会把它悄悄带回来", async () => {
		// 主人明明删了浅色,一点「恢复默认值」它又回来了 —— 这件事界面上没地方
		// 交代,看起来就是个 bug。主人 2026-08-20 拍板:删了就是删了。
		const id = await makeDual();
		await store.setDefault(id);
		await store.removeMode(id, "light");
		const snap = await store.getDefault(id);
		expect(snap?.modes.light).toBeUndefined();
		expect(snap?.modes.dark).toBeDefined();
	});

	it("盘上没有快照(存量目录)→ 照删不误,不因为缺一份快照就失败", async () => {
		// `save()` 本来就会写 default.json,所以这个场景只出现在旧版留下的目录上。
		const id = await makeDual();
		await rm(join(dir, id, "default.json"));
		await store.removeMode(id, "light");
		expect((await store.get(id))?.modes.light).toBeUndefined();
		expect(await store.getDefault(id)).toBeNull();
	});

	it("那一色正被启用 → 顺手把那个槽卸下来", async () => {
		// 不卸的话,active.light 指着一套没有 light 的皮肤 —— setActiveSlot 明明
		// 拦着这种状态(「纯暗皮肤进不了亮槽」),从这条路却能绕出来。
		const id = await makeDual();
		await store.activate(id);
		expect(await store.getActive()).toEqual({ light: id, dark: id });
		await store.removeMode(id, "light");
		expect(await store.getActive()).toEqual({ light: null, dark: id });
	});

	it("别人占着的槽不受牵连", async () => {
		const id = await makeDual();
		const other = (await store.save({ manifest: makeManifest(), assets: new Map() })).id;
		await store.setActiveSlot("dark", id);
		await store.setActiveSlot("light", other);
		await store.removeMode(id, "dark");
		expect(await store.getActive()).toEqual({ light: other, dark: null });
	});

	it("最后一套模式删不得 —— 那等于删掉整套皮肤", async () => {
		// schema 要求「至少给一套」。真让它删空,盘上就躺着一套永远装不上、
		// 也编辑不了的皮肤 —— 该走「删除」那条路。
		const id = await makeDual();
		await store.removeMode(id, "light");
		await expect(store.removeMode(id, "dark")).rejects.toThrow(/最后/);
		expect((await store.get(id))?.modes.dark).toBeDefined();
	});

	it("本来就没有那一色 → 拒,别装作删过了", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		await expect(store.removeMode(id, "dark")).rejects.toThrow(/没有/);
	});

	it("不认识的 id 一律拒 —— 这道闸与 remove 同一条纪律", async () => {
		// `%2e%2e%2f` 这种写法 Hono 会解码,而这里干的是写盘。
		for (const bad of ["../evil", "nope"]) {
			await expect(store.removeMode(bad, "light")).rejects.toThrow();
		}
	});

	it("资产一张不动 —— 那一色用的图,另一色可能马上要接着用", async () => {
		const { id } = await store.save({
			manifest: makeManifest({
				modes: { light: { wallpaper: { image: "assets/bg.png" } }, dark: {} },
			}),
			assets: new Map([["assets/bg.png", PNG]]),
		});
		await store.removeMode(id, "light");
		expect(await store.listAssets(id)).toEqual(["assets/bg.png"]);
	});
});

/**
 * 并发写。路由与聊天里的 create_skin 共用一个实例,一次点击可以同时打出好几个请求;
 * 这家店的写全是「读内存 → 写盘 → 改内存」,交错起来就是后写的覆盖先写的、或者一起越过上限。
 * 每条都是「几个请求同时到」,不是「一个接一个」。
 */
describe("并发写", () => {
	it("并发 addAsset 不会一起越过份数上限 —— 数份数与写盘之间不许有别人的写钻进来", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		for (let i = 0; i < MAX_SKIN_ASSETS - 1; i++) await store.addAsset(id, PNG, "png");

		const settled = await Promise.allSettled(
			Array.from({ length: 4 }, () => store.addAsset(id, PNG, "png")),
		);

		expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
		expect(await store.listAssets(id)).toHaveLength(MAX_SKIN_ASSETS);
	});

	it("并发 addAsset 各记各的原名 —— 清单是整份读整份写,不能丢条", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const labels = Array.from({ length: 8 }, (_, i) => `文件-${i}.png`);

		const names = await Promise.all(labels.map((label) => store.addAsset(id, PNG, "png", label)));

		expect(await store.assetNames(id)).toEqual(
			Object.fromEntries(names.map((name, i) => [name, labels[i]])),
		);
	});

	it("并发 setActiveSlot:亮槽与暗槽各设各的,谁也不覆盖谁,重启后仍在", async () => {
		const { id: lightSkin } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const { id: darkSkin } = await store.save({
			manifest: makeManifest({ name: "夜装", modes: { dark: {} } }),
			assets: new Map(),
		});

		await Promise.all([
			store.setActiveSlot("light", lightSkin),
			store.setActiveSlot("dark", darkSkin),
		]);

		expect(store.getActive()).toEqual({ light: lightSkin, dark: darkSkin });
		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect(reborn.getActive()).toEqual({ light: lightSkin, dark: darkSkin });
	});

	it("并发 activate:纯亮皮肤与纯暗皮肤同时启用,两个槽都得落下", async () => {
		const { id: lightSkin } = await store.save({ manifest: makeManifest(), assets: new Map() });
		const { id: darkSkin } = await store.save({
			manifest: makeManifest({ name: "夜装", modes: { dark: {} } }),
			assets: new Map(),
		});

		await Promise.all([store.activate(lightSkin), store.activate(darkSkin)]);

		expect(store.getActive()).toEqual({ light: lightSkin, dark: darkSkin });
	});

	it("removeMode 与编辑器保存同时到:保存过的那一色不许被 removeMode 拿旧清单顶回去", async () => {
		const { id } = await store.save({
			manifest: makeManifest({
				modes: {
					light: { colors: { accent: "#fb7299" } },
					dark: { colors: { accent: "#00e5ff" } },
				},
			}),
			assets: new Map(),
		});
		const edited = makeManifest({
			modes: { light: { colors: { accent: "#fb7299" } }, dark: { colors: { accent: "#123456" } } },
		});

		await Promise.all([store.updateManifest(id, edited), store.removeMode(id, "light")]);

		const expected = { dark: { colors: { accent: "#123456" } } };
		expect((await store.get(id))?.modes).toEqual(expected);
		const reborn = new SkinStore({ skinsDir: dir });
		await reborn.init();
		expect((await reborn.get(id))?.modes).toEqual(expected);
	});

	it("remove 排在前面的话,随后到的 addAsset 只能落空,不能把刚删掉的皮肤目录又写出来", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });

		const [, added] = await Promise.allSettled([store.remove(id), store.addAsset(id, PNG, "png")]);

		expect(added.status).toBe("rejected");
		expect(existsSync(join(dir, id))).toBe(false);
	});
});

/**
 * 拒收**自带码**(ADR-0026):路由靠 `SkinStoreError.code` 回给面板,不再把一切抛错一把抓成 400。
 * 这里钉的是每一处拒收各是哪个码 —— 换掉哪个码,路由的状态码和面板的分支都跟着变。
 */
describe("SkinStoreError:拒收各带各的码", () => {
	const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
		try {
			await run();
		} catch (e) {
			expect(e).toBeInstanceOf(SkinStoreError);
			return (e as SkinStoreError).code;
		}
		return "没有拒收";
	};

	it("没有这套皮肤 → not_found(启用 / 设槽 / 存清单 / 钉默认值 / 删一色 / 传资产)", async () => {
		expect(await codeOf(() => store.activate("nope"))).toBe("not_found");
		expect(await codeOf(() => store.setActiveSlot("light", "nope"))).toBe("not_found");
		expect(await codeOf(() => store.updateManifest("nope", makeManifest()))).toBe("not_found");
		expect(await codeOf(() => store.setDefault("nope"))).toBe("not_found");
		expect(await codeOf(() => store.removeMode("nope", "light"))).toBe("not_found");
		expect(await codeOf(() => store.addAsset("nope", PNG, "png"))).toBe("not_found");
	});

	it("要的东西不对 → invalid(没有那个模式、文件类型不认、太大)", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		expect(await codeOf(() => store.setActiveSlot("dark", id))).toBe("invalid");
		expect(await codeOf(() => store.removeMode(id, "dark"))).toBe("invalid");
		expect(await codeOf(() => store.addAsset(id, PNG, "svg"))).toBe("invalid");
		expect(await codeOf(() => store.addAsset(id, new Uint8Array(6 * 1024 * 1024), "png"))).toBe(
			"invalid",
		);
	});

	it("与当前状态冲突 → conflict(资产份数满了、最后一套模式)", async () => {
		const { id } = await store.save({ manifest: makeManifest(), assets: new Map() });
		for (let i = 0; i < MAX_SKIN_ASSETS; i++) await store.addAsset(id, PNG, "png");
		expect(await codeOf(() => store.addAsset(id, PNG, "png"))).toBe("conflict");

		const dual = await store.save({
			manifest: makeManifest({ modes: { light: {}, dark: {} } }),
			assets: new Map(),
		});
		await store.removeMode(dual.id, "light");
		expect(await codeOf(() => store.removeMode(dual.id, "dark"))).toBe("conflict");
	});

	it("toFailure():码原样、话就是 message,不带别的格", async () => {
		const err = new SkinStoreError("conflict", "满了");
		expect(err.toFailure()).toEqual({ ok: false, code: "conflict", message: "满了" });
	});
});
