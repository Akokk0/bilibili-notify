// @vitest-environment jsdom

/**
 * 皮肤合成层:语义字段 → CSS 变量表 → documentElement 注入。
 * 预览与正式应用共用同一套合成函数(定案);单套皮肤锁模式;?skin=off 逃生舱。
 */

import type { SkinManifest, SkinMode } from "@bilibili-notify/contract";
import { describe, expect, it } from "vitest";
import {
	applySkinCss,
	applySkinVars,
	clearSkinCss,
	clearSkinVars,
	composeChatWallpaperCss,
	composeEffectsCss,
	composeSkinCss,
	composeSkinVars,
	composeWallpaperCss,
	resolveSkinMode,
	skinKillSwitchActive,
	translateSkinCssHooks,
} from "../skin";

const assetUrl = (name: string) => `/api/skins/abc/assets/${name.slice("assets/".length)}`;

describe("composeSkinVars", () => {
	it("colors 语义键映射到内部 --bn-* 变量", () => {
		const vars = composeSkinVars(
			{ colors: { accent: "#123456", textPrimary: "#111111", dangerSoft: "#fee" } },
			assetUrl,
			"light",
		);
		expect(vars["--color-bn-pink"]).toBe("#123456");
		expect(vars["--color-bn-text-primary"]).toBe("#111111");
		expect(vars["--color-bn-danger-soft"]).toBe("#fee");
	});

	it("page.background → --bn-page-bg", () => {
		const vars = composeSkinVars({ page: { background: "#fef0f4" } }, assetUrl, "light");
		expect(vars["--bn-page-bg"]).toBe("#fef0f4");
	});

	it("wallpaper 合成:overlay 纱跟模式走(亮=白纱/暗=黑纱)+ 资产 URL + cover,并覆盖 page.background", () => {
		const mode: SkinMode = {
			page: { background: "#000000" },
			wallpaper: { image: "assets/bg.webp", fit: "cover", overlay: 0.3 },
		};
		const light = composeSkinVars(mode, assetUrl, "light");
		expect(light["--bn-page-bg"]).toContain('url("/api/skins/abc/assets/bg.webp")');
		expect(light["--bn-page-bg"]).toContain("rgba(255, 255, 255, 0.3)");
		expect(light["--bn-page-bg"]).toContain("cover");
		expect(light["--bn-page-bg"]).not.toContain("#000000");

		const dark = composeSkinVars(mode, assetUrl, "dark");
		expect(dark["--bn-page-bg"]).toContain("rgba(0, 0, 0, 0.3)");
	});

	it("wallpaper tile 铺法用 repeat,不带 cover", () => {
		const vars = composeSkinVars(
			{ wallpaper: { image: "assets/bg.png", fit: "tile" } },
			assetUrl,
			"light",
		);
		expect(vars["--bn-page-bg"]).toContain("repeat");
		expect(vars["--bn-page-bg"]).not.toContain("cover");
	});

	it("glass 六键映射,blur 数字拼 px", () => {
		const vars = composeSkinVars(
			{
				glass: {
					background: "rgba(255, 255, 255, 0.5)",
					border: "rgba(255, 255, 255, 0.3)",
					strongBackground: "rgba(255, 255, 255, 0.9)",
					strongBorder: "rgba(0, 0, 0, 0.05)",
					blur: 20,
					strongBlur: 28,
				},
			},
			assetUrl,
			"light",
		);
		expect(vars["--bn-glass-bg"]).toBe("rgba(255, 255, 255, 0.5)");
		expect(vars["--bn-glass-border"]).toBe("rgba(255, 255, 255, 0.3)");
		expect(vars["--bn-glass-strong-bg"]).toBe("rgba(255, 255, 255, 0.9)");
		expect(vars["--bn-glass-strong-border"]).toBe("rgba(0, 0, 0, 0.05)");
		expect(vars["--bn-glass-blur"]).toBe("20px");
		expect(vars["--bn-glass-strong-blur"]).toBe("28px");
	});

	it("fonts.body:带空格/中文的名字加引号,末尾补 system-ui 兜底", () => {
		const vars = composeSkinVars(
			{ fonts: { body: ["LXGW WenKai", "霞鹜文楷", "monospace"] } },
			assetUrl,
			"light",
		);
		expect(vars["--font-cjk"]).toBe('"LXGW WenKai", "霞鹜文楷", monospace, system-ui, sans-serif');
	});

	it("radius 数字拼 px", () => {
		const vars = composeSkinVars({ radius: { card: 8, pill: 12 } }, assetUrl, "light");
		expect(vars["--radius-bn-card"]).toBe("8px");
		expect(vars["--radius-bn-pill"]).toBe("12px");
	});

	it("空 mode → 空对象,全回默认装(聊天观感也走 :root 的 token 派生链,无需 JS 输出)", () => {
		expect(composeSkinVars({}, assetUrl, "light")).toEqual({});
	});

	it("colors 新键 listRow/listRowBorder 映射到行条变量", () => {
		const vars = composeSkinVars(
			{ colors: { listRow: "rgba(255, 255, 255, 0.45)", listRowBorder: "#39c5bb" } },
			assetUrl,
			"light",
		);
		expect(vars["--color-bn-list-row"]).toBe("rgba(255, 255, 255, 0.45)");
		expect(vars["--color-bn-list-row-border"]).toBe("#39c5bb");
	});
});

