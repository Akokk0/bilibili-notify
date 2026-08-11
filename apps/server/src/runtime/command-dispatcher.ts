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
import { type ParamSpec, type ParamValue, parseArgs, parseSignature } from "./command-params.js";
import { extractPrivateMessage, type InboundPrivateMessage } from "./inbound-message.js";

/** 一条注册进来的指令。业务实现各归各的服务,这里只管认出来、校验、交出去。 */
export interface CommandSpec {
	/** 触发词。 */
	name: string;
	/** 参数签名,如 `<时长:duration>`。不含指令名。省略 = 不收参数。 */
	signature?: string;
	/** 拿到的永远是**已校验**的值 —— 解析失败根本不会走到这里。 */
	run: (values: Record<string, ParamValue>) => Promise<void>;
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
	const compiled: { spec: CommandSpec; params: ParamSpec[] }[] = opts.commands.map((spec) => ({
		spec,
		params: parseSignature(spec.signature ?? ""),
	}));

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
		for (const { spec, params } of compiled) {
			if (!body.startsWith(spec.name)) continue;
			const rest = body.slice(spec.name.length);
			// 触发词后面必须是边界:到头,或者空白 + 参数。不做前缀模糊匹配 ——
			// 「静」不该命中「静音」,否则主人随口一个字就触发了动作。
			if (rest.length > 0 && !/^\s/.test(rest)) continue;
			return { kind: "hit", spec, params, rest: rest.trim() };
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
