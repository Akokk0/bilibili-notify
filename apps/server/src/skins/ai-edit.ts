/**
 * 抽屉内嵌 AI(「让女仆改」)的服务端逻辑。
 *
 * 产物**不落盘**:AI 输出 → 剥围栏 → parseSkinManifest(含 CSS 清洗)+ 资产引用
 * 校验 → 把清洗后的 manifest 还给编辑器 draft,实时预览;保存永远由主人点。
 * 首答校验不过时**带错误反馈自动重试一次**(弱模型常犯格式小错,直接报错太挫败),
 * 二败才对外报 errors。
 */

import {
	SKIN_BEST_PRACTICES,
	SKIN_COLOR_TOKEN_MAP,
	SKIN_CSS_HOOK_NOTES,
	SKIN_CSS_PROP_NOTES,
	SKIN_LIMITS,
	SKIN_PSEUDO_NOTES,
	SKIN_RADIUS_NOTES,
	type SkinManifest,
} from "@bilibili-notify/contract";
import { referencedAssets } from "./package.js";
import { parseSkinManifest, SKIN_FONT_FILE_RE, WALLPAPER_IMAGE_RE } from "./schema.js";

/** 单次调用里 AI 生成器的最小面;engines.commentary 的 generateRaw 即是。 */
export interface SkinAiGenerator {
	/**
	 * `onProgress` 收「已经吐了多少字符」。这一趟要几分钟,而调用它的工具轮不产生
	 * 正文 —— 不报进度的话,界面上那几分钟跟卡死一模一样。
	 */
	generateRaw(system: string, user: string, onProgress?: (chars: number) => void): Promise<string>;
}

export interface SkinAiEditInput {
	generateRaw: SkinAiGenerator["generateRaw"];
	/** 包内资产清单(assets/<名>,图与字体的全集);AI 只许引用这里面的东西。 */
	assets: string[];
	/** 生成名 → 主人上传时的原文件名;只进提示词里的清单,manifest 仍写生成名。 */
	assetNames?: Record<string, string>;
	/** 当前 draft(编辑器手上的整份 manifest,可能含未保存改动)。 */
	draft: unknown;
	instruction: string;
}

export type SkinAiEditResult =
	| { ok: true; manifest: SkinManifest; warnings: string[] }
	| { ok: false; errors: string[] };

const HOOK_LIST = Object.values(SKIN_CSS_HOOK_NOTES)
	.map((n) => `  ${n}`)
	.join("\n");

/**
 * colors 的可用键。改皮肤时 draft 里已有的键就是活样板,但**从零建**(聊天里
 * 「做一套皮肤」)手上什么都没有 —— 不摊开这张表,AI 只能瞎编键名,而不认识的键
 * 是**静默忽略**的:构建全绿、皮肤装上去半边不变色,最难查的那种。
 */
const COLOR_KEY_LIST = Object.keys(SKIN_COLOR_TOKEN_MAP).join(" / ");

