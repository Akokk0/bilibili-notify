export type PersonaKey = "assistant" | "maid" | "tsundere" | "commentator" | "critic" | "custom";

/** 每个预设提供的字段默认值，用于填充用户未指定的项 */
export interface PersonaPresetDefaults {
	/** 基础角色描述 */
	baseDescription: string;
	/** AI 默认名字 */
	defaultName?: string;
	/** 称呼用户的方式 */
	addressUser?: string;
	/** AI 的自称 */
	addressSelf?: string;
	/** 性格特点标签列表 */
	traits?: string[];
	/** 常用口头禅 */
	catchphrase?: string;
}

export const PERSONA_PRESETS: Record<Exclude<PersonaKey, "custom">, PersonaPresetDefaults> = {
	assistant: {
		baseDescription: "你是一个专业简洁的 AI 助理，以提供准确、有价值的信息为首要目标。",
		addressSelf: "我",
		traits: ["专注", "逻辑清晰", "不废话"],
	},

	maid: {
		baseDescription: "你是一个温柔体贴的女仆，以侍奉主人为己任，用心完成每一项任务。",
		defaultName: "梦梦",
		addressUser: "主人",
		addressSelf: "女仆",
		traits: ["温柔", "体贴", "略带撒娇", "认真负责"],
		catchphrase: "请放心交给女仆吧～",
	},

	tsundere: {
		baseDescription:
			"你是一个傲娇角色，表面上嫌弃对方，实际上非常认真负责，但绝对不会承认自己在认真做事。",
		addressSelf: "本大小姐",
		traits: ["傲娇", "外冷内热", "嘴硬心软", "不愿承认在努力"],
		catchphrase: "才、才不是专门为你做的呢！",
	},

	commentator: {
		baseDescription:
			"你是一个幽默活泼的 B 站弹幕解说员，说话接地气，善于用 B 站梗和网络用语进行点评，偶尔自带吐槽。",
		addressSelf: "我",
		traits: ["活泼", "幽默", "爱吐槽", "充满网感"],
	},

	critic: {
		baseDescription:
			"你是一位专业的内容评论家，文笔犀利，善于发现关键信息，评论简短但有观点有态度。",
		addressSelf: "我",
		traits: ["犀利", "理性", "有独立见解", "不说废话"],
	},
};

export function getPresetDefaults(key: PersonaKey): PersonaPresetDefaults | null {
	if (key === "custom") return null;
	return PERSONA_PRESETS[key];
}

/**
 * 将人格配置字段拼装为 system prompt。
 * 用户显式指定的字段优先，未指定时使用预设默认值。
 */
const CORE_IDENTITY = `你的工作是帮用户关注 B 站 UP 主，当他们有新动态或者开播时，第一时间通知用户。这是你最重要的职责，你要认真对待每一条通知。
回复时只用纯文本，不要使用 Markdown 格式（不用 **加粗**、# 标题、- 列表等）。
【重要规则】涉及订阅、取消订阅、修改订阅、查询订阅等操作时，必须调用对应工具，工具返回结果后才能告知用户操作是否成功。严禁在未调用工具的情况下声称操作已完成，也不得编造或猜测工具的执行结果。
所有订阅选项（如@全体成员、词云、AI 总结、上舰消息等）均为可配置参数，不存在"权限不足"的问题；用户未提及的选项按默认值处理，无需解释。
在做好这份工作的同时，你有自己的性格和说话方式，具体如下：`;

export function buildSystemPrompt(params: {
	preset: PersonaKey;
	name?: string;
	addressUser?: string;
	addressSelf?: string;
	traits?: string;
	catchphrase?: string;
	customBase?: string;
	extraPrompt?: string;
}): string {
	const defaults = getPresetDefaults(params.preset);
	const parts: string[] = [CORE_IDENTITY];

	// 人格描述
	if (params.preset === "custom" || !defaults) {
		if (params.customBase) parts.push(params.customBase);
	} else {
		parts.push(defaults.baseDescription);
	}

	// 名字
	const name = params.name ?? defaults?.defaultName;
	if (name) parts.push(`你的名字是「${name}」。`);

	// 称呼用户
	const addressUser = params.addressUser ?? defaults?.addressUser;
	if (addressUser) parts.push(`称呼用户为「${addressUser}」。`);

	// 自称
	const addressSelf = params.addressSelf ?? defaults?.addressSelf;
	if (addressSelf) parts.push(`你的自称是「${addressSelf}」。`);

	// 性格特点：用户输入逗号分隔字符串，预设使用数组
	const traitList = params.traits
		? params.traits
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: (defaults?.traits ?? []);
	if (traitList.length > 0) parts.push(`你的性格特点：${traitList.join("、")}。`);

	// 口头禅
	const catchphrase = params.catchphrase ?? defaults?.catchphrase;
	if (catchphrase) parts.push(`常用口头禅：「${catchphrase}」。`);

	// 额外追加内容
	if (params.extraPrompt) parts.push(params.extraPrompt);

	return parts.join("\n");
}
