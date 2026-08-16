/**
 * 制作引导页的纯函数层:提示词生成 + 前端组包。
 * 用户全程不碰压缩软件 —— AI 吐 JSON,粘过来,可选拖一张壁纸,这里拼成标准 zip。
 */

import { SKIN_COLOR_TOKEN_MAP, SKIN_CSS_HOOK_MAP } from "@bilibili-notify/contract";
import { strToU8, zipSync } from "fflate";

/** 组包时壁纸统一用这个基名,提示词里也这么约定,扩展名按实际文件修正。 */
const WALLPAPER_BASENAME = "assets/wallpaper";

/**
 * 生成粘给任意 AI 的皮肤制作提示词:schema 规格 + 当前生效令牌值(给 AI 当
 * 设计基准)+ 输出要求。`readVar` 读 documentElement 的计算值,测试传假表。
 */
export function buildSkinPrompt(readVar: (name: string) => string): string {
	const colorLines = Object.entries(SKIN_COLOR_TOKEN_MAP)
		.map(([key, cssVar]) => {
			const v = readVar(cssVar).trim();
			return `- colors.${key}${v ? `(当前 ${v})` : ""}`;
		})
		.join("\n");
	const pageBg = readVar("--bn-page-bg").trim();

	return `请为「bilibili-notify」的 Web 面板设计一套界面皮肤,输出一个 skin.json。

## 输出格式(schemaVersion 1)

顶层字段:
- schemaVersion: 固定 1
- name: 皮肤名(≤50 字)
- author / description: 可选
- modes: { light?, dark? } —— 尽量两套都给;只给一套时应用后会锁定该模式

每套 mode 里全部字段可选,没写的沿用默认装:
- colors: 语义色键值,值只收 hex / rgb() / hsl() / oklch() / transparent(禁 url()、var()、分号)。可用键:
${colorLines}
- page.background: 整页背景,纯色或 linear/radial/conic(含 repeating-*)渐变${pageBg ? `(当前 ${pageBg})` : ""}
- wallpaper: { image, fit: cover|contain|tile, position, overlay: 0~0.8, blur: 0~40 }
  —— image 固定写 "${WALLPAPER_BASENAME}.webp"(用户上传时会自动修正扩展名);overlay 是遮罩纱,纱色自动跟模式走(亮色蒙白纱/暗色蒙黑纱),配壁纸建议 ≥0.2 保文字可读;blur 是壁纸自身高斯模糊(px),高饱和/高对比壁纸建议 8~16 退成柔和色底,免得玻璃卡上透出脏斑
  —— 亮色 + 艳壁纸的经典配方:overlay 0.3~0.4 + blur 8~16。卡内列表行**默认全透明**(内容直接画在玻璃上,区块玻璃卡是唯一一层,别叠第二层),只有刻意要行条底/描边时才配 colors.listRow / colors.listRowBorder
- glass: { background, border, strongBackground, strongBorder, blur: 0~40, strongBlur: 0~40 } —— 玻璃面板的底色(带透明度的颜色)与模糊度;默认装玻璃卡**无描边**(卡片风,层次靠 shadows),border 对只在刻意要描边风格(如暗色霓虹边)时才配 —— 亮色/玻璃感皮肤一律不配描边
- fonts.body: 字体名数组(1~8 个)
- radius: { card: 0~32, pill: 0~999 }
- shadows: { card, elev } —— 卡片/悬浮两档阴影,值如 "0 10px 30px rgba(57, 197, 187, 0.25)";用带颜色的阴影能做出霓虹辉光感
- effects: 动效预设(自动尊重系统减少动效设置),两道可选:
  - glassShine: { color? } —— 玻璃卡辉光呼吸游走,默认主强调色
  - bokeh: { colors: [1~4 个颜色] } —— 悬浮大光斑慢速漂移

顶层(与 modes 平级)还可给:
- texts: { headerTitle, chatPlaceholder } —— 顶栏标题与聊天输入框提示语,每条 ≤60 字,给皮肤配人格化文案
- css: 自定义 CSS 字符串(明暗共用;每套 mode 里也可给 css 做本模式追加)—— 深度定制的主力,规则见下节

## 自定义 CSS(组件级造型与动效都靠它)

- 选择器**只准**写 \`[data-bn="<挂点>"]\`,可配伪类(:hover 等)/伪元素(::before/::after)/组合器;class、id、标签名选择器一律会被丢弃。可用挂点:
${Object.entries(SKIN_CSS_HOOK_MAP)
	.map(([hook]) => `  - "${hook}"`)
	.join("\n")}
  ("page" 是整页,"glass"/"glass-strong" 是玻璃卡片/弹层,其余对应同名组件)
- 属性走视觉白名单:background/border/outline/box-shadow/text-shadow/color/opacity/filter/backdrop-filter/transform/transition/animation/border-radius/clip-path/inset/width/height/z-index 等;**display、pointer-events、visibility 会被丢弃**
- **禁 url()**(以及 image-set/element/src)—— 图片一律走 wallpaper 字段,CSS 里写了会被逐条剔除
- position 只准 static/relative/absolute;伪元素 content 只准 "" 或 none
- 动画用 @keyframes,**名字必须以 skin- 开头**(如 @keyframes skin-float),再在 animation 里引用;可用 @media (prefers-reduced-motion) 做无动效降级
- 违禁项不会导致整包被拒,但会被逐条静默丢弃 —— 别浪费笔墨写白名单外的东西

## 设计要求

- 面板是玻璃拟态:半透明玻璃卡浮在整页背景上,glass.background 记得留透明度
- 明暗两套都设计时,dark 套的表面色要明显亮于页面背景,文字对比度要够
- 图片类字段(wallpaper)引用 assets/ 下的文件;若用户说明只有一张壁纸,就只写 wallpaper,不要虚构别的图片引用(引用了包里没有的文件会被拒收)

只输出 skin.json 的 JSON 内容,不要任何解释或代码块围栏。`;
}

