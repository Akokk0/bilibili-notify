/**
 * 指令分发器 —— 主人在私聊里敲的那几条指令,从这里认出来、校验参数、交出去。
 *
 * ## 顺序是安全属性:鉴权在前,解析在后
 *
 * 通用分发器的本能是对认不出的输入给回音(「无此指令,试试帮助」)。这条链路上不行 ——
 * 任何回音都是接口指纹,试探者靠报错差异就能摸出指令表,而这条私聊通道的对面是主人的
 * B 站账号与推送控制权。所以:
 *
 *     入站帧 → 是私聊吗 ─否→ 静默
 *                ↓是
 *             是主人吗 ─否→ 静默(连「你没权限」都不回)
 *                ↓是
 *             解析 / 路由 / 报错
 *
 * 鉴权因此**不能**写成路由表里的一个中间件 —— 它必须先于解析发生,否则「未知指令」
 * 的回音会先于鉴权漏出去。
 */

import type { CommandConfig, Logger } from "@bilibili-notify/internal";
import type { InboundPrivateMessage } from "../platforms/types.js";
import { type ParamSpec, parseArgs, parseSignature, type Values } from "./command-params.js";
import { suggestCommand } from "./command-suggest.js";

/**
 * 一条注册进来的指令。业务实现各归各的服务,这里只管认出来、校验、交出去。
 *
 * 泛型参数 `S` 是签名的**字面量**类型,`run` 的入参由它推出来 —— 用 {@link command}
 * 注册就能拿到,不必自己写。
 */
export interface CommandSpec<S extends string = string> {
	/** 主名。**用英文** —— 中文放 {@link aliases}。 */
	name: string;
	/**
	 * 别名,和主名等价。内置的中文名走这里,主人在面板上加的也并进来。
	 *
	 * 匹配时剥掉的是**实际命中的那个触发词**的长度,不是主名的 —— 拿主名长度去剥
	 * 别名,参数就整体错位了(koishi 专门修过这个回归)。
	 */
	aliases?: readonly string[];
	/** 参数签名,如 `<duration:duration|时长>`。不含指令名。省略 = 不收参数。 */
	signature?: S;
	/** 一句话说明,帮助里会列出来。列表是在手机上看的,**一行以内**。 */
	description?: string;
	/**
	 * 补充说明,只在 `help <这条>` 的详情里出现。
	 *
	 * 放这些「敲之前才想知道」的注意事项(比如静音管不管定时周报)。写进
	 * {@link description} 的话,整份列表会被这类长句撑散。
	 */
	details?: string;
	/**
	 * 一个能照抄的例子,**只写参数部分**(如 `3h`)—— 前缀与指令名由帮助现场拼。
	 * 连前缀一起写死的话,主人改完前缀,例子就成了错的。
	 */
	example?: string;
	/**
	 * 拿到的永远是**已校验**的值 —— 解析失败根本不会走到这里,
	 * 而且类型是从 `signature` 推出来的:`<duration:duration|时长>` → `{ duration: number }`。
	 */
	run: (values: Values<S>) => Promise<void>;
}

/**
 * 注册一条指令。存在的唯一理由是**留住签名的字面量类型** ——
 * 直接往 `CommandSpec[]` 里塞对象的话,`signature` 会被拓宽成 `string`,推导就没了。
 *
 * ```ts
 * command({
 *   name: "mute",
 *   aliases: ["静音"],
 *   signature: "<duration:duration|时长>",
 *   run: async (values) => { values.duration },  // ← number,不用断言
 * })
 * ```
 */
export function command<S extends string>(spec: CommandSpec<S>): CommandSpec {
	// 这里必须断言:函数参数是逆变的,`(v: {时长: number}) => …` 不能直接当
	// `(v: {}) => …` 用。断言只此一处、在库代码里,换来的是每个 handler 都不用断言。
	return spec as unknown as CommandSpec;
}

/**
 * 待确认队列 —— 审批的 `y`/`n` 走这里,不进指令表。
 *
 * dispatcher **故意不知道** y/n 这个语法:它只问「有待确认的吗」「你消费了吗」。
 * 让通用设施去认某一条具体指令的语法,就又把依赖方向倒过来了。
 */
export interface ConfirmationWindow {
	/** 有待确认项吗?没有的话 `y` 只是个普通字母,压根不该进指令层。 */
	isWaiting(): boolean;
	/** 试着当确认回应处理。返回 true = 已消费,不再往下走。 */
	tryHandle(msg: InboundPrivateMessage): Promise<boolean>;
}

