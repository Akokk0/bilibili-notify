/**
 * 皮肤合成层:SkinMode(语义字段)→ CSS 变量表 → documentElement 注入。
 * 预览与正式应用共用这一套函数(定案);变量值在服务端已过注入面校验,
 * 这里用 setProperty 注入 —— DOM API 不解析分号逃逸,是第二道保险。
 */

import {
	SKIN_COLOR_TOKEN_MAP,
	SKIN_CSS_HOOK_MAP,
	SKIN_FONT_FAMILY,
	SKIN_FONT_FORMATS,
	type SkinManifest,
	type SkinMode,
	type SkinWallpaper,
} from "@bilibili-notify/contract";
import type { ResolvedTheme } from "../store/theme";

export type SkinVars = Record<string, string>;

/** 需要引号的字体名:含空格或任何非 ASCII 字符。 */
function quoteFontName(name: string): string {
	return /^[A-Za-z0-9-]+$/.test(name) ? name : `"${name}"`;
}

/**
 * 这张壁纸要不要走糊化层。
 *
 * 四处问的是同一句,而 `!(wp.blur !== undefined && wp.blur > 0)` 这种双重否定
 * 读一次就得在脑内化简一次才敢确认几处一致。类型谓词是为了让早退之后 `wp.blur`
 * 还是 number —— 糊化层的 inset 与 filter 都要用它。
 */
function hasBlur<T extends { blur?: number }>(wp: T | undefined): wp is T & { blur: number } {
	return (wp?.blur ?? 0) > 0;
}

/**
 * 壁纸背景层清单:遮罩纱 + 图。纱色跟模式走 —— 亮色蒙白纱、暗色蒙黑纱,
 * 黑纱压高饱和亮壁纸只会更浑浊(玻璃叠玻璃议题的定案之一)。
 */
function buildWallpaperLayers(
	wp: NonNullable<SkinMode["wallpaper"]> & { image: string },
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	const fit = wp.fit ?? "cover";
	const position = wp.position ?? "center";
	const layers: string[] = [];
	if (wp.overlay !== undefined && wp.overlay > 0) {
		const base = theme === "light" ? "255, 255, 255" : "0, 0, 0";
		const o = `rgba(${base}, ${wp.overlay})`;
		layers.push(`linear-gradient(${o}, ${o})`);
	}
	const image = `url("${assetUrl(wp.image)}")`;
	layers.push(
		fit === "tile"
			? `${image} ${position} repeat`
			: `${image} ${position} / ${fit === "contain" ? "contain" : "cover"} no-repeat`,
	);
	return layers.join(", ");
}

