/**
 * 抽屉内嵌 AI 的服务端逻辑:
 * - buildSkinAiSystemPrompt:schema 规格 + CSS hook/白名单 + 包内资产约束 + 只输出 JSON
 * - runSkinAiEdit:调 generateRaw → 剥围栏 → parseSkinManifest + 资产引用校验;
 *   失败**带错误反馈自动重试一次**,二败才对外报错。产物是清洗后的 manifest,不落盘。
 */

import { SKIN_CSS_HOOK_MAP } from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import { buildSkinAiSystemPrompt, runSkinAiEdit } from "../ai-edit.js";

const ASSETS = ["assets/bg.png", "assets/deco.webp"];

const DRAFT = { schemaVersion: 1, name: "樱花夜", modes: { light: {} } };

function validJson(extra?: object): string {
	return JSON.stringify({ ...DRAFT, name: "樱花夜·AI", ...extra });
}

describe("buildSkinAiSystemPrompt", () => {
	it("包含 hook 名单、skin- 前缀规则、资产清单与「只输出 JSON」", () => {
		const p = buildSkinAiSystemPrompt(ASSETS);
		for (const hook of Object.keys(SKIN_CSS_HOOK_MAP)) {
			expect(p).toContain(`"${hook}"`);
		}
		expect(p).toContain("skin-");
		expect(p).toContain("assets/bg.png");
		expect(p).toContain("assets/deco.webp");
		expect(p).toMatch(/只输出|仅输出/);
	});

	it("壁纸糊化与行条键都教到(玻璃叠玻璃定案)", () => {
		const p = buildSkinAiSystemPrompt(ASSETS);
		expect(p).toContain("blur 0~40");
		expect(p).toContain("白纱");
		expect(p).toContain("listRow");
	});

	it("动效预设两道菜都点名;已移除的动效与贴纸不许再教给内嵌 AI", () => {
		const p = buildSkinAiSystemPrompt(ASSETS);
		for (const k of ["glassShine", "bokeh"]) expect(p).toContain(k);
		for (const gone of ["backgroundFlow", "particles", "decorations"]) {
			expect(p).not.toContain(gone);
		}
	});

	it("包里没有图时明说别引用图片字段", () => {
		expect(buildSkinAiSystemPrompt([])).toMatch(/没有.*图片|无.*图片/);
	});
});

describe("runSkinAiEdit", () => {
	it("一次给出合法 JSON(哪怕带代码围栏)→ ok,manifest 是清洗后的产物", async () => {
		const gen = vi.fn(async (_system: string, _user: string) =>
			[
				"```json",
				validJson({ css: '[data-bn="glass"]{border-width:2px} div{color:red}' }),
				"```",
			].join("\n"),
		);
		const res = await runSkinAiEdit({
			generateRaw: gen,
			assets: ASSETS,
			draft: DRAFT,
			instruction: "名字加个 AI 后缀",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.manifest.name).toBe("樱花夜·AI");
		// css 过了清洗:div 选择器被丢并进 warnings
		expect(res.manifest.css).toContain("border-width:2px");
		expect(res.manifest.css).not.toContain("color");
		expect(res.warnings.join()).toContain("div");
		expect(gen).toHaveBeenCalledTimes(1);
		// user 消息里带着草稿与要求
		const user = gen.mock.calls[0]?.[1] ?? "";
		expect(user).toContain("樱花夜");
		expect(user).toContain("名字加个 AI 后缀");
	});

	it("首答烂 JSON → 自动重试且反馈里带错误;二答合法 → ok", async () => {
		const gen = vi
			.fn<(system: string, user: string) => Promise<string>>()
			.mockResolvedValueOnce("这不是 JSON 哦~")
			.mockResolvedValueOnce(validJson());
		const res = await runSkinAiEdit({
			generateRaw: gen,
			assets: ASSETS,
			draft: DRAFT,
			instruction: "改名",
		});
		expect(res.ok).toBe(true);
		expect(gen).toHaveBeenCalledTimes(2);
		const retryUser = gen.mock.calls[1]?.[1] ?? "";
		expect(retryUser).toMatch(/校验|不是合法|错误/);
	});

	it("引用清单外的图片 → 校验失败进重试;两答都不合法 → ok:false 带 errors,只调两次", async () => {
		const bad = JSON.stringify({
			...DRAFT,
			modes: { light: { wallpaper: { image: "assets/nope.png" } } },
		});
		const gen = vi.fn<(system: string, user: string) => Promise<string>>().mockResolvedValue(bad);
		const res = await runSkinAiEdit({
			generateRaw: gen,
			assets: ASSETS,
			draft: DRAFT,
			instruction: "加壁纸",
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.errors.join()).toContain("assets/nope.png");
		expect(gen).toHaveBeenCalledTimes(2);
	});
});