export interface CommandDispatcherOptions {
	logger: Logger;
	/**
	 * 主人在他那条私聊通道上的身份。取不到就谁都不认 ——
	 * 与 `roast-command` 同一个来源,**绝不跨平台比对**(两个命名空间的字符串撞上
	 * 就是认错人)。
	 */
	masterUserId: () => string | undefined;
	/** 回一句话给主人(用的是既有的私聊通道)。 */
	reply: (text: string) => Promise<void>;
	/**
	 * 面板上那份指令配置(总开关 / 前缀 / 别名覆盖)。**现读**,不快照 ——
	 * 主人改完保存,前缀与总开关立刻按新的算;别名进了触发词表,要 {@link
	 * CommandDispatcher.reconcile} 重建。
	 */
	config: () => CommandConfig;
	commands: readonly CommandSpec[];
	/** 待确认队列。不传 = 这条链路上没有需要确认的东西。 */
	confirmation?: ConfirmationWindow;
}

export interface CommandDispatcher {
	/**
	 * 喂一条 adapter 归一化好的私聊消息(OneBot 与官机交出来的是同一个形状)。不是主人、
	 * 不是指令,都静默返回。鉴权与路由全在这里 —— 唯一入口,不会有哪条路把「不是主人
	 * 也放行」写漏。
	 */
	handleMessage(msg: InboundPrivateMessage): Promise<void>;
	/**
	 * 别名配置变了之后重建触发词表。挂在 `config-changed` 上。
	 *
	 * **重建失败不抛**:它是在总线回调里被调的,那里抛出去就是一个
	 * unhandledRejection,而独立端装了处理器会直接关掉整个进程 —— 一次手滑的别名
	 * 配置不该有这种后果。保住上一份能用的表,记一条 error。
	 */
	reconcile(): void;
}

/**
 * 这条指令**实际生效**的别名。
 *
 * 面板上配了就整份替换内置那份(配成 `[]` 就是一个别名都不要),没配过(键不在)
 * 才用内置的。指令表与帮助共用这一个判定 —— 各写一份的话,帮助迟早会列出一批
 * 敲了没反应的别名。
 */
export function effectiveAliases(
	spec: { name: string; aliases?: readonly string[] },
	aliases: Record<string, string[]>,
): readonly string[] {
	return aliases[spec.name] ?? spec.aliases ?? [];
}

type Compiled = { spec: CommandSpec; params: ParamSpec[]; triggers: string[] };

/**
 * 编译指令表:解析签名、算出每条的触发词、查重。
 *
 * 签名在这里就解析掉,不等主人敲指令时才解析 —— 签名是代码里写死的,写错了该在启动
 * 那一刻炸,而不是等某天他真敲了那条指令才发现。
 */
function compile(commands: readonly CommandSpec[], aliases: Record<string, string[]>): Compiled[] {
	const compiled: Compiled[] = commands.map((spec) => ({
		spec,
		params: parseSignature(spec.signature ?? ""),
		triggers: [spec.name, ...effectiveAliases(spec, aliases)]
			// 长的排前面:别名之间可能互为前缀(「静音」/「静」),短的先匹上就会把
			// 剩下那截当成参数。
			.sort((a, b) => b.length - a.length),
	}));

	// 两条指令抢同一个词,只有一条会响 —— 而且是**静默**的,另一条就此人间蒸发。
	// 别名是面板上可配的(主人给「周报」起个别名叫「状态」),这道判定迟早会被真实
	// 用户踩到;当场拒绝比让他自己猜哪条坏了强得多。
	const seen = new Map<string, string>();
	for (const { spec, triggers } of compiled) {
		for (const raw of triggers) {
			// 查重也要按小写来 —— 匹配是大小写不敏感的,`Mute` 和 `mute` 在运行时就是
			// 同一个词,查重放过它们等于放进一对必然静默失灵的触发词。
			const t = raw.toLowerCase();
			const owner = seen.get(t);
			if (owner !== undefined) {
				// 报错里用主人**写的那个**大小写,不是折算过的 —— 他要在配置里找的是原样。
				throw new Error(
					`指令「${spec.name}」的触发词「${raw}」和「${owner}」撞了,一个词只能归一条指令`,
				);
			}
			seen.set(t, spec.name);
		}
	}
	return compiled;
}