export function composeSkinVars(
	mode: SkinMode,
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): SkinVars {
	const vars: SkinVars = {};

	if (mode.colors) {
		for (const [key, cssVar] of Object.entries(SKIN_COLOR_TOKEN_MAP)) {
			const value = mode.colors[key as keyof typeof SKIN_COLOR_TOKEN_MAP];
			if (value) vars[cssVar] = value;
		}
	}

	if (mode.page?.background) vars["--bn-page-bg"] = mode.page.background;

	if (mode.wallpaper?.image) {
		const wp = { ...mode.wallpaper, image: mode.wallpaper.image };
		// blur>0 时壁纸交给 composeWallpaperCss 的 html::before 糊化层;
		// --bn-page-bg 留给 page.background/默认底色,垫在糊化层后面。
		if (!hasBlur(wp)) {
			vars["--bn-page-bg"] = buildWallpaperLayers(wp, assetUrl, theme);
		}
	}

	if (mode.glass) {
		const g = mode.glass;
		if (g.background) vars["--bn-glass-bg"] = g.background;
		if (g.border) vars["--bn-glass-border"] = g.border;
		if (g.strongBackground) vars["--bn-glass-strong-bg"] = g.strongBackground;
		if (g.strongBorder) vars["--bn-glass-strong-border"] = g.strongBorder;
		if (g.blur !== undefined) vars["--bn-glass-blur"] = `${g.blur}px`;
		if (g.strongBlur !== undefined) vars["--bn-glass-strong-blur"] = `${g.strongBlur}px`;
	}

	// 自带字体**排在字体栈最前面,不是顶掉它**:文件一旦拉不下来(网断、被删),
	// 后面那几个家族名还能接着兜,不至于一路掉到系统兜底链。@font-face 本体由
	// composeFontFaceCss 出,和壁纸一样 —— 字段存名字,拼 URL 是注入层的事。
	{
		const stack = [
			...(mode.fonts?.asset ? [`"${SKIN_FONT_FAMILY}"`] : []),
			...(mode.fonts?.body ?? []).map(quoteFontName),
		];
		if (stack.length > 0) {
			vars["--font-cjk"] = [...stack, "system-ui", "sans-serif"].join(", ");
		}
	}

	if (mode.radius?.card !== undefined) vars["--radius-bn-card"] = `${mode.radius.card}px`;
	if (mode.radius?.pill !== undefined) vars["--radius-bn-pill"] = `${mode.radius.pill}px`;
	if (mode.railWidth !== undefined) vars["--bn-rail-width"] = `${mode.railWidth}px`;

	if (mode.shadows?.card) vars["--shadow-bn-card"] = mode.shadows.card;
	if (mode.shadows?.elev) vars["--shadow-bn-elev"] = mode.shadows.elev;

	// AI 聊天页:强调色/辉光/玻璃全走 styles.css 的 token 派生链(--bn-chat-dot ←
	// --color-bn-pink ← colors.accent;玻璃族直接吃 --bn-glass-*),JS 不再复刻。
	// 这里只在皮肤 chat 段给了独立底色/壁纸时覆盖 --bn-chat-bg 这一个变量。
	{
		const chat = mode.chat ?? {};
		// chat 壁纸(无 blur)合成进背景时,底层用显式 background(纯色包渐变)或
		// surface-muted 兜底 —— --bn-page-bg 可能是多层列表,拼进多层 background
		// 或渐变参数都非法。blur>0 时壁纸走 composeChatWallpaperCss 的糊化层。
		const wp = chat.wallpaper;
		if (wp?.image && !hasBlur(wp)) {
			const layers = buildWallpaperLayers({ ...wp, image: wp.image }, assetUrl, theme);
			const base = chat.background;
			const bottom = base
				? base.includes("gradient(")
					? base
					: `linear-gradient(${base}, ${base})`
				: "linear-gradient(var(--color-bn-surface-muted), var(--color-bn-surface-muted))";
			vars["--bn-chat-bg"] = `${layers}, ${bottom}`;
		} else if (chat.background) {
			vars["--bn-chat-bg"] = chat.background;
		}
	}

	return vars;
}

export interface ResolvedSkinMode {
	mode: SkinMode;
	theme: ResolvedTheme;
	locked: boolean;
}

/** 双套跟随请求模式;单套锁定到皮肤给的那套(切换钮随之置灰)。 */
export function resolveSkinMode(skin: SkinManifest, requested: ResolvedTheme): ResolvedSkinMode {
	const { light, dark } = skin.modes;
	if (light && dark) {
		return { mode: requested === "dark" ? dark : light, theme: requested, locked: false };
	}
	if (dark) return { mode: dark, theme: "dark", locked: true };
	if (light) return { mode: light, theme: "light", locked: true };
	// 校验层保证至少一套;真到这里就当没皮肤。
	return { mode: {}, theme: requested, locked: false };
}

/** 上次注入过的键,换皮肤/清皮肤时按这份清单移除 —— 别让残留变量叠在新皮肤上。 */
const injected = new WeakMap<HTMLElement, string[]>();

export function applySkinVars(el: HTMLElement, vars: SkinVars): void {
	clearSkinVars(el);
	for (const [key, value] of Object.entries(vars)) {
		el.style.setProperty(key, value);
	}
	injected.set(el, Object.keys(vars));
}

export function clearSkinVars(el: HTMLElement): void {
	for (const key of injected.get(el) ?? []) {
		el.style.removeProperty(key);
	}
	injected.delete(el);
}

/** `?skin=off`:本次会话强制默认装(不改服务端状态),皮肤糊了界面时的逃生舱。 */
export function skinKillSwitchActive(search: string): boolean {
	return new URLSearchParams(search).get("skin") === "off";
}

// ---- 自定义 CSS ------------------------------------------------------------

