/**
 * 女仆技能(Agent Skill)的 wire 契约 —— `apps/server` ↔ `apps/web` 共用。
 *
 * 一条技能 = 一份 `SKILL.md`(YAML frontmatter + Markdown 正文),存在
 * `<dataDir>/maid-skills/<name>/SKILL.md`。形状照 Claude Code 的 Agent Skill
 * 标准,但**不跑脚本、不带附件**(ADR-0001)。
 *
 * 尺子(名字正则 / 长度上限)放在这里而不是各写一份:服务端拒收与网页端提示若
 * 各判各的,迟早会出现「网页说没问题、存进去被拒」这种主人无从下手的状态。
 */

/**
 * 技能名的形状:kebab-case ASCII。
 *
 * 它**同时是磁盘目录名与斜杠命令**,所以白名单里一个 `.` `/` `\` 都没有 ——
 * `..` 在构造上就拼不出来。服务端仍会独立再判一次(网页这边只是提前告诉主人),
 * 那道闸才是安全边界。
 */
export const MAID_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAID_SKILL_LIMITS = {
	/** 名字长度 —— 目录名与斜杠命令都要打。 */
	nameChars: 32,
	/**
	 * description 长度。常驻成本全压在这一句上:每一条参与模型自选的技能,每轮
	 * 请求都带着它的 description。
	 */
	descChars: 200,
	/** 正文长度。只在技能被用上那一轮进上下文,可以宽得多,但不能没有底。 */
	bodyChars: 20_000,
} as const;

/** 一条技能。`builtin` 的改不动也删不掉(只读、跟版本走)。 */
export interface MaidSkillDTO {
	name: string;
	description: string;
	/** 允许用的工具名**子集**;缺席 = 不限。只减不加,写个不存在的名字不会长出工具。 */
	allowedTools?: string[];
	/** 退出模型自选,只留斜杠命令这条路。 */
	disableModelInvocation: boolean;
	body: string;
	builtin: boolean;
}

/** 盘上读不进来的一条 —— 主人手放的文件写错了,得让他看得见。 */
export interface MaidSkillProblemDTO {
	/** `<dataDir>/maid-skills/` 下的目录名。 */
	dir: string;
	reason: string;
}

export interface MaidSkillsListResponse {
	list: MaidSkillDTO[];
	/** 空数组 = 盘上一切正常。非空时界面要显眼地提一句,否则主人以为自己没放对地方。 */
	problems: MaidSkillProblemDTO[];
	/**
	 * 现在真的存在的工具名 —— 编辑器拿它摆 `allowed-tools` 的勾选框。
	 *
	 * 由服务端给而不是网页自己写一份:工具表的真身在 `packages/ai`,抄一份到前端
	 * 就等于埋一张早晚过期的表,而过期的表在界面上长成「勾了一把根本不存在的工具」
	 * —— 收窄是交集,那一勾会静默地什么都不做。
	 */
	tools: string[];
}

/** 新建 / 修改的请求体。`builtin` 不收 —— 那是服务端的判定,不是主人能声明的。 */
export type MaidSkillWriteRequest = Omit<MaidSkillDTO, "builtin">;

/**
 * 「读取一条技能」那把工具的名字 —— 服务端建工具、web 端画调用痕迹胶囊,
 * 两处共用这一个标识。各写一份字面量的话,改名会**静默**让胶囊不再出现。
 *
 * 与 `create_skin` 同一条注入路(dashboard 聊天的 ExtraTool),**绝不进
 * `TOOL_DEFINITIONS`** —— 那张表是三端共享的,而 koishi 的 `bili.chat` 没有权限门。
 */
export const AI_TOOL_LOAD_SKILL = "load_skill";
