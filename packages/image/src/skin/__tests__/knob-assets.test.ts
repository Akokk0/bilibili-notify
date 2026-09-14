/**
 * 字体 / 图两档旋钮的**宿主解析**(ADR-0014 决策 16 的 🔗,2026-09-14 主人拍板)。
 *
 * 这两档与别的旋钮不同:值不是 CSS 字面量,而是主人资产库里的一个 id —— 字体要读盘
 * 拼成 `@font-face`,图要读盘变成 data URL。钉四条,各对应一个静默失败:
 * ① **解析不出来就不注**(资产被删了 / 卷丢了):注一条空 `url("")` 进去,卡片背景当场
 *    变白,而皮肤 CSS 里本来写好的兜底一行都不会生效;② **多张按推送轮换**(与从前那个
 *    背景图库一字不差,少了它就是「选了三张只出第一张」);③ 同一款字体**只内联一次**
 *    (一款中文字库 base64 之后二三十兆,而镜像里 V8 的 old-space 只有 512MB);
 * ④ 图的变量值**自带 `center / cover`** —— 尺寸不能挪到皮肤 CSS 那头写(渐变一带尺寸
 *    就换了光栅抖动,像素门 14 张红过)。
 */

import type { CardSkinKnob } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolveKnobAssets } from "../knob-assets";

const FONT: CardSkinKnob = { key: "font", label: "字体", type: "font", default: "" };
const WALL: CardSkinKnob = { key: "wallpaper", label: "壁纸", type: "image" };

const resolvers = (over: Partial<Parameters<typeof resolveKnobAssets>[2]> = {}) => ({
	image: vi.fn(async (id: string) => `data:image/png;base64,${id}`),
	fontFace: vi.fn(async (id: string) => `@font-face{font-family:"bn-user-font";src:url("${id}")}`),
	...over,
});

describe("resolveKnobAssets", () => {
	it("家族名直接进变量(带兜底链)——皮肤写 var(--bn-knob-font) 就能用", async () => {
		const r = resolvers();
		const out = await resolveKnobAssets([FONT], { font: "Source Han Sans" }, r);
		expect(out.vars).toContain('--bn-knob-font:"Source Han Sans"');
		expect(out.vars).toContain("sans-serif");
		expect(out.fontFaces).toBe("");
		expect(r.fontFace).not.toHaveBeenCalled();
	});

	it("主人传的字体文件 → 多一条 @font-face,变量指向它", async () => {
		const r = resolvers();
		const out = await resolveKnobAssets([FONT], { font: "upload:f1" }, r);
		expect(r.fontFace).toHaveBeenCalledWith("f1");
		expect(out.fontFaces).toContain("@font-face");
		expect(out.vars).toContain('--bn-knob-font:"bn-user-font"');
	});

	it("同一款字体被两枚旋钮指着 → 只内联一次(一款中文字库二三十兆)", async () => {
		const r = resolvers();
		const second: CardSkinKnob = {
			key: "title-font",
			label: "标题字体",
			type: "font",
			default: "",
		};
		const out = await resolveKnobAssets(
			[FONT, second],
			{ font: "upload:f1", "title-font": "upload:f1" },
			r,
		);
		expect(r.fontFace).toHaveBeenCalledTimes(1);
		expect(out.fontFaces.match(/@font-face/g)).toHaveLength(1);
		expect(out.vars).toContain("--bn-knob-title-font");
	});

	it("图:变量值自带 center / cover", async () => {
		const out = await resolveKnobAssets([WALL], { wallpaper: ["a1"] }, resolvers());
		expect(out.vars).toBe('--bn-knob-wallpaper:url("data:image/png;base64,a1") center / cover;');
	});

	it("多张按推送轮换 —— 选第几张由调用方给", async () => {
		const r = resolvers({ pick: (n: number) => 1 % n });
		const out = await resolveKnobAssets([WALL], { wallpaper: ["a1", "a2"] }, r);
		expect(out.vars).toContain("a2");
	});

	it("资产解析不出来(被删了 / 卷丢了)→ 那一条干脆不注,皮肤 CSS 的兜底照旧生效", async () => {
		const r = resolvers({ image: vi.fn(async () => ""), fontFace: vi.fn(async () => "") });
		const out = await resolveKnobAssets(
			[FONT, WALL],
			{ font: "upload:gone", wallpaper: ["gone"] },
			r,
		);
		expect(out.vars).toBe("");
		expect(out.fontFaces).toBe("");
	});

	it("没声明 / 没拧过 / 值是残的 → 什么都不做,一次盘都不读", async () => {
		const r = resolvers();
		expect(await resolveKnobAssets(undefined, { font: "Menlo" }, r)).toEqual({
			vars: "",
			fontFaces: "",
		});
		expect((await resolveKnobAssets([FONT, WALL], {}, r)).vars).toBe("");
		expect((await resolveKnobAssets([WALL], { wallpaper: "a1" as never }, r)).vars).toBe("");
		expect(r.image).not.toHaveBeenCalled();
	});
});
