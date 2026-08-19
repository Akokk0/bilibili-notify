import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AI_TOOL_CREATE_SKIN, type AiChatMode } from "@bilibili-notify/contract";
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

/**
 * 女仆为了答这一句而调过的一个工具。
 *
 * 跟着回复一起落盘而不是只活在那次流里:只在流里显示的话,`done` 一到、真身把
 * 在途副本换下来的那一刻,这几条就凭空消失了,刷新之后也再看不到她查过什么。
 */
export interface StoredToolTrace {
	name: string;
	args: Record<string, string>;
	ok: boolean;
}

/** 一条聊天消息。`id` 供前端当 React key,`ts` 是落盘时刻(ISO)。 */
export interface StoredMessage {
	id: string;
	role: ConversationRole;
	content: string;
	ts: string;
	/** 助手消息专有,见 {@link StoredToolTrace}。没调过工具就整个字段缺席。 */
	tools?: StoredToolTrace[];
	/**
	 * 助手消息专有:答这一句之前的思考过程(思考模型的那段草稿)。
	 * 只作展示,**永不**回传给模型当上下文。没思考就整个字段缺席。
	 */
	reasoning?: string;
	/**
	 * 用户消息专有:这一问带的图片资产 id(见 `runtime/chat-assets`)。
	 *
	 * 存 id 而**不是** base64:会话文件是整份读进内存的,把图塞进去之后,往后
	 * 每次打开这个会话都要连着几 MB 的 base64 一起扛。没带图就整个字段缺席。
	 */
	images?: string[];
}

/** 追加消息时的入参 —— id / ts 由 store 生成,调用方不许自己编。 */
export interface NewMessage {
	role: ConversationRole;
	content: string;
	tools?: readonly StoredToolTrace[];
	reasoning?: string;
	images?: readonly string[];
}

export interface Conversation {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: StoredMessage[];
	/**
	 * 这场对话的面孔,开局定下、整场锁定(见 {@link AiChatMode})。
	 *
	 * 读的时候**一律补默认**,不让 undefined 流出去:上线前的会话文件里没有这个
	 * 字段,而下游(路由挑 system、侧栏画 label)每一处都得自己想一遍「没有算什么」
	 * 的话,迟早有一处想反 —— 那就是老会话集体变成皮肤工坊。
	 */
	mode: AiChatMode;
	/** 带不带女仆人格;同样读时补默认(老会话 = true)。 */
	persona: boolean;
	/**
	 * 标题是否已由 AI 起过。缺失(旧文件)按 false 算。
	 *
	 * 「只起一次」的判据是它,而**不是**「刚聊完第一轮」。用轮次当判据的话,
	 * 功能上线前就存在的会话里早已有好几条消息,永远不满足条件 —— 主人一屋子
	 * 叫「你好」的会话一个都轮不上。
	 */
	autoTitled?: boolean;
}

/** 侧栏列表项 —— 只有元信息,不驮消息体。 */
export interface ConversationMeta {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** 见 {@link Conversation.mode}。侧栏那一行的 label 指着它。 */
	mode: AiChatMode;
	/** 见 {@link Conversation.persona}。 */
	persona: boolean;
	/** 见 {@link Conversation.autoTitled}。前端拿它决定要不要去要一个标题。 */
	autoTitled?: boolean;
}