/**
 * hook → 真实选择器的注入时翻译。存盘的皮肤 CSS 永远是 hook 形式
 * (`[data-bn="glass"]`),内部选择器重构只改 SKIN_CSS_HOOK_MAP,存量皮肤跟着走。
 * 输入是服务端清洗后的产物,格式可控(css-tree 序列化,引号或裸标识符两种);
 * 未知 hook 原样保留 —— 属性选择器命中不了任何元素,天然无害。
 */
export function translateSkinCssHooks(css: string): string {
	return css.replace(/\[data-bn[~|]?="?([A-Za-z0-9-]+)"?\]/g, (raw, hook: string) => {
		const real = SKIN_CSS_HOOK_MAP[hook as keyof typeof SKIN_CSS_HOOK_MAP];
		return real ?? raw;
	});
}

/** 正则转义 —— hook 映射表右侧的真实选择器里有 `[` `]` `"` `.` `~` `=` 这些元字符。 */
function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 挂点 → 「这个挂点挂了装饰伪元素吗」的正则。映射表是常量,正则也就是常量 ——
 * 编辑器每敲一个键都会重跑一趟 composeSkinCss,别在那条路上现编译十条。
 */
const DECORATION_RES: readonly (readonly [string, RegExp])[] = Object.values(SKIN_CSS_HOOK_MAP).map(
	(sel) =>
		[
			sel,
			new RegExp(`${escapeForRegExp(sel)}(?::[a-z-]+(?:\\([^)]*\\))?)*::(?:before|after)`, "i"),
		] as const,
);

/**
 * 这套 CSS 里,哪些挂点真的挂了装饰性伪元素。
 *
 * 中间允许夹伪类:`[data-bn~="btn"]:hover::after` 照样算 btn 的装饰层。
 * 只挑真用到的那几个 —— 凭空给每个挂点建层叠上下文,会把里面的浮层困死。
 */
function hooksWithDecoration(css: string): string[] {
	return DECORATION_RES.filter(([, re]) => re.test(css)).map(([sel]) => sel);
}

/**
 * 装饰性伪元素的两道硬规矩 —— **永远在内容之下、永远不吃点击**,外加宿主那边
 * 让这两句成立所需的定位与层叠上下文。
 *
 * 真机上撞的(2026-08-19「樱墨 · Sakura Ink」):设计师写了一层再标准不过的卡面高光
 * (`::before` + `position:absolute` + `inset:0` + 渐变)。绝对定位的伪元素画进「定位
 * 后代」那一层,压在宿主所有非定位内容**之上**,于是一处根因两个症状 —— 那层膜吃掉
 * 了它盖住的每一次点击,顶栏与每张卡的文字按钮又都被白纱糊住(主人:「像蒙了一层,
 * 很虚」)。`pointer-events` 在皮肤白名单外,设计师写不出来也补不了。
 *
 * 清洗层已经替新皮肤补了这两句,但**存盘的是清洗后的产物** —— 已经装在主人机器上的
 * 皮肤不会再过一遍清洗。所以注入层也设同一道闸,存量皮肤刷一下页面就好。
 *
 * 三处讲究:
 * - 伪元素那句**后置 + `!important`**。光靠后置只赢得了同特异性的:皮肤写
 *   `[data-bn="card"]:hover::after{z-index:9}` 就比这句多一个伪类,排多后面都压不住。
 *   `!important` 无视特异性,而皮肤自己的 `!important` 已经在 {@link stripImportant}
 *   里摘干净了 —— 这一句于是必胜。宿主那句**不能**跟着加:`!important` 声明的层序
 *   是反的,加了 components 层的 `position:relative` 就会反过来顶掉顶栏的 sticky。
 * - 宿主那句**包在 `@layer components` 里**。顶栏是 `.bn-glass-strong` + Tailwind 的
 *   `sticky`(在 `@layer utilities`),而层的比较发生在特异性**之前**、无层 author 样式
 *   永远赢 —— 裸着写这句 `position:relative` 就会把顶栏的 `position:sticky` 顶掉。
 *   components 层排在 utilities 之前,工具类照旧赢。
 */
function decorationGuardCss(css: string): string {
	const hosts = hooksWithDecoration(css);
	if (hosts.length === 0) return "";
	const hostRules = hosts.map((sel) => `${sel}{position:relative;isolation:isolate}`).join("");
	const pseudos = hosts.flatMap((sel) => [`${sel}::before`, `${sel}::after`]).join(",");
	return `@layer components{${hostRules}}\n${pseudos}{pointer-events:none!important;z-index:-1!important}`;
}

