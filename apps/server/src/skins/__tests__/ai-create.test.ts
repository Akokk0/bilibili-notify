/**
 * 聊天里「女仆,给我做一套皮肤」的服务端生成。
 *
 * 与 `ai-edit` 同一条纪律(剥围栏 → parseSkinManifest 清洗 → 资产引用校验 →
 * 首答不过带错误反馈重试一次),差别只有两处:
 * - 起点是**一句话**,不是现成 draft —— 所以 system 里必须把可用的 colors 键
 *   摊开给 AI 看,否则它从零写只能瞎编键名,写出来的一片被静默忽略。
 * - 新包里**一张图都没有**(聊天里递不了图) —— 任何壁纸引用当场拒收。
 */

import {
	SKIN_COLOR_TOKEN_MAP,
	SKIN_CSS_HOOK_MAP,
	type SkinCssHook,
} from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import { runSkinAiCreate } from "../ai-create.js";
import { SKIN_CSS_HOOK_NOTES } from "../ai-edit.js";
import { WALLPAPER_IMAGE_RE } from "../schema.js";

const SKIN = {
	schemaVersion: 1,
	name: "夜航灯",
	modes: { dark: { colors: { accent: "#00e5ff" } } },
};

function gen(...answers: string[]) {
	let i = 0;
	return vi.fn(async (_system: string, _user: string) => answers[i++] ?? answers.at(-1) ?? "");
}

