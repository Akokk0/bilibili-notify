/**
 * `@bilibili-notify/extension/wire` —— 契约里**过 wire 的那几格**,一个**零依赖**子入口。
 *
 * 拓展照旧从根入口拿它们(那里转出来了),分一个子入口出来只为一件事:
 * `@bilibili-notify/contract` 的规矩是「运行时只许依赖零依赖的子入口」(见它的文件头),
 * 而根入口驮着 zod 与 `@bilibili-notify/internal` 的整个域模型 —— 面板那一侧要的其实只是
 * 这几个形状。
 *
 * ⛔ **只放纯结构类型**:不 import zod、不 import internal、一行运行时值都没有。往这儿加
 * 一格之前先问它是不是这种东西 —— 不是的话它属于根入口。
 */

/**
 * 面板照它画一栏配置。与拓展交的那份 zod 是**两份声明**,注册那一刻逐格对表
 * (ADR-0012 决策 19 / 33):字段表给人填(label / 控件),schema 给机器校验(类型 / 必填)。
 *
 * 🔴 `secret: true` 同时是**备份脱敏的依据**。脱敏本来靠一份键名黑名单,而拓展的 config
 * 键名归拓展自己起 —— 不声明的话,那个 token 会原样躺在主人发出去求助的备份文件里。
 */
export type ExtensionConfigField = ExtensionConfigFieldBase &
	(
		| {
				kind: "text";
				placeholder?: string;
				mono?: boolean;
				secret?: boolean;
		  }
		| { kind: "number"; min?: number; max?: number; step?: number; suffix?: string }
		| { kind: "toggle" }
		| { kind: "select"; options: readonly { value: string; label: string }[] }
	);

interface ExtensionConfigFieldBase {
	/** config 里的键名。**同时是这一栏的身份** —— 值就落在 `config[code]`。 */
	code: string;
	label: string;
	hint?: string;
	required?: boolean;
}

/**
 * 一个能借来当连接的 bot。
 *
 * 面板新建连接时列给主人挑,挑中的那个**整个 `config` 原样落进连接**、`platform` 落进
 * 连接的 `platform` —— 宿主看不懂 config(那归拓展自己那份 zod),只负责原样存回。
 * `platform` 是开放词表;`icon` 是 data URL(与桥协议 §5.2 同一种)。
 */
export interface ExtensionBotView<TConfig = unknown> {
	/** 绑上这个 bot 的连接该存的 config。拓展自己认得就行。 */
	config: TConfig;
	platform: string;
	name?: string;
	selfId?: string;
	icon?: string;
	/** 经由谁借来的(桥:那条接入的名字)—— 两条桥各驮一个同名 bot 时分得开。 */
	via?: string;
	/** 已经被哪条连接绑着 —— 面板标「已加过」,同一个 bot 别建两条连接。 */
	boundTo?: string;
}
