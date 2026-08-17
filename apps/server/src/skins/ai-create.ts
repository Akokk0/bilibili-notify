/**
 * 从**一句话**生成一整套皮肤 —— 聊天里「女仆,给我做套赛博朋克的皮肤」那条路的
 * 生成层。产物是清洗后的 manifest,落盘由调用方(`chat-tool.ts`)负责。
 *
 * 与 `ai-edit`(改现有皮肤)共用同一份规格提示词与同一条重试纪律,差别只有两处:
 * - 起点是要求而不是草稿,所以 system 走 create 口吻,并把 colors 键摊开;
 * - 新包里一张图都没有 —— 聊天里递不了壁纸,任何图片引用当场拒收(`assets` 恒空)。
 *
 * 为什么不让聊天的模型直接在工具入参里吐 skin.json:那得把整份 schema 规格塞进
 * 每一轮聊天的 system,聊天气都还没聊就先烧掉几千 token;而且皮肤规格与女仆人格
 * 混在一个上下文里,两边都会被带跑。这里是**嵌套一次专职调用**,规格只在那一次
 * 出现。
 */

import type { SkinAiGenerator } from "./ai-edit.js";
import { buildSkinAiSystemPrompt, runSkinAiRound, type SkinAiEditResult } from "./ai-edit.js";

export interface SkinAiCreateInput {
	generateRaw: SkinAiGenerator["generateRaw"];
	/** 主人想要的皮肤(自然语言),由聊天里的女仆转述、补全细节后递进来。 */
	brief: string;
}

/** 与 edit 同形:成功给清洗后的 manifest + 清洗警告,失败给能转述给主人的错误串。 */
export type SkinAiCreateResult = SkinAiEditResult;

export async function runSkinAiCreate(input: SkinAiCreateInput): Promise<SkinAiCreateResult> {
	return runSkinAiRound({
		generateRaw: input.generateRaw,
		system: buildSkinAiSystemPrompt([], "create"),
		user: `主人想要的皮肤风格:${input.brief}\n\n请据此从零设计一整套,输出完整的 skin.json。`,
		assets: new Set<string>(),
	});
}
