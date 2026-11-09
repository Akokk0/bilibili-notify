/**
 * 皮肤包目录(`createSkinStore`)的工厂层测试:一个目录里一皮肤一子目录,清单 + `assets/`。
 *
 * 钉的是这一层自己的性质 —— 开机扫描认得出哪些不是皮肤、整包搭好才出现、失败不留暂存、
 * 删除先改名、同一皮肤的写全部串行 —— 不去碰面板皮肤与卡片皮肤各自的规矩(那些在它们
 * 自己的测试里)。全部走真目录,不 mock 原语:原子写、整目录替换、串行队列就是这层性质的
 * 一部分,替掉它们就测不出并发丢写。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLeftoverName } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import {
	createSkinStore,
	flushSkinWrites,
	type ManifestResult,
	type SkinPackageStore,
	type SkinPackageStoreOptions,
} from "../skin-store.js";

interface TestManifest {
	name: string;
	rev?: number;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 序列化到这个名字时抛错 —— 用来在整包搭建中途制造失败。 */
const BOOM = "boom";
/** 份数上限,只在并发用例里当「数份数」的那把尺。 */
const CAP = 3;
const ID_SHAPE = /^[a-z0-9]+-[a-f0-9]{8}$/;

function parse(raw: unknown): ManifestResult<TestManifest> {
	if (typeof raw !== "object" || raw === null || typeof (raw as TestManifest).name !== "string") {
		return { ok: false, code: "invalid", message: "清单缺 name" };
	}
	return { ok: true, manifest: raw as TestManifest };
}

/** 与两家门面一样的写法:tab 缩进、末尾不换行。 */
function serialize(manifest: TestManifest): string {
	if (manifest.name === BOOM) throw new Error("序列化炸了");
	return JSON.stringify(manifest, null, "\t");
}

let root: string;
let dir: string;
let skipped: { entry: string; message: string }[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-skin-store-"));
	dir = join(root, "skins");
	skipped = [];
});
afterEach(async () => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	await rm(root, { recursive: true, force: true });
});

function makeStore(overrides: Partial<SkinPackageStoreOptions<TestManifest>> = {}) {
	return createSkinStore<TestManifest>({
		dir,
		manifestFile: "skin.json",
		parse,
		serialize,
		assets: {
			formats: { png: "image/png" },
			maxBytes: 1024,
			naming: { kind: "given", isValidName: (name) => /^[a-z0-9-]+\.png$/.test(name) },
			labelsFile: "index.json",
		},
		onSkip: (entry, message) => skipped.push({ entry, message }),
		...overrides,
	});
}

/** 手工在盘上摆一个皮肤目录(模拟上个进程留下的)。 */
async function seedSkin(id: string, manifest: TestManifest = { name: id }): Promise<void> {
	await mkdir(join(dir, id), { recursive: true });
	await writeFile(join(dir, id, "skin.json"), serialize(manifest));
}

/** 已就绪的店,并建好一套皮肤。 */
async function readyWithSkin(): Promise<{ store: SkinPackageStore<TestManifest>; id: string }> {
	const store = makeStore();
	await store.ensureReady();
	const id = await store.create({ name: "首套" });
	return { store, id };
}

