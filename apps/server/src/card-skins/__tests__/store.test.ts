/**
 * 卡片皮肤库(ADR-0014 决策 2 / 5)。
 *
 * 这一组钉三件盘上的事:**内置那份是索引外的第八套**(列得出、拿得到、复制得了、
 * 删不掉存不了)、**落盘的是洗过的产物**、**一份坏皮肤不拖死 init**。往返(导出 → 再装
 * 回来内容一致)单独一条 —— 那是「主人把皮肤发给别人」这件事的全部依据。
 *
 * 全程在 `mkdtemp` 的临时目录里跑,一个字节都不碰真实 dataDir。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CARD_SKIN_LIMITS,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
} from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CARD_SKIN_MANIFEST_FILE } from "../package.js";
import { CardSkinPackageError, CardSkinStore } from "../store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function manifest(extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		dataVersion: 1,
		name: "测试卡片皮肤",
		author: "伦伦酱",
		cards: {
			live: {
				width: 600,
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				],
			},
		},
		...extra,
	};
}

function pack(
	m: Record<string, unknown> = manifest(),
	assets: Record<string, Uint8Array> = {},
): Uint8Array {
	return zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(m)), ...assets });
}

let dir: string;
let store: CardSkinStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-card-skins-"));
	store = new CardSkinStore({ dir });
	await store.init();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("init 与内置那份", () => {
	it("空目录(连目录都还没有)→ 只有内置那一套,摆在首位", async () => {
		const fresh = new CardSkinStore({ dir: join(dir, "还没建") });
		await fresh.init();
		const list = fresh.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: DEFAULT_CARD_SKIN_ID,
			name: DEFAULT_CARD_SKIN.name,
			builtin: true,
		});
	});

	it("get(default) 每次给一份拷贝 —— 调用方改它不该污染整个进程", () => {
		const a = store.get(DEFAULT_CARD_SKIN_ID);
		expect(a).toEqual(DEFAULT_CARD_SKIN);
		if (!a) return;
		a.name = "被改过了";
		a.cards.live?.blocks.pop();
		expect(store.get(DEFAULT_CARD_SKIN_ID)).toEqual(DEFAULT_CARD_SKIN);
		expect(DEFAULT_CARD_SKIN.name).toBe("默认");
	});

	it("不存在的 id → null,路径穿越的写法也一样", () => {
		expect(store.get("没有这套")).toBeNull();
		expect(store.get("../../etc")).toBeNull();
	});
});

describe("install", () => {
	it("装完:list / get 一致,盘上是 <id>/card-skin.json + assets/*", async () => {
		const { id, warnings } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		expect(warnings).toEqual([]);

		const list = store.list();
		expect(list.map((s) => s.id)).toEqual([DEFAULT_CARD_SKIN_ID, id]);
		expect(list[1]).toMatchObject({ name: "测试卡片皮肤", author: "伦伦酱", builtin: false });
		expect(list[1]?.updatedAt).toBeGreaterThan(0);
		expect(store.get(id)?.name).toBe("测试卡片皮肤");

		expect(await readdir(join(dir, id))).toEqual(
			expect.arrayContaining([CARD_SKIN_MANIFEST_FILE, "assets"]),
		);
		expect(await readdir(join(dir, id, "assets"))).toEqual(["bg.png"]);
		expect(await store.readAsset(id, "assets/bg.png")).toEqual(PNG);
		// 临时目录不许留下 —— 它会被下一次 init 当成半套皮肤。
		expect((await readdir(dir)).some((n) => n.endsWith(".tmp"))).toBe(false);
	});

	it("重启(重建一家店 init 一次)之后索引还在", async () => {
		const { id } = await store.install(pack());
		const reopened = new CardSkinStore({ dir });
		await reopened.init();
		expect(reopened.get(id)?.name).toBe("测试卡片皮肤");
		expect(reopened.warnings()).toEqual([]);
	});

	it("坏包一律抛 CardSkinPackageError,错误逐条带着", async () => {
		await expect(store.install(strToU8("这不是 zip"))).rejects.toBeInstanceOf(CardSkinPackageError);
		await expect(store.install(pack({ ...manifest(), name: "" }))).rejects.toBeInstanceOf(
			CardSkinPackageError,
		);
		expect(store.list()).toHaveLength(1);
		expect(await readdir(dir)).toEqual([]);
	});

	/** 盘上躺着原文的话,出图那头要么现洗一遍,要么把 `<script>` 原样喂给 puppeteer。 */
	it("落盘的是洗过的产物,不是原文", async () => {
		const { id, warnings } = await store.install(
			pack(
				manifest({
					cards: {
						live: {
							width: 600,
							css: '[data-bn="glass"]{border-radius:12px}[data-bn="evilhook"]{color:red}',
							blocks: [
								{
									id: "note",
									kind: "custom",
									grid: { row: 1, column: 1, span: 12 },
									html: "<div>{up.name}</div><script>alert(1)</script>",
								},
							],
						},
					},
				}),
			),
		);
		const onDisk = await readFile(join(dir, id, CARD_SKIN_MANIFEST_FILE), "utf8");
		expect(onDisk).not.toContain("evil");
		expect(onDisk).not.toContain("script");
		expect(onDisk).toContain("border-radius:12px");
		expect(warnings.join()).toContain("script");
	});
});