export function createCommandDispatcher(opts: CommandDispatcherOptions): CommandDispatcher {
	// 构造期照旧**抛** —— 这时候撞车只可能是代码里内置的那几条自己撞了,是 bug,
	// 该在启动那一刻炸掉。运行期的 reconcile 走另一套(见下)。
	let compiled = compile(opts.commands, opts.config().aliases);

	/**
	 * 剥掉前缀并认出指令。三种结果要分开 —— 「没带前缀」与「带了前缀但认不出」
	 * 该有不同反应,前者是主人在正常说话,后者是他敲错了指令名。
	 */
	type MatchResult =
		| { kind: "hit"; spec: CommandSpec; params: ParamSpec[]; rest: string }
		// `typed` 是主人**当成指令名敲的那一截**(第一个词),拿去找近似建议。
		// 整串带上参数去比的话,`/mut 3h` 离 `mute` 就有三步远,建议直接失灵。
		| { kind: "unknown"; typed: string }
		| { kind: "not-a-command" };

	function match(text: string, prefix: string): MatchResult {
		const trimmed = text.trim();
		if (!trimmed.startsWith(prefix)) return { kind: "not-a-command" };
		const body = trimmed.slice(prefix.length).trim();
		for (const { spec, params, triggers } of compiled) {
			for (const trigger of triggers) {
				// 大小写不敏感:手机输入法会把 `/mute` 自动首字母大写成 `/Mute`,而主人
				// 屏幕上那行字和帮助里印的看起来一模一样 —— 「明明照着抄的却不认」最劝退。
				// 触发词全是小写英文或中文,放宽没有歧义代价。
				//
				// **按 trigger 的长度切片再比**,不用 `toLowerCase().startsWith()`:某些
				// 字符小写化会改变长度(İ → i̇),那样下面剥长度就会错位。
				if (body.slice(0, trigger.length).toLowerCase() !== trigger.toLowerCase()) continue;
				// **剥掉的是命中的那个触发词的长度**,不是主名的 —— 用主名长度去剥别名,
				// 参数会整体错位(koishi 修过这个回归)。
				const rest = body.slice(trigger.length);
				// 触发词后面必须是边界:到头,或者空白 + 参数。不做前缀模糊匹配 ——
				// 「静」不该命中「静音」,否则主人随口一个字就触发了动作。
				if (rest.length > 0 && !/^\s/.test(rest)) continue;
				return { kind: "hit", spec, params, rest: rest.trim() };
			}
		}
		return { kind: "unknown", typed: body.split(/\s+/, 1)[0] ?? "" };
	}

	async function handleMessage(msg: InboundPrivateMessage): Promise<void> {
		// —— 第一道门:鉴权。必须在解析之前,理由见文件头。
		const master = opts.masterUserId();
		if (!master || msg.userId !== master) return;

		// —— 第二道门:待确认窗口。**只在真有待确认项时才开。**
		//
		// 以前是无条件解析 y/n,没待审时回一句「现在没有等待审批的锐评哦～」——
		// 于是主人在私聊里随口打个 y(英文聊天里很常见)就收到这句莫名其妙的话。
		// 草稿 TTL 有 48 小时,真要批准几乎不可能撞上超时;没待审时那个 y 就只是
		// 个普通字母,不该进指令层。
		if (opts.confirmation?.isWaiting()) {
			if (await opts.confirmation.tryHandle(msg)) return;
		}

		// —— 第三道门:总开关。**排在确认流之后** —— 「关掉 = 整条链路只剩确认流」,
		// 一起关掉的话,主人关一下指令,手里那份等审批的周报就再也批不掉了。
		// 关掉后一个字都不回:他自己关的,不需要被提醒;回音只会让这条私聊又开始插嘴。
		const config = opts.config();
		if (!config.enabled) return;

		const hit = match(msg.text, config.prefix);
		// 没带前缀 = 主人在正常说话,当没看见。这条私聊同时是他聊天的地方。
		if (hit.kind === "not-a-command") return;
		if (hit.kind === "unknown") {
			// **强制联动**:前缀为空时必须静默。否则同一套逻辑会对主人的每一句话都回
			// 这句 —— 用户配出一个会打扰自己的组合,是我们的设计错误,不是他的操作错误。
			if (!config.prefix) return;
			// 他多半只是漏了个字母,指出最近的那条,这次手滑就地结束。建议敢在这儿
			// 出声,是因为已经过了鉴权门 —— 它本质上是接口指纹,见 `./command-suggest`。
			// 前缀现拼:写死 `/` 的话,主人改完前缀拿到的是一条敲了没反应的指令。
			const near = suggestCommand(
				hit.typed,
				compiled.flatMap((c) => c.triggers),
			);
			await opts.reply(
				near ? `没有这条指令哦～是不是想敲 ${config.prefix}${near}？` : "没有这条指令哦～",
			);
			return;
		}

		// 解析与执行分离:parse 失败就报错返回,handler 拿到的永远是已校验的值。
		const parsed = parseArgs(hit.params, hit.rest);
		if (!parsed.ok) {
			await opts.reply(parsed.message);
			return;
		}

		opts.logger.info(`[command] 主人触发了「${hit.spec.name}」`);
		try {
			await hit.spec.run(parsed.values);
		} catch (err) {
			// 一条指令炸了不该带塌这条入站链路 —— 它还担着审批的 y/n。
			opts.logger.warn(
				`[command] 「${hit.spec.name}」执行失败: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return {
		handleMessage,
		reconcile() {
			try {
				compiled = compile(opts.commands, opts.config().aliases);
			} catch (err) {
				// 这里**不能抛**:调用点在 `config-changed` 的总线回调里,抛出去就是一个
				// unhandledRejection,而独立端装了处理器会直接关掉整个进程。保存那一刻
				// 已经查过重(见 globals 路由),能走到这儿说明是从别的路径写进来的
				// (恢复备份、手改盘上的 json)—— 那更不该拿整个服务陪葬。
				opts.logger.error(
					`[command] 指令表重建失败,仍按上一份配置工作:${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}
