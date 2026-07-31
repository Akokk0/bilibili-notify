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
 * 「只用纯文本」——**只发给不渲染 Markdown 的那些去处**。
 *
 * QQ / Telegram / webhook 收到的是纯文字,`**加粗**` 在那儿就是字面的星号。而
 * dashboard 的聊天是渲染 Markdown 的,同一条约束在那边纯属反作用 —— 所以它由
 * {@link buildSystemPrompt} 的 `allowMarkdown` 摘除。
 *
 * 拎成常量而不是拿字符串匹配去删一行:那样改天文案一动就悄悄失效了。
 */
const PLAIN_TEXT_ONLY = `回复时只用纯文本，不要使用 Markdown 格式（不用 **加粗**、# 标题、- 列表等）。`;

/**
 * 共用开头拆成前后两截,`PLAIN_TEXT_ONLY` 夹在**原来的位置**(第一句之后、
 * 【重要规则】之前)。
 *
 * 不图省事把它挪到整段末尾:那样推送侧看到的提示词顺序就变了。这条链上的
 * 收件人是主人的群,「行为不变」得是字面意义上的不变。
 */
const CORE_IDENTITY_HEAD = `你的工作是帮用户关注 B 站 UP 主，当他们有新动态或者开播时，第一时间通知用户。这是你最重要的职责，你要认真对待每一条通知。`;

/**
 * 工具铁律 —— **只发给真的挂了工具的那两条路**(群聊女仆 `chat()` / dashboard 聊天
 * `chatStateless()`)。
 *
 * 它曾经是无条件拼进 `CORE_IDENTITY` 的,于是动态点评、直播总结这些**一个工具都没挂**
 * 的场景也照收:模型被告知「查订阅必须调工具」,手上却什么都没有,只好用自然语言演一遍
 * ——「我得先确认一下我这边有没有订阅这个 UP 主…让我先看看订阅情况,稍等一下哦!」
 * 然后就没有然后了。用户拿到的整条锐评就是这么一句空转。
 */
const TOOL_LAW = `【重要规则】涉及订阅、取消订阅、修改订阅、查询订阅等操作时，必须调用对应工具，工具返回结果后才能告知用户操作是否成功。严禁在未调用工具的情况下声称操作已完成，也不得编造或猜测工具的执行结果。
所有订阅选项（如@全体成员、词云、AI 总结、上舰消息等）均为可配置参数，不存在"权限不足"的问题；用户未提及的选项按默认值处理，无需解释。`;

/**
 * 没挂工具那条路的对应规则(动态点评 / 直播总结 / 统计页锐评)。
 *
 * 光把 {@link TOOL_LAW} 摘掉不够 —— 模型仍然知道自己「负责帮用户关注 UP 主」,照样会
 * 自作主张说要去翻订阅列表。得明说这一次手上没有工具、素材就在眼前,把那条路堵死。
 */
const NO_TOOL_LAW = `【重要规则】这一次你没有任何可调用的工具，查不到订阅列表，也改不了任何设置。眼前给你的内容就是全部素材，直接据此作答即可——不要说「让我查一下」「稍等」，不要声称你要去确认订阅情况，也不要向用户索取更多信息。`;

const CORE_IDENTITY_TAIL = `在做好这份工作的同时，你有自己的性格和说话方式，具体如下：`;

/**
 * 将人格配置字段拼装为 system prompt。
 * 用户显式指定的字段优先，未指定时使用预设默认值。
 */

export function buildSystemPrompt(params: {
	preset: PersonaKey;
	name?: string;
	addressUser?: string;
	addressSelf?: string;
	traits?: string;
	catchphrase?: string;
	customBase?: string;
	extraPrompt?: string;
	/**
	 * 调用方会渲染 Markdown 吗?只有 dashboard 的聊天会。
	 *
	 * **缺省是 false**,方向是要紧的:漏传的调用方拿到的是推送该有的行为(仍然
	 * 叮嘱纯文本),而不是把 `**加粗**` 泄进主人的群里。
	 */
	allowMarkdown?: boolean;
	/**
	 * 这次调用**真的挂了工具**吗?挂了才发工具铁律,否则发「你没有工具」那条。
	 *
	 * **缺省是 false**,方向和 `allowMarkdown` 一样要紧:漏传的调用方拿到的是
	 * 「没有工具」这个不会出岔子的默认。反过来(默认发铁律)就是那个 bug —— 锐评
	 * 那条路从来没人想起来要关掉它。
	 */
	withTools?: boolean;
}): string {
	const defaults = getPresetDefaults(params.preset);
	const parts: string[] = [
		[
			CORE_IDENTITY_HEAD,
			...(params.allowMarkdown ? [] : [PLAIN_TEXT_ONLY]),
			params.withTools ? TOOL_LAW : NO_TOOL_LAW,
			CORE_IDENTITY_TAIL,
		].join("\n"),
	];

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
