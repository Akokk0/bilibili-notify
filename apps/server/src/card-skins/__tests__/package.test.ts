/**
 * 卡片皮肤包的装包门(ADR-0014 决策 2 / 5 / 19)。
 *
 * 两层各钉各的:`parseCardSkinPackage` 是**文件层**(白名单、上限、zip bomb、JSON),
 * `checkCardSkinPackage` 是**清单层**(形状 + 清洗 + 资产引用)。清洗器本身的红线在
 * `css-sanitizer.test.ts` / `html-sanitizer.test.ts` 钉过,这里只问一件它们答不了的事:
 * **洗过的产物真的写回了 manifest 吗** —— 存盘存的是原文的话,出图那头要么现洗一遍,
 * 要么把 `<script>` 原样喂给 puppeteer。
 */

import { CARD_SKIN_LIMITS, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { openZipEntries } from "../../zip-junk.js";
import {
	CARD_SKIN_MANIFEST_FILE,
	checkCardSkinPackage,
	MAX_CARD_SKIN_MANIFEST_BYTES,
	parseCardSkinPackage,
} from "../package.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** woff2 的魔数 `wOF2`;内容不解析,只要求后缀过白名单。 */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

function manifest(extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		dataVersion: 1,
		name: "测试卡片皮肤",
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

function pack(files: Record<string, Uint8Array | Record<string, unknown>>): Uint8Array {
	const out: Record<string, Uint8Array> = {};
	for (const [name, data] of Object.entries(files)) {
		out[name] = data instanceof Uint8Array ? data : strToU8(JSON.stringify(data));
	}
	return zipSync(out);
}

/** 摊包 + 验洗一条龙(装包那条路的全程),失败时把错误原样带出来。 */
function open(zip: Uint8Array) {
	const opened = parseCardSkinPackage(zip);
	if (!opened.ok) return { ok: false as const, errors: opened.errors };
	return checkCardSkinPackage(opened.manifestRaw, new Set(opened.assets.keys()));
}

describe("parseCardSkinPackage:文件层", () => {
	it("card-skin.json + 资产 → ok,清单与资产都取出", () => {
		const r = parseCardSkinPackage(
			pack({ [CARD_SKIN_MANIFEST_FILE]: manifest(), "assets/bg.png": PNG }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.manifestRaw as { name: string }).name).toBe("测试卡片皮肤");
		expect(r.assets.get("assets/bg.png")).toEqual(PNG);
	});

	it("缺 card-skin.json → 拒(而且说得出缺的是谁)", () => {
		const r = parseCardSkinPackage(pack({ "assets/bg.png": PNG }));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain(CARD_SKIN_MANIFEST_FILE);
	});

	it("不是 zip 的字节流 → 拒", () => {
		expect(parseCardSkinPackage(strToU8("这不是 zip")).ok).toBe(false);
	});

	it("card-skin.json 不是合法 JSON → 拒", () => {
		const r = parseCardSkinPackage(pack({ [CARD_SKIN_MANIFEST_FILE]: strToU8("{ 半截") }));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("JSON");
	});

	/**
	 * 资产名是要拼进磁盘路径与出图 HTML 的 `src` 的,所以名字的安全性**由构造保证**:
	 * 一级 `assets/` + 小写白名单字符 + 后缀白名单。这里每一条都留一个哨兵 —— 放宽任
	 * 何一条,下面这些就都进得来。
	 */
	it.each([
		["路径穿越", "assets/../../etc/passwd"],
		["二级目录", "assets/sub/bg.png"],
		["根目录的文件", "bg.png"],
		["能带脚本的 svg", "assets/bg.svg"],
		["没有后缀", "assets/bg"],
		["名字里带 ..", "assets/..png"],
		["大写与空格", "assets/Big Photo.PNG"],
		["夹带的可执行文件", "evil.sh"],
	])("资产名非法(%s)→ 整包拒", (_label, name) => {
		const r = parseCardSkinPackage(pack({ [CARD_SKIN_MANIFEST_FILE]: manifest(), [name]: PNG }));
		expect(r.ok).toBe(false);
	});

	it("字体与图片一视同仁地收下", () => {
		const r = parseCardSkinPackage(
			pack({ [CARD_SKIN_MANIFEST_FILE]: manifest(), "assets/font-a1.woff2": WOFF2 }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.assets.get("assets/font-a1.woff2")).toEqual(WOFF2);
	});

	it("单份资产超上限 → 拒(解压后按真实字节复核,不信 zip 头)", () => {
		const big = new Uint8Array(CARD_SKIN_LIMITS.maxAssetBytes + 1);
		big.set(PNG);
		const r = parseCardSkinPackage(
			pack({ [CARD_SKIN_MANIFEST_FILE]: manifest(), "assets/big.png": big }),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("assets/big.png");
	});

	it("装满 maxAssets 份 → 照收;多一份 → 拒(自己导出的满包必须传得回来)", () => {
		const files = (n: number): Record<string, Uint8Array | Record<string, unknown>> => {
			const out: Record<string, Uint8Array | Record<string, unknown>> = {
				[CARD_SKIN_MANIFEST_FILE]: manifest(),
			};
			for (let i = 0; i < n; i++) out[`assets/img-${i}.png`] = PNG;
			return out;
		};
		const full = parseCardSkinPackage(pack(files(CARD_SKIN_LIMITS.maxAssets)));
		expect(full.ok).toBe(true);
		if (full.ok) expect(full.assets.size).toBe(CARD_SKIN_LIMITS.maxAssets);

		const over = parseCardSkinPackage(pack(files(CARD_SKIN_LIMITS.maxAssets + 1)));
		expect(over.ok).toBe(false);
		if (over.ok) return;
		expect(over.errors.join()).toContain(String(CARD_SKIN_LIMITS.maxAssets));
	});

	it("macOS 打包垃圾静默忽略(用户自己压的包十有八九带)", () => {
		const r = parseCardSkinPackage(
			pack({
				[CARD_SKIN_MANIFEST_FILE]: manifest(),
				"__MACOSX/._card-skin.json": strToU8("junk"),
				".DS_Store": strToU8("junk"),
				"assets/.DS_Store": strToU8("junk"),
			}),
		);
		expect(r.ok).toBe(true);
	});
});

/**
 * 压缩炸弹的第一道闸:**解压前**按 zip 头声明的数量 / 大小预筛。
 *
 * 数量与清单体积两条拿真包打;总量那条不拿 70MB 的真包打 —— 那道闸是共用的
 * `openZipEntries`,把上限调小一样问得出「它会不会红」,而卡片皮肤传给它的两个数
 * 由上面那条「多一份就拒」与清单体积那条钉着。
 */
describe("zip bomb 两道闸", () => {
	/**
	 * 断言得盯住**是哪道闸开的口**,而且**不许引用实现里那个常量**:
	 *
	 * - 只问 `ok:false` 的话,把条目数那道整个拆掉都不会红 —— 夹带文件与超量资产各自
	 *   也会让它 false。所以它得是**唯一**那条错误(那正是「解压前就停手」的可观测形状)。
	 * - 条目数从 `MAX_CARD_SKIN_PACKAGE_FILES` 现算的话,把常量改成 9999 连包都跟着
	 *   变大,测试照样绿(实测,2026-09-13)—— 数量只从契约的 `maxAssets` 推。
	 */
	it("条目数超上限 → 解压前就拒,而且是唯一那条错误", () => {
		const files: Record<string, Uint8Array> = { "evil.sh": strToU8("rm -rf /") };
		for (let i = 0; i < CARD_SKIN_LIMITS.maxAssets + 3; i++) files[`assets/img-${i}.png`] = PNG;
		const r = parseCardSkinPackage(zipSync(files));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain("包内文件太多");
	});

	it("清单本身过大 → 拒(它和资产不是一条线)", () => {
		const huge = strToU8(`{}${" ".repeat(MAX_CARD_SKIN_MANIFEST_BYTES)}`);
		const r = parseCardSkinPackage(zipSync({ [CARD_SKIN_MANIFEST_FILE]: huge }));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain(CARD_SKIN_MANIFEST_FILE);
	});

	it("声明的解压总量超上限 → 解压前就拒", () => {
		const zip = zipSync({ "a.bin": new Uint8Array(4096), "b.bin": new Uint8Array(4096) });
		expect(openZipEntries(zip, { maxFiles: 10, maxTotalBytes: 8192 }).ok).toBe(true);
		const r = openZipEntries(zip, { maxFiles: 10, maxTotalBytes: 4096 });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("总大小");
	});
});

describe("checkCardSkinPackage:清单层", () => {
	it("形状不对 → 拒,错误指得出是哪个块", () => {
		const r = checkCardSkinPackage(
			manifest({
				cards: {
					live: {
						width: 600,
						blocks: [
							{
								id: "nope",
								kind: "builtin",
								builtin: "不存在的块",
								grid: { row: 1, column: 1, span: 12 },
							},
						],
					},
				},
			}),
			new Set(),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("不存在的块");
	});

	/**
	 * 这条是这一组的主角:**存盘的是洗过的产物**。
	 *
	 * 装一个同时带 `[data-bn="evilhook"]{}`(表上没有的挂点 —— 自 2026-09-13「开放重写」
	 * 起,自由的是挂点**之外**的段,挂点本身仍按块对表)与 `<script>` 的包 —— 产物里
	 * 两样都不许剩,而且得有 warning 说出去,否则作者只会看见「装上了、没生效」。
	 */
	it("CSS 与 HTML 的清洗产物写回 manifest,并各自留下 warning", () => {
		const r = open(
			pack({
				[CARD_SKIN_MANIFEST_FILE]: manifest({
					cards: {
						live: {
							width: 600,
							css: '[data-bn="glass"]{border-radius:12px}[data-bn="evilhook"]{color:red}',
							blocks: [
								{
									id: "cover",
									kind: "builtin",
									builtin: "cover",
									grid: { row: 1, column: 1, span: 12 },
									css: '[data-bn="image"]{border-radius:8px}[data-bn="evilhook"]{color:red}',
								},
								{
									id: "note",
									kind: "custom",
									grid: { row: 2, column: 1, span: 12 },
									html: '<div class="note">{up.name}</div><script>alert(1)</script>',
								},
							],
						},
					},
				}),
			}),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const card = r.manifest.cards.live;
		expect(card?.css).toBe('[data-bn="glass"]{border-radius:12px}');
		const [cover, note] = card?.blocks ?? [];
		// 块级 CSS 的产物带着归一后的 self 前缀(2026-09-13「开放重写」):`image` 是
		// 块内部的挂点、不能打头,清洗时补 `[data-bn="self"] ` 把它关回块里。
		expect(cover?.css).toBe('[data-bn="self"] [data-bn="image"]{border-radius:8px}');
		expect(note?.kind === "custom" ? note.html : "").toBe('<div class="note">{up.name}</div>');
		expect(JSON.stringify(r.manifest)).not.toContain("evil");
		expect(JSON.stringify(r.manifest)).not.toContain("script");
		expect(r.warnings.join()).toContain("cards.live.css");
		expect(r.warnings.join()).toContain("script");
	});

	it("洗空的 CSS 当没写(不留空串字段),但不拒整包", () => {
		const r = checkCardSkinPackage(
			manifest({
				cards: {
					live: {
						width: 600,
						css: '[data-bn="evilhook"]{color:red}',
						blocks: [
							{
								id: "cover",
								kind: "builtin",
								builtin: "cover",
								grid: { row: 1, column: 1, span: 12 },
								css: '[data-bn="evilhook"]{color:red}',
							},
						],
					},
				},
			}),
			new Set(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect("css" in (r.manifest.cards.live ?? {})).toBe(false);
		expect("css" in (r.manifest.cards.live?.blocks[0] ?? {})).toBe(false);
	});

	it("自定义块的占位符指向不存在的字段 → 拒(不是留个空洞推到群里)", () => {
		const r = checkCardSkinPackage(
			manifest({
				cards: {
					live: {
						width: 600,
						blocks: [
							{
								id: "note",
								kind: "custom",
								grid: { row: 1, column: 1, span: 12 },
								html: "<div>{up.nickname}</div>",
							},
						],
					},
				},
			}),
			new Set(),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("up.nickname");
	});

	it("自定义块引用包内资产:在包里 → 留;不在 → 丢掉那个 <img> 并告警", () => {
		const html = '<div>{up.name}<img src="asset:assets/logo.png" alt="logo"></div>';
		const card = (h: string) => ({
			live: {
				width: 600,
				blocks: [{ id: "note", kind: "custom", grid: { row: 1, column: 1, span: 12 }, html: h }],
			},
		});

		const kept = checkCardSkinPackage(
			manifest({ cards: card(html) }),
			new Set(["assets/logo.png"]),
		);
		expect(kept.ok).toBe(true);
		if (kept.ok) {
			const block = kept.manifest.cards.live?.blocks[0];
			expect(block?.kind === "custom" ? block.html : "").toContain("asset:assets/logo.png");
		}

		const dropped = checkCardSkinPackage(manifest({ cards: card(html) }), new Set());
		expect(dropped.ok).toBe(true);
		if (!dropped.ok) return;
		const block = dropped.manifest.cards.live?.blocks[0];
		expect(block?.kind === "custom" ? block.html : "").not.toContain("img");
		expect(dropped.warnings.join()).toContain("assets/logo.png");
	});

	it("backgroundImage 指向包里没有的资产 → 拒(全局与按卡种两处都拦)", () => {
		const missing = checkCardSkinPackage(
			manifest({ variables: { backgroundImage: "assets/bg.png" } }),
			new Set(),
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors.join()).toContain("assets/bg.png");

		const perKind = checkCardSkinPackage(
			manifest({ variablesByKind: { live: { backgroundImage: "assets/bg.png" } } }),
			new Set(),
		);
		expect(perKind.ok).toBe(false);
		if (!perKind.ok) expect(perKind.errors.join()).toContain("variablesByKind.live");

		const present = checkCardSkinPackage(
			manifest({ variables: { backgroundImage: "assets/bg.png" } }),
			new Set(["assets/bg.png"]),
		);
		expect(present.ok).toBe(true);
	});

	it("backgroundImage 指到字体上 → 拒(更像是复制粘贴串了行)", () => {
		const r = checkCardSkinPackage(
			manifest({ variables: { backgroundImage: "assets/font-a1.woff2" } }),
			new Set(["assets/font-a1.woff2"]),
		);
		expect(r.ok).toBe(false);
	});

	it("默认皮肤一字不改地过门 —— 它是格式够不够用的验收门(ADR-0014 决策 5)", () => {
		const raw = structuredClone(DEFAULT_CARD_SKIN);
		const r = checkCardSkinPackage(raw, new Set());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings).toEqual([]);
		expect(r.manifest.cards).toEqual(DEFAULT_CARD_SKIN.cards);
	});

	it("清洗不动调用方那份 raw(原对象一字不改)", () => {
		const raw = manifest({
			cards: {
				live: {
					width: 600,
					css: ".evil{color:red}",
					blocks: [
						{
							id: "cover",
							kind: "builtin",
							builtin: "cover",
							grid: { row: 1, column: 1, span: 12 },
						},
					],
				},
			},
		});
		const before = JSON.stringify(raw);
		expect(checkCardSkinPackage(raw, new Set()).ok).toBe(true);
		expect(JSON.stringify(raw)).toBe(before);
	});
});

describe("checkCardSkinPackage:资产变量与皮肤字体的引用(ADR-0014 决策 13 的 🔗)", () => {
	const withAssets = (over: Record<string, unknown>) =>
		manifest({
			cards: {
				live: {
					width: 600,
					blocks: [
						{
							id: "cover",
							kind: "builtin",
							builtin: "cover",
							grid: { row: 1, column: 1, span: 12 },
						},
					],
					...over,
				},
			},
		});

	it("根 / 块的 assets 表指向包里真有的资产 → ok", () => {
		const r = open(
			pack({
				[CARD_SKIN_MANIFEST_FILE]: withAssets({
					assets: { hud: "asset:assets/hud.png" },
					blocks: [
						{
							id: "cover",
							kind: "builtin",
							builtin: "cover",
							grid: { row: 1, column: 1, span: 12 },
							assets: { tex: "asset:assets/hud.png" },
						},
					],
				}),
				"assets/hud.png": PNG,
			}),
		);
		expect(r.ok).toBe(true);
	});

	it("assets 表指了包里没有的资产 → 拒,错误里点名变量与文件", () => {
		const r = open(
			pack({ [CARD_SKIN_MANIFEST_FILE]: withAssets({ assets: { hud: "asset:assets/nope.png" } }) }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.join()).toMatch(/assets\.hud.*assets\/nope\.png/);
	});

	it("fonts 指向包里的字体 → ok;指向不存在的 / 指向图片 → 拒", () => {
		const good = open(
			pack({
				[CARD_SKIN_MANIFEST_FILE]: manifest({
					fonts: [{ family: "Orbitron", asset: "asset:assets/orb.woff2" }],
				}),
				"assets/orb.woff2": WOFF2,
			}),
		);
		expect(good.ok).toBe(true);
		const missing = open(
			pack({
				[CARD_SKIN_MANIFEST_FILE]: manifest({
					fonts: [{ family: "Orbitron", asset: "asset:assets/orb.woff2" }],
				}),
			}),
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors.join()).toMatch(/fonts\[0\].*orb\.woff2/);
		const notFont = open(
			pack({
				[CARD_SKIN_MANIFEST_FILE]: manifest({
					fonts: [{ family: "Orbitron", asset: "asset:assets/hud.png" }],
				}),
				"assets/hud.png": PNG,
			}),
		);
		expect(notFont.ok).toBe(false);
		if (!notFont.ok) expect(notFont.errors.join()).toContain("不是字体");
	});
});
