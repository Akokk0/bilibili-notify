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
 * `..` 在构造上就拼不出来。皮肤库那次审计的教训摆在这儿:`SkinStore.remove` 少了
 * 这道闸,被 `DELETE /%2e%2e%2fconversations` 删掉了整个会话目录。
 *
 * 只收小写还有第二重理由:macOS 的文件系统大小写不敏感、且会把文件名归一化成
 * NFD,这两件事只在纯 ASCII 小写这一档上没有意外。
 *
 * 服务端仍会独立再判一次(网页这边只是提前告诉主人),那道闸才是安全边界。
 * 主人 2026-08-20 拍板走 Claude Code 的 kebab-case ASCII 标准。
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

/**
 * 名字能不能用。**这是一道安全闸,不只是口味** —— 名字同时是磁盘目录名与斜杠
 * 命令,见 {@link MAID_SKILL_NAME_RE}。收 `unknown`:服务端那一侧是从主人手写的
 * YAML 里掏出来的,类型上什么都可能。
 */
export function isValidSkillName(name: unknown): boolean {
	if (typeof name !== "string") return false;
	if (name.length === 0 || name.length > MAID_SKILL_LIMITS.nameChars) return false;
	return MAID_SKILL_NAME_RE.test(name);
}

/**
 * 一条技能能不能存下来 —— 返回 `null` = 能;返回一句话 = 不能,那句就是给主人
 * 看的理由。
 *
 * 五条规则**两端共用**。收编前服务端(真闸)与网页端(省一趟往返的预检)各写
 * 一份:顺序一样、五句里三句一字不差,剩下两句只是同一件事的两种说法。尺子早就
 * 放在这个文件里了(见顶上那段),判法却还留在两边 —— 而少改一边的后果正是那段
 * 注释要防的:「网页说没问题、存进去被拒」。
 *
 * **它不替代服务端那道闸**:网页端只是提前说,真正的边界仍在服务端 —— 只是现在
 * 两边照的是同一把尺子、说的是同一句话。
 */
export function complainAboutSkill(d: {
	name: unknown;
	description: unknown;
	body: unknown;
}): string | null {
	if (!isValidSkillName(d.name)) {
		return `名字只收小写字母 / 数字 / 单个连字符(如 weekly-report),最长 ${MAID_SKILL_LIMITS.nameChars} 字符`;
	}
	const description = typeof d.description === "string" ? d.description.trim() : "";
	if (description === "") return "得写一句 description —— 女仆靠它决定要不要用这条";
	if (description.length > MAID_SKILL_LIMITS.descChars) {
		return `description 超长(上限 ${MAID_SKILL_LIMITS.descChars} 字)`;
	}
	const body = typeof d.body === "string" ? d.body.trim() : "";
	if (body === "") return "正文是空的 —— 一条什么都不说的技能等于没有";
	if (body.length > MAID_SKILL_LIMITS.bodyChars) {
		return `正文超长(上限 ${MAID_SKILL_LIMITS.bodyChars} 字)`;
	}
	return null;
}

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
 * `TOOL_DEFINITIONS`** —— 那张表是群聊路径也共享的,而群里没有权限门。
 */
export const AI_TOOL_LOAD_SKILL = "load_skill";