describe("duplicate", () => {
	it("复制内置那份 → 新 id、内容等于 DEFAULT_CARD_SKIN、builtin:false、名字带「副本」", async () => {
		const { id } = await store.duplicate(DEFAULT_CARD_SKIN_ID);
		expect(id).not.toBe(DEFAULT_CARD_SKIN_ID);
		const copy = store.get(id);
		expect(copy).toEqual({ ...DEFAULT_CARD_SKIN, name: `${DEFAULT_CARD_SKIN.name} 副本` });
		expect(store.list().find((s) => s.id === id)).toMatchObject({ builtin: false });
		// 内置那份纹丝不动(它还在首位,还是内置)。
		expect(store.list()[0]).toMatchObject({ id: DEFAULT_CARD_SKIN_ID, builtin: true });
	});

	it("复制普通皮肤时资产跟着走", async () => {
		const { id } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		const { id: copyId } = await store.duplicate(id, "另一套");
		expect(store.get(copyId)?.name).toBe("另一套");
		expect(await store.readAsset(copyId, "assets/bg.png")).toEqual(PNG);
		// 两份各存各的:删了源,副本的资产还在。
		await store.remove(id);
		expect(await store.readAsset(copyId, "assets/bg.png")).toEqual(PNG);
	});

	it("名字超 schema 上限就截断 —— 不让它在下一次保存时才炸", async () => {
		const { id } = await store.install(pack({ ...manifest(), name: "咪".repeat(40) }));
		const { id: copyId } = await store.duplicate(id);
		expect(store.get(copyId)?.name).toHaveLength(40);
	});

	it("不存在的 id → 抛", async () => {
		await expect(store.duplicate("没有这套")).rejects.toThrow("皮肤不存在");
	});
});

describe("remove", () => {
	it("内置那份删不掉,而且话说得清", async () => {
		await expect(store.remove(DEFAULT_CARD_SKIN_ID)).rejects.toThrow("复制");
		expect(store.get(DEFAULT_CARD_SKIN_ID)).not.toBeNull();
	});

	it("删完:索引没了、目录没了、残骸也没留", async () => {
		const { id } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		await store.remove(id);
		expect(store.get(id)).toBeNull();
		expect(store.list()).toHaveLength(1);
		expect(await readdir(dir)).toEqual([]);
	});

	it("不认识的 id 抛错,一个字节都不动(路径穿越的写法同理)", async () => {
		const { id } = await store.install(pack());
		await expect(store.remove("../..")).rejects.toThrow("皮肤不存在");
		await expect(store.remove("没有这套")).rejects.toThrow("皮肤不存在");
		expect(await readdir(dir)).toEqual([id]);
	});
});