it.each([
	[
		"en",
		{
			unreadable: "skin.json could not be read or is not valid JSON; skipped.",
			parse: "Manifest parsing failed (Original diagnostic 原文); skipped.",
			missing: "Skin not found: missing",
			outside:
				"createSkinStore: Additional file names must stay inside the skin directory (../outside).",
		},
	],
	[
		"ja",
		{
			unreadable: "skin.jsonを読み取れないか、有効なJSONではないため、スキップしました。",
			parse: "マニフェストの解析に失敗しました（Original diagnostic 原文）。スキップしました。",
			missing: "スキンが見つかりません：missing",
			outside:
				"createSkinStore：追加ファイルの名前はスキンディレクトリ内に収まる必要があります（../outside）。",
		},
	],
	[
		"zh-TW",
		{
			unreadable: "skin.json 無法讀取或不是有效的 JSON，已略過。",
			parse: "資訊清單解析失敗（Original diagnostic 原文），已略過。",
			missing: "找不到佈景主題：missing",
			outside: "createSkinStore：附加檔案的名稱必須位於佈景主題目錄內（../outside）。",
		},
	],
] as const)("%s:扫描说明本地化但诊断原文保留,坏文件与正常索引不被改写", async (locale, text) => {
	i18n.set({ locale, voice: "plain" });
	await seedSkin("good", { name: "Original skin 原文" });
	await seedSkin("throws");
	await mkdir(join(dir, "bad"));
	await writeFile(join(dir, "bad", "skin.json"), "{ Original bad JSON");
	const store = makeStore({
		parse: (raw, id) => {
			if (id === "throws") throw new Error("Original diagnostic 原文");
			return parse(raw);
		},
	});
	await store.ensureReady();
	expect(store.ids()).toEqual(["good"]);
	expect(store.get("good")).toEqual({ name: "Original skin 原文" });
	expect([...skipped].sort((a, b) => a.entry.localeCompare(b.entry))).toEqual([
		{ entry: "bad", message: text.unreadable },
		{ entry: "throws", message: text.parse },
	]);
	expect(() => store.pathOf("missing")).toThrow(text.missing);
	await expect(
		store.create({ name: "rejected" }, new Map([["../outside", "do not write"]])),
	).rejects.toThrow(text.outside);
	expect(store.ids()).toEqual(["good"]);
	expect(await readFile(join(dir, "bad", "skin.json"), "utf8")).toBe("{ Original bad JSON");
	expect((await readdir(dir)).sort()).toEqual(["bad", "good", "throws"]);
});

describe("就绪", () => {
	it("ensureReady 之前索引是空的;之后读得到盘上原有的皮肤与它的 mtime", async () => {
		await seedSkin("old-1", { name: "老皮肤", rev: 7 });
		const store = makeStore();
		expect(store.ids()).toEqual([]);
		expect(store.has("old-1")).toBe(false);
		expect(store.get("old-1")).toBeNull();

		await store.ensureReady();
		expect(store.ids()).toEqual(["old-1"]);
		expect(store.has("old-1")).toBe(true);
		expect(store.get("old-1")).toEqual({ name: "老皮肤", rev: 7 });
		expect(store.updatedAt("old-1")).toBe((await stat(join(dir, "old-1", "skin.json"))).mtimeMs);
		expect(store.updatedAt("没有")).toBeNull();
	});

	it("目录还没建 → ensureReady 建出来,索引为空,不报错", async () => {
		const store = makeStore();
		await store.ensureReady();
		expect(store.ids()).toEqual([]);
		expect((await stat(dir)).isDirectory()).toBe(true);
	});

	it("ensureReady 幂等:两处同时调也只扫一遍盘", async () => {
		await mkdir(join(dir, "半截"), { recursive: true });
		const store = makeStore();
		await Promise.all([store.ensureReady(), store.ensureReady()]);
		await store.ensureReady();
		expect(skipped).toHaveLength(1);
	});

	it("init 每次都重扫:盘上后来多出来的,再 init 一次就读得到", async () => {
		const store = makeStore();
		await store.ensureReady();
		await seedSkin("late-1");
		expect(store.ids()).toEqual([]);

		await store.init();
		expect(store.ids()).toEqual(["late-1"]);
	});

	it("init 自己把 ensureReady 那把锁点上:开机裸调 init 读过盘,随后的 ensureReady 不该再扫一遍", async () => {
		const store = makeStore();
		await store.init();
		await seedSkin("late-1");

		await store.ensureReady();

		expect(store.ids()).toEqual([]);
	});

	it("写之前没就绪 → 自己先就绪,盘上原有的皮肤不会被新建的挤出索引", async () => {
		await seedSkin("old-1");
		const store = makeStore();
		const id = await store.create({ name: "新的" });
		expect(store.ids().sort()).toEqual(["old-1", id].sort());
	});
});