export interface ConversationStore {
	/** 所有会话的元信息,按 `updatedAt` 倒序(最近聊过的在最前)。 */
	list(): Promise<ConversationMeta[]>;
	/** 读一整个会话(含消息);不存在返回 null。 */
	get(id: string): Promise<Conversation | null>;
	/**
	 * 新建一个空会话。会话总数超上限时顺手删掉最旧的。
	 *
	 * 面孔在这一刻定死,之后没有任何接口能改它 —— 「锁定」不是界面上藏个按钮,
	 * 是**根本没有那条路**。
	 */
	create(init?: { mode?: AiChatMode; persona?: boolean }): Promise<Conversation>;
	/**
	 * 追加消息并回写。返回更新后的会话;会话不存在返回 null(**不**凭空造一个 ——
	 * 那会让「删掉的会话又冒出来」这种幽灵行为看着像正常功能)。
	 */
	appendMessages(id: string, messages: readonly NewMessage[]): Promise<Conversation | null>;
	/**
	 * 改标题(AI 起完名字回写)。返回更新后的会话;会话不存在或标题是空白返回 null。
	 *
	 * **不动 `updatedAt`** —— 起个标题不算「聊过」。动了的话,一次后台改名就会把
	 * 这个会话顶到侧栏最前,而主人明明正在聊别的。
	 */
	setTitle(id: string, title: string): Promise<Conversation | null>;
	/** 删除一个会话。返回它此前是否存在。 */
	remove(id: string): Promise<boolean>;
	/**
	 * 标记这一场**正有一轮在跑**,返回收工时该调的那个函数。
	 *
	 * 为什么需要它:消息是「拿到回复之后才落盘」的(routes/ai.ts 那条既有决定 ——
	 * 先写用户消息的话,AI 一失败盘上就留下一个没人回答的问题),所以一轮生成期间
	 * 盘上仍是零消息;而 {@link list} 会把零消息的当空壳藏起来。皮肤生成要几分钟,
	 * 主人正聊着的那一场就这么从侧栏消失了。
	 *
	 * 计数而非布尔:同一场可能同时有两轮在跑,先收工的那次不该把还在跑的也放出去。
	 * 返回的函数**可以重复调**(只销自己那一笔),catch 与 finally 都调不会串账。
	 */
	markBusy(id: string): () => void;
}

export interface ConversationStoreOptions {
	dataDir: string;
	logger: Logger;
	/** 单会话保留的最大消息条数,超出丢最旧的。默认 200。 */
	maxMessages?: number;
	/** 保留的最大会话数,超出在 create 时删最旧的。默认 50。 */
	maxConversations?: number;
}

/**
 * 老会话(文件里没有 `mode`)的面孔 —— 从工具痕迹里认。
 *
 * 上线前的会话一律按「聊天」读的话,主人一屋子做过皮肤的老会话在侧栏里一块牌都
 * 不挂,看不出哪场是工坊的。而 `create_skin` 的痕迹是**结论级**的证据,不是猜。
 *
 * 只在读的时候认,**不回写盘**:推断幂等,而改主人的存档不是。显式值永远优先 ——
 * 这一层只补「文件里没写」的那种情况。
 */
