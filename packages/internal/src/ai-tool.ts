import type { Result } from "./constants";

/**
 * 注入工具的**富返回值** —— 除了回灌给模型的文本,还能顺带收窄接下来的工具面。
 *
 * 直接返回字符串等价于 `{ text }`,绝大多数工具用不上这个形状。
 */
export interface AiToolResult {
	/** 回灌给模型的文本,与直接返回字符串等价。 */
	text: string;
	/**
	 * **下一轮起**把工具表收窄到这些名字。
	 *
	 * 语义是**交集,只减不加**:名字不在当前工具表上就当没写,凭空长不出工具来。
	 * 这条不是口味 —— 唯一的用户是「读取技能」那把工具,而技能正文是主人(或他从
	 * 网上抄来的一份)写的**数据**;用户可写的数据永远不能扩大能力面。
	 *
	 * 想让某把工具在收窄之后仍然在场(比如这把工具自己),**把它的名字一并写进来**
	 * —— generator 不为任何工具开后门。
	 *
	 * 收窄只活这一次请求:工具表随请求现造,下一条用户消息拿回完整的那份。
	 */
	restrictTools?: readonly string[];
	/**
	 * 要交给模型**看**的图(data URL 或公网地址)。
	 *
	 * tool 消息只收文字,所以图不跟着结果走:主模型看得见图,就在这一轮的工具结果后面
	 * 补一条带图的 user 消息;配了看图副模型,就转成文字并进结果;两样都没有,就在结果
	 * 后面说一句看不见。**哪条路由 generator 定** —— 看图配置在它手上,工具不必知道。
	 * 看不见不算失败(ADR-0015 决策 19)。
	 */
	images?: readonly string[];
}

/**
 * 调用方**注入**的额外工具 —— 挂在调用点上,不进 `@bilibili-notify/ai` 的 `TOOL_DEFINITIONS`。
 *
 * 那张表是三端共用的、且只读(见 `executeTool` 的文档与 read-only-tools-gate);
 * 而写能力只有**有权限门的那一端**才配拥有。所以口子开在调用点:注入者给定义 +
 * 执行器,generator 只管挂上与转发,不认识它的语义。目前唯一的注入者是独立端
 * dashboard 的聊天(cookie session 后面,只有主人本人)。
 *
 * `execute` 拿到的入参已被逐值 String 归一(见 `execToolCall`)—— 布尔到手是
 * `"true"` / `"false"`,数字是字符串,按字符串判。
 */
export interface AiTool {
	definition: {
		type: "function";
		function: {
			name: string;
			description?: string;
			parameters?: Record<string, unknown>;
			strict?: boolean | null;
		};
	};
	/** 给人看的名字 —— 聊天里那条「她正在查什么」小条上的字(必填:漏配就是界面上一个英文标识符)。 */
	label: string;
	/**
	 * 小条上补哪一格入参。`keys` 是候选参数名,按顺序取第一个有值的;`format` 只翻那一格的值
	 * (卡种 `live` → 「直播卡」),不给就原样显示。不给 `labelArg` = 不补。
	 */
	labelArg?: { keys: readonly string[]; format?: (value: string) => string };
	/**
	 * `onProgress` 是**给慢工具的活口**:工具轮不产生正文,一趟几分钟的活儿在界面上
	 * 跟卡死长得一模一样。报的是「已经吐了多少字符」这种粗粒度进度 —— 别把工具的
	 * 中间产物往里塞,那条路会一路流到界面上。不报也行,只是主人得干等。
	 */
	execute: (
		args: Record<string, string>,
		onProgress?: (chars: number) => void,
	) => Promise<Result<AiToolResult>>;
}

/** 标签用到的那几格 —— 从 {@link AiTool} 里挑出来读的(小条只认这几样,不碰 `execute` 等)。 */
export type AiToolLabelFields = Pick<AiTool, "label" | "labelArg">;

/**
 * 一条女仆技能的全部内容(主人盘上的 `SKILL.md`、内置的、提供方带来的都是这个形状)。
 * `builtin` 之类的身份由技能库另行标注,不属于技能本身。
 */
export interface MaidSkill {
	/** kebab-case,既是目录名也是斜杠命令。提供方交的是本名,登记表补上来源的命名空间。 */
	name: string;
	/** 一句话说清它干什么 —— 模型靠它决定要不要自选这条。 */
	description: string;
	/**
	 * 允许用的工具名**子集**;`undefined` = 不限(用这场对话本来的工具面)。提供方的工具写全名。
	 *
	 * **只减不加**(ADR 决策 11):用户可写的数据永远不能扩大工具面。所以这里给出
	 * 的名字只用来做交集,写一个不存在的工具名不会凭空长出一把工具来。
	 */
	allowedTools?: string[];
	/** 退出模型自选,只留斜杠命令这条路。 */
	disableModelInvocation: boolean;
	/** frontmatter 之后的正文,首尾空白已剥。 */
	body: string;
}

/**
 * 来源交的一组只读工具:在自己的 `start(ctx)` 里经 `ctx.registerAiToolProvider` 登记。
 *
 * 每把工具的 `definition.function.name` 是提供方自己的本名;宿主统一加命名空间,
 * 模型看到的全名是 `<命名空间>__<本名>`。
 */
export interface AiToolProvider {
	readOnly: readonly AiTool[];
	/** 提供方带来的技能,名字给本名,宿主加命名空间(`<来源键>-<本名>`);`allowedTools` 写工具全名。 */
	skills?: MaidSkill[];
}
