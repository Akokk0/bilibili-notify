import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSerialQueue, type Logger } from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import { dataPath } from "./roots.js";

/**
 * RoastDraftStore —— 等主人点头的锐评草稿。
 *
 * 审批开着时,到点生成出来的稿子不能只待在内存里:主人可能过几个小时才回一句 `y`,
 * 中间容器重启过一次。所以落盘,拓扑与 {@link SubscriptionStateStore} 同款 —— 单个 JSON
 * 文件 `<dataRoot>/state/roast-drafts.json`、tmpfile+rename 原子写、全部写操作走
 * 一条私有写道(两条流水线可能在同一分钟里各自生成一份)。
 *
 * 它**不发任何 config 事件** —— 草稿是 apps/server 自己的运行时产物,不是配置。
 *
 * 过期是主动清的,不是读的时候顺手滤掉:48 小时没人理要**告诉主人一声**,悄悄消失
 * 的话主人只会以为这周的周报又没发 —— 那正是他让女仆修掉的那种沉默。
 *
 * **UP 一律按订阅 id 记**(ADR-0020 决策 18):单人草稿的 `subscriptionId`、结果里每一处回指。0.x 写下的
 * 老草稿按 uid 记,由迁移器换成订阅 id(`migration/roast-drafts.ts`)。
 */

/** 草稿的存活时长。超过就丢,并告知主人。 */
export const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * 短 ID 的字符集 —— 去掉了 `0/o`、`1/l/i`。
 *
 * 主人是在手机上把这两个字符打出来的,形近字符看错一个就批错了单,而批错的后果
 * 恰恰是审批本身要防的事。30 个字符两位 = 900 种,待审同时挂着的通常不超过个位数。
 */
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const ID_LENGTH = 2;

export interface RoastDraft {
	/** 短 ID,主人在 IM 里打的就是它。 */
	id: string;
	kind: "board" | "solo";
	/** 单人锐评才有:评的是哪条订阅(两支订阅都行)。 */
	subscriptionId?: string;
	days: number;
	/**
	 * 推送目标 —— **生成那一刻的快照**,不是发送时再读配置。
	 *
	 * 主人审批期间把配置改到别的群去了,这份已经过目的稿子仍该发去当初那几个群:
	 * 他点头的是「这份内容发给这些人」,不是单独一句「这份内容 OK」。
	 */
	targets: string[];
	/** StatsRoastResult | StatsSoloRoastResult。存原样,渲染时才认类型。 */
	result: unknown;
	createdAt: string;
	expiresAt: string;
}

export interface RoastDraftStore {
	load(): Promise<void>;
	/** 落一份待审草稿,返回它(含分配好的短 ID)。 */
	add(
		draft: Pick<RoastDraft, "kind" | "days" | "targets" | "result"> & { subscriptionId?: string },
		now?: number,
	): Promise<RoastDraft>;
	/** 当前还没过期的草稿。 */
	list(now?: number): RoastDraft[];
	get(id: string, now?: number): RoastDraft | undefined;
	/** 取走并删除 —— 批准与否决都走它,同一份批不了第二次。已过期的取不到。 */
	take(id: string, now?: number): Promise<RoastDraft | undefined>;
	/** 清掉过期的并交还给调用方(据此私聊主人)。交还过一次就不再交还。 */
	sweep(now?: number): Promise<RoastDraft[]>;
	/**
	 * 关停:先等在途与已排队的写全部落盘,再关门 —— 此后的 add / take / sweep 一律以
	 * `SerialQueueClosedError` 拒绝、不碰盘。关停的 `flush` 段调它。
	 */
	close(): Promise<void>;
}

export interface CreateRoastDraftStoreOptions {
	dataRoot: string;
	logger: Logger;
}

/** 锐评草稿在代里的位置。 */
export const ROAST_DRAFTS_FILE = ["runtime", "roast-drafts.json"] as const;

/** 写道的唯一一个键:整份只有一个文件。 */
const WRITE_KEY = "roast-drafts";

export function createRoastDraftStore(opts: CreateRoastDraftStoreOptions): RoastDraftStore {
	const file = dataPath(opts.dataRoot, ...ROAST_DRAFTS_FILE);
	let records: RoastDraft[] = [];
	let loaded = false;
	// 单键写道 —— 两条流水线(榜单 / 某位 UP)可能在同一分钟里各自落一份草稿,
	// 整文件的 read-modify-write 交错就会丢掉其中一份。同 SubscriptionStateStore。
	const writes = createSerialQueue();

	function runSerial<T>(task: () => Promise<T>): Promise<T> {
		return writes.run(WRITE_KEY, task);
	}

	async function persist(): Promise<void> {
		try {
			await atomicWriteJson(file, records);
		} catch (err) {
			opts.logger.warn(`[roast-draft] 落盘失败: ${String(err)}`);
			throw err;
		}
	}

	function alive(d: RoastDraft, now: number): boolean {
		return Date.parse(d.expiresAt) > now;
	}

	function newId(): string {
		const taken = new Set(records.map((d) => d.id));
		// 900 种里挑一个没被占的。待审同时不过个位数,这个循环实际转不了几圈;
		// 真撞满了就加一位,不让它转成死循环。
		for (let attempt = 0; attempt < 200; attempt++) {
			let id = "";
			for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
			if (!taken.has(id)) return id;
		}
		let id = "";
		for (let i = 0; i < ID_LENGTH + 1; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
		return id;
	}

	return {
		add(draft, now = Date.now()) {
			return runSerial(async () => {
				const made: RoastDraft = {
					id: newId(),
					kind: draft.kind,
					subscriptionId: draft.subscriptionId,
					days: draft.days,
					targets: [...draft.targets],
					result: draft.result,
					createdAt: new Date(now).toISOString(),
					expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(),
				};
				records = [...records, made];
				await persist();
				return structuredClone(made);
			});
		},

		list(now = Date.now()) {
			return records.filter((d) => alive(d, now)).map((d) => structuredClone(d));
		},

		get(id, now = Date.now()) {
			const d = records.find((r) => r.id === id);
			return d && alive(d, now) ? structuredClone(d) : undefined;
		},

		take(id, now = Date.now()) {
			return runSerial(async () => {
				const d = records.find((r) => r.id === id);
				// 过期的取不到 —— 主人隔三天回一句 y,不该把陈年榜单发出去。
				// 但记录仍留着,由 sweep 统一清理并通知,免得这里悄悄吞掉。
				if (!d || !alive(d, now)) return undefined;
				records = records.filter((r) => r.id !== id);
				await persist();
				return structuredClone(d);
			});
		},

		sweep(now = Date.now()) {
			return runSerial(async () => {
				const dead = records.filter((d) => !alive(d, now));
				if (dead.length === 0) return [];
				records = records.filter((d) => alive(d, now));
				await persist();
				return dead.map((d) => structuredClone(d));
			});
		},

		close: () => writes.close(),

		async load() {
			if (loaded) return;
			loaded = true;
			try {
				const raw = await readFile(file, "utf8");
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					records = parsed as RoastDraft[];
				} else {
					opts.logger.warn("[roast-draft] 文件不是数组,当空的起");
				}
			} catch (err) {
				// 盘上文件坏了也得能起 —— 草稿丢了顶多少发一份周报,
				// 起不来是整个服务没了。
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[roast-draft] 读盘失败,当空的起: ${String(err)}`);
				}
			}
		},
	};
}
