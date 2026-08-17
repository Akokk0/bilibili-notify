/**
 * 抽屉内嵌 AI(「让女仆改」)的服务端逻辑。
 *
 * 产物**不落盘**:AI 输出 → 剥围栏 → parseSkinManifest(含 CSS 清洗)+ 资产引用
 * 校验 → 把清洗后的 manifest 还给编辑器 draft,实时预览;保存永远由主人点。
 * 首答校验不过时**带错误反馈自动重试一次**(弱模型常犯格式小错,直接报错太挫败),
 * 二败才对外报 errors。
 */

import {
	SKIN_COLOR_TOKEN_MAP,
	SKIN_CSS_HOOK_MAP,
	type SkinCssHook,
	type SkinManifest,
} from "@bilibili-notify/contract";
import { referencedImages } from "./package.js";
import { parseSkinManifest } from "./schema.js";

/** 单次调用里 AI 生成器的最小面;engines.commentary 的 generateRaw 即是。 */
export interface SkinAiGenerator {
	generateRaw(system: string, user: string): Promise<string>;
}

export interface SkinAiEditInput {
	generateRaw: SkinAiGenerator["generateRaw"];
	/** 包内资产清单(assets/<名>);AI 只许引用这里面的图。 */
	assets: string[];
	/** 当前 draft(编辑器手上的整份 manifest,可能含未保存改动)。 */
	draft: unknown;
	instruction: string;
}

export type SkinAiEditResult =
	| { ok: true; manifest: SkinManifest; warnings: string[] }
	| { ok: false; errors: string[] };

/**
 * 每个 CSS 挂点在这个面板里**长什么样**。
 *
 * 光把名字列出来,AI 只能按名字想象形状,而想错了没有任何东西会拦它:真机上
 * `nav` 被当成横向胶囊条写了 `border-radius:999px`,落到竖向的分区列表上就成了
 * 一个盖住半个页面的大椭圆(2026-08-18)。挂点是对外承诺的公开 API,加一个就得
 * 在这儿补一句 —— ai-create 的测试遍历 {@link SKIN_CSS_HOOK_MAP} 钉着这条。
 */