describe("runSkinAiCreate", () => {
	it("一次给出合法 JSON(哪怕带围栏)→ ok,产物是清洗后的 manifest", async () => {
		const g = gen(
			[
				"```json",
				JSON.stringify({ ...SKIN, css: '[data-bn="glass"]{border-width:2px}' }),
				"```",
			].join("\n"),
		);
		const res = await runSkinAiCreate({ generateRaw: g, brief: "赛博朋克风,暗色,青色霓虹" });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.manifest.name).toBe("夜航灯");
		expect(res.manifest.modes.dark?.colors?.accent).toBe("#00e5ff");
		expect(g).toHaveBeenCalledTimes(1);
		// 主人的要求原样进 user 消息 —— 生成靠它,丢了就成了随机出图。
		expect(g.mock.calls[0]?.[1] ?? "").toContain("赛博朋克风,暗色,青色霓虹");
	});

	/**
	 * 真机上栽的那一跤(2026-08-18,「樱落 · 樱泽墨」):图已经拿到手、也落了盘,
	 * 可设计师看到素材清单写的是「可用图片」,就当成可选、干脆没写 wallpaper ——
	 * 主人拿到一套纯色底皮肤,女仆还得跟主人解释壁纸没做上。一趟生成好几分钟,
	 * 不能靠设计师这一遍的心情。
	 */
	describe("主人指定了壁纸", () => {
		it("设计师没写 wallpaper → 服务端补进每一套 mode", async () => {
			const g = gen(JSON.stringify({ ...SKIN, modes: { light: {}, dark: {} } }));
			const res = await runSkinAiCreate({
				generateRaw: g,
				brief: "樱花粉浅色",
				assets: ["assets/wallpaper.jpg"],
				wallpaper: "assets/wallpaper.jpg",
			});

			expect(res.ok).toBe(true);
			if (!res.ok) return;
			for (const mode of ["light", "dark"] as const) {
				expect(res.manifest.modes[mode]?.wallpaper?.image).toBe("assets/wallpaper.jpg");
			}
		});

		it("设计师自己配好了就不动它 —— 它挑的 overlay / blur 比兜底值懂行", async () => {
			const g = gen(
				JSON.stringify({
					...SKIN,
					modes: {
						light: { wallpaper: { image: "assets/wallpaper.jpg", overlay: 0.5, blur: 20 } },
					},
				}),
			);
			const res = await runSkinAiCreate({
				generateRaw: g,
				brief: "樱花粉浅色",
				assets: ["assets/wallpaper.jpg"],
				wallpaper: "assets/wallpaper.jpg",
			});

			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.manifest.modes.light?.wallpaper?.overlay).toBe(0.5);
			expect(res.manifest.modes.light?.wallpaper?.blur).toBe(20);
		});

		it("补出来的壁纸得是合法值 —— 兜底路径绕开了模型,可没绕开 schema", async () => {
			const g = gen(JSON.stringify({ ...SKIN, modes: { light: {} } }));
			const res = await runSkinAiCreate({
				generateRaw: g,
				brief: "樱花粉浅色",
				assets: ["assets/wallpaper.jpg"],
				wallpaper: "assets/wallpaper.jpg",
			});

			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const wp = res.manifest.modes.light?.wallpaper;
			expect(WALLPAPER_IMAGE_RE.test(wp?.image ?? "")).toBe(true);
			expect(wp?.overlay).toBeGreaterThanOrEqual(0);
			expect(wp?.overlay).toBeLessThanOrEqual(0.8);
			expect(wp?.blur).toBeGreaterThanOrEqual(0);
			expect(wp?.blur).toBeLessThanOrEqual(40);
		});

		it("system 把素材说成硬要求 —— 「可用」这个措辞正是上次被绕开的口子", async () => {
			const g = gen(JSON.stringify(SKIN));
			await runSkinAiCreate({
				generateRaw: g,
				brief: "樱花粉浅色",
				assets: ["assets/wallpaper.jpg"],
				wallpaper: "assets/wallpaper.jpg",
			});

			const system = g.mock.calls[0]?.[0] ?? "";
			expect(system).toContain("assets/wallpaper.jpg");
			// 「必须」在别处的规则里也出现(@keyframes 那条),所以要求它跟素材段挨着 ——
			// 否则这条断言换个提示词照样绿,等于没测。
			const note = system.slice(0, system.indexOf("assets/wallpaper.jpg") + 200);
			expect(note.slice(note.lastIndexOf("包内"))).toMatch(/必须用上/);
		});
	});

	it("system 摊开可用的 colors 键 —— 从零设计不能靠猜键名", async () => {
		const g = gen(JSON.stringify(SKIN));
		await runSkinAiCreate({ generateRaw: g, brief: "随便来一套" });

		const system = g.mock.calls[0]?.[0] ?? "";
		for (const key of ["accent", "textPrimary", "surface", "listRow", "danger"]) {
			expect(system).toContain(key);
		}
		// 抽查够了,但键名总数别掉队:少一半就是这张表换了形状而提示词没跟上。
		const present = Object.keys(SKIN_COLOR_TOKEN_MAP).filter((k) => system.includes(k));
		expect(present.length).toBe(Object.keys(SKIN_COLOR_TOKEN_MAP).length);
	});

	it("system 交代 brief 里的具体色值要照用 —— 不然聊天里查来的配色白查", async () => {
		// 聊天那一层可以联网查「某部作品的代表色」,但结果只能经 brief 递到这一跳。
		// 设计师若自顾自另配一套,查资料这条链就断在最后一步。
		const g = gen(JSON.stringify(SKIN));
		await runSkinAiCreate({ generateRaw: g, brief: "初音未来风,主色 #39C5BB" });

		expect(g.mock.calls[0]?.[0] ?? "").toMatch(/给了具体色值|指定了色值/);
	});

	it("system 交代每个 CSS 挂点长什么样 —— 光给名字,AI 只能按名字猜形状", async () => {
		const g = gen(JSON.stringify(SKIN));
		await runSkinAiCreate({ generateRaw: g, brief: "随便来一套" });

		const system = g.mock.calls[0]?.[0] ?? "";
		// 说明表必须覆盖全部挂点 —— 加了新挂点不补说明,AI 就又回到瞎猜。
		for (const hook of Object.keys(SKIN_CSS_HOOK_MAP)) {
			expect(Object.keys(SKIN_CSS_HOOK_NOTES)).toContain(hook);
			expect(system).toContain(SKIN_CSS_HOOK_NOTES[hook as SkinCssHook]);
		}
	});

	it("system 拦住「容器套胶囊圆角」—— 真机上 nav 被 999px 压成了一个大椭圆", async () => {
		const g = gen(JSON.stringify(SKIN));
		await runSkinAiCreate({ generateRaw: g, brief: "随便来一套" });

		expect(g.mock.calls[0]?.[0] ?? "").toContain("999px");
		// nav 在这个面板里既有横向 tab 条也有竖向分区列表,这句是那次事故的解药。
		expect(SKIN_CSS_HOOK_NOTES.nav).toMatch(/竖/);
	});

	it("system 写明 fonts.body 最多 8 个 —— 不说,AI 会照 CSS 习惯列一长串", async () => {
		const g = gen(JSON.stringify(SKIN));
		await runSkinAiCreate({ generateRaw: g, brief: "随便来一套" });

		expect(g.mock.calls[0]?.[0] ?? "").toMatch(/最多 8 个|≤ ?8 个/);
	});

	it("system 明说包里没有图片 —— 聊天里递不了壁纸", async () => {
		const g = gen(JSON.stringify(SKIN));
		await runSkinAiCreate({ generateRaw: g, brief: "随便来一套" });

		expect(g.mock.calls[0]?.[0] ?? "").toMatch(/没有.*图片|无.*图片/);
	});

	it("产物引用了壁纸 → 拒收(包里根本没有那张图)", async () => {
		const bad = JSON.stringify({
			...SKIN,
			modes: { dark: { wallpaper: { image: "assets/wallpaper.webp" } } },
		});
		const res = await runSkinAiCreate({ generateRaw: gen(bad, bad), brief: "带张壁纸" });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.errors.join()).toContain("assets/wallpaper.webp");
	});

	it("首答不是 JSON → 带错误反馈重试一次,第二答合法就 ok", async () => {
		const g = gen("我觉得可以这样:", JSON.stringify(SKIN));
		const res = await runSkinAiCreate({ generateRaw: g, brief: "暗色" });

		expect(res.ok).toBe(true);
		expect(g).toHaveBeenCalledTimes(2);
		// 重试的 user 里带上「上次错在哪」,否则弱模型只会原样再错一遍。
		const retryUser = g.mock.calls[1]?.[1] ?? "";
		expect(retryUser).toContain("暗色");
		expect(retryUser).toMatch(/未通过校验|不是合法 JSON/);
	});

	it("两答都不过 → ok:false,错误串给上层转述", async () => {
		const res = await runSkinAiCreate({ generateRaw: gen("不行", "还是不行"), brief: "暗色" });

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.errors.length).toBeGreaterThan(0);
	});
});
