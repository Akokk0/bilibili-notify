/**
 * 女仆对话 `ai/conversations/<id>.json`:
 *
 * - 0.x 早期的会话文件里没有「面孔」那三格(`mode` / `persona` / `skinTarget`)→ 补齐。一项一项收进来(⑥c);
 *   从前是会话库读盘时补、不回写,会话库开机只认带齐三格的文件。
 * - 卡片皮肤不迁(ADR-0022 决策 12),会话里对它们的引用剥掉、文字保留(决策 4):整场对话的账本
 *   `cardSkinLedger`、每条回复碰过的皮肤 `cardSkins`。新代里没有这些皮肤,留着只会指向空处。工具痕迹里提到的
 *   皮肤是文字,留着。
 * - 聊天附件进图库(⑳b):消息里 `images` 的旧附件 id 换成图库引用,对不上的从消息里拿掉(整条 `images` 都没了就
 *   整个字段缺席);附件本身怎么读、怎么复制进图库见 `chat-attachments.ts`。
 */

import { join } from "node:path";
import { CONVERSATIONS_DIR } from "../ai/conversation-store.js";
import { dataPath } from "../runtime/roots.js";
import type { ChatAttachmentMigrator } from "./chat-attachments.js";
import { isPlainObject, listFiles, readJsonFile, rewriteJsonFile } from "./files.js";

/**
 * 0.x 的工具名:老会话里记下的就是这些。冻在这里,不跟着现在的工具改名走 —— 改了名,认的就不再是老文件里
 * 写着的那几个字。
 */
const ZERO_SKIN_TOOL = "create_skin";
const ZERO_CARD_TOOLS: ReadonlySet<string> = new Set([
	"list_skins",
	"read_card",
	"read_block",
	"look_card",
	"write_card",
	"set_block",
	"remove_block",
	"set_skin_meta",
]);

interface ZeroConversation {
	id: string;
	messages: { tools?: { name: string }[] }[];
	mode?: unknown;
	persona?: unknown;
	skinTarget?: unknown;
	cardSkinLedger?: unknown;
}

/** 用过哪样工具 —— 结论级的证据,不是猜。 */
function usedTool(conv: ZeroConversation, pick: (name: string) => boolean): boolean {
	return conv.messages.some((m) => m.tools?.some((t) => pick(t.name)));
}

/** 一场会话迁成最新的形状:补面孔,剥卡片皮肤的引用。 */
export function migrateConversation(conv: ZeroConversation): ZeroConversation {
	return stripCardSkinRefs(fillFace(conv));
}

/**
 * 缺的那几格补上(`null` 也算缺):做过皮肤的是皮肤工坊,做过卡片皮肤的是卡片(这一格上线之前,工坊只做得了
 * 界面皮肤),人格默认带着。写着的永远优先。
 */
function fillFace(conv: ZeroConversation): ZeroConversation {
	return {
		...conv,
		mode:
			conv.mode ??
			(usedTool(conv, (name) => name === ZERO_SKIN_TOOL || ZERO_CARD_TOOLS.has(name))
				? "skin"
				: "chat"),
		persona: conv.persona ?? true,
		skinTarget:
			conv.skinTarget ??
			(usedTool(conv, (name) => ZERO_CARD_TOOLS.has(name)) ? "card" : "dashboard"),
	};
}

/** 账本整个拿掉;每条消息上碰过的皮肤拿掉,别的原样。 */
function stripCardSkinRefs(conv: ZeroConversation): ZeroConversation {
	const { cardSkinLedger: _ledger, ...rest } = conv;
	return {
		...rest,
		messages: conv.messages.map((message) => {
			if (!isPlainObject(message) || !("cardSkins" in message)) return message;
			const { cardSkins: _touched, ...kept } = message;
			return kept;
		}),
	};
}

/**
 * 每条消息的 `images`:旧附件 id 逐个问 `attachments` 换成图库引用,对不上的拿掉。位置不动(`images` 在消息里
 * 原来排第几还排第几),一个引用都没留下就整个字段拿掉 —— 会话库的约定是「没带图就缺席」。同一条消息里指到
 * 同一张图的几个旧 id 只留一个引用。
 */
async function rewriteChatImages(
	conv: ZeroConversation,
	attachments: ChatAttachmentMigrator,
): Promise<ZeroConversation> {
	// 消息是盘上读出来的任意东西(`ZeroConversation` 只描述了认得的那一点),按 unknown 走。
	const messages: unknown[] = [];
	for (const message of conv.messages as unknown[]) {
		if (!isPlainObject(message) || !Array.isArray(message.images)) {
			messages.push(message);
			continue;
		}
		const refs: string[] = [];
		for (const id of message.images) {
			const ref = typeof id === "string" ? await attachments.ref(id) : null;
			if (ref !== null && !refs.includes(ref)) refs.push(ref);
		}
		messages.push(
			Object.fromEntries(
				Object.entries(message).flatMap(([key, value]): [string, unknown][] =>
					key !== "images" ? [[key, value]] : refs.length > 0 ? [[key, refs]] : [],
				),
			),
		);
	}
	return { ...conv, messages: messages as ZeroConversation["messages"] };
}

/**
 * 新代里的会话文件迁成最新的形状,回改写过的文件(绝对路径)。认不出是一场会话的(没有 id、消息不是数组)、
 * 补的时候抛错的(消息坏了)原样留着 —— 从前读盘时这种文件就被跳过,现在会话库照样跳过它。
 * 它们带的附件没人引用,算孤儿(不搬)。
 */
export async function migrateConversationFiles(
	dataRoot: string,
	attachments: ChatAttachmentMigrator,
): Promise<string[]> {
	const dir = dataPath(dataRoot, ...CONVERSATIONS_DIR);
	const rewritten: string[] = [];
	for (const name of await listFiles(dir, ".json")) {
		const path = join(dir, name);
		const file = await readJsonFile(path);
		if (file.kind !== "ok") continue;
		const conv = file.value as ZeroConversation | null;
		if (!conv || typeof conv.id !== "string" || !Array.isArray(conv.messages)) continue;
		let faced: ZeroConversation;
		try {
			faced = migrateConversation(conv);
		} catch {
			continue;
		}
		// 附件要读盘,读不动的是真错误(不是坏会话),放在 try 外面让它抛、迁移重来。
		const next = await rewriteChatImages(faced, attachments);
		if (JSON.stringify(next) === JSON.stringify(conv)) continue;
		await rewriteJsonFile(path, next);
		rewritten.push(path);
	}
	return rewritten;
}