describe("exportZip", () => {
	it("导出再装回来,内容一字不差(主人把皮肤发给别人就靠这条)", async () => {
		const { id } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		const zip = await store.exportZip(id);
		const { id: backId } = await store.install(zip);
		expect(backId).not.toBe(id);
		expect(store.get(backId)).toEqual(store.get(id));
		expect(await store.readAsset(backId, "assets/bg.png")).toEqual(PNG);
	});

	it("内置那份也导得出(拿它当模板改)", async () => {
		const zip = await store.exportZip(DEFAULT_CARD_SKIN_ID);
		const { id } = await store.install(zip);
		// ⚠️ 不是 toEqual(DEFAULT_CARD_SKIN):今天清洗层会剥掉它的块间距,
		// 见 package.test.ts 里那条带 ⚠️ 的说明。这里只问「装得回来、块还在」。
		expect(store.get(id)?.cards.live?.blocks.map((b) => b.id)).toEqual(
			DEFAULT_CARD_SKIN.cards.live?.blocks.map((b) => b.id),
		);
	});

	it("不存在的 id → 抛", async () => {
		await expect(store.exportZip("没有这套")).rejects.toThrow("皮肤不存在");
	});
});

describe("save(编辑器保存)", () => {
	it("走的是同一道清洗:越界挂点与 <script> 进不了盘", async () => {
		const { id } = await store.install(pack());
		const { warnings } = await store.save(
			id,
			manifest({
				cards: {
					live: {
						width: 600,
						css: '[data-bn="glass"]{border-radius:20px}[data-bn="evilhook"]{color:red}',
						blocks: [
							{
								id: "note",
								kind: "custom",
								grid: { row: 1, column: 1, span: 12 },
								html: "<div>{up.name}</div><script>alert(1)</script>",
							},
						],
					},
				},
			}),
		);
		expect(warnings.join()).toContain("script");
		const onDisk = await readFile(join(dir, id, CARD_SKIN_MANIFEST_FILE), "utf8");
		expect(onDisk).not.toContain("evil");
		expect(onDisk).not.toContain("script");
		expect(store.get(id)?.cards.live?.css).toBe('[data-bn="glass"]{border-radius:20px}');
	});

	it("资产清单来自盘上:引用盘上真有的图 → 过;引用没有的 → 拒", async () => {
		const { id } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		await expect(
			store.save(id, manifest({ variables: { backgroundImage: "assets/bg.png" } })),
		).resolves.toMatchObject({ warnings: [] });
		await expect(
			store.save(id, manifest({ variables: { backgroundImage: "assets/nope.png" } })),
		).rejects.toBeInstanceOf(CardSkinPackageError);
	});

	it("形状不对 → 抛 CardSkinPackageError,盘上那份原封不动", async () => {
		const { id } = await store.install(pack());
		const before = await readFile(join(dir, id, CARD_SKIN_MANIFEST_FILE), "utf8");
		await expect(store.save(id, { schemaVersion: 99 })).rejects.toBeInstanceOf(
			CardSkinPackageError,
		);
		expect(await readFile(join(dir, id, CARD_SKIN_MANIFEST_FILE), "utf8")).toBe(before);
	});

	it("内置那份存不了;不认识的 id 也存不了", async () => {
		await expect(store.save(DEFAULT_CARD_SKIN_ID, manifest())).rejects.toThrow("复制");
		await expect(store.save("没有这套", manifest())).rejects.toThrow("皮肤不存在");
	});
});