export const SKIN_CSS_HOOK_NOTES: Record<SkinCssHook, string> = {
	page: '"page"=整页根(壁纸之上、内容之下;氛围层挂它的伪元素)',
	glass: '"glass"=所有轻玻璃卡片(小到一行数据卡,大到整块面板)',
	"glass-strong": '"glass-strong"=强玻璃面(弹层、浮条、抽屉)',
	btn: '"btn"=所有按钮(矮元素,胶囊圆角安全)',
	"btn-primary": '"btn-primary"=主按钮(粉色实底那种)',
	input: '"input"=单行输入框',
	header: '"header"=顶栏(横向长条)',
	nav: '"nav"=页面级导航容器 —— 横向 tab 条和**竖向的分区列表**都挂它,别当成横条设形状',
	avatar: '"avatar"=圆头像(本身已经是圆的)',
	modal: '"modal"=弹窗卡片本体',
};

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
): string {
	const assetNote =
		assets.length > 0
			? `包内可用图片(wallpaper.image / chat.wallpaper.image 只准引用这些):\n${assets.map((a) => `- ${a}`).join("\n")}`
			: "包里没有任何图片资产:不要写 wallpaper 字段,引用不存在的图会被拒收。";
	const intro =
		mode === "create"
			? "你会收到主人想要的风格,**从零设计一整套**并输出完整的 skin.json。名字(name)与一句描述(description)也由你起,要贴合风格。要求里**给了具体色值**(某部作品的代表色之类)就照它配色,别自己另起一套 —— 那些色值可能是聊天那一侧专门查来的。"
			: "你会收到当前皮肤的 skin.json 草稿和一句修改要求,输出**修改后的完整 skin.json**。";

	return `你是「bilibili-notify」Web 面板的皮肤设计师。${intro}

## 规则

- schemaVersion 固定 1;没被要求改的字段一律原样保留,不要顺手删改
- colors 的可用键(只收这些,别的键会被静默忽略):${COLOR_KEY_LIST};值只收 hex / rgb() / hsl() / oklch() / transparent(禁 url()、var()、分号)
- modes: { light?, dark? },每套里可用 colors / page.background / wallpaper(image·fit·position·overlay 0~0.8·blur 0~40)/ chat(background·wallpaper 同构 —— AI 聊天页专属背景,只管背景:强调色跟随 colors.accent、玻璃件直用 glass 段,background 缺省透出整页皮肤底,通常不用写)/ glass(background·border·strongBackground·strongBorder·blur 0~40·strongBlur;默认装无描边,border 对只在刻意要描边风格(如暗色霓虹边)时才配,亮色/玻璃感皮肤不配)/ fonts.body(**最多 8 个**字体名的数组,只准字母/数字/空格/点/连字符,别加引号;拿不准就整个不写)/ radius(card 0~32·pill 0~999)/ shadows(card·elev)/ css / effects
- wallpaper.overlay 是遮罩纱,纱色自动跟模式(亮=白纱/暗=黑纱);wallpaper.blur 是壁纸自身高斯模糊。亮色+高饱和壁纸的配方:overlay 0.3~0.4 + blur 8~16。卡内列表行默认全透明(内容直接画在玻璃上,别在玻璃卡里叠第二层),只有刻意要行条底/描边时才配 colors.listRow / colors.listRowBorder
- effects 动效预设两道可选:glassShine { color? } / bokeh { colors: [1~4 色] }
- 顶层可给 texts: { headerTitle, chatPlaceholder }(≤60 字)与 css(明暗共用)
- ${assetNote}

## 库内最佳实践(官方皮肤库的统一手感;用户没提相反要求时照此执行)

- 亮色:glass 统一 background "rgba(255, 255, 255, 0.85)" / strongBackground "rgba(255, 255, 255, 0.88)" / blur 12,不配描边;不写 shadows(默认装双层影即亮色标准);**不写 effects**(流光/光斑全属暗色,亮色靠渐变结界底+配色+CSS 出表现力)
- 暗色:glass background 取深底色相 alpha 0.55、strongBackground 更深一档 alpha 0.85,blur 18 / strongBlur 26;描边配霓虹细边(border 0.22~0.28 / strongBorder 0.3~0.35);shadows 统一双层:card "0 10px 36px rgba(<深底>, 0.65), 0 0 18px rgba(<主强调>, 0.12)"、elev "0 18px 56px rgba(<深底>, 0.75), 0 0 30px rgba(<主强调>, 0.2)";开 glassShine(主强调 alpha 0.32)+ bokeh 2~3 团霓虹(alpha 0.4~0.75)—— 动效特效是暗色专属语汇
- chatPlaceholder 写沉浸式世界观文案:「状态确认 + 引导输入」句式(如「神经链路已接入,输入指令开始同步…」),别写说明书腔

## 自定义 CSS(组件级造型与动效的主力)

- 选择器只准 [data-bn="<挂点>"] 配伪类/伪元素/组合器。挂点就这些,各自长这样:
${HOOK_LIST}
- **胶囊/正圆圆角(border-radius 999px、50%)只准给按钮、头像这类矮元素**;容器类挂点(page / glass / glass-strong / nav / header / modal)圆角别超过 24px —— 容器有高瘦形态,套上 999px 会鼓成一个大椭圆
- 属性只收视觉白名单(background/border/box-shadow/color/opacity/filter/backdrop-filter/transform/transition/animation/border-radius/clip-path/inset/width/height/z-index 等);display、pointer-events、visibility 会被丢弃
- 禁 url()(图走字段,CSS 里写了会被剔除);position 只准 static/relative/absolute;伪元素 content 只准 "" 或 none
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
	const missing = [...referencedImages(parsed.skin)].filter((image) => !assets.has(image));
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
	/** 包内可用资产;manifest 引用了这之外的图 = 拒收。 */
	assets: Set<string>;
}): Promise<SkinAiEditResult> {
	const first = await input.generateRaw(input.system, input.user);
	const parsed = tryParse(first, input.assets);
	if (parsed.ok) return parsed;

	// 带错误反馈重试一次 —— 原答也附上,让模型知道自己上次说了什么。
	const retryUser = `${input.user}\n\n你上次的输出未通过校验:\n${parsed.errors.map((e) => `- ${e}`).join("\n")}\n\n上次输出:\n${first}\n\n请修正后重新输出完整 skin.json,仍然只输出 JSON。`;
	const second = await input.generateRaw(input.system, retryUser);
	return tryParse(second, input.assets);
}

export async function runSkinAiEdit(input: SkinAiEditInput): Promise<SkinAiEditResult> {
	return runSkinAiRound({
		generateRaw: input.generateRaw,
		system: buildSkinAiSystemPrompt(input.assets),
		user: `当前 skin.json 草稿:\n${JSON.stringify(input.draft, null, "\t")}\n\n修改要求:${input.instruction}`,
		assets: new Set(input.assets),
	});
}
