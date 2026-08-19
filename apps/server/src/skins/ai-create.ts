/**
 * 从**一句话**生成一整套皮肤 —— 聊天里「女仆,给我做套赛博朋克的皮肤」那条路的
 * 生成层。产物是清洗后的 manifest,落盘由调用方(`chat-tool.ts`)负责。
 *
 * 与 `ai-edit`(改现有皮肤)共用同一份规格提示词与同一条重试纪律,差别只有两处:
 * - 起点是要求而不是草稿,所以 system 走 create 口吻,并把 colors 键摊开;
 * - 包里的图只有主人这一问贴进来的那张(调用方拷进 `assets`),没贴就是零资产 ——
 *   AI 自己写不出图,引用了包里没有的名字一律当场拒收。
 *
 * 为什么不让聊天的模型直接在工具入参里吐 skin.json:那得把整份 schema 规格塞进
 * 每一轮聊天的 system,聊天气都还没聊就先烧掉几千 token;而且皮肤规格与女仆人格
 * 混在一个上下文里,两边都会被带跑。这里是**嵌套一次专职调用**,规格只在那一次
 * 出现。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import type { SkinAiGenerator } from "./ai-edit.js";
import { buildSkinAiSystemPrompt, runSkinAiRound, type SkinAiEditResult } from "./ai-edit.js";

/**
 * 兜底补写壁纸时用的参数。取自 system 里那条「亮色 + 高饱和壁纸」的配方
 * (overlay 0.3~0.4 + blur 8~16)的中间值 —— 谁都不难看,谁都不惊艳。
 * 设计师自己配了就不走这儿,它挑的值比这套通用值懂行。
 */
const FALLBACK_OVERLAY = 0.35;
const FALLBACK_BLUR = 12;

export interface SkinAiCreateInput {
	generateRaw: SkinAiGenerator["generateRaw"];
	/** 主人想要的皮肤(自然语言),由聊天里的女仆转述、补全细节后递进来。 */
	brief: string;
	/**
	 * 这次新包里会有的图(`assets/<名>`)。给了才准写 wallpaper —— 名字要一字不差
	 * 地进 system,否则设计师按「包里没有图」那条规矩绕开壁纸。
	 */
	assets?: readonly string[];
	/**
	 * 主人**点名要当壁纸**的那张(包内路径)。给了就保证它出现在产物里:设计师
	 * 自己写进去最好,没写就由这一层补。
	 *
	 * 为什么不只靠提示词:提示词已经说了「必须用上」,可那是一句请求不是一道闸。
	 * 真机上它被当成可选绕过去一次,而一趟生成两分多钟、主人拿到的是一套纯色底
	 * 皮肤 —— 这种代价不该由一句措辞兜着。
	 */
	wallpaper?: string;
	/** 设计师吐字的进度,原样交给 {@link runSkinAiRound}。 */
	onProgress?: (chars: number) => void;
}

/** 与 edit 同形:成功给清洗后的 manifest + 清洗警告,失败给能转述给主人的错误串。 */
export type SkinAiCreateResult = SkinAiEditResult;

export async function runSkinAiCreate(input: SkinAiCreateInput): Promise<SkinAiCreateResult> {
	const assets = [...(input.assets ?? [])];
	const result = await runSkinAiRound({
		generateRaw: input.generateRaw,
		...(input.onProgress ? { onProgress: input.onProgress } : {}),
		system: buildSkinAiSystemPrompt(assets, "create"),
		user: `主人想要的皮肤风格:${input.brief}\n\n请据此从零设计一整套,输出完整的 skin.json。`,
		assets: new Set(assets),
	});
	if (!result.ok || !input.wallpaper) return result;
	return attachWallpaper(result, input.wallpaper);
}

/**
 * 把主人点名的那张图补进每一套 mode。已经自己配了 `wallpaper.image` 的 mode 一律
 * 不碰 —— 设计师挑的 overlay / blur 是照着它自己那套配色定的,比通用兜底值懂行。
 *
 * 补出来的值全是本文件里的常量,不经模型,所以不必重跑一遍 parse;
 * 「补出来的也得在 schema 范围内」由测试钉着。
 */
function attachWallpaper(
	result: Extract<SkinAiEditResult, { ok: true }>,
	image: string,
): SkinAiEditResult {
	const modes: SkinManifest["modes"] = { ...result.manifest.modes };
	const patched: string[] = [];
	for (const key of ["light", "dark"] as const) {
		const mode = modes[key];
		if (!mode || mode.wallpaper?.image) continue;
		modes[key] = {
			...mode,
			wallpaper: {
				...mode.wallpaper,
				image,
				fit: "cover",
				overlay: FALLBACK_OVERLAY,
				blur: FALLBACK_BLUR,
			},
		};
		patched.push(key);
	}
	if (patched.length === 0) return result;
	return {
		...result,
		manifest: { ...result.manifest, modes },
		// 编辑器那侧会把警告显出来:让人知道这张壁纸是补上去的,不是设计师配的。
		warnings: [
			...result.warnings,
			`设计师没把主人指定的壁纸写进 ${patched.join(" / ")},已按默认参数补上(overlay ${FALLBACK_OVERLAY} / blur ${FALLBACK_BLUR})`,
		],
	};
}