describe("composeWallpaperCss(壁纸糊化层)", () => {
	const wp = { image: "assets/bg.webp", overlay: 0.3, blur: 12 } as const;

	/**
	 * 为什么是 `html::before` 而不是 `body::before`:`page` 挂点就是 `body`,皮肤
	 * 完全可以写 `[data-bn="page"]::before`(飘花瓣那类氛围层就得这么写)。两边抢
	 * 同一个伪元素时 CSS 按声明**逐条**合并 —— 真机上「樱墨 · Sakura Ink」的花瓣
	 * 把壁纸糊化层压成了 14×12px 且 opacity:0 的一小块,主人的壁纸就这么没了,
	 * 且构建全绿、只在装上那一刻才看得出来。`html` 不是任何挂点,抢不到。
	 */
	it("blur>0:壁纸(含纱)整体搬进 html::before 固定层做静态高斯模糊", () => {
		const css = composeWallpaperCss({ wallpaper: { ...wp } }, assetUrl, "light");
		expect(css).toContain("html::before");
		// body::before 留给皮肤的 page 氛围层,我们不占
		expect(css).not.toContain("body::before");
		expect(css).toContain("position:fixed");
		expect(css).toContain("filter:blur(12px)");
		// 负 inset 外扩,遮掉 blur 的边缘透底
		expect(css).toContain("inset:-24px");
		expect(css).toContain('url("/api/skins/abc/assets/bg.webp")');
		expect(css).toContain("rgba(255, 255, 255, 0.3)");
		// 纱色照旧跟模式走
		expect(composeWallpaperCss({ wallpaper: { ...wp } }, assetUrl, "dark")).toContain(
			"rgba(0, 0, 0, 0.3)",
		);
	});

	it("blur>0 时 --bn-page-bg 不再放壁纸(留给 page.background/默认底)", () => {
		const vars = composeSkinVars(
			{ page: { background: "#101010" }, wallpaper: { ...wp } },
			assetUrl,
			"light",
		);
		expect(vars["--bn-page-bg"]).toBe("#101010");
	});

	it("没配 blur → 返回空串,壁纸照旧走 --bn-page-bg(现状不变)", () => {
		const mode: SkinMode = { wallpaper: { image: "assets/bg.webp" } };
		expect(composeWallpaperCss(mode, assetUrl, "light")).toBe("");
		expect(composeSkinVars(mode, assetUrl, "light")["--bn-page-bg"]).toContain("url(");
	});
});

describe("resolveSkinMode(单套锁模式)", () => {
	const light: SkinMode = { colors: { accent: "#aaa111" } };
	const dark: SkinMode = { colors: { accent: "#bbb222" } };

	it("双套皮肤:跟随请求的模式,不锁", () => {
		const skin: SkinManifest = { schemaVersion: 1, name: "t", modes: { light, dark } };
		expect(resolveSkinMode(skin, "dark")).toEqual({ mode: dark, theme: "dark", locked: false });
		expect(resolveSkinMode(skin, "light")).toEqual({ mode: light, theme: "light", locked: false });
	});

	it("只有 dark 一套:请求 light 也锁到 dark", () => {
		const skin: SkinManifest = { schemaVersion: 1, name: "t", modes: { dark } };
		expect(resolveSkinMode(skin, "light")).toEqual({ mode: dark, theme: "dark", locked: true });
	});
});

describe("applySkinVars / clearSkinVars", () => {
	it("注入 setProperty;clear 把上次注入的全部移除", () => {
		const el = document.createElement("div");
		applySkinVars(el, { "--color-bn-pink": "#123456", "--bn-page-bg": "#fff" });
		expect(el.style.getPropertyValue("--color-bn-pink")).toBe("#123456");

		// 换一套变量更少的皮肤:上一套的残留键必须被清掉
		applySkinVars(el, { "--bn-page-bg": "#000" });
		expect(el.style.getPropertyValue("--color-bn-pink")).toBe("");
		expect(el.style.getPropertyValue("--bn-page-bg")).toBe("#000");

		clearSkinVars(el);
		expect(el.style.getPropertyValue("--bn-page-bg")).toBe("");
	});
});