export function buildSkinAiSystemPrompt(
	assets: string[],
	/** create = 从零建一套(聊天里「给我做套皮肤」),没有草稿可依。 */
	mode: "edit" | "create" = "edit",
	/**
	 * `assets/<生成名>` → 主人上传时的原文件名。给了就附在清单每行后面。
	 *
	 * 有用是因为提示词本来就要求「整套配色要跟这张图搭」,而 `assets/img-a1b2c3d4.png`
	 * 这串 hex 什么都没告诉设计师。代价是同一行出现两个字符串,所以一旦有原名,
	 * 就得**明说 manifest 里照抄哪一个** —— 写错的产物会被资产校验拒收,而一趟生成
	 * 是两分多钟。没有原名时这句消歧不出现:多背一句用不上的规矩只是噪音。
	 */
	names: Record<string, string> = {},
): string {
	// 措辞是有代价的:这里原本写「包内可用图片」,真机上设计师就把它当成可选,
	// 主人点名要的壁纸下下来了却没进 manifest(2026-08-18「樱落 · 樱泽墨」)。
	// 包里有图 = 主人指定的,不是备选。
	// 图与字体**必须分开讲**:listAssets 给的是一份全集,混在同一句「必须用上、
	// 写进 wallpaper.image」里,设计师就会拿 woff2 去当壁纸 —— 产物必被拒收。
	const images = assets.filter((a) => WALLPAPER_IMAGE_RE.test(a));
	const fonts = assets.filter((a) => SKIN_FONT_FILE_RE.test(a));
	const listOf = (items: string[]): string =>
		items.map((a) => (names[a] ? `- ${a} —— 原文件名「${names[a]}」` : `- ${a}`)).join("\n");
	// 只在真有原名时才加这句 —— 一行只有一个字符串的时候,消歧是纯噪音。
	const hasNames = assets.some((a) => names[a]);
	const copyRule = hasNames
		? "**只准照抄破折号前面那个 assets/… 路径;原文件名只是让你知道这是什么文件,写进 manifest 会被拒收**"
		: "路径一字不差照抄";
	/** 同理:没原名可看时,「原文件名点明了它是什么图」这句话本身就是废话。 */
	const nameHint = hasNames ? " —— 原文件名往往就点明了它是什么图" : "";
	const imageNote =
		images.length > 0
			? `包内图片(主人指定要用的,**必须用上**,别当可选):\n${listOf(images)}\n每一套 mode 都要写 wallpaper.image 引用它(${copyRule}),并配 fit / overlay / blur;整套配色要跟这张图搭${nameHint}。wallpaper.image / chat.wallpaper.image 只准引用上面这些,别的图一律不存在。`
			: "包里没有任何图片资产:不要写 wallpaper 字段,引用不存在的图会被拒收。";
	// 字体不像壁纸那样「主人点名要的」—— 传一款字体多半只为备着,所以这里是可选,
	// 不用壁纸那句「必须用上」的措辞。
	const fontNote =
		fonts.length > 0
			? `包内字体(主人自己传的,想用就写进 fonts.asset):\n${listOf(fonts)}\nfonts.asset 只准引用上面这些(${copyRule})。`
			: "包里没有任何字体文件:不要写 fonts.asset —— 你没法凭空造一款字,引用不存在的字体会被拒收。要换字体只能写 fonts.body(系统里装了的家族名)。";
	const assetNote = `${imageNote}\n${fontNote}`;
	const intro =
		mode === "create"
			? "你会收到主人想要的风格,**从零设计一整套**并输出完整的 skin.json。名字(name)与一句描述(description)也由你起,要贴合风格。要求里**给了具体色值**(某部作品的代表色之类)就照它配色,别自己另起一套 —— 那些色值可能是聊天那一侧专门查来的。"
			: "你会收到当前皮肤的 skin.json 草稿和一句修改要求,输出**修改后的完整 skin.json**。";

	return `你是「bilibili-notify」Web 面板的皮肤设计师。${intro}

## 规则

- schemaVersion 固定 1;没被要求改的字段一律原样保留,不要顺手删改
- colors 的可用键(只收这些,别的键会被静默忽略):${COLOR_KEY_LIST};值只收 hex / rgb() / hsl() / oklch() / transparent(禁 url()、var()、分号)
- modes: { light?, dark? },每套里可用 colors / page.background / wallpaper(image·fit·position·overlay ${SKIN_LIMITS.wallpaperOverlay.min}~${SKIN_LIMITS.wallpaperOverlay.max}·blur ${SKIN_LIMITS.wallpaperBlur.min}~${SKIN_LIMITS.wallpaperBlur.max})/ chat(background·wallpaper 同构 —— AI 聊天页专属背景,只管背景:强调色跟随 colors.accent、玻璃件直用 glass 段,background 缺省透出整页皮肤底,通常不用写)/ glass(background·border·strongBackground·strongBorder·blur ${SKIN_LIMITS.glassBlur.min}~${SKIN_LIMITS.glassBlur.max}·strongBlur;默认装无描边,border 对只在刻意要描边风格(如暗色霓虹边)时才配,亮色/玻璃感皮肤不配)/ fonts.body(**最多 ${SKIN_LIMITS.maxFonts} 个**字体名的数组,只准字母/数字/空格/点/连字符,别加引号;拿不准就整个不写)· fonts.asset(主人自己传进包里的字体文件,见下方清单;设了就排在 fonts.body 之前)/ radius(card ${SKIN_LIMITS.radiusCard.min}~${SKIN_LIMITS.radiusCard.max}·pill ${SKIN_LIMITS.radiusPill.min}~${SKIN_LIMITS.radiusPill.max})/ railWidth(${SKIN_LIMITS.railWidth.min}~${SKIN_LIMITS.railWidth.max} px,五个带左侧分区栏的页面那条栏有多宽;窄屏那条栏会变成横条,写了也不生效 —— 没特别理由就别写)/ shadows(card·elev)/ css / effects
- wallpaper.overlay 是遮罩纱,纱色自动跟模式(亮=白纱/暗=黑纱);wallpaper.blur 是壁纸自身高斯模糊。亮色+高饱和壁纸的配方:overlay 0.3~0.4 + blur 8~16。卡内列表行默认全透明(内容直接画在玻璃上,别在玻璃卡里叠第二层),只有刻意要行条底/描边时才配 colors.listRow / colors.listRowBorder
- effects 动效预设两道可选:glassShine { color? } / bokeh { colors: [1~${SKIN_LIMITS.maxBokehColors} 色] }
- 顶层可给 texts: { headerTitle, chatPlaceholder }(≤${SKIN_LIMITS.maxTextChars} 字)与 css(明暗共用)
- ${assetNote}

## 库内最佳实践(官方皮肤库的统一手感;用户没提相反要求时照此执行)

${SKIN_BEST_PRACTICES}

## 自定义 CSS(组件级造型与动效的主力)

- 选择器只准 [data-bn="<挂点>"] 配伪类/伪元素/组合器。挂点就这些,各自长这样:
${HOOK_LIST}
${SKIN_RADIUS_NOTES}
${SKIN_CSS_PROP_NOTES}
- 禁 url()(图走字段,CSS 里写了会被剔除)
${SKIN_PSEUDO_NOTES}
- @keyframes 名必须以 skin- 开头;可用 @media (prefers-reduced-motion) 做降级

只输出 skin.json 的 JSON 内容,不要解释,不要代码块围栏。`;
}