describe("开机扫描", () => {
	it("暂存 / 旧目录 / 老版本的 .tmp、.deleting 残留静默跳过:不进索引、不通知 onSkip、原样不动", async () => {
		await seedSkin("good-1");
		// 里面放的是一份合格清单 —— 跳过得靠名字,不能靠读不读得出来。
		const leftovers = ["a.bn-tmp.123.abcdef", "b.bn-old.123.abcdef", "c.tmp", "d.deleting"];
		for (const name of leftovers) await seedSkin(name);
		await writeFile(join(dir, "散落的文件.json"), "{}");

		const store = makeStore();
		await store.ensureReady();

		expect(store.ids()).toEqual(["good-1"]);
		expect(skipped).toEqual([]);
		expect((await readdir(dir)).sort()).toEqual(["good-1", "散落的文件.json", ...leftovers].sort());
	});

	it("清单读不出 / 不是合法 JSON / parse 不过 → 跳过并通知 onSkip,目录原样在、不被改名隔离", async () => {
		await seedSkin("good-1");
		await mkdir(join(dir, "无清单"), { recursive: true });
		await mkdir(join(dir, "坏json"), { recursive: true });
		await writeFile(join(dir, "坏json", "skin.json"), "{ 半截");
		await mkdir(join(dir, "形状不对"), { recursive: true });
		await writeFile(join(dir, "形状不对", "skin.json"), JSON.stringify({ rev: 1 }));

		const store = makeStore();
		await store.ensureReady();

		expect(store.ids()).toEqual(["good-1"]);
		const byEntry = new Map(skipped.map((s) => [s.entry, s.message]));
		expect([...byEntry.keys()].sort()).toEqual(["坏json", "形状不对", "无清单"]);
		// 读不出来的两条要说出是哪个文件;形状不对的把 parse 给的原话带出来。
		expect(byEntry.get("无清单")).toContain("skin.json");
		expect(byEntry.get("坏json")).toContain("skin.json");
		expect(byEntry.get("形状不对")).toBe("清单缺 name");
		// 不动它 —— 交给人查,别静默删数据。
		expect((await readdir(dir)).sort()).toEqual(["good-1", "坏json", "形状不对", "无清单"].sort());
		expect(await readFile(join(dir, "坏json", "skin.json"), "utf8")).toBe("{ 半截");
	});

	it("parse 拿得到目录名(门面据此拒收保留 id)", async () => {
		await seedSkin("reserved");
		await seedSkin("fine");
		const store = makeStore({
			parse: (raw, id) =>
				id === "reserved" ? { ok: false, code: "invalid", message: "保留字" } : parse(raw),
		});
		await store.ensureReady();
		expect(store.ids()).toEqual(["fine"]);
		expect(skipped).toEqual([{ entry: "reserved", message: "保留字" }]);
	});
});