function inferMode(conv: Conversation): AiChatMode {
	const workshop = conv.messages.some((m) => m.tools?.some((t) => t.name === AI_TOOL_CREATE_SKIN));
	return workshop ? "skin" : "chat";
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
			// 面孔在**读的这一处**补默认,一次补齐、下游全都拿到实值。上线前的
			// 会话文件里没这两个字段,让 undefined 流出去的话,每一个下游都得自己
			// 想一遍「没有算什么」—— 想反一处,主人的老会话就集体变了面孔。
			return {
				...parsed,
				mode: parsed.mode ?? inferMode(parsed),
				persona: parsed.persona ?? true,
			};
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

	/**
	 * 空会话过多久算「凉透」。取得宽是因为一轮对话可以很长 —— 皮肤生成一趟几分钟,
	 * 加上主人打字与读回复,半小时是个谁都不冤枉的界。
	 */
	const EMPTY_CONVERSATION_TTL_MS = 30 * 60 * 1000;

	/**
	 * 正在跑的轮次计数(会话 id → 几轮)。只活在内存里 —— 进程一重启,「在途」这件事
	 * 本来就不存在了(那些 SSE 全断了),陈旧的标记反而会把死壳永久钉在侧栏上。
	 */
	const busy = new Map<string, number>();

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
			// 零消息的不露面。会话是在**发送之前**就建好的(前端要先拿到 id 才能
			// 开那条 SSE),而整轮失败时服务端一个字都不落盘 —— 壳却留下了。主人
			// 看到的是侧栏冒出一条点进去空空如也的「对话」,删又不知道该不该删。
			//
			// 只过滤不删:判它是垃圾要等到它凉透(见 create 里的清理),列表这一层
			// 只管别让它碍眼。
			//
			// **在途的那一场例外**:它盘上同样是零消息(消息拿到回复才落盘),可它
			// 恰恰是主人此刻正看着的那一场 —— 藏掉它,侧栏里就没有「我正在聊的那条」。
			// 见 markBusy。
			return all
				.filter((c) => c.messages.length > 0 || busy.has(c.id))
				.map((c) => ({
					id: c.id,
					title: c.title,
					createdAt: c.createdAt,
					updatedAt: c.updatedAt,
					messageCount: c.messages.length,
					mode: c.mode,
					persona: c.persona,
				}));
		},

		async get(id) {
			return readOne(fileOf(id));
		},

		create(init) {
			return serial(async () => {
				const now = new Date().toISOString();
				const conv: Conversation = {
					id: randomUUID(),
					title: PLACEHOLDER_TITLE,
					createdAt: now,
					updatedAt: now,
					messages: [],
					mode: init?.mode ?? "chat",
					persona: init?.persona ?? true,
				};
				await writeOne(conv);

				// 建完再修剪 —— 先修剪的话,上限为 N 时会在「已有 N 个」的一刻删掉
				// 一个却还没建新的,列表短暂地少一条。
				//
				// **刚建的这个必须先排除在候选之外。**它的 updatedAt 与同毫秒里
				// 别人的完全相同,靠排序保不住;真被挑中就是「点了新对话,对话没了」。
				const others = (await listAll()).filter((c) => c.id !== conv.id);

				// **先回收凉透的空壳**,再按数量修剪。壳不进列表(见 list),可它照样
				// 占着名额;而修剪按 updatedAt 挑人下手,壳只要比某条真会话新,被挤
				// 下去的就是主人真聊过的那一条。
				//
				// 「凉透」这个条件不能省:此刻正在发送的那一轮,盘上也是零消息 ——
				// 皮肤生成一趟就要几分钟,中途另开一个对话把它清掉,主人回来会发现
				// 刚才那轮凭空没了。
				const cutoff = Date.now() - EMPTY_CONVERSATION_TTL_MS;
				const alive: Conversation[] = [];
				for (const c of others) {
					if (c.messages.length === 0 && Date.parse(c.createdAt) < cutoff) {
						await unlink(fileOf(c.id)).catch(() => {});
						logger.debug(`[ai-chat] 回收没发出去的空会话 ${c.id}`);
						continue;
					}
					alive.push(c);
				}

				for (const stale of alive.slice(Math.max(0, maxConversations - 1))) {
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
					conv.messages.push({
						id: randomUUID(),
						role: m.role,
						content: m.content,
						ts: now,
						// 没调过工具就**不写**这个字段:绝大多数消息都没调,一条一个空
						// 数组等于给每个会话文件白加一份噪音。思考与图片同理。
						...(m.tools?.length ? { tools: [...m.tools] } : {}),
						...(m.reasoning ? { reasoning: m.reasoning } : {}),
						...(m.images?.length ? { images: [...m.images] } : {}),
					});
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

		setTitle(id, title) {
			return serial(async () => {
				const next = title.trim().replace(/\s+/g, " ");
				if (!next) return null;
				const conv = await readOne(fileOf(id));
				if (!conv) return null;
				conv.title = clipTitle(next);
				conv.autoTitled = true;
				// updatedAt 保持不动,理由见接口上的注释。
				await writeOne(conv);
				return conv;
			});
		},

		markBusy(id) {
			busy.set(id, (busy.get(id) ?? 0) + 1);
			let released = false;
			return () => {
				// 幂等:调用方的 catch 与 finally 都调一次也不会把别人那一笔销掉。
				if (released) return;
				released = true;
				const left = (busy.get(id) ?? 1) - 1;
				if (left > 0) busy.set(id, left);
				else busy.delete(id);
			};
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