describe("skinKillSwitchActive(?skin=off 逃生舱)", () => {
	it("?skin=off → true;其余 → false", () => {
		expect(skinKillSwitchActive("?skin=off")).toBe(true);
		expect(skinKillSwitchActive("?foo=1&skin=off")).toBe(true);
		expect(skinKillSwitchActive("?skin=on")).toBe(false);
		expect(skinKillSwitchActive("")).toBe(false);
	});
});

describe("composeSkinVars / shadows(辉光)", () => {
	it("card/elev 映射到 --shadow-bn-* 变量", () => {
		const vars = composeSkinVars(
			{
				shadows: {
					card: "0 10px 30px rgba(57, 197, 187, 0.25)",
					elev: "0 18px 50px rgba(57, 197, 187, 0.4)",
				},
			},
			assetUrl,
			"light",
		);
		expect(vars["--shadow-bn-card"]).toBe("0 10px 30px rgba(57, 197, 187, 0.25)");
		expect(vars["--shadow-bn-elev"]).toBe("0 18px 50px rgba(57, 197, 187, 0.4)");
	});
});

describe("自定义 CSS:hook 翻译与合成", () => {
	it("hook 按映射表翻译成真实选择器;未知 hook 原样保留(命中不了任何元素)", () => {
		expect(translateSkinCssHooks('[data-bn="glass"]:hover{border-width:2px}')).toBe(
			".bn-glass:hover{border-width:2px}",
		);
		expect(translateSkinCssHooks('[data-bn="page"]::before{content:""}')).toBe(
			'body::before{content:""}',
		);
		// 挂属性的组件 hook → ~= 匹配(一个元素可挂多个 hook)
		expect(translateSkinCssHooks('[data-bn="btn-primary"]{opacity:0.9}')).toBe(
			'[data-bn~="btn-primary"]{opacity:0.9}',
		);
		// 无引号形式(css-tree 对 Identifier 值的序列化)同样认
		expect(translateSkinCssHooks("[data-bn=glass]{opacity:1}")).toBe(".bn-glass{opacity:1}");
		expect(translateSkinCssHooks('[data-bn="nope"]{opacity:1}')).toBe(
			'[data-bn="nope"]{opacity:1}',
		);
	});

	/**
	 * 装饰性伪元素:**永远在内容之下、永远不吃点击**。
	 *
	 * 真机上撞的(2026-08-19,「樱墨 · Sakura Ink」):设计师写了一层再标准不过的
	 * 卡面高光(`::before` + `position:absolute` + `inset:0` + 渐变)。它带来两个症状,
	 * 根都在同一处 —— 绝对定位的伪元素画进「定位后代」那一层,压在宿主所有非定位
	 * 内容**之上**:
	 *
	 * 1. 那层膜吃掉了它盖住的每一次点击(`pointer-events` 在白名单外,设计师补不了);
	 * 2. 顶栏和每张卡的文字、按钮都被那层白纱糊住,主人形容「像蒙了一层,很虚」。
	 *
	 * 清洗层已经替新皮肤补了这两句,但**存盘的是清洗后的产物** —— 已经装在主人机器
	 * 上的皮肤不会再过一遍清洗。所以注入层也得设同一道闸,存量皮肤刷一下页面就好。
	 *
	 * 这道闸是**后置**的:`z-index` 在白名单里,皮肤自己写得出来,只有排在它后面
	 * 才压得住(`pointer-events` 倒是怎么排都赢 —— 皮肤 CSS 里不可能出现它)。
	 */
	it("composeSkinCss:伪元素既不吃点击、也压不到内容之上 —— 存量皮肤也吃这道闸", () => {
		const css = composeSkinCss(
			{
				schemaVersion: 1,
				name: "t",
				css: '[data-bn="glass"]::before{content:"";position:absolute;inset:0;z-index:9}',
				modes: { light: {} },
			},
			"light",
		);
		expect(css).toContain("pointer-events:none");
		// 后置:必须排在皮肤自己那段**之后**,否则皮肤的 z-index 压得过它
		expect(css.lastIndexOf("z-index:-1")).toBeGreaterThan(css.lastIndexOf("z-index:9"));
		expect(css).toContain(".bn-glass::before");
		expect(css).toContain(".bn-glass::after");
	});

	/**
	 * `z-index:-1` 要生效在「宿主背景之上、宿主内容之下」,宿主得是个层叠上下文;
	 * `inset:0` 要贴在宿主自己身上,宿主还得是个包含块。两件事一起补。
	 *
	 * **必须包在 `@layer components` 里**:顶栏是 `.bn-glass-strong` + Tailwind 的
	 * `sticky`(在 `@layer utilities`)。层的比较发生在特异性**之前**,无层 author
	 * 样式永远赢 —— 裸着写这句 `position:relative` 就会把顶栏的 `position:sticky`
	 * 顶掉(上一轮就是这么踩的)。components 层排在 utilities 之前,工具类照旧赢。
	 */
	it("用了伪元素的挂点:宿主在 @layer components 里补定位与层叠上下文", () => {
		const css = composeSkinCss(
			{
				schemaVersion: 1,
				name: "t",
				css: '[data-bn="glass"]::before{content:"";position:absolute;inset:0}',
				modes: { light: {} },
			},
			"light",
		);
		expect(css).toContain("@layer components{");
		expect(css).toContain(".bn-glass{position:relative;isolation:isolate}");
		// 没被装饰的挂点不碰 —— 凭空给它们建层叠上下文会困住里面的浮层
		expect(css).not.toContain("body{position:relative");
	});

	it("伪元素挂在 :hover 后面也算 —— 宿主照样补", () => {
		const css = composeSkinCss(
			{
				schemaVersion: 1,
				name: "t",
				css: '[data-bn="btn"]:hover::after{content:"";position:absolute;inset:0}',
				modes: { light: {} },
			},
			"light",
		);
		expect(css).toContain('[data-bn~="btn"]{position:relative;isolation:isolate}');
	});

	it("皮肤压根没写伪元素 → 不白搭这一段", () => {
		const css = composeSkinCss(
			{ schemaVersion: 1, name: "t", css: '[data-bn="btn"]{opacity:0.9}', modes: { light: {} } },
			"light",
		);
		expect(css).not.toContain("pointer-events");
		expect(css).not.toContain("@layer");
	});

	it("composeSkinCss:顶层共用 + 当前模式追加,输出已翻译;两段都缺 → 空串", () => {
		const manifest: SkinManifest = {
			schemaVersion: 1,
			name: "t",
			css: '[data-bn="glass"]{border-width:1px}',
			modes: {
				light: { css: '[data-bn="btn"]{opacity:0.9}' },
				dark: {},
			},
		};
		const light = composeSkinCss(manifest, "light");
		expect(light).toContain(".bn-glass{border-width:1px}");
		expect(light).toContain('[data-bn~="btn"]{opacity:0.9}');
		// dark 套没有自己的 css,但顶层共用仍在
		expect(composeSkinCss(manifest, "dark")).toBe(".bn-glass{border-width:1px}");
		expect(composeSkinCss({ schemaVersion: 1, name: "t", modes: { light: {} } }, "light")).toBe("");
	});

	it("applySkinCss 注入 <style>;再次调用覆盖;clearSkinCss 移除", () => {
		applySkinCss(".bn-glass{opacity:0.95}");
		const el = document.getElementById("bn-skin-css");
		expect(el?.tagName).toBe("STYLE");
		expect(el?.textContent).toBe(".bn-glass{opacity:0.95}");

		applySkinCss("body{border-width:0}");
		expect(document.querySelectorAll("#bn-skin-css")).toHaveLength(1);
		expect(document.getElementById("bn-skin-css")?.textContent).toBe("body{border-width:0}");

		clearSkinCss();
		expect(document.getElementById("bn-skin-css")).toBeNull();
		// 空串 = 不留空标签
		applySkinCss("");
		expect(document.getElementById("bn-skin-css")).toBeNull();
	});
});

