/**
 * 女仆对话 `ai/conversations/<id>.json`:0.x 早期的会话文件里没有「面孔」那三格(`mode` / `persona` /
 * `skinTarget`)→ 补齐。一项一项收进来(⑥c);从前是会话库读盘时补、不回写,会话库开机只认带齐三格的文件。
 */

import { join } from "node:path";
import { CONVERSATIONS_DIR } from "../ai/conversation-store.js";
import { dataPath } from "../runtime/roots.js";
import { listFiles, readJsonFile, rewriteJsonFile } from "./files.js";

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
}

/** 用过哪样工具 —— 结论级的证据,不是猜。 */
function usedTool(conv: ZeroConversation, pick: (name: string) => boolean): boolean {
	return conv.messages.some((m) => m.tools?.some((t) => pick(t.name)));
}

/**
 * 缺的那几格补上(`null` 也算缺):做过皮肤的是皮肤工坊,做过卡片皮肤的是卡片(这一格上线之前,工坊只做得了
 * 界面皮肤),人格默认带着。写着的永远优先。
 */
export function migrateConversation(conv: ZeroConversation): ZeroConversation {
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

/**
 * 新代里的会话文件迁成最新的形状,回改写过的文件(绝对路径)。认不出是一场会话的(没有 id、消息不是数组)、
 * 补的时候抛错的(消息坏了)原样留着 —— 从前读盘时这种文件就被跳过,现在会话库照样跳过它。
 */
export async function migrateConversationFiles(dataRoot: string): Promise<string[]> {
	const dir = dataPath(dataRoot, ...CONVERSATIONS_DIR);
	const rewritten: string[] = [];
	for (const name of await listFiles(dir, ".json")) {
		const path = join(dir, name);
		const file = await readJsonFile(path);
		if (file.kind !== "ok") continue;
		const conv = file.value as ZeroConversation | null;
		if (!conv || typeof conv.id !== "string" || !Array.isArray(conv.messages)) continue;
		let next: ZeroConversation;
		try {
			next = migrateConversation(conv);
		} catch {
			continue;
		}
		if (JSON.stringify(next) === JSON.stringify(conv)) continue;
		await rewriteJsonFile(path, next);
		rewritten.push(path);
	}
	return rewritten;
}