export type MakeSkinZipResult =
	| { ok: true; zip: Uint8Array; warnings: string[] }
	| { ok: false; error: string };

interface WallpaperInput {
	/** 扩展名(webp/jpg/jpeg/png),来自用户拖入的文件。 */
	ext: string;
	data: Uint8Array;
}

/**
 * 粘贴的 manifest JSON + 可选壁纸 → 标准皮肤包。带壁纸时统一命名为
 * `assets/wallpaper.<ext>` 并同步 manifest 里已有的壁纸引用;字段校验不在这里
 * 做(服务端是唯一权威),只挡「根本不是 JSON」这种没法打包的输入。
 */
export function makeSkinZip(manifestJson: string, wallpaper?: WallpaperInput): MakeSkinZipResult {
	let manifest: Record<string, unknown>;
	try {
		const parsed = JSON.parse(manifestJson);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, error: "粘贴的内容不是 JSON 对象" };
		}
		manifest = parsed as Record<string, unknown>;
	} catch {
		return { ok: false, error: "粘贴的内容不是合法 JSON(检查有没有带上代码块围栏)" };
	}

	const warnings: string[] = [];
	const modes =
		typeof manifest.modes === "object" && manifest.modes !== null
			? (manifest.modes as Record<string, unknown>)
			: {};
	const wallpaperRefs: Array<Record<string, unknown>> = [];
	for (const key of ["light", "dark"]) {
		const mode = modes[key];
		if (typeof mode !== "object" || mode === null) continue;
		const wp = (mode as Record<string, unknown>).wallpaper;
		if (typeof wp === "object" && wp !== null && "image" in wp) {
			wallpaperRefs.push(wp as Record<string, unknown>);
		}
	}

	const files: Record<string, Uint8Array> = {};
	if (wallpaper) {
		const name = `${WALLPAPER_BASENAME}.${wallpaper.ext.toLowerCase()}`;
		files[name] = wallpaper.data;
		for (const wp of wallpaperRefs) wp.image = name;
		if (wallpaperRefs.length === 0) {
			warnings.push("拖了壁纸图,但 JSON 里没有任何 wallpaper 字段,这张图不会被使用");
		}
	} else if (wallpaperRefs.length > 0) {
		warnings.push("JSON 里引用了壁纸图片,但还没有拖入图片文件 —— 上传会被拒,请补一张");
	}

	files["skin.json"] = strToU8(JSON.stringify(manifest, null, "\t"));
	return { ok: true, zip: zipSync(files), warnings };
}
