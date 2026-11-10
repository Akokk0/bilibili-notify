import { packageLocale } from "@bilibili-notify/internal/texts";
import { type PromptNouns, renderPromptNouns } from "./prompt-nouns";

/** 模型规则保持中文；只在一次请求开始时读取当前输出语言，工具轮和重试沿用这一份。 */
export function withOutputLanguage(prompt: string): string {
	const languages = {
		"zh-CN": "简体中文",
		en: "英文，使用英文标点",
		ja: "日文，使用日文标点",
		"zh-TW": "台湾繁体中文，使用台湾惯用词",
	};
	return `${prompt}\n\n【输出语言】面向用户的自然语言内容使用${languages[packageLocale()]}。前文出现其他语言要求时，以本条为准。保留代码、字段名、枚举值、占位符和引用原文；用户明确要求逐字保留的片段，不论使用哪种语言，都必须完整原样输出，不得翻译、拆分或省略；结构化输出仍严格遵守原格式。`;
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
const CORE_IDENTITY_HEAD = `你的工作是帮用户关注{sources}上的{creatorNoun}：他们有新{postNoun}或开播时，系统会第一时间推送，你负责其中的点评、总结和答疑。`;

/**
 * 工具铁律 —— **只发给真的挂了工具的那两条路**(试推送的 `chat()` / dashboard 聊天
 * `chatStateless()`)。
 *
 * 它曾经是无条件拼进 `CORE_IDENTITY` 的,于是动态点评、直播总结这些**一个工具都没挂**
 * 的场景也照收:模型被告知「查订阅必须调工具」,手上却什么都没有,只好用自然语言演一遍
 * ——「我得先确认一下我这边有没有订阅这个 UP 主…让我先看看订阅情况,稍等一下哦!」
 * 然后就没有然后了。用户拿到的整条锐评就是这么一句空转。
 *
 * **只讲查询,不许承诺写。** 工具表是只读的(见 `tools.ts` 的 `executeTool` 文档与
 * `read-only-tools-gate.test.ts`)—— 增删改订阅的工具是刻意下架的,因为群聊上下文里塞
 * 满外部可控内容而 `bili.chat` 没有权限门。所以这里不能再指着不存在的写工具说「必须
 * 调用」,更不能说「不存在权限不足的问题」:那是在鼓励模型表现得像它能配置订阅,轻则
 * 空转,重则回一句「已经帮你取消了」而什么也没发生。
 */
const TOOL_LAW = `【重要规则】查询订阅、{creatorNoun}信息、直播状态等，必须调用对应工具，拿到结果后再回答；严禁在未调用工具的情况下编造或猜测结果。
订阅的添加、取消、修改只能由用户自己在面板或命令里操作，你没有这个能力——遇到这类请求直接说明并引导，不要声称已经办好。`;

/**
 * 没挂工具那条路的对应规则(动态点评 / 直播总结 / 统计页锐评)。
 *
 * 光把 {@link TOOL_LAW} 摘掉不够 —— 模型仍然知道自己「负责帮用户关注创作者」,照样会
 * 自作主张说要去翻订阅列表。得把这条路堵死。
 *
 * 但堵它**不必提到工具**。这条路的请求里压根没挂 tools,模型本来就调不了;写一句「你
 * 没有任何可调用的工具」反倒是主动把这个概念请进上下文,徒增噪音。所以只正面讲清这次
 * 要干什么:就眼前的素材作答、一次说完、别预告下一步。
 */
const NO_TOOL_LAW = `【本次任务】就眼前给到的内容直接作答，一次说完。不要预告下一步动作（「让我查一下」「稍等」），也不要向用户索取更多信息。`;

const CORE_IDENTITY_TAIL = `在做好这份工作的同时，你有自己的性格和说话方式，具体如下：`;

/**
 * 无人格那一档的收尾 —— 替换 {@link CORE_IDENTITY_TAIL} 的位置。
 *
 * 不能只是「把性格删掉」了事:什么都不说的话,模型会自己找一副腔调补上(多半是
 * 客服腔的「很高兴为您服务」)。明写一句要什么,比留白稳。
 */
const NO_PERSONA_TONE = `回答保持中立、简洁、就事论事，不要给自己设定名字或性格，也不要用角色扮演的口吻。`;

/**
 * 将人格配置字段拼装为 system prompt。
 * 人格内容只取调用方传入的字段。
 */

export function buildSystemPrompt(params: {
	/** 这次涉及的来源叫法,由服务端现取。 */
	nouns: PromptNouns;
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
	/**
	 * 这次要带上人格吗?dashboard 的聊天里主人开局能选「无人格」那一档。
	 *
	 * **缺省是 true**,方向与上面两个相反但同理:三端共享这个包,漏传的调用方
	 * (推送、点评、总结)必须一字不变地拿到原来的行为。
	 *
	 * 关掉的只有**性格**:职责说明、Markdown 约定、工具铁律一条都不动 —— 少了
	 * 工具铁律,模型连「查订阅得调工具」都会忘(见 persona-prompt-tools.test.ts
	 * 记着的那个老 bug)。
	 */
	withPersona?: boolean;
}): string {
	const withPersona = params.withPersona ?? true;
	const parts: string[] = [
		[
			CORE_IDENTITY_HEAD,
			...(params.allowMarkdown ? [] : [PLAIN_TEXT_ONLY]),
			params.withTools ? TOOL_LAW : NO_TOOL_LAW,
			// 引子后面就是性格那一串;不带人格时连引子一起收,否则末尾挂着一句
			// 「具体如下:」而下文空空。
			...(withPersona ? [CORE_IDENTITY_TAIL] : [NO_PERSONA_TONE]),
		].join("\n"),
	];
	if (!withPersona) return renderPromptNouns(parts.join("\n"), params.nouns);

	// 人格描述
	if (params.customBase) parts.push(params.customBase);

	// 名字
	if (params.name) parts.push(`你的名字是「${params.name}」。`);

	// 称呼用户
	if (params.addressUser) parts.push(`称呼用户为「${params.addressUser}」。`);

	// 自称
	if (params.addressSelf) parts.push(`你的自称是「${params.addressSelf}」。`);

	// 性格特点：调用方输入逗号分隔字符串。
	const traitList = params.traits
		? params.traits
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: [];
	if (traitList.length > 0) parts.push(`你的性格特点：${traitList.join("、")}。`);

	// 口头禅
	if (params.catchphrase) parts.push(`常用口头禅：「${params.catchphrase}」。`);

	// 额外追加内容
	if (params.extraPrompt) parts.push(params.extraPrompt);

	return renderPromptNouns(parts.join("\n"), params.nouns);
}
