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

	/** 与服务端 ai-edit 那条路同一个理由,见该文件同名用例。 */
	it("教会 AI 文字四档的轻重顺序(secondary 恒重于 tertiary)", () => {
		const p = buildSkinPrompt(readVar);
		// 断言绑在讲这条规则的那一行、且顺序词与两个键名同处**一句**之内。
		// 松一档就白测:整份提示词里 textSecondary / textTertiary 各出现多次,
		// `textSecondary[^\n]*重[^\n]*textTertiary` 会在任意组合上蒙中(实测把
		// 「更重于」抽掉仍然绿);`textPrimary.*textSecondary.*textTertiary` 更是
		// COLOR_KEY_LIST 的天然排列,恒真。
		const rule = p.split("\n").find((l) => l.includes("文字四档"));
		expect(`提示词里有讲文字四档的那条 ${rule !== undefined}`).toBe(
			"提示词里有讲文字四档的那条 true",
		);
		expect(rule).toMatch(/textSecondary[^。]*更重于[^。]*textTertiary/);
	});

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

	it("教会 AI 壁纸糊化/白纱语义/行条键(玻璃叠玻璃定案)", () => {
		const p = buildSkinPrompt(readVar);
		expect(p).toContain("blur: 0~40");
		expect(p).toContain("白纱");
		expect(p).toContain("colors.listRow");
	});

	it("教会 AI 动效预设:两道菜都点名;已移除的动效与贴纸不再教", () => {
		const p = buildSkinPrompt(readVar);
		expect(p).toContain("effects");
		for (const k of ["glassShine", "bokeh"]) expect(p).toContain(k);
		for (const gone of ["backgroundFlow", "particles", "decorations"]) {
			expect(p).not.toContain(gone);
		}
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

	/**
	 * `chat.wallpaper` 与整页 wallpaper 是**同构共用**的一把尺(schema.ts 那句注释),
	 * 提示词里也明写着 chat 段可以有 wallpaper、image 同样只准引用包内 assets。
	 * 收集引用时却只走了 `modes.*.wallpaper` —— 于是 AI 老老实实产出的聊天壁纸皮肤,
	 * 拖进来的图不会被改成它引的名字,包必然在上传时被 `referencedAssets` 打回,
	 * 而报错只说「manifest 引用了它,包里没有」,不说是哪个 wallpaper 字段。
	 */
	const chatManifest = JSON.stringify({
		schemaVersion: 1,
		name: "t",
		modes: {
			dark: { chat: { wallpaper: { image: "assets/wallpaper.webp", overlay: 0.4 } } },
		},
	});

	it("chat.wallpaper 的引用一样要跟着改名 —— 它和整页壁纸是同一把尺", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const r = makeSkinZip(chatManifest, { ext: "png", data: png });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const files = unzipSync(r.zip);
		expect(files["assets/wallpaper.png"]).toEqual(png);
		const packed = JSON.parse(strFromU8(files["skin.json"] as Uint8Array));
		expect(packed.modes.dark.chat.wallpaper.image).toBe("assets/wallpaper.png");
		expect(r.warnings).toEqual([]);
	});

	it("只有 chat.wallpaper 却没拖图 → 照样提示缺图,别等服务端拒收才说", () => {
		const r = makeSkinZip(chatManifest);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.join()).toMatch(/壁纸|图片/);
	});
});