/**
 * 摘掉皮肤自己的 `!important`。
 *
 * 服务端清洗层已经这么干了,但**存盘的是当时那一版清洗的产物** —— 早于那条规矩
 * 装上的皮肤仍带着 `!important`,它会压过上面那两句硬规矩(那才是它们要拦的东西)。
 * 注入层再摘一遍,存量皮肤刷一下页面就好。
 *
 * 前瞻限定在声明结尾,`content:"读作!important"` 这种字符串字面量不受影响 ——
 * 那里的 `!important` 后面跟的是引号,不是 `;` 或 `}`。
 */
function stripImportant(css: string): string {
	return css.replace(/!\s*important(?=\s*[;}])/gi, "");
}

/** 顶层共用 + 当前模式追加(后到的覆盖先到的),输出已完成 hook 翻译。 */
export function composeSkinCss(manifest: SkinManifest, mode: "light" | "dark"): string {
	const parts = [manifest.css, manifest.modes[mode]?.css].filter(
		(s): s is string => typeof s === "string" && s !== "",
	);
	const css = stripImportant(translateSkinCssHooks(parts.join("\n")));
	const guard = decorationGuardCss(css);
	return guard === "" ? css : `${css}\n${guard}`;
}

/**
 * 壁纸糊化层:wallpaper.blur > 0 时壁纸(含纱)整体搬进 `html::before` 固定层
 * 做静态高斯模糊 —— 一次成像、无逐帧动画。负 inset 按 2×blur 外扩,遮掉模糊
 * 的边缘透底;z-index:-1 让它画在页底之上、页面内容之下(body 的背景按 HTML
 * 规则上浮成 canvas,所以这一层照旧压在它上面)。
 * 与动效 CSS 同为可信内置产物,拼进同一个 style 标签。
 *
 * **为什么是 html 而不是 body**:`page` 挂点就是 `body`,皮肤完全可以写
 * `[data-bn="page"]::before`(飘花瓣那类氛围层就得这么写)。两边抢同一个伪元素时
 * CSS 按声明**逐条**合并 —— 真机上「樱墨 · Sakura Ink」的花瓣把这一层压成了
 * 14×12px、opacity:0 的一小块,主人的壁纸就这么没了,而且构建全绿、只在装上那一刻
 * 才看得出来。`html` 不是任何挂点,抢不到。
 */
export function composeWallpaperCss(
	mode: SkinMode,
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	return blurLayerCss(mode.wallpaper, "html::before", "fixed", assetUrl, theme);
}

/**
 * 糊化层的本体,整页与聊天共用。两处只差选择器与 position —— 负 inset、
 * `z-index:-1`、`pointer-events:none`、`filter:blur()` 这套规矩是同一套,
 * 分成两份抄的话改一处忘另一处,两个壁纸的糊化行为就会悄悄分叉。
 */
function blurLayerCss(
	wp: SkinWallpaper | undefined,
	selector: string,
	position: "fixed" | "absolute",
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	if (!wp?.image || !hasBlur(wp)) return "";
	const layers = buildWallpaperLayers({ ...wp, image: wp.image }, assetUrl, theme);
	return `${selector}{content:"";position:${position};inset:-${wp.blur * 2}px;z-index:-1;pointer-events:none;background:${layers};filter:blur(${wp.blur}px)}`;
}

/**
 * 皮肤自带字体 → 一条 `@font-face`。没配字体文件时返回空串。
 *
 * 为什么必须走这条内置路、而不能让皮肤自己在自定义 CSS 里写:**清洗层直接拒收
 * `url()`**(外联是隐私泄露面),所以 `fonts.asset` 是自带字体唯一可能的入口 ——
 * 与壁纸同一套安排,字段里只存包内名字,拼 URL 在这儿做。
 *
 * `font-display: swap` 与出图那条路(`packages/image` 的 `buildFontFace` 用 block)
 * 刻意相反:那边字体是内联 data URL、不走网络,block 只是让浏览器别抢跑;这边是
 * 真的要下载八九兆,block 会让整页文字在下完之前**一个字都不显示**。
 */
