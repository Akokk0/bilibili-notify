import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";

/**
 * 女仆 AI 聊天的会话持久化 —— dashboard 聊天侧栏「最近」的数据源。
 *
 * 文件布局:`<dataDir>/ai/chat/<id>.json`,一会话一个文件,整体读写。
 *
 * 与 FansStore / StatsStore 的 append-only jsonl **刻意不同**。那两者是不断
 * 追加的时序采样,只增不改;会话不是 —— 标题会补、旧消息会被裁掉,都是对
 * 已落盘内容的修改,append-only 表达不了。而单个会话的体量(几十条消息)整体
 * 重写完全不成问题,拆成 jsonl 反而要自己维护一份可变的元信息。
 *
 * 一会话一个文件而不是一个大 JSON:删一个会话就是删一个文件,不必把别人的
 * 记录一起读出来重写;某个文件写坏了也只烂那一条,不会把整个侧栏带走。
 * 代价是 `list()` 要把目录里每个文件都解析一遍 —— 所以有 {@link maxConversations}
 * 上限盯着,不让它无限涨。
 */

export type ConversationRole = "user" | "assistant";

/** 一条聊天消息。`id` 供前端当 React key,`ts` 是落盘时刻(ISO)。 */
export interface StoredMessage {
	id: string;
	role: ConversationRole;
	content: string;
	ts: string;
}

/** 追加消息时的入参 —— id / ts 由 store 生成,调用方不许自己编。 */
export interface NewMessage {
	role: ConversationRole;
	content: string;
}

export interface Conversation {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: StoredMessage[];
}

/** 侧栏列表项 —— 只有元信息,不驮消息体。 */
export interface ConversationMeta {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface ConversationStore {
	/** 所有会话的元信息,按 `updatedAt` 倒序(最近聊过的在最前)。 */
	list(): Promise<ConversationMeta[]>;
	/** 读一整个会话(含消息);不存在返回 null。 */
	get(id: string): Promise<Conversation | null>;
	/** 新建一个空会话。会话总数超上限时顺手删掉最旧的。 */
	create(): Promise<Conversation>;
	/**
	 * 追加消息并回写。返回更新后的会话;会话不存在返回 null(**不**凭空造一个 ——
	 * 那会让「删掉的会话又冒出来」这种幽灵行为看着像正常功能)。
	 */
	appendMessages(id: string, messages: readonly NewMessage[]): Promise<Conversation | null>;
	/** 删除一个会话。返回它此前是否存在。 */
	remove(id: string): Promise<boolean>;
}

export interface ConversationStoreOptions {
	dataDir: string;
	logger: Logger;
	/** 单会话保留的最大消息条数,超出丢最旧的。默认 200。 */
	maxMessages?: number;
	/** 保留的最大会话数,超出在 create 时删最旧的。默认 50。 */
	maxConversations?: number;
}

/** 新会话的占位标题。首条用户消息落下来之前一直显示它。 */
const PLACEHOLDER_TITLE = "新对话";
/** 标题从首问截取的最大字数。侧栏一行放得下,再长也是省略号。 */
const TITLE_MAX_CHARS = 24;
const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_MAX_CONVERSATIONS = 50;

export function createConversationStore(opts: ConversationStoreOptions): ConversationStore {
	const { dataDir, logger } = opts;
	const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
	const maxConversations = opts.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
	const dir = join(dataDir, "ai", "chat");
	const fileOf = (id: string) => join(dir, `${encodeURIComponent(id)}.json`);

	/**
	 * 同一时刻创建 / 追加的两次写不能交错。会话文件是「读—改—写」整体重写,
	 * 并发下后写会拿着过期快照覆盖前写,丢掉一整轮问答。用一条串行链排队,
	 * 而不是丢弃式锁 —— 每一条消息都必须落盘,不能因为忙就扔掉。
	 */
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = chain.then(fn, fn);
		chain = next.then(
			() => {},
			() => {},
		);
		return next;
	};

