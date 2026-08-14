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

	it("文件数超上限 → 拒绝", () => {
		const files: Record<string, Uint8Array> = { "skin.json": manifestJson() };
		for (let i = 0; i < 20; i++) files[`assets/a${i}.png`] = PNG;
		const r = openSkinPackage(makeZip(files));
		expect(r.ok).toBe(false);
	});
});

describe("openSkinPackage / decorations 与 banner 的资产引用", () => {
	it("decorations/banner 引用的图在包里 → ok 且计入已引用(不再告警未使用)", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: {
					dark: {
						decorations: [{ image: "assets/chara.png" }],
						banner: { image: "assets/hero.png" },
					},
				},
			}),
			"assets/chara.png": PNG,
			"assets/hero.png": PNG,
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings).toEqual([]);
	});

	it("decorations 引用的图缺失 → 拒绝并点名文件", () => {
		const zip = makeZip({
			"skin.json": manifestJson({
				modes: { dark: { decorations: [{ image: "assets/missing.png" }] } },
			}),
		});
		const r = openSkinPackage(zip);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.join()).toContain("assets/missing.png");
	});
});
