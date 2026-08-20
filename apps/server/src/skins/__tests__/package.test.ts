/**
 * zip 皮肤包解析:不可信 zip → { manifest, assets } 或拒绝。
 *
 * 要点:① 包内文件白名单(skin.json + assets/ 图片),macOS 打包垃圾静默忽略;
 * ② manifest 引用的壁纸必须真的在包里;③ 大小 / 文件数上限防 zip bomb。
 */

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { openSkinPackage } from "../package.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** woff2 的魔数 `wOF2`;内容不解析,只要求后缀过白名单。 */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

function makeZip(files: Record<string, Uint8Array>): Uint8Array {
	return zipSync(files);
}

function manifestJson(extra?: Record<string, unknown>): Uint8Array {
	return strToU8(
		JSON.stringify({
			schemaVersion: 1,
			name: "测试皮肤",
			modes: { light: { colors: { accent: "#fb7299" } } },
			...extra,
		}),
	);
}

describe("openSkinPackage", () => {
	it("skin.json + 被引用的壁纸 → ok,manifest 与资产都取出", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { light: { wallpaper: { image: "assets/bg.png" } } },
			}),
			"assets/bg.png": PNG,
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.manifest.name).toBe("测试皮肤");
		expect(r.assets.get("assets/bg.png")).toEqual(PNG);
	});

	it("纯配色包(只有 skin.json)→ ok", () => {
		const r = openSkinPackage(makeZip({ "skin.json": manifestJson() }));
		expect(r.ok).toBe(true);
	});

	it("不是 zip 的字节流 → 拒绝", () => {
		const r = openSkinPackage(strToU8("这不是 zip"));
		expect(r.ok).toBe(false);
	});

	it("缺 skin.json → 拒绝", () => {
		const r = openSkinPackage(makeZip({ "assets/bg.png": PNG }));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("skin.json");
	});

	it("skin.json 不是合法 JSON → 拒绝", () => {
		const r = openSkinPackage(makeZip({ "skin.json": strToU8("{oops") }));
		expect(r.ok).toBe(false);
	});

	it("manifest 校验失败(非法颜色)→ 拒绝并透传字段级错误", () => {
		const zip = makeZip({
			"skin.json": strToU8(
				JSON.stringify({
					schemaVersion: 1,
					name: "t",
					modes: { light: { colors: { accent: "url(https://evil.example)" } } },
				}),
			),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("accent");
	});

	it("manifest 引用的壁纸不在包里 → 拒绝", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { dark: { wallpaper: { image: "assets/missing.webp" } } },
			}),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("assets/missing.webp");
	});

	it("chat.wallpaper 引用的图同样要在包里 → 缺了拒绝", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { light: { chat: { wallpaper: { image: "assets/chat-missing.webp" } } } },
			}),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("assets/chat-missing.webp");
	});

	it("包里混入白名单外的文件 → 拒绝;macOS 打包垃圾静默忽略", () => {
		const evil = openSkinPackage(
			makeZip({ "skin.json": manifestJson(), "evil.sh": strToU8("rm -rf /") }),
		);
		expect(evil.ok).toBe(false);

		const macJunk = openSkinPackage(
			makeZip({
				"skin.json": manifestJson(),
				"__MACOSX/._skin.json": strToU8("junk"),
				".DS_Store": strToU8("junk"),
			}),
		);
		expect(macJunk.ok).toBe(true);
	});

	it("包内未被引用的多余资产 → 不拒绝,给告警", () => {
		const r = openSkinPackage(makeZip({ "skin.json": manifestJson(), "assets/unused.png": PNG }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.join()).toContain("assets/unused.png");
	});

	it("单个资产超 5MB → 拒绝", () => {
		const big = new Uint8Array(5 * 1024 * 1024 + 1);
		big.set(PNG);
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { light: { wallpaper: { image: "assets/big.png" } } },
			}),
			"assets/big.png": big,
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toMatch(/5\s*MB|过大/);
	});

	it("被引用的字体文件 → ok,和壁纸一样取出来", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { light: { fonts: { asset: "assets/font-a1b2c3d4.woff2" } } },
			}),
			"assets/font-a1b2c3d4.woff2": WOFF2,
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.assets.get("assets/font-a1b2c3d4.woff2")).toEqual(WOFF2);
	});

	it("manifest 引用的字体不在包里 → 拒绝(与壁纸同一条纪律)", () => {
		// 收下的话,装上就是「编辑器里明明选着这款字、页面却是系统字」——
		// 本仓库反复复发的那类「选得动、存得住、就是不生效」。
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { dark: { fonts: { asset: "assets/font-missing.woff2" } } },
			}),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("assets/font-missing.woff2");
	});

	it("字体上限 20MB,图片仍旧 5MB —— 两条线各管各的", () => {
		// 一款完整中文 woff2 就有八九兆,拿图片那条 5MB 线卡它等于这功能不存在;
		// 反过来,别让字体放宽顺手把图片也放宽了(壁纸没有大到 20MB 的理由)。
		const bigFont = new Uint8Array(20 * 1024 * 1024 + 1);
		bigFont.set(WOFF2);
		const rejected = openSkinPackage(
			makeZip({
				"skin.json": manifestJson({
					modes: { light: { fonts: { asset: "assets/font-big.woff2" } } },
				}),
				"assets/font-big.woff2": bigFont,
			}),
		);
		expect(rejected.ok).toBe(false);

		const okFont = new Uint8Array(6 * 1024 * 1024);
		okFont.set(WOFF2);
		const accepted = openSkinPackage(
			makeZip({
				"skin.json": manifestJson({
					modes: { light: { fonts: { asset: "assets/font-ok.woff2" } } },
				}),
				"assets/font-ok.woff2": okFont,
			}),
		);
		expect(accepted.ok).toBe(true);

		const bigImage = new Uint8Array(6 * 1024 * 1024);
		bigImage.set(PNG);
		const image = openSkinPackage(
			makeZip({
				"skin.json": manifestJson({
					modes: { light: { wallpaper: { image: "assets/big.png" } } },
				}),
				"assets/big.png": bigImage,
			}),
		);
		expect(image.ok).toBe(false);
	});

	it("包里的原名清单被解析出来,而它自己不算一份资产", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { light: { wallpaper: { image: "assets/img-a1.png" } } },
			}),
			"assets/img-a1.png": PNG,
			"assets/index.json": strToU8(JSON.stringify({ "assets/img-a1.png": "樱花壁纸.png" })),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.names).toEqual({ "assets/img-a1.png": "樱花壁纸.png" });
		// 不进 assets:进了就会被当成一份资产落盘、列出、甚至 serve 出去。
		expect(r.assets.has("assets/index.json")).toBe(false);
		// 也不该被当成「带了但没引用的多余资产」告警。
		expect(r.warnings.join()).not.toContain("index.json");
	});

	it("清单坏掉 → 照收这个包,只是没名字(名字不是包的必要成分)", () => {
		const zip = makeZip({
			"skin.json": manifestJson(),
			"assets/index.json": strToU8("{这不是 JSON"),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.names).toEqual({});
	});

	it("清单里的键不是合法资产名 → 丢掉那条", () => {
		const zip = makeZip({
			"skin.json": manifestJson(),
			"assets/index.json": strToU8(
				JSON.stringify({ "../../etc/passwd": "坏", "assets/ok.png": "好.png" }),
			),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.names).toEqual({ "assets/ok.png": "好.png" });
	});

	it("文件数超上限 → 拒绝", () => {
		const files: Record<string, Uint8Array> = { "skin.json": manifestJson() };
		for (let i = 0; i < 20; i++) files[`assets/a${i}.png`] = PNG;
		const r = openSkinPackage(makeZip(files));
		expect(r.ok).toBe(false);
	});
});

describe("openSkinPackage / decorations 已下线", () => {
	it("存量包里的 decorations → 字段忽略告警,引用的图按未使用资产提示", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { dark: { decorations: [{ image: "assets/chara.png" }] } },
			}),
			"assets/chara.png": PNG,
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.some((w) => w.includes("decorations"))).toBe(true);
		expect(r.warnings.some((w) => w.includes("assets/chara.png"))).toBe(true);
	});
});