describe("create", () => {
	it("整包落盘:清单字节 = serialize 的结果,附带文件在原位,assets/ 目录总在;索引即时可见", async () => {
		const store = makeStore();
		await store.ensureReady();
		const manifest = { name: "樱花夜", rev: 2 };
		const id = await store.create(
			manifest,
			new Map<string, string | Uint8Array>([
				["assets/bg.png", PNG],
				["default.json", "出厂快照"],
			]),
		);

		expect(id).toMatch(ID_SHAPE);
		expect(store.ids()).toEqual([id]);
		expect(store.get(id)).toEqual(manifest);
		expect(await readFile(join(dir, id, "skin.json"), "utf8")).toBe(serialize(manifest));
		expect(new Uint8Array(await readFile(join(dir, id, "assets", "bg.png")))).toEqual(PNG);
		expect(await readFile(join(dir, id, "default.json"), "utf8")).toBe("出厂快照");
		expect(store.updatedAt(id)).toBe((await stat(join(dir, id, "skin.json"))).mtimeMs);
		// 暂存与旧目录一个不留。
		expect((await readdir(dir)).filter(isLeftoverName)).toEqual([]);
	});

	it("没有任何资产也建出空的 assets/ —— 盘上形状与从前一致", async () => {
		const { id } = await readyWithSkin();
		expect((await stat(join(dir, id, "assets"))).isDirectory()).toBe(true);
		expect(await readdir(join(dir, id, "assets"))).toEqual([]);
	});

	it("每次给一个新 id;重启(同目录新实例)读回同一份", async () => {
		const store = makeStore();
		await store.ensureReady();
		const a = await store.create({ name: "甲" });
		const b = await store.create({ name: "乙" });
		expect(a).not.toBe(b);

		const reborn = makeStore();
		await reborn.ensureReady();
		expect(reborn.ids().sort()).toEqual([a, b].sort());
		expect(reborn.get(a)).toEqual({ name: "甲" });
	});

	it("搭到一半失败 → 抛出去,不留暂存,原有的皮肤与索引不受牵连", async () => {
		const { store, id: existing } = await readyWithSkin();
		const before = (await readdir(dir)).sort();

		await expect(store.create({ name: BOOM })).rejects.toThrow("序列化炸了");

		expect((await readdir(dir)).sort()).toEqual(before);
		expect(store.ids()).toEqual([existing]);
	});

	it("附带文件的名字跑出皮肤目录 → 抛 TypeError,一个字节都不落盘", async () => {
		const store = makeStore();
		await store.ensureReady();
		for (const bad of ["../escape.txt", "/etc/escape.txt", "assets/../../escape.txt"]) {
			await expect(store.create({ name: "坏" }, new Map([[bad, "x"]]))).rejects.toThrow(TypeError);
		}
		expect(await readdir(dir)).toEqual([]);
		expect(await readdir(root)).toEqual(["skins"]);
	});
});