	async function readOne(file: string): Promise<Conversation | null> {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch {
			return null; // 缺文件 = 没这个会话,不是错误。
		}
		try {
			const parsed = JSON.parse(raw) as Conversation;
			if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) {
				throw new Error("shape mismatch");
			}
			return parsed;
		} catch (err) {
			// 一条脏记录不该让侧栏整个空掉:跳过它,别的照常列出来。
			logger.warn(`[ai-chat] 跳过损坏的会话文件 ${file}: ${String(err)}`);
			return null;
		}
	}

	async function writeOne(conv: Conversation): Promise<void> {
		await mkdir(dir, { recursive: true });
		await writeFile(fileOf(conv.id), JSON.stringify(conv), "utf8");
	}

	async function listAll(): Promise<Conversation[]> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return []; // 一次都没聊过,目录还没建。
		}
		const out: Conversation[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const conv = await readOne(join(dir, name));
			if (conv) out.push(conv);
		}
		// 倒序:最近聊过的排最前,侧栏「最近」的语义就落在这一行。
		// 时间戳只到毫秒,同毫秒的两条会并列;再按 createdAt、最后按 id 兜底,
		// 是为了让并列时的次序**稳定** —— 否则同一批会话每次 readdir 回来的顺序
		// 不同,侧栏会自己抖动,连带 create() 的修剪也会随机挑人下手。
		out.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) ||
				b.createdAt.localeCompare(a.createdAt) ||
				b.id.localeCompare(a.id),
		);
		return out;
	}

	return {
		async list() {
			const all = await listAll();
			return all.map((c) => ({
				id: c.id,
				title: c.title,
				createdAt: c.createdAt,
				updatedAt: c.updatedAt,
				messageCount: c.messages.length,
			}));
		},

		async get(id) {
			return readOne(fileOf(id));
		},

		create() {
			return serial(async () => {
				const now = new Date().toISOString();
				const conv: Conversation = {
					id: randomUUID(),
					title: PLACEHOLDER_TITLE,
					createdAt: now,
					updatedAt: now,
					messages: [],
				};
				await writeOne(conv);

				// 建完再修剪 —— 先修剪的话,上限为 N 时会在「已有 N 个」的一刻删掉
				// 一个却还没建新的,列表短暂地少一条。
				//
				// **刚建的这个必须先排除在候选之外。**它的 updatedAt 与同毫秒里
				// 别人的完全相同,靠排序保不住;真被挑中就是「点了新对话,对话没了」。
				const others = (await listAll()).filter((c) => c.id !== conv.id);
				for (const stale of others.slice(Math.max(0, maxConversations - 1))) {
					await unlink(fileOf(stale.id)).catch(() => {});
					logger.debug(`[ai-chat] 会话数超上限,删除最旧的 ${stale.id}`);
				}
				return conv;
			});
		},

		appendMessages(id, messages) {
			return serial(async () => {
				const conv = await readOne(fileOf(id));
				if (!conv) return null;

				const now = new Date().toISOString();
				for (const m of messages) {
					conv.messages.push({ id: randomUUID(), role: m.role, content: m.content, ts: now });
				}

				// 标题只认**首条**用户消息,且只定一次:侧栏那一行是主人用来认会话的
				// 路标,聊到第五轮突然改成第五个问题,等于把路标挪了。
				if (conv.title === PLACEHOLDER_TITLE) {
					const firstAsk = conv.messages.find((m) => m.role === "user" && m.content.trim());
					if (firstAsk) conv.title = clipTitle(firstAsk.content);
				}

				if (conv.messages.length > maxMessages) {
					conv.messages = conv.messages.slice(-maxMessages);
				}
				conv.updatedAt = now;
				await writeOne(conv);
				return conv;
			});
		},

		remove(id) {
			return serial(async () => {
				try {
					await unlink(fileOf(id));
					return true;
				} catch {
					return false;
				}
			});
		},
	};
}

/** 首问 → 侧栏标题。压掉换行,超长截断加省略号。 */
function clipTitle(text: string): string {
	const flat = text.trim().replace(/\s+/g, " ");
	return flat.length <= TITLE_MAX_CHARS ? flat : `${flat.slice(0, TITLE_MAX_CHARS)}…`;
}
