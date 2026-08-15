/**
 * 制作引导页的两件纯函数:
 * - buildSkinPrompt:「schema 规格 + 当前令牌值 + 输出要求」拼成可粘给任意 AI 的提示词
 * - makeSkinZip:粘贴的 JSON + 可选壁纸 → 标准 zip(壁纸统一命名并同步 manifest 引用)
 */

import { SKIN_CSS_HOOK_MAP } from "@bilibili-notify/contract";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildSkinPrompt, makeSkinZip } from "../skin-pack";

describe("buildSkinPrompt", () => {
	const readVar = (name: string) =>
		({ "--color-bn-pink": "#fb7299", "--bn-page-bg": "linear-gradient(#fff, #eee)" })[name] ?? "";

	it("包含 schema 版本、语义键、当前值参考与「只输出 JSON」要求", () => {
		const p = buildSkinPrompt(readVar);
		expect(p).toContain("schemaVersion");
		expect(p).toContain("accent");
		expect(p).toContain("#fb7299");
		expect(p).toMatch(/只输出|只回复|仅输出/);
		expect(p).toContain("assets/wallpaper");
	});

	it("教会 AI 自定义 CSS:全部 hook 名、白名单要点、skin- 前缀与红线", () => {
		const p = buildSkinPrompt(readVar);
		for (const hook of Object.keys(SKIN_CSS_HOOK_MAP)) {
			expect(p).toContain(`"${hook}"`);
		}
		expect(p).toContain("data-bn");
		expect(p).toContain("skin-");
		expect(p).toMatch(/url\(/); // 明说 url() 禁用,别让 AI 白写
		expect(p).toMatch(/@keyframes/);
	});
});

describe("makeSkinZip", () => {
	const manifest = JSON.stringify({
		schemaVersion: 1,
		name: "t",
		modes: {
			light: { wallpaper: { image: "assets/wallpaper.webp", overlay: 0.3 } },
			dark: { colors: { accent: "#123456" } },
		},
	});

	it("无壁纸:zip 里只有 skin.json,内容原样", () => {
		const r = makeSkinZip(JSON.stringify({ schemaVersion: 1, name: "t", modes: { light: {} } }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const files = unzipSync(r.zip);
		expect(Object.keys(files)).toEqual(["skin.json"]);
	});

	it("带壁纸:文件进 assets/wallpaper.<ext>,manifest 里的壁纸引用同步改名", () => {
		const jpg = new Uint8Array([0xff, 0xd8, 0xff]);
		const r = makeSkinZip(manifest, { ext: "jpg", data: jpg });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const files = unzipSync(r.zip);
		expect(files["assets/wallpaper.jpg"]).toEqual(jpg);
		const packed = JSON.parse(strFromU8(files["skin.json"] as Uint8Array));
		expect(packed.modes.light.wallpaper.image).toBe("assets/wallpaper.jpg");
		// 没写 wallpaper 的 mode 不被强塞
		expect(packed.modes.dark.wallpaper).toBeUndefined();
	});

	it("JSON 写了壁纸但没拖图 → 提示缺图(交给服务端也会拒,前端先说人话)", () => {
		const r = makeSkinZip(manifest);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.join()).toMatch(/壁纸|图片/);
	});

	it("粘贴的不是合法 JSON → 报错不组包", () => {
		const r = makeSkinZip("{oops");
		expect(r.ok).toBe(false);
	});
});
