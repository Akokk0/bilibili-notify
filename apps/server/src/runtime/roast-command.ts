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

/** OneBot v11 私聊文本事件里我们用得到的那几个字段。 */
export interface InboundPrivateMessage {
	userId: string;
	text: string;
}

/**
 * 从一帧 OneBot 事件里挑出私聊文本。不是私聊消息就返回 null。
 *
 * `message` 段可能是字符串,也可能是 OneBot 的段数组;后者只取 text 段拼起来 ——
 * 主人回 `y` 时客户端可能顺手带上别的段(比如 reply),不该因此认不出来。
 */
export function extractPrivateMessage(
	frame: Record<string, unknown>,
): InboundPrivateMessage | null {
	if (frame.post_type !== "message") return null;
	if (frame.message_type !== "private") return null;
	const userId = frame.user_id;
	if (typeof userId !== "number" && typeof userId !== "string") return null;

	let text = "";
	if (typeof frame.raw_message === "string" && frame.raw_message.trim()) {
		text = frame.raw_message;
	} else if (typeof frame.message === "string") {
		text = frame.message;
	} else if (Array.isArray(frame.message)) {
		text = frame.message
			.filter(
				(seg): seg is { type: string; data: { text?: string } } =>
					typeof seg === "object" && seg !== null && (seg as { type?: string }).type === "text",
			)
			.map((seg) => seg.data?.text ?? "")
			.join("");
	}
	if (!text.trim()) return null;
	return { userId: String(userId), text };
}

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
}

export function createRoastCommandHandler(opts: RoastCommandHandlerOptions): RoastCommandHandler {
	const { drafts, logger } = opts;

	async function run(cmd: RoastCommand): Promise<void> {
		if (cmd.kind === "none") return;

		const pending = drafts.list();
		if (pending.length === 0) {
			await opts.reply("现在没有等待审批的锐评哦～");
			return;
		}

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

	return {
		async handle(frame) {
			const msg = extractPrivateMessage(frame);
			if (!msg) return;

			const master = opts.masterUserId();
			// 不是主人就当没看见:不回复、不报错。回一句「你没权限」等于告诉对方
			// 这里有个接口可以试探。
			if (!master || msg.userId !== master) return;

			const cmd = parseRoastCommand(msg.text);
			if (cmd.kind === "none") return;

			try {
				await run(cmd);
			} catch (err) {
				logger.warn(
					`[roast-cmd] 处理指令失败: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}