describe("composeEffectsCss(动效预设 → 内置 CSS)", () => {
	it("backgroundFlow 已移除(整页 background 动画真机卡顿):存量数据不再产出任何 CSS", () => {
		const legacyMode = { effects: { backgroundFlow: true } } as unknown as SkinMode;
		expect(composeEffectsCss(legacyMode)).toBe("");
	});

	it("glassShine:默认主强调色,可指定颜色;动画只碰 box-shadow", () => {
		const dflt = composeEffectsCss({ effects: { glassShine: {} } });
		expect(dflt).toContain("var(--color-bn-pink)");
		expect(dflt).toContain("bn-skin-glass-shine");
		const custom = composeEffectsCss({ effects: { glassShine: { color: "#39c5bb" } } });
		expect(custom).toContain("#39c5bb");
	});

	it("glassShine 叠加在基础影上:关键帧合回 --tw-shadow 链,不顶掉 shadow-bn-* 的层次", () => {
		// CSS 动画值覆盖 utility 的 box-shadow —— 帧里必须引用元素自己的
		// --tw-shadow(自定义属性动画覆盖不到)把基础三层影合回来,流光只做追加层;
		// 否则流光一开,无描边卡片风的层次感整个被吃掉(真机验过)。
		const css = composeEffectsCss({ effects: { glassShine: {} } });
		expect(css).toContain("var(--tw-shadow, 0 0 #0000)");
	});

	it("光斑:输出 keyframes,且 reduce 偏好下隐藏效果层", () => {
		const css = composeEffectsCss({
			effects: { bokeh: { colors: ["#fb7299"] } },
		});
		expect(css).toContain("bn-skin-drift");
		expect(css).toMatch(/prefers-reduced-motion: reduce[^}]*\{\s*\[data-skin-effects\]/);
	});

	it("没配 effects → 空串", () => {
		expect(composeEffectsCss({})).toBe("");
	});
});