describe("坏皮肤不拖死 init", () => {
	it("读不动 / 形状不对 / 占了保留字的目录各自跳过并记 warning,好的那套照旧在", async () => {
		const { id } = await store.install(pack());
		await mkdir(join(dir, "没有清单"), { recursive: true });
		await mkdir(join(dir, "坏json"), { recursive: true });
		await writeFile(join(dir, "坏json", CARD_SKIN_MANIFEST_FILE), "{ 半截");
		await mkdir(join(dir, "形状不对"), { recursive: true });
		await writeFile(
			join(dir, "形状不对", CARD_SKIN_MANIFEST_FILE),
			JSON.stringify({ schemaVersion: 1, name: "缺 cards" }),
		);
		await mkdir(join(dir, DEFAULT_CARD_SKIN_ID), { recursive: true });
		await writeFile(
			join(dir, DEFAULT_CARD_SKIN_ID, CARD_SKIN_MANIFEST_FILE),
			JSON.stringify(manifest({ name: "冒名顶替" })),
		);

		const reopened = new CardSkinStore({ dir });
		await reopened.init();
		expect(reopened.list().map((s) => s.id)).toEqual([DEFAULT_CARD_SKIN_ID, id]);
		// 内置那份还是代码里那份,不是盘上那个冒名的。
		expect(reopened.get(DEFAULT_CARD_SKIN_ID)?.name).toBe(DEFAULT_CARD_SKIN.name);
		const warnings = reopened.warnings().join("\n");
		expect(warnings).toContain("没有清单");
		expect(warnings).toContain("坏json");
		expect(warnings).toContain("形状不对");
		expect(warnings).toContain(DEFAULT_CARD_SKIN_ID);
		// 坏目录不动它 —— 交给人查,别静默删数据。
		expect(await readdir(dir)).toEqual(expect.arrayContaining(["坏json", "形状不对"]));
	});

	it("写到一半的 .tmp / 删到一半的 .deleting 静默跳过,不当成坏皮肤刷警告", async () => {
		await mkdir(join(dir, "abc.tmp"), { recursive: true });
		await mkdir(join(dir, "abc.deleting"), { recursive: true });
		const reopened = new CardSkinStore({ dir });
		await reopened.init();
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.warnings()).toEqual([]);
	});
});

describe("readAsset", () => {
	/**
	 * ⚠️ 穿越的例子**必须真能穿到一个存在的文件上**:`assets/../../../etc/passwd` 从
	 * 临时目录往上爬三层落在 `/var/folders/…/etc/passwd`,那儿本来就没东西 —— 把白名单
	 * 整个拆掉,这条照样绿(实测,2026-09-13)。所以先在皮肤目录的**上一层**放一份
	 * 真文件,再去够它。
	 */
	it("名字不合白名单 → null,哪怕那条路径真够得到一份文件", async () => {
		const { id } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		await writeFile(join(dir, "secret.txt"), "主人的秘密");
		expect(await store.readAsset(id, "assets/../../secret.txt")).toBeNull();
		expect(await store.readAsset(id, "../../../etc/passwd")).toBeNull();
	});

	it("皮肤不存在 / 文件不在 / 内置那份 → null,都不抛", async () => {
		const { id } = await store.install(pack(manifest(), { "assets/bg.png": PNG }));
		expect(await store.readAsset(id, "assets/nope.png")).toBeNull();
		expect(await store.readAsset("没有这套", "assets/bg.png")).toBeNull();
		expect(await store.readAsset(DEFAULT_CARD_SKIN_ID, "assets/bg.png")).toBeNull();
	});
});

/**
 * **往一套已存盘的皮肤里加 / 删资产**。在这之前资产只能随 zip 装包进来 —— 于是编辑器里
 * 「皮肤自带字体」永远指不到任何东西(清单里的 `asset:assets/<文件>` 必须是包内文件)。
 *
 * 加进来的那道闸得**与装包门同一把尺**:名字白名单(它要拼进磁盘路径)、单份体积、份数
 * 上限。少一条就是「装包进不来的东西,换个门能进」。
 *
 * 删那道闸是另一件事:清单还引用着就不许删 —— 删了之后这套皮肤连自己都存不下去
 * (下次保存装包门判「指了…,但包里没有这份资产」),而主人只会看到一句莫名其妙的报错。
 */
