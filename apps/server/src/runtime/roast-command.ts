/**
 * 审批指令 —— 主人在私聊里回的那句 `y` / `n`。
 *
 * 这是独立端**第一条入站链路**。在此之前 OneBot 通道是纯 push-only(所有无 echo
 * 的帧一律丢弃),所以这里的原则是「只认死了的那一小撮,其余原样丢回去」:
 *
 * - 只认**私聊**。群里有人打个 y 不该把一份待审的周报发出去。
 * - 只认**主人本人**。发送者不是主人配置里那个 user_id 就当没看见 —— 不回复、
 *   不报错、不留痕,免得把这条通道变成一个可以试探的接口。
 * - 只认 `y` / `n`(可带草稿 ID)。别的一律不管,让主人照常在私聊里说别的话。
 *
 * 解析与副作用是分开的:{@link parseRoastCommand} 是纯函数,好测;
 * {@link createRoastCommandHandler} 负责鉴权与真正的批准 / 丢弃。
 */

import type { Logger } from "@bilibili-notify/internal";
import type { ConfirmationWindow } from "./command-dispatcher.js";
import { extractPrivateMessage, type InboundPrivateMessage } from "./inbound-message.js";
import type { RoastDraft, RoastDraftStore } from "./roast-draft-store.js";

export type RoastCommand =
	| { kind: "approve"; id?: string }
	| { kind: "reject"; id?: string }
	/** 认不出来的内容 —— 主人在私聊里说别的话,不该被当成指令。 */
	| { kind: "none" };

/**
 * 从一句私聊文本里认指令。
 *
 * 宽松的地方:大小写、前后空格、`y`/`yes`/`n`/`no`,以及 ID 前多余的空白。
 * 严格的地方:整句必须**只有**指令本身 —— 「今天不想发 y」不该发出一份周报。
 */
export function parseRoastCommand(raw: string): RoastCommand {
	const text = raw.trim().toLowerCase();
	const m = text.match(/^(y|yes|n|no)(?:\s+([0-9a-z]+))?$/);
	if (!m) return { kind: "none" };
	const id = m[2];
	return m[1] === "y" || m[1] === "yes" ? { kind: "approve", id } : { kind: "reject", id };
}

export type { InboundPrivateMessage };
// 入站私聊解析已挪到 `inbound-message.ts` —— 指令分发器也要用,不该让通用设施
// 反过来依赖某一条具体指令。这里继续 re-export,既有调用点不用动。
export { extractPrivateMessage };

export interface RoastCommandHandlerOptions {
	drafts: RoastDraftStore;
	logger: Logger;
	/** 主人的 OneBot user_id。取自主人私聊目标的 session.userId;拿不到就谁都不认。 */
	masterUserId: () => string | undefined;
	/** 批准之后把这份草稿真的发出去。 */
	deliver: (draft: RoastDraft) => Promise<void>;
	/** 回一句话给主人(用的是既有的私聊通道)。 */
	reply: (text: string) => Promise<void>;
}

export interface RoastCommandHandler {
	/** 喂一帧 OneBot 事件。不是主人的审批指令就静默返回。 */
	handle(frame: Record<string, unknown>): Promise<void>;
	/**
	 * 喂一条**已经解析好**的私聊消息。给帧格式不是 OneBot 的平台用
	 * (qq-official 的网关那边送来的就是 `{userOpenid, text}`)。
	 *
	 * 鉴权与指令语义全在这里,`handle` 也只是「解析 OneBot 帧 → 调它」——
	 * 两条路各写一份的话,迟早有一边把「不是主人也放行」写漏。
	 */
	handleMessage(msg: InboundPrivateMessage): Promise<void>;
	/**
	 * 作为指令分发器的**第二道门**接入 —— 有待审草稿时才认 y/n。
	 *
	 * 依赖方向是这边指过去(具体指令 → 通用设施),反过来不行:让 dispatcher 去认
	 * y/n 这个语法,就等于通用设施依赖了某一条具体指令。
	 */
	confirmation: ConfirmationWindow;
}

export function createRoastCommandHandler(opts: RoastCommandHandlerOptions): RoastCommandHandler {
	const { drafts, logger } = opts;

	async function run(cmd: RoastCommand): Promise<void> {
		if (cmd.kind === "none") return;

		const pending = drafts.list();
		// 没待审就当没看见。以前这里回一句「现在没有等待审批的锐评哦～」,于是主人在
		// 私聊里随口打个 y(英文聊天里很常见)就收到这句莫名其妙的话 —— 而这条私聊
		// 同时是他正常说话的地方。草稿 TTL 有 48 小时,真想批准几乎不可能撞上超时。
		if (pending.length === 0) return;

		// 没带 ID:只有一份待审时就是它 —— 常见情况一个字母搞定。多份时必须指明,
		// 猜错的代价是把不该发的那份发出去了,而那正是审批要防的事。
		let target: RoastDraft | undefined;
		if (cmd.id) {
			target = pending.find((d) => d.id === cmd.id);
			if (!target) {
				await opts.reply(`没找到编号 ${cmd.id} 的待审锐评，可能已经处理过或者超时了。`);
				return;
			}
		} else if (pending.length === 1) {
			target = pending[0];
		} else {
			const list = pending
				.map((d) => `${d.id}（${d.kind === "board" ? "周报" : "单人"}）`)
				.join("、");
			await opts.reply(
				`现在有 ${pending.length} 份待审：${list}。请带上编号，比如「y ${pending[0]?.id}」。`,
			);
			return;
		}

		if (!target) return;
		const taken = await drafts.take(target.id);
		// take 会再判一次过期,并且是原子的 —— 两条指令同时进来只有一条拿得到。
		if (!taken) {
			await opts.reply(`编号 ${target.id} 刚刚已经被处理或超时了。`);
			return;
		}

		if (cmd.kind === "reject") {
			logger.info(`[roast-cmd] 主人丢弃了草稿 ${taken.id}`);
			await opts.reply(`好的，${taken.id} 已经丢掉了～`);
			return;
		}

		logger.info(`[roast-cmd] 主人批准了草稿 ${taken.id}`);
		await opts.deliver(taken);
	}

	/**
	 * 试着把这条消息当审批回应处理。返回 false = 没消费,机会让回给指令表。
	 *
	 * 鉴权在这里**再做一次**,虽然 dispatcher 那边已经鉴过:两条路各写一份的话,
	 * 迟早有一边把「不是主人也放行」写漏,而这条链路的代价是把没审过的锐评发出去。
	 */
	async function tryHandle(msg: InboundPrivateMessage): Promise<boolean> {
		const master = opts.masterUserId();
		// 不是主人就当没看见:不回复、不报错。回一句「你没权限」等于告诉对方
		// 这里有个接口可以试探。
		if (!master || msg.userId !== master) return false;

		const cmd = parseRoastCommand(msg.text);
		// 认不出来 → 让回给指令表。有待审的时候主人照样得能敲别的指令。
		if (cmd.kind === "none") return false;

		try {
			await run(cmd);
		} catch (err) {
			logger.warn(`[roast-cmd] 处理指令失败: ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	async function handleMessage(msg: InboundPrivateMessage): Promise<void> {
		await tryHandle(msg);
	}

	return {
		async handle(frame) {
			const msg = extractPrivateMessage(frame);
			if (!msg) return;
			await handleMessage(msg);
		},
		handleMessage,
		confirmation: {
			isWaiting: () => drafts.list().length > 0,
			tryHandle,
		},
	};
}