describe("chat 变量(强调色/辉光/玻璃全走 styles.css 的 token 派生链,JS 只管 --bn-chat-bg)", () => {
	it("无 chat 段:一个 chat 变量都不输出 —— dot/glow/玻璃全由 :root 的 var 链派生,colors.accent 覆盖 --color-bn-pink 时聊天页自动跟色", () => {
		const vars = composeSkinVars({ colors: { accent: "#a3de4f" } }, assetUrl, "light");
		expect(Object.keys(vars).filter((k) => k.startsWith("--bn-chat-"))).toEqual([]);
	});

	it("chat.background → 只覆盖 --bn-chat-bg 这一个变量", () => {
		const vars = composeSkinVars(
			{
				colors: { accent: "#a3de4f" },
				chat: { background: "linear-gradient(135deg, #fdeef1, #fbe7ec)" },
			},
			assetUrl,
			"light",
		);
		expect(vars["--bn-chat-bg"]).toContain("linear-gradient");
		expect(Object.keys(vars).filter((k) => k.startsWith("--bn-chat-"))).toEqual(["--bn-chat-bg"]);
	});

	it("chat 壁纸(无 blur):纱层+图层合进 --bn-chat-bg;配了 background 时垫在最底", () => {
		const bare = composeSkinVars(
			{ chat: { wallpaper: { image: "assets/c.webp", overlay: 0.3 } } },
			assetUrl,
			"light",
		);
		expect(bare["--bn-chat-bg"]).toContain('url("/api/skins/abc/assets/c.webp")');
		expect(bare["--bn-chat-bg"]).toContain("rgba(255, 255, 255, 0.3)");
		// 没配 background 也要有实底兜住 contain/tile 的留白(var 只能当渐变的颜色参数用,
		// --bn-page-bg 是多层列表不能进渐变,所以兜底用单色 token 包渐变)
		expect(bare["--bn-chat-bg"]).toContain(
			"linear-gradient(var(--color-bn-surface-muted), var(--color-bn-surface-muted))",
		);

		const withBg = composeSkinVars(
			{
				chat: {
					background: "linear-gradient(135deg, #fff, #eee)",
					wallpaper: { image: "assets/c.webp" },
				},
			},
			assetUrl,
			"light",
		);
		expect(withBg["--bn-chat-bg"]).toMatch(/url\(.+\).*linear-gradient\(135deg/);
	});

	it("chat 壁纸 blur>0:壁纸整体搬进 chat 根的 ::before 糊化层,--bn-chat-bg 不动(:root 默认引整页底)", () => {
		const mode: SkinMode = { chat: { wallpaper: { image: "assets/c.webp", blur: 10 } } };
		const vars = composeSkinVars(mode, assetUrl, "light");
		expect(vars["--bn-chat-bg"]).toBeUndefined();
		const css = composeChatWallpaperCss(mode, assetUrl, "light");
		expect(css).toContain("[data-bn-chat-root]::before");
		expect(css).toContain("blur(10px)");
		expect(css).toContain('url("/api/skins/abc/assets/c.webp")');
	});

	it("chat 壁纸没配或 blur=0 → composeChatWallpaperCss 输出空串", () => {
		expect(composeChatWallpaperCss({}, assetUrl, "light")).toBe("");
		expect(
			composeChatWallpaperCss(
				{ chat: { wallpaper: { image: "assets/c.webp" } } },
				assetUrl,
				"light",
			),
		).toBe("");
	});
});