export function composeFontFaceCss(mode: SkinMode, assetUrl: (name: string) => string): string {
	const asset = mode.fonts?.asset;
	if (!asset) return "";
	const ext = asset.toLowerCase().split(".").pop() ?? "";
	const format = SKIN_FONT_FORMATS[ext];
	// 认不出后缀就不给 format 提示 —— 猜一个错的比不写更糟(浏览器会据此直接跳过)。
	const src = `url("${assetUrl(asset)}")${format ? ` format("${format}")` : ""}`;
	return `@font-face{font-family:"${SKIN_FONT_FAMILY}";src:${src};font-display:swap}`;
}

/**
 * 动效预设 → 内置 CSS。这段是**我们自己写的可信产物**(不过白名单),与皮肤
 * 自定义 CSS 拼进同一个 style 标签。所有动画包在 prefers-reduced-motion:
 * no-preference 里;光斑层在 reduce 偏好下整层隐藏(不动的光斑只是色块)。
 */
export function composeEffectsCss(mode: SkinMode): string {
	const fx = mode.effects;
	if (!fx) return "";
	const anim: string[] = [];

	if (fx.glassShine) {
		// 只动 box-shadow:不碰 position/transform,零布局回归面。
		// 动画值会覆盖 utility 的 box-shadow,所以每帧都把元素自己的 --tw-* 合成链
		// 合回来(自定义属性动画覆盖不到,hover 切 elev 也跟着走),基础三层影保住,
		// 流光只是追加的最外层;裸 .bn-glass(没配 shadow-bn-*)兜底 0 0 #0000。
		const c = fx.glassShine.color ?? "var(--color-bn-pink)";
		const base =
			"var(--tw-inset-shadow, 0 0 #0000), var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow, 0 0 #0000)";
		anim.push(
			`${SKIN_CSS_HOOK_MAP.glass}{animation:bn-skin-glass-shine 7s ease-in-out infinite}`,
			`@keyframes bn-skin-glass-shine{0%,100%{box-shadow:${base}, 0 -10px 28px -14px ${c}}25%{box-shadow:${base}, 10px 0 28px -14px ${c}}50%{box-shadow:${base}, 0 10px 28px -14px ${c}}75%{box-shadow:${base}, -10px 0 28px -14px ${c}}}`,
		);
	}

	if (fx.bokeh) {
		anim.push(
			"@keyframes bn-skin-drift{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(6vw,-5vh) scale(1.15)}66%{transform:translate(-5vw,5vh) scale(0.9)}}",
		);
	}

	const parts: string[] = [];
	if (anim.length > 0) {
		parts.push(`@media (prefers-reduced-motion: no-preference){${anim.join("")}}`);
	}
	if (fx.bokeh) {
		parts.push("@media (prefers-reduced-motion: reduce){[data-skin-effects]{display:none}}");
	}
	return parts.join("\n");
}

/**
 * chat 专属壁纸的糊化层:与整页 composeWallpaperCss 同哲学 —— blur > 0 时
 * 壁纸(含纱)搬进 chat 根([data-bn-chat-root],fixed 满屏、自带 stacking
 * context)的 ::before 做静态高斯模糊;z-index:-1 画在根背景之上、内容之下。
 */
export function composeChatWallpaperCss(
	mode: SkinMode,
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	return blurLayerCss(
		mode.chat?.wallpaper,
		"[data-bn-chat-root]::before",
		"absolute",
		assetUrl,
		theme,
	);
}

const SKIN_STYLE_ID = "bn-skin-css";

/** 皮肤 CSS 注入:单例 <style>,重复调用覆盖内容;空串等价于清除。 */
export function applySkinCss(css: string): void {
	if (css === "") {
		clearSkinCss();
		return;
	}
	let el = document.getElementById(SKIN_STYLE_ID);
	if (!(el instanceof HTMLStyleElement)) {
		el = document.createElement("style");
		el.id = SKIN_STYLE_ID;
		document.head.appendChild(el);
	}
	// 一字不差就别碰:改颜色/圆角/玻璃时自定义 CSS 段根本没变,而重写 textContent
	// 会把整张皮肤样式表推倒重解析(CSSOM 重建 + 全文档样式重算),这条 effect 上
	// 它比注入变量贵得多,且编辑器每敲一个键都会走一遍。
	if (el.textContent === css) return;
	el.textContent = css;
}

export function clearSkinCss(): void {
	document.getElementById(SKIN_STYLE_ID)?.remove();
}