/** 剥掉模型爱加的 \`\`\`json 围栏与首尾闲话,尽力取出 JSON 本体。 */
export function stripJsonFences(text: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
	if (fenced !== undefined) return fenced.trim();
	const t = text.trim();
	// 没围栏但夹了闲话:截取首个 { 到最后一个 } 的区间。
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start >= 0 && end > start) return t.slice(start, end + 1);
	return t;
}

/** 单答的解析 + 校验;错误串给重试反馈用。 */
function tryParse(
	text: string,
	assets: Set<string>,
): { ok: true; manifest: SkinManifest; warnings: string[] } | { ok: false; errors: string[] } {
	let json: unknown;
	try {
		json = JSON.parse(stripJsonFences(text));
	} catch {
		return { ok: false, errors: ["输出不是合法 JSON"] };
	}
	const parsed = parseSkinManifest(json);
	if (!parsed.ok) return parsed;
	const missing = [...referencedAssets(parsed.skin)].filter((name) => !assets.has(name));
	if (missing.length > 0) {
		return {
			ok: false,
			errors: missing.map((m) => `${m}: manifest 引用了它,但包里没有这个文件`),
		};
	}
	return { ok: true, manifest: parsed.skin, warnings: parsed.warnings };
}

/**
 * 一轮「生成 → 校验 → 失败带反馈重试一次」。改皮肤(edit)与从零建皮肤(create)
 * 共用这条纪律 —— 弱模型常犯的是格式小错,直接报错太挫败;但也只给一次机会,
 * 二败还硬试就是在替主人烧 token。
 */
export async function runSkinAiRound(input: {
	generateRaw: SkinAiGenerator["generateRaw"];
	system: string;
	/** 首轮的 user 消息;重试时在它后面追加错误反馈。 */
	user: string;
	/** 包内可用资产;manifest 引用了这之外的图 / 字体 = 拒收。 */
	assets: Set<string>;
	/**
	 * 设计师吐字的进度。两趟**各报各的** —— 字数归零重来看着像倒退,但那正是
	 * 实情:校验没过的那一份被扔了,现在写的是新的一份。
	 */
	onProgress?: (chars: number) => void;
}): Promise<SkinAiEditResult> {
	const first = await input.generateRaw(input.system, input.user, input.onProgress);
	const parsed = tryParse(first, input.assets);
	if (parsed.ok) return parsed;

	// 带错误反馈重试一次 —— 原答也附上,让模型知道自己上次说了什么。
	const retryUser = `${input.user}\n\n你上次的输出未通过校验:\n${parsed.errors.map((e) => `- ${e}`).join("\n")}\n\n上次输出:\n${first}\n\n请修正后重新输出完整 skin.json,仍然只输出 JSON。`;
	const second = await input.generateRaw(input.system, retryUser, input.onProgress);
	return tryParse(second, input.assets);
}

export async function runSkinAiEdit(input: SkinAiEditInput): Promise<SkinAiEditResult> {
	return runSkinAiRound({
		generateRaw: input.generateRaw,
		system: buildSkinAiSystemPrompt(input.assets, "edit", input.assetNames ?? {}),
		user: `当前 skin.json 草稿:\n${JSON.stringify(input.draft, null, "\t")}\n\n修改要求:${input.instruction}`,
		assets: new Set(input.assets),
	});
}
