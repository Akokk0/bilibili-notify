import { t as serverText } from "../i18n/index.js";
/**
 * 服务端注入给聊天的几把工具(读技能、做皮肤、卡片工坊)给人看的标签。
 *
 * 只放字(多语言字典落地后整个收进去);工具定义处引用这里,逻辑里不拼句子。核心自带
 * 那几把的标签在 `packages/ai/src/tool-label-texts.ts`。
 *
 * `labelArg`:小条上补哪一格入参(`keys` 按顺序取第一个有值的,`format` 翻那一格的值)。
 */

import type { AiToolLabelFields } from "@bilibili-notify/ai";
import type { AI_CARD_WORKSHOP_TOOLS as CARD } from "@bilibili-notify/contract";
import { CARD_KIND_NAMES } from "@bilibili-notify/internal";

/** 卡种名翻成中文;认不出就原样留着,别留一片空白。 */
const kindName = (kind: string): string =>
	(CARD_KIND_NAMES as Readonly<Record<string, string>>)[kind] ?? kind;

type LabelTexts = AiToolLabelFields;

/**
 * 读技能。**两条路共用这一条**:女仆自己挑的,以及主人打斜杠点名的(那一枚痕迹是服务端
 * 手工补的)。名字一定要显示出来 —— 这枚小条存在的全部意义就是交代「她为什么突然换了套说法」。
 */
export const LOAD_SKILL_LABEL: LabelTexts = {
	get label() {
		return serverText("service.ai.tool-label-texts.text.1");
	},
	labelArg: { keys: ["name"] },
};

/** 做皮肤要跑一整趟嵌套生成,几十秒起步 —— 小条上写清「在做什么样的」,主人才知道不是卡住了。 */
export const CREATE_SKIN_LABEL: LabelTexts = {
	get label() {
		return serverText("service.ai.tool-label-texts.text.2");
	},
	labelArg: { keys: ["brief"] },
};

/** 卡片皮肤工坊。做一整套是十来次调用,小条得分得清「这一下在动哪张卡、哪一块」。 */
export const CARD_WORKSHOP_LABELS: Readonly<Record<keyof typeof CARD, LabelTexts>> = {
	listSkins: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.3");
		},
	},
	readCard: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.4");
		},
		labelArg: { keys: ["kind"], format: kindName },
	},
	readBlock: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.5");
		},
		labelArg: { keys: ["block"] },
	},
	lookCard: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.6");
		},
		labelArg: { keys: ["kind"], format: kindName },
	},
	writeCard: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.7");
		},
		labelArg: { keys: ["kind"], format: kindName },
	},
	setBlock: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.8");
		},
		labelArg: { keys: ["block"] },
	},
	removeBlock: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.9");
		},
		labelArg: { keys: ["block"] },
	},
	setSkinMeta: {
		get label() {
			return serverText("service.ai.tool-label-texts.text.10");
		},
		labelArg: { keys: ["name"] },
	},
};