describe("addAsset / removeAsset —— 编辑器往皮肤里加文件", () => {
	const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);

	async function withSkin(fn: (s: CardSkinStore, id: string) => Promise<void>): Promise<void> {
		const { id } = await store.install(pack({ ...manifest(), name: "霓虹" }));
		await fn(store, id);
	}

	it("加一份字体 → 回它在清单里该写的名字,而且列得出来、读得回来", async () => {
		await withSkin(async (store, id) => {
			const { name } = await store.addAsset(id, "Song.TTF", TTF);
			expect(name).toBe("assets/song.ttf");
			expect(await store.listAssets(id)).toContain("assets/song.ttf");
			expect(await store.readAsset(id, "assets/song.ttf")).toEqual(TTF);
		});
	});

	it("后缀不在白名单里 → 拒(装包门进不来的东西,这条门也别放进来)", async () => {
		await withSkin(async (store, id) => {
			await expect(store.addAsset(id, "evil.svg", TTF)).rejects.toThrow();
			await expect(store.addAsset(id, "evil.js", TTF)).rejects.toThrow();
		});
	});

	it("名字带路径 → 拒(它要拼进磁盘路径)", async () => {
		await withSkin(async (store, id) => {
			await expect(store.addAsset(id, "../../etc/passwd.ttf", TTF)).rejects.toThrow();
			await expect(store.addAsset(id, "sub/dir/a.ttf", TTF)).rejects.toThrow();
		});
	});

	it("同名的已经有了 → 拒并说清楚(悄悄覆盖会把别处正用着的那份换掉)", async () => {
		await withSkin(async (store, id) => {
			await store.addAsset(id, "song.ttf", TTF);
			await expect(store.addAsset(id, "song.ttf", TTF)).rejects.toThrow(/已经有/);
		});
	});

	it("超过单份体积 / 份数上限 → 拒", async () => {
		await withSkin(async (store, id) => {
			const huge = new Uint8Array(CARD_SKIN_LIMITS.maxAssetBytes + 1);
			await expect(store.addAsset(id, "big.ttf", huge)).rejects.toThrow();

			for (let i = 0; i < CARD_SKIN_LIMITS.maxAssets; i++) {
				await store.addAsset(id, `f${i}.ttf`, TTF);
			}
			await expect(store.addAsset(id, "one-more.ttf", TTF)).rejects.toThrow(/上限/);
		});
	});

	it("删一份 → 真的没了", async () => {
		await withSkin(async (store, id) => {
			await store.addAsset(id, "song.ttf", TTF);
			await store.removeAsset(id, "assets/song.ttf");
			expect(await store.listAssets(id)).not.toContain("assets/song.ttf");
		});
	});

	it("清单还引用着 → 不许删,并说出是谁在引用", async () => {
		await withSkin(async (store, id) => {
			await store.addAsset(id, "song.ttf", TTF);
			await store.save(id, {
				...manifest(),
				name: "霓虹",
				fonts: [{ family: "Song", asset: "asset:assets/song.ttf" }],
			});
			await expect(store.removeAsset(id, "assets/song.ttf")).rejects.toThrow(/Song/);
			// 拒了就得真没删掉 —— 半途而废比不做更糟。
			expect(await store.listAssets(id)).toContain("assets/song.ttf");
		});
	});

	it("内置那份加不了也删不了(它没有落盘的身子)", async () => {
		await withSkin(async (store) => {
			await expect(store.addAsset(DEFAULT_CARD_SKIN_ID, "a.ttf", TTF)).rejects.toThrow();
			await expect(store.removeAsset(DEFAULT_CARD_SKIN_ID, "assets/a.ttf")).rejects.toThrow();
		});
	});
});