describe("saveManifest", () => {
	it("落盘字节 = serialize 的结果,索引与 updatedAt 一并更新,资产不动", async () => {
		const { store, id } = await readyWithSkin();
		await store.assetsOf(id).put({ bytes: PNG, ext: "png", name: "bg.png" });
		const next = { name: "改名了", rev: 9 };

		expect(await store.saveManifest(id, next)).toBe(true);

		expect(await readFile(join(dir, id, "skin.json"), "utf8")).toBe(serialize(next));
		expect(store.get(id)).toEqual(next);
		expect(store.updatedAt(id)).toBe((await stat(join(dir, id, "skin.json"))).mtimeMs);
		expect((await store.assetsOf(id).list()).map((a) => a.id)).toEqual(["bg.png"]);
	});

	it("不认识的 id → false,不在盘上凭空造目录", async () => {
		const store = makeStore();
		await store.ensureReady();
		expect(await store.saveManifest("没有", { name: "x" })).toBe(false);
		expect(await store.saveManifest("../外面", { name: "x" })).toBe(false);
		expect(await readdir(dir)).toEqual([]);
		expect(await readdir(root)).toEqual(["skins"]);
	});

	it("序列化失败 → 抛出去,盘上与索引都还是旧的", async () => {
		const { store, id } = await readyWithSkin();
		const before = await readFile(join(dir, id, "skin.json"), "utf8");
		await expect(store.saveManifest(id, { name: BOOM })).rejects.toThrow("序列化炸了");
		expect(await readFile(join(dir, id, "skin.json"), "utf8")).toBe(before);
		expect(store.get(id)).toEqual({ name: "首套" });
	});

	it("与 remove 同时来、remove 排在前面 → 写不回去,皮肤目录不会被写成只剩一个清单的空壳", async () => {
		const { store, id } = await readyWithSkin();
		const [removed, saved] = await Promise.all([
			store.remove(id),
			store.saveManifest(id, { name: "迟到的写" }),
		]);
		expect([removed, saved]).toEqual([true, false]);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("remove", () => {
	it("目录与索引都没了,不留残骸;返回 true", async () => {
		const { store, id } = await readyWithSkin();
		await store.assetsOf(id).put({ bytes: PNG, ext: "png", name: "bg.png" });

		expect(await store.remove(id)).toBe(true);

		expect(store.has(id)).toBe(false);
		expect(store.ids()).toEqual([]);
		expect(await readdir(dir)).toEqual([]);
	});

	it("不认识的 id → false,一个字节都不动,哪怕它指得出一个真目录", async () => {
		const { store, id } = await readyWithSkin();
		const outsider = join(root, "conversations");
		await mkdir(outsider, { recursive: true });
		await writeFile(join(outsider, "a.json"), "{}");

		expect(await store.remove("../conversations")).toBe(false);
		expect(await store.remove("没有")).toBe(false);

		expect(await readFile(join(outsider, "a.json"), "utf8")).toBe("{}");
		expect(await readdir(dir)).toEqual([id]);
	});

	it("重复删同一个 → 第二次 false", async () => {
		const { store, id } = await readyWithSkin();
		expect(await store.remove(id)).toBe(true);
		expect(await store.remove(id)).toBe(false);
	});
});

describe("assetsOf / pathOf", () => {
	it("资产存储落在 <皮肤目录>/assets,选项原样带过去(格式、上限、原名清单)", async () => {
		const { store, id } = await readyWithSkin();
		const assets = store.assetsOf(id);

		const put = await assets.put({
			bytes: PNG,
			ext: "png",
			name: "bg.png",
			label: "主人的壁纸.png",
		});
		expect(put).toEqual({ ok: true, id: "bg.png" });
		expect(await readdir(join(dir, id, "assets"))).toEqual(
			expect.arrayContaining(["bg.png", "index.json"]),
		);
		expect(await assets.labels()).toEqual({ "bg.png": "主人的壁纸.png" });
		const tooBig = await assets.put({ bytes: new Uint8Array(2048), ext: "png", name: "big.png" });
		expect(tooBig.ok).toBe(false);
	});

	it("不认识的 id 直接抛 —— 免得往皮肤目录外面写", async () => {
		const store = makeStore();
		await store.ensureReady();
		expect(() => store.assetsOf("../..")).toThrow();
		expect(() => store.pathOf("../..", "skin.json")).toThrow();
	});

	it("pathOf:皮肤目录下的路径;不给相对路径就是皮肤目录本身", async () => {
		const { store, id } = await readyWithSkin();
		expect(store.pathOf(id)).toBe(join(dir, id));
		expect(store.pathOf(id, "default.json")).toBe(join(dir, id, "default.json"));
	});
});

describe("run:同一皮肤的写串行", () => {
	/** 数份数 → 到上限就拒 → put,与两家门面 addAsset 的骨架一样。 */
	function addWithCap(store: SkinPackageStore<TestManifest>, id: string, name: string) {
		return store.run(id, async () => {
			const assets = store.assetsOf(id);
			if ((await assets.list()).length >= CAP) return false;
			const result = await assets.put({ bytes: PNG, ext: "png", name, label: `原名-${name}` });
			return result.ok;
		});
	}

	it("并发的「数份数 → put」在同一个 run 里就不会超过上限", async () => {
		const { store, id } = await readyWithSkin();
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) => addWithCap(store, id, `a${i}.png`)),
		);
		expect(results.filter(Boolean)).toHaveLength(CAP);
		expect(await store.assetsOf(id).list()).toHaveLength(CAP);
	});

	it("并发的 put 各记各的原名,清单不丢条", async () => {
		const { store, id } = await readyWithSkin();
		const names = Array.from({ length: CAP }, (_, i) => `n${i}.png`);
		await Promise.all(names.map((name) => addWithCap(store, id, name)));
		const labels = await store.assetsOf(id).labels();
		expect(Object.keys(labels).sort()).toEqual(names.sort());
	});

	it("同一目录上开了不止一个实例也排同一条队(队列在模块里,不在实例里)", async () => {
		const first = makeStore();
		await first.ensureReady();
		const id = await first.create({ name: "共用" });
		const second = makeStore();
		const events: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const held = first.run(id, async () => {
			events.push("first:start");
			await gate;
			events.push("first:end");
		});
		const waiting = second.run(id, async () => {
			events.push("second:start");
		});
		// 给第二个实例足够的时间「抢跑」:各排各的队的话,它这时早就开始了。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(events).toEqual(["first:start"]);

		release();
		await Promise.all([held, waiting]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("不同皮肤互不等待:一套的任务卡着,另一套照样往前走", async () => {
		const store = makeStore();
		await store.ensureReady();
		const a = await store.create({ name: "甲" });
		const b = await store.create({ name: "乙" });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const slow = store.run(a, async () => {
			await gate;
			return "甲";
		});
		expect(await store.run(b, async () => "乙")).toBe("乙");
		release();
		expect(await slow).toBe("甲");
	});

	it("前一个任务抛错不挡后面的;错误原样交回给它自己的调用方", async () => {
		const { store, id } = await readyWithSkin();
		const failing = store.run(id, async () => {
			throw new Error("任务自己炸了");
		});
		const after = store.run(id, async () => "后面的照跑");
		await expect(failing).rejects.toThrow("任务自己炸了");
		expect(await after).toBe("后面的照跑");
	});

	it("任务里用递进来的 saveManifest 存清单不死锁,并且存完排在别人前面的写之后", async () => {
		const { store, id } = await readyWithSkin();
		const order: string[] = [];
		const first = store.run(id, async (saveManifest) => {
			order.push("first:start");
			await saveManifest({ name: "第一手", rev: 1 });
			order.push("first:end");
		});
		const second = store.run(id, async (saveManifest) => {
			order.push(`second:sees:${store.get(id)?.name}`);
			return await saveManifest({ name: "第二手", rev: 2 });
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:sees:第一手"]);
		expect(store.get(id)).toEqual({ name: "第二手", rev: 2 });
	});

	it("run 里递进来的 saveManifest 遇到已被删的皮肤 → false", async () => {
		const { store, id } = await readyWithSkin();
		const removal = store.remove(id);
		const saved = store.run(id, (saveManifest) => saveManifest({ name: "迟到" }));
		expect(await removal).toBe(true);
		expect(await saved).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("runRoot:门面自己的根级文件", () => {
	it("按交进来的顺序一个接一个跑,失败不挡后面", async () => {
		const store = makeStore();
		await store.ensureReady();
		const seen: number[] = [];
		const tasks = [
			store.runRoot(async () => {
				await new Promise((r) => setTimeout(r, 20));
				seen.push(1);
			}),
			store.runRoot(async () => {
				seen.push(2);
				throw new Error("中间一个炸了");
			}),
			store.runRoot(async () => {
				seen.push(3);
			}),
		];
		const settled = await Promise.allSettled(tasks);
		expect(seen).toEqual([1, 2, 3]);
		expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
	});
});

describe("flushSkinWrites:关停时只等、不关门", () => {
	it("等到在途的写做完才落定", async () => {
		const store = makeStore();
		await store.ensureReady();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let wrote = false;
		const writing = store.runRoot(async () => {
			await held;
			wrote = true;
		});

		let flushed = false;
		const flushing = flushSkinWrites().then(() => {
			flushed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(flushed).toBe(false);

		release();
		await flushing;
		await writing;
		expect(wrote).toBe(true);
	});

	it("flush 过之后队列照样收写:模块级的队被同一进程里下一个起的服务接着用", async () => {
		const store = makeStore();
		await store.ensureReady();
		await flushSkinWrites();
		await expect(store.runRoot(async () => "还能写")).resolves.toBe("还能写");
	});
});
