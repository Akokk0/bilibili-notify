/**
 * 服务端注入给聊天的几把工具(读技能、做皮肤、卡片工坊)给人看的标签。
 *
 * 只放字(多语言字典落地后整个收进去);工具定义处引用这里,逻辑里不拼句子。核心自带
 * 那几把的标签在 `packages/ai/src/tool-label-texts.ts`。
 *
 * `labelArgs`:小条上补哪一格入参,按顺序取第一个有值的。
 */

import type { AiTool } from "@bilibili-notify/ai";
import type { AI_CARD_WORKSHOP_TOOLS as CARD } from "@bilibili-notify/contract";
import { CARD_KIND_NAMES } from "@bilibili-notify/internal";

/** 卡种名翻成中文;认不出就原样留着,别留一片空白。 */
const kindName = (kind: string): string =>
	(CARD_KIND_NAMES as Readonly<Record<string, string>>)[kind] ?? kind;

type LabelTexts = Pick<AiTool, "label" | "labelArgs" | "formatLabelArg">;

/**
 * 读技能。**两条路共用这一条**:女仆自己挑的,以及主人打斜杠点名的(那一枚痕迹是服务端
 * 手工补的)。名字一定要显示出来 —— 这枚小条存在的全部意义就是交代「她为什么突然换了套说法」。
 */
export const LOAD_SKILL_LABEL: LabelTexts = { label: "使用技能", labelArgs: ["name"] };

/** 做皮肤要跑一整趟嵌套生成,几十秒起步 —— 小条上写清「在做什么样的」,主人才知道不是卡住了。 */
export const CREATE_SKIN_LABEL: LabelTexts = { label: "制作皮肤", labelArgs: ["brief"] };

/** 卡片皮肤工坊。做一整套是十来次调用,小条得分得清「这一下在动哪张卡、哪一块」。 */
export const CARD_WORKSHOP_LABELS: Readonly<Record<keyof typeof CARD, LabelTexts>> = {
	listSkins: { label: "查看卡片皮肤库" },
	readCard: { label: "看卡片", labelArgs: ["kind"], formatLabelArg: kindName },
	readBlock: { label: "看卡片的块", labelArgs: ["block"] },
	lookCard: { label: "看一眼效果", labelArgs: ["kind"], formatLabelArg: kindName },
	writeCard: { label: "写卡片", labelArgs: ["kind"], formatLabelArg: kindName },
	setBlock: { label: "改卡片的块", labelArgs: ["block"] },
	removeBlock: { label: "删卡片的块", labelArgs: ["block"] },
	setSkinMeta: { label: "给卡片皮肤起名", labelArgs: ["name"] },
};
