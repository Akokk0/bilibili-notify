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

import type { Logger } from "@bilibili-notify/internal";
import { type ParamSpec, parseArgs, parseSignature, type Values } from "./command-params.js";
import { extractPrivateMessage, type InboundPrivateMessage } from "./inbound-message.js";

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
	/** 指令前缀,主人可配。默认 `/`。 */
	prefix: string;
	commands: readonly CommandSpec[];
	/** 待确认队列。不传 = 这条链路上没有需要确认的东西。 */
	confirmation?: ConfirmationWindow;
}

export interface CommandDispatcher {
	/** 喂一帧平台事件。不是私聊、不是主人的指令,都静默返回。 */
	handle(frame: Record<string, unknown>): Promise<void>;
	/**
	 * 喂一条**已经解析好**的私聊消息。给帧格式不是 OneBot 的平台用
	 * (qq-official 的网关送来的是 `{userOpenid, text}`)。
	 *
	 * 鉴权与路由全在这里,`handle` 只是「解析帧 → 调它」—— 两条路各写一份鉴权的话,
	 * 迟早有一边把「不是主人也放行」写漏。
	 */
	handleMessage(msg: InboundPrivateMessage): Promise<void>;
}

export function createCommandDispatcher(opts: CommandDispatcherOptions): CommandDispatcher {
	// 签名在这里就解析掉,不等到主人敲指令时才解析:签名是代码里写死的,写错了该在
	// 启动那一刻炸(parseSignature 会抛),而不是等某天主人真敲了那条指令才发现。
	const compiled: { spec: CommandSpec; params: ParamSpec[]; triggers: string[] }[] =
		opts.commands.map((spec) => ({
			spec,
			params: parseSignature(spec.signature ?? ""),
			// 主名与别名一视同仁。长的排前面:别名之间可能互为前缀(「静音」/「静」),
			// 短的先匹上就会把剩下那截当成参数。
			triggers: [spec.name, ...(spec.aliases ?? [])].sort((a, b) => b.length - a.length),
		}));

	// 两条指令抢同一个词,只有一条会响 —— 而且是**静默**的,另一条就此人间蒸发。
	// 别名将来是面板上可配的(主人给「周报」起个别名叫「状态」),所以这道判定迟早
	// 会被真实用户踩到;在注册那一刻炸,比让他自己猜哪条坏了强得多。
	const seen = new Map<string, string>();
	for (const { spec, triggers } of compiled) {
		for (const t of triggers) {
			const owner = seen.get(t);
			if (owner !== undefined) {
				throw new Error(
					`指令「${spec.name}」的触发词「${t}」和「${owner}」撞了,一个词只能归一条指令`,
				);
			}
			seen.set(t, spec.name);
		}
	}

	/**
	 * 剥掉前缀并认出指令。三种结果要分开 —— 「没带前缀」与「带了前缀但认不出」
	 * 该有不同反应,前者是主人在正常说话,后者是他敲错了指令名。
	 */
	type MatchResult =
		| { kind: "hit"; spec: CommandSpec; params: ParamSpec[]; rest: string }
		| { kind: "unknown" }
		| { kind: "not-a-command" };

	function match(text: string): MatchResult {
		const trimmed = text.trim();
		if (!trimmed.startsWith(opts.prefix)) return { kind: "not-a-command" };
		const body = trimmed.slice(opts.prefix.length).trim();
		for (const { spec, params, triggers } of compiled) {
			for (const trigger of triggers) {
				if (!body.startsWith(trigger)) continue;
				// **剥掉的是命中的那个触发词的长度**,不是主名的 —— 用主名长度去剥别名,
				// 参数会整体错位(koishi 修过这个回归)。
				const rest = body.slice(trigger.length);
				// 触发词后面必须是边界:到头,或者空白 + 参数。不做前缀模糊匹配 ——
				// 「静」不该命中「静音」,否则主人随口一个字就触发了动作。
				if (rest.length > 0 && !/^\s/.test(rest)) continue;
				return { kind: "hit", spec, params, rest: rest.trim() };
			}
		}
		return { kind: "unknown" };
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

		const hit = match(msg.text);
		// 没带前缀 = 主人在正常说话,当没看见。这条私聊同时是他聊天的地方。
		if (hit.kind === "not-a-command") return;
		if (hit.kind === "unknown") {
			// **强制联动**:前缀为空时必须静默。否则同一套逻辑会对主人的每一句话都回
			// 这句 —— 用户配出一个会打扰自己的组合,是我们的设计错误,不是他的操作错误。
			if (!opts.prefix) return;
			await opts.reply("没有这条指令哦～");
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
		async handle(frame) {
			const msg = extractPrivateMessage(frame);
			// 不是私聊(群消息 / 心跳 / 通知)就到此为止 —— 群里有人打个「/状态」不该触发。
			if (!msg) return;
			await handleMessage(msg);
		},
		handleMessage,
	};
}
