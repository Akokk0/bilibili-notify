/**
 * 抽屉内嵌 AI(「让女仆改」)的服务端逻辑。
 *
 * 产物**不落盘**:AI 输出 → 剥围栏 → parseSkinManifest(含 CSS 清洗)+ 资产引用
 * 校验 → 把清洗后的 manifest 还给编辑器 draft,实时预览;保存永远由主人点。
 * 首答校验不过时**带错误反馈自动重试一次**(弱模型常犯格式小错,直接报错太挫败),
 * 二败才对外报 errors。
 */

import { SKIN_CSS_HOOK_MAP, type SkinManifest } from "@bilibili-notify/contract";
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

const HOOK_LIST = Object.keys(SKIN_CSS_HOOK_MAP)
	.map((h) => `"${h}"`)
	.join(" / ");

export function buildSkinAiSystemPrompt(assets: string[]): string {
	const assetNote =
		assets.length > 0
			? `包内可用图片(wallpaper.image / chat.wallpaper.image 只准引用这些):\n${assets.map((a) => `- ${a}`).join("\n")}`
			: "包里没有任何图片资产:不要写 wallpaper 字段,引用不存在的图会被拒收。";

	return `你是「bilibili-notify」Web 面板的皮肤设计师。你会收到当前皮肤的 skin.json 草稿和一句修改要求,输出**修改后的完整 skin.json**。

## 规则

- schemaVersion 固定 1;没被要求改的字段一律原样保留,不要顺手删改
- modes: { light?, dark? },每套里可用 colors / page.background / wallpaper(image·fit·position·overlay 0~0.8·blur 0~40)/ chat(background·wallpaper 同构 —— AI 聊天页专属背景,只管背景:强调色跟随 colors.accent、玻璃件直用 glass 段,background 缺省透出整页皮肤底,通常不用写)/ glass(background·border·strongBackground·strongBorder·blur 0~40·strongBlur;默认装无描边,border 对只在刻意要描边风格(如暗色霓虹边)时才配,亮色/玻璃感皮肤不配)/ fonts.body / radius(card 0~32·pill 0~999)/ shadows(card·elev)/ css / effects
- wallpaper.overlay 是遮罩纱,纱色自动跟模式(亮=白纱/暗=黑纱);wallpaper.blur 是壁纸自身高斯模糊。亮色+高饱和壁纸的配方:overlay 0.3~0.4 + blur 8~16。卡内列表行默认全透明(内容直接画在玻璃上,别在玻璃卡里叠第二层),只有刻意要行条底/描边时才配 colors.listRow / colors.listRowBorder
- effects 动效预设两道可选:glassShine { color? } / bokeh { colors: [1~4 色] }
- 顶层可给 texts: { headerTitle, chatPlaceholder }(≤60 字)与 css(明暗共用)
- ${assetNote}

## 自定义 CSS(组件级造型与动效的主力)

- 选择器只准 [data-bn="<挂点>"] 配伪类/伪元素/组合器;挂点:${HOOK_LIST}
  ("page"=整页,"glass"/"glass-strong"=玻璃卡/弹层,其余对应同名组件)
- 属性只收视觉白名单(background/border/box-shadow/color/opacity/filter/backdrop-filter/transform/transition/animation/border-radius/clip-path/inset/width/height/z-index 等);display、pointer-events、visibility 会被丢弃
- 禁 url()(图走字段,CSS 里写了会被剔除);position 只准 static/relative/absolute;伪元素 content 只准 "" 或 none
- @keyframes 名必须以 skin- 开头;可用 @media (prefers-reduced-motion) 做降级

只输出修改后的 skin.json 的 JSON 内容,不要解释,不要代码块围栏。`;
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

export async function runSkinAiEdit(input: SkinAiEditInput): Promise<SkinAiEditResult> {
	const system = buildSkinAiSystemPrompt(input.assets);
	const assets = new Set(input.assets);
	const baseUser = `当前 skin.json 草稿:\n${JSON.stringify(input.draft, null, "\t")}\n\n修改要求:${input.instruction}`;

	const first = await input.generateRaw(system, baseUser);
	const parsed = tryParse(first, assets);
	if (parsed.ok) return parsed;

	// 带错误反馈重试一次 —— 原答也附上,让模型知道自己上次说了什么。
	const retryUser = `${baseUser}\n\n你上次的输出未通过校验:\n${parsed.errors.map((e) => `- ${e}`).join("\n")}\n\n上次输出:\n${first}\n\n请修正后重新输出完整 skin.json,仍然只输出 JSON。`;
	const second = await input.generateRaw(system, retryUser);
	return tryParse(second, assets);
}
