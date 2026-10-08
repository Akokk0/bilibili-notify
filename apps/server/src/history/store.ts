import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DailyHistoryCount } from "@bilibili-notify/contract";
import type {
	DeliveryResult,
	FeatureKey,
	HistoryEntry,
	HistoryMessage,
	HistoryPayload,
	Identity,
	ImageRef,
	Logger,
	MessageBus,
	NotificationPayload,
	PostFilterReason,
	PushMessageRole,
	PushStatus,
} from "@bilibili-notify/internal";
import {
	countsAsDelivery,
	countsAsFailure,
	createSerialQueue,
	FEATURE_KEYS,
	HistoryEntrySchema,
	HistoryPatchSchema,
	IMAGE_REF_PATTERN,
} from "@bilibili-notify/internal";
import { appendJsonl, atomicWriteFile } from "@bilibili-notify/storage";
import type { ImageWriter } from "../images/image-store.js";
import { dataPath } from "../runtime/roots.js";
import { RecencyTable } from "../util/recency-table.js";
import { latestByIdentity } from "./repush.js";
import type { RepushStore } from "./repush-store.js";

/**
 * 推送历史:jsonl-by-day 持久化 + bus 广播。
 *
 * **一行 = 一次推送 × 一个目标**,行里是这次推送发给这个目标的消息列表与逐条结果。
 * 本体(卡片)落地就建行、emit `history-recorded`;同一次推送的后续消息(词云 / 总结 /
 * 图集 / @全体)算好发出后**追加到同一行**:盘上写一条补丁行,读时按行 id 并回去,
 * emit `history-updated`。jsonl 仍是 append-only,保留期(见 `retention.ts`)按日文件淘汰。
 *
 * 被全局静音 / 免扰时段挡下的推送也落行(状态 `silenced`,每条消息带 `isSilenced`、没有结果),
 * 同样留重推原件 —— 一条都没发,但之后可以补发。
 *
 * 图片存进图库 `images/`(ADR-0022 决策 9),引用存在 `payload.image`,面板经 `/api/images/<引用>` 读。历史是图库的
 * 一家引用方(保留期内的行引用的图,见 `retention.ts` 的 `listHistoryImageRefs`),图不由历史删 —— 保留期、
 * `deleteRange` 都只动行与重推原件,图由图库的按引用清扫收走。
 */

export interface HistoryRecordMessage {
	payload: NotificationPayload;
	role: PushMessageRole;
	/** 无目标行没有它;被前一条失败中止、从没出过网的那几条也没有;被挡下的也没有。 */
	result?: DeliveryResult;
	/** 这条被全局静音 / 免扰时段挡下了(推送层给的,见 `PushMessageResult.isSilenced`);与 `result` 互斥。 */
	isSilenced?: true;
}

export interface NewHistoryEntry {
	pushId: string;
	/** 这次推送的特性键(补报记 `liveStart`、周期记 `liveStreaming`)。 */
	feature: FeatureKey;
	/** 替谁发的:订阅的身份(`subscriptionIdentityOf` 的结果),B 站行与拓展行同一种形状。 */
	identity: Identity;
	subscriptionId: string;
	/** null = 这一行没有目标:这类推送没有任何可用目标(「无目标」行),或者是一条被过滤的作品(见 `filteredBy`)。 */
	targetId: string | null;
	/**
	 * 这条作品被过滤挡下了,记的是原因 —— 给了就落一行 `filtered`(ADR-0021 决策 34 的 🔗):只留痕,
	 * 不存重推原件;写一次就完,不和任何行合并、之后也不追加。`targetId` 一律给 null。
	 */
	filteredBy?: PostFilterReason;
	messages: HistoryRecordMessage[];
	/** Snapshot of sub.cachedProfile.name at write time; survives 订阅删除。 */
	nameSnapshot?: string;
	/**
	 * 推送那一刻的头像:抄订阅资料里存进图库的 `avatar`(拓展行;B 站行没有,抓图服务在 3a)。是别家的引用,
	 * 写行前先续期 —— 续不上(图已经不在了)这一格就不写,行照写。
	 */
	avatarSnapshot?: ImageRef;
}

/**
 * 人工重推补进来的一条。`repushOf` **必填** —— 这条路径只服务重推,而一条没说清楚
 * 「补的是第几条」的重投会让四态算错(每一号只认它最后那次尝试)。
 */
export interface HistoryRepushMessage extends HistoryRecordMessage {
	/** 补的是行里第几条(那一条在 `messages` 里的下标)。 */
	repushOf: number;
}

interface HistoryQuery {
	limit?: number;
	since?: string;
	feature?: FeatureKey;
}

interface DailyAggregateOptions {
	/** 窗口天数(含今天),调用方负责 clamp。 */
	days: number;
	/**
	 * 客户端时区偏移,JS `Date.prototype.getTimezoneOffset()` 口径
	 * (分钟,UTC+8 → -480)。缺省 0 = UTC 日界。
	 */
	tzOffsetMin?: number;
	/** 注入时钟,测试用。 */
	now?: Date;
}

// DailyHistoryCount 的类型本体在 @bilibili-notify/contract(web 同源消费)。

export interface DeleteRangeOptions {
	/** 闭区间,ms。 */
	fromMs: number;
	toMs: number;
}

export interface HistoryStore {
	/**
	 * 整类清空文字(㉙d,「存储占用」):真删全部 `history/<日>.jsonl`(不是写成空文件 —— 那是 {@link deleteRange}
	 * 给「删一段」用的),经同一条写道,排在在飞的 `record` / `appendToRow` 之后;内存里还能被追加的行
	 * 与「刚补完的那一行」一并忘掉。**连同重推原件**:同一趟里整个删掉 `history/repush/`(行没了,原件没有任何入口
	 * 能读到,还经「重推原件」那一家留着图;`deleteRange` 对被删行的原件也是这么处理)。**不动**图的保留水位线 `retention.json`。
	 * 一个日文件都没有也成功。
	 */
	clear(): Promise<void>;
	/**
	 * 记一次推送对一个目标的一段消息。同 pushId + 同目标第一次来建行,之后追加;
	 * 返回合并后的整行。
	 */
	record(input: NewHistoryEntry): Promise<HistoryEntry>;
	/**
	 * 往**一行已知 id 的行**里补几条消息(人工重推,ADR-0017)。找不到那一行、或者一条
	 * 都不补,回 `null` 且什么都不写。
	 *
	 * 为什么不能走 `record`:那条路靠内存里那张 `open` 表找行(键 `pushId|targetId`、
	 * 上限 2000 行、重启即空),服务的是「同一次推送的几段消息陆续落地」那几秒到几分钟。
	 * 人工重推是隔了几小时、甚至重启过一次之后的事 —— 那时 `open` 里早没有这一行,
	 * `record` 会建出第二行来,面板上于是出现两行同一次推送。
	 */
	appendToRow(
		rowId: string,
		createdAt: string,
		messages: readonly HistoryRepushMessage[],
	): Promise<HistoryEntry | null>;
	/**
	 * 按行 id 把一行读回来(补丁已经并好),找不到回 `null`。`createdAt` 用来定位日文件。
	 *
	 * 重推那条路要先看见这一行才判得了闸,端点也据此回 404。
	 */
	findRow(rowId: string, createdAt: string): Promise<HistoryEntry | null>;
	query(opts: HistoryQuery): Promise<HistoryEntry[]>;
	aggregateDaily(opts: DailyAggregateOptions): Promise<DailyHistoryCount[]>;
	/**
	 * 删掉 `createdAt` 落在窗内的行(本体行 + 补丁行)与它们的重推原件,回删了几行。**不删图**:行引用的图在图库里,
	 * 行没了它们就不再被这一家引用,过了宽限期由图库的清扫收走(同一张图可能还被别的行、资料缓存引用着)。
	 *
	 * 今天只有 devtools 截流在用(清掉截流期间记下的 delivered 行)。**这是唯一还会删文字的路**,刻意的
	 * 例外:保留期的清扫只清重推原件(图归图库的清扫),文字不设上限(ADR-0022 决策 9)。与 `record` 串行 ——
	 * 删的同时有行在追加,补丁会补到一行刚被删掉的本体上。
	 */
	deleteRange(opts: DeleteRangeOptions): Promise<number>;
	/**
	 * 关停:先等在途与已排队的写(落行 / 追加 / 删区间)全部落盘,再关门 —— 此后的 record /
	 * appendToRow / deleteRange 一律以 `SerialQueueClosedError` 拒绝、不碰盘。关停的 `flush` 段调它。
	 */
	close(): Promise<void>;
}

function zeroCounts(): Record<FeatureKey, number> {
	return Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0])) as Record<FeatureKey, number>;
}

/**
 * 状态的算法(消息的纯函数,外加行上的 `filteredBy`)。**被过滤的行**(`filteredBy` 有值)一律 `filtered`,
 * 排在最前:它的目标那一格也空着,可它不是「无目标」—— 两种空目标的行靠这一格分开。
 *
 * 其余的行:本体 = 第一条 `role: "main"` 的消息:它没到就是失败;它到了、别的没到是
 * 部分失败(附加项,或本体的后续分条)。只有附加项先到的行(@全体 抢在卡片前面落地)
 * 暂按失败 / 已送达算,本体一到就重算。
 *
 * **被静音 / 免扰挡下的消息**(`isSilenced`,没有结果):本体那一号的最后一次是被挡的 → 整行
 * `silenced`,不看附加项;没有本体、全是被挡的也是 `silenced`。别的情况下被挡的那几号**不参与**
 * 「是否全送到」的判断(本体送到了、只有附加项被挡的行算已送达 —— 被挡不是没送到,不能算成部分失败)。
 * 补发的消息带 `repushOf` 追加进来,同一号的最后一次就换成了补发那次的结果。
 *
 * **每条消息的身份 = `repushOf ?? 它自己的下标`,每一号只认它最后那次尝试**
 * (ADR-0017 决策 16)—— 人工重推把补发的消息追加进原行,一行里于是会有同一条消息的
 * 好几次结果。🔴 **不能简化成「按 role 取最后一次」**:同一 role 下有多条时会把不同的
 * 消息混成一个,补好了 extra1 整行就变绿,而 extra2 还躺着没送到。
 *
 * 老行没有 `repushOf`,每条自成一号,算出来与从前逐字节一样;盘上的老数据一条都不用迁移
 * (`status` 是写入时算好存下的,读侧不重算)。
 */
export function computeStatus(
	targetId: string | null,
	messages: HistoryMessage[],
	filteredBy?: PostFilterReason,
): PushStatus {
	if (filteredBy !== undefined) return "filtered";
	if (targetId === null) return "no-targets";
	const latest = latestByIdentity(messages);
	// 一号都没有的有目标行 = 什么都没发出去,不是「全到了」——`[].every` 恒真,不挡住
	// 它,一行没有消息的行会顶着「已送达」进面板与今日 KPI。
	//
	// 判据是**每一号都有到了的结果**,不是「有结果的那些都到了」:决策 17 之后,那几条
	// 因为前面失败而从没发出去的消息也会落进行里(没有 `result`)。只看有结果的那些,
	// 一行「本体到了、后面两条压根没发」会被算成已送达。
	const mainIdx = messages.findIndex((m) => m.role === "main");
	const main = mainIdx === -1 ? undefined : latest.get(mainIdx);
	if (main?.isSilenced) return "silenced";
	// 被挡的那几号不参与下面「是否全送到」的判断。
	const attempted = [...latest.values()].filter((m) => !m.isSilenced);
	// 一号都不剩:没有本体、全是被挡的。(有本体而它被挡的,上面已经回了。)
	if (latest.size > 0 && attempted.length === 0) return "silenced";
	if (attempted.length > 0 && attempted.every((m) => m.result?.ok === true)) {
		return "delivered";
	}
	if (mainIdx === -1 || main?.result?.ok !== true) return "failed";
	return "partial";
}

/** 同 pushId 同目标的行还在内存里时才能追加;保留最近这些,够一次推送从头到尾。 */
const OPEN_ROWS_CAP = 2000;

/** 写道的唯一一个键:历史的写全局串行,是刻意的。 */
const WRITE_KEY = "history";

export interface CreateHistoryStoreOptions {
	dataRoot: string;
	bus: MessageBus;
	logger: Logger;
	/**
	 * 往图库存图 / 续期的口:历史登记成图库的引用方(`runtime/bootstrap.ts`)才拿得到。配图、头像快照走它。
	 */
	images: ImageWriter;
	/**
	 * 重推原件(ADR-0017)。给了就在每次落行 / 追加时留一份**没有损耗的**原料 ——
	 * 那一刻是最后的机会,再往后历史里就只剩给人看的摘要了。不给 = 不留原件。
	 */
	repush?: RepushStore;
}

export function createHistoryStore(opts: CreateHistoryStoreOptions): HistoryStore {
	const root = dataPath(opts.dataRoot, "history");
	/** 还可能被追加的行,键 = `${pushId}|${targetId}`;满了丢最久没碰的。 */
	const open = new RecencyTable<HistoryEntry>(OPEN_ROWS_CAP);
	/**
	 * 写串行化:同一次推送的两段(卡片、紧随其后的 @全体)不会同时建两行。**全局单键**(`WRITE_KEY`)——
	 * 历史的全局串行是刻意的,别按推送或目标拆键。关停时 `close()` 等它走空再关门。
	 */
	const writes = createSerialQueue();
	/**
	 * **刚补完的那一行**,给 `appendToRow` 连着补下一条时当 base 用。
	 *
	 * 为什么要它:一次「重推全部」是 N 条消息 N 次 `appendToRow`,而每次都
	 * `readJsonl(dayFile(createdAt))` —— 整份日文件读进来、**逐行**跑一遍
	 * `HistoryEntrySchema` / `HistoryPatchSchema`。日文件是「一次推送 × 一个目标」一行,
	 * 高推送量实例一天几千行,于是补一个 6 条的行就是 7 遍全份解析(`start()` 的
	 * `findRow` 还占一遍)。同一个文件的 `readTailEntries` 早就为 `query()` 躲开过
	 * 这笔钱,重推这条路又把它整个请了回来 —— 而且这几遍都排在写道 `writes` 上,
	 * 期间所有正常推送的落行都在后面等着。
	 *
	 * 🔴 **只在这份日文件自那以后一个字节都没被动过时才算数**:每次用之前 `stat` 一下
	 * 对 size + mtime。`record` 往同一天追了一行、`deleteRange` 重写了这份、保留期把
	 * 整份端了、测试直接往文件里写 —— 任何一种都对不上,当场回落到老老实实重读。
	 * 只认**一行**(不是整份文件的解析结果),免得高推送量实例的一整天行都被它攥着不放。
	 */
	let hotRow: {
		rowId: string;
		path: string;
		size: number;
		mtimeMs: number;
		entry: HistoryEntry;
	} | null = null;

	/** 文件的「有没有被动过」指纹;文件不在回 `null`(于是缓存一定作废)。 */
	async function fileSig(path: string): Promise<{ size: number; mtimeMs: number } | null> {
		try {
			const st = await stat(path);
			return { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			return null;
		}
	}

	async function ensureDirs(): Promise<void> {
		await mkdir(root, { recursive: true });
	}

	function dayFile(dateIso: string): string {
		// YYYY-MM-DDTHH:MM:SS.sssZ → YYYY-MM-DD
		return join(root, `${dateIso.slice(0, 10)}.jsonl`);
	}

	/**
	 * 配图存进图库,回引用。过不了图库(不是 png / jpg / gif / webp、超 8MB)这一格缺着、记一句 warn,行照写 ——
	 * 从前是信 payload 声明的 mime 直接落盘,现在一律按嗅探。磁盘写失败(图库回的不是 `invalid`)在这里抛出去、
	 * 这一行不写,同从前 —— 那时是图库自己抛。同一份字节再存一次回同一个引用(只刷新修改时间),所以重推每试一次
	 * 不会再多写一份。
	 */
	async function putImage(bytes: Uint8Array, label: string): Promise<ImageRef | undefined> {
		const stored = await opts.images.put(bytes);
		if (stored.ok) return stored.ref;
		if (stored.code !== "invalid") throw new Error(`配图存不进图库:${label} — ${stored.message}`);
		opts.logger.warn(`[history] 配图存不进图库,这条消息不带图:${label} — ${stored.message}`);
		return undefined;
	}

	/** 头像快照抄的是别家的引用:先续期;续不上(图已经不在了)或续期出错都不写这一格,行照写。 */
	async function keptAvatar(ref: ImageRef | undefined): Promise<ImageRef | undefined> {
		if (ref === undefined) return undefined;
		try {
			return (await opts.images.keep(ref)) ? ref : undefined;
		} catch (err) {
			opts.logger.warn(`[history] 头像快照续期失败,这一行不带头像:${String(err)}`);
			return undefined;
		}
	}

	async function reduce(
		msg: HistoryRecordMessage,
		label: string,
		feature: FeatureKey,
	): Promise<HistoryPayload> {
		const payload = msg.payload;
		switch (payload.kind) {
			case "text":
				return { kind: "text", text: payload.text };
			case "image": {
				const image = await putImage(payload.image.buffer, label);
				// 纯图推送(无 caption)在 History 列表会落成「（无内容）」—— 给个可读摘要。
				// 下播的附加项里唯一的图是词云;别的纯图都是拆成独立消息的卡片。
				const text =
					payload.caption ||
					(feature === "liveEnd" && msg.role === "extra" ? "[弹幕词云]" : "[卡片图]");
				return { kind: "image", text, image };
			}
			case "image-group":
				return {
					kind: "text",
					text: `[图集 ${payload.images.length} 张${payload.mergeForward ? " · 合并转发" : ""}]`,
				};
			case "miniapp-card":
				return { kind: "text", text: `[小程序卡] ${payload.title}` };
			case "composite": {
				const textParts: string[] = [];
				let image: ImageRef | undefined;
				let firstImageSeen = false;
				for (const seg of payload.segments) {
					if (seg.kind === "text") {
						textParts.push(seg.text);
					} else if (seg.kind === "image" && !firstImageSeen) {
						// 历史行只记第一张(重推原件里每一张都在);第一张存不进图库,后面的也不顶上。
						firstImageSeen = true;
						image = await putImage(seg.buffer, label);
					} else if (seg.kind === "link") {
						textParts.push(seg.title ? `${seg.title} ${seg.href}` : seg.href);
					} else if (seg.kind === "at-all") {
						// @全体 段无文字载体,但 History 需要可读标记,否则独立的 @全体 提醒
						// 消息会整条落成「（无内容）」。按段序前置拼接(@全体 通常单独成消息)。
						textParts.push("@全体");
					}
				}
				return {
					kind: "composite",
					text: textParts.join("\n"),
					image,
				};
			}
		}
	}

	async function reduceAll(
		messages: readonly HistoryRecordMessage[],
		rowId: string,
		offset: number,
		feature: FeatureKey,
	): Promise<HistoryMessage[]> {
		const out: HistoryMessage[] = [];
		for (const [i, msg] of messages.entries()) {
			const payload = await reduce(msg, `${rowId}-${offset + i}`, feature);
			// 投递结果原样交下去:盘上那一格就是结果形状,截流标记这类 schema 不认的格在写盘前的校验里剥掉。
			// 被挡的那一格与结果互斥:有结果就不是被挡的。
			out.push({
				payload,
				role: msg.role,
				...(msg.result
					? { result: msg.result }
					: msg.isSilenced
						? { isSilenced: true as const }
						: {}),
			});
		}
		return out;
	}

	/**
	 * 把这一段消息的**原样 payload** 留一份给重推(ADR-0017 决策 1)。
	 *
	 * 必须在这儿做:`reduceAll` 之后原样的那份就只剩这一处还握着了(历史行里是有损摘要)。原件按下标与历史行的
	 * `messages` 一一对应(`reduceAll` 逐条来、不丢条),图由原件自己存进图库。
	 *
	 * 没有目标的行不留 —— 无目标行不是失败是没配目标,被过滤的行只留痕、压根没推,按钮本来就不给
	 * 它们(决策 6)。被静音 / 免扰挡下的行有目标,照留:补发靠的就是这一份。
	 */
	async function saveRepushSnapshot(
		rowId: string,
		createdAt: string,
		raw: HistoryRecordMessage[],
		target: string | null,
	): Promise<void> {
		if (!opts.repush || target === null) return;
		try {
			await opts.repush.append(
				rowId,
				createdAt,
				raw.map((m) => ({ payload: m.payload, role: m.role })),
			);
		} catch (err) {
			// 原件留不下只是「这一行将来重推不了」,不该连累这次推送的历史。
			opts.logger.warn(`[history] 重推原件写入失败,这一行将来补不了:${rowId} — ${String(err)}`);
		}
	}

	function validated(entry: HistoryEntry): HistoryEntry {
		// Defensive validation — schema mismatches are programmer errors, but
		// recording corrupt jsonl is worse than rejecting the write.
		const parsed = HistoryEntrySchema.safeParse(entry);
		if (!parsed.success) {
			opts.logger.error(
				`[history] entry rejected by schema, dropping: ${JSON.stringify(parsed.error.issues)}`,
			);
			throw new Error("history entry schema validation failed");
		}
		return parsed.data;
	}

	/**
	 * 把一段**已经 reduce 好的**消息并进一行:算状态 → 写补丁行 → 更新内存表 → emit。
	 *
	 * 两条路共用这一份:`record` 的追加分支(同一次推送的后续几段落地)与人工重推的
	 * `appendToRow`。它们真正不同的只有「base 从哪来」(内存 `open` 表 / 扫日文件)与
	 * 「added 怎么造」(要不要盖 `repushOf`);剩下这一串**必须一个字不差地同步**,
	 * 只改一边的话重推那条路就静默写出另一种行 —— 正是 ADR-0017 担心的那类静默。
	 *
	 * 🔴 `path` 由调用方给:补丁必须落进**原行那一天**的日文件。`parseLines` 的 `byId`
	 * 是**单文件局部**的,跨了日文件就找不到亲、整条补丁被静默丢掉 —— 症状是「点了重推,
	 * 消息真的发出去了,面板上却什么都没变」。
	 *
	 * 🔴 补丁行的**键序固定 `rowId` 打头**:读侧靠行首一眼认出它、不必先 JSON.parse
	 * (见 `isPatchLine`)。换个键序写出来的补丁行,写的时候不报错、读的时候没人认。
	 *
	 * `beforeEmit` 是给 `record` 那侧留的口:重推原件要在**面板收到这一行变了之前**
	 * 落盘,否则面板回头问「这行还能补吗」时原件还没写出来。
	 */
	async function applyPatch(
		base: HistoryEntry,
		added: HistoryMessage[],
		path: string,
		beforeEmit?: (merged: HistoryEntry) => Promise<void>,
	): Promise<HistoryEntry> {
		const messages = [...base.messages, ...added];
		const merged = validated({
			...base,
			status: computeStatus(base.targetId, messages, base.filteredBy),
			messages,
		});
		// 落盘的是**过了 schema 的那几条**(`merged` 的尾巴),不是调用方交来的原样:schema 不认的格
		// (截流标记之类)本体行不留,补丁行也不留。
		const patch = {
			rowId: merged.id,
			status: merged.status,
			messages: merged.messages.slice(base.messages.length),
		};
		await appendJsonl(path, [patch]);
		// 这一行要是还在内存表里(刚推完就点了重推),把它也更新掉 —— 否则同一次推送
		// 后面那几段(词云 / 总结)落地时会拿旧的算 offset 与状态。
		const key = `${merged.pushId}|${merged.targetId ?? "-"}`;
		if (open.get(key)) open.set(key, merged);
		await beforeEmit?.(merged);
		opts.bus.emit("history-updated", merged);
		return merged;
	}

	async function recordSerialized(input: NewHistoryEntry): Promise<HistoryEntry> {
		await ensureDirs();
		const key = `${input.pushId}|${input.targetId ?? "-"}`;
		// 被过滤的行写一次就完:不找已有的行来并,也不进 `open`(那张表有上限,一阵被过滤的作品不该把
		// 一行还在等词云 / 总结落地的推送挤出去)。
		const existing = input.filteredBy === undefined ? open.get(key) : undefined;
		if (!existing) {
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			const messages = await reduceAll(input.messages, id, 0, input.feature);
			const avatarSnapshot = await keptAvatar(input.avatarSnapshot);
			// 键的顺序就是盘上的顺序,与迁移器(`migration/history.ts`)改出来的老行同一个排法。
			const entry = validated({
				id,
				pushId: input.pushId,
				createdAt,
				feature: input.feature,
				identity: input.identity,
				subscriptionId: input.subscriptionId,
				targetId: input.targetId,
				status: computeStatus(input.targetId, messages, input.filteredBy),
				...(input.filteredBy !== undefined ? { filteredBy: input.filteredBy } : {}),
				messages,
				nameSnapshot: input.nameSnapshot,
				avatarSnapshot,
			});
			await appendJsonl(dayFile(createdAt), [entry]);
			if (input.filteredBy === undefined) open.set(key, entry);
			await saveRepushSnapshot(id, createdAt, input.messages, input.targetId);
			opts.bus.emit("history-recorded", entry);
			return entry;
		}
		const added = await reduceAll(
			input.messages,
			existing.id,
			existing.messages.length,
			existing.feature,
		);
		// 补丁写进**原行那一天**的文件,原件也跟着那一天走 —— 两边始终同一个日子。
		return applyPatch(existing, added, dayFile(existing.createdAt), () =>
			saveRepushSnapshot(existing.id, existing.createdAt, input.messages, existing.targetId),
		);
	}

	function record(input: NewHistoryEntry): Promise<HistoryEntry> {
		return writes.run(WRITE_KEY, () => recordSerialized(input));
	}

	async function findRow(rowId: string, createdAt: string): Promise<HistoryEntry | null> {
		return (await readJsonl(dayFile(createdAt))).find((r) => r.id === rowId) ?? null;
	}

	async function appendToRowSerialized(
		rowId: string,
		createdAt: string,
		messages: readonly HistoryRepushMessage[],
	): Promise<HistoryEntry | null> {
		if (messages.length === 0) return null;
		await ensureDirs();
		const path = dayFile(createdAt);
		const sig = await fileSig(path);
		// 连着补第二条起走这条:上一条刚写完的那一行还在手上,而这份文件自那以后没被
		// 动过(见 `hotRow`)。对不上、或者文件压根不在(`sig` 为 null)就重读 ——
		// 整份日文件读一遍、逐行 zod,换来的是不依赖那张重启即空的内存表,而这条路径
		// 存在的理由正是「那张表里早没有这一行了」。
		const reusable =
			sig &&
			hotRow &&
			hotRow.rowId === rowId &&
			hotRow.path === path &&
			hotRow.size === sig.size &&
			hotRow.mtimeMs === sig.mtimeMs
				? hotRow.entry
				: undefined;
		const base = reusable ?? (await readJsonl(path)).find((r) => r.id === rowId);
		if (!base) return null;
		const reduced = await reduceAll(messages, base.id, base.messages.length, base.feature);
		// 补进来的图跟着**整行**的序号往后排(`reduceAll` 的 offset),盖不掉原来那几张。
		const added = reduced.map((m, i) => ({ ...m, repushOf: messages[i]?.repushOf ?? 0 }));
		// 🔴 写进**原行那一天**的文件(`path` 就是 `dayFile(createdAt)`)—— 跨了日文件补丁会被
		// 静默丢掉,见 `applyPatch` 的说明。
		const merged = await applyPatch(base, added, path);
		// 指纹得在**写完之后**取:这一趟自己写的那条补丁行不该让下一条判成「被别人动过」。
		const after = await fileSig(path);
		hotRow = after ? { rowId, path, ...after, entry: merged } : null;
		return merged;
	}

	function appendToRow(
		rowId: string,
		createdAt: string,
		messages: readonly HistoryRepushMessage[],
	): Promise<HistoryEntry | null> {
		return writes.run(WRITE_KEY, () => appendToRowSerialized(rowId, createdAt, messages));
	}

	async function query(q: HistoryQuery): Promise<HistoryEntry[]> {
		await ensureDirs();
		const limit = Math.min(q.limit ?? 100, 500);
		const sinceMs = q.since ? Date.parse(q.since) : Number.NEGATIVE_INFINITY;
		const out: HistoryEntry[] = [];

		// List day files, newest first.
		let files: string[];
		try {
			const all = await readdir(root);
			files = all
				.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
				.sort()
				.reverse();
		} catch {
			return [];
		}

		// feature 的合格行可能散在整份文件里,拿尾巴不成立 —— 那条路只好照旧
		// 全量解析。前端两个调用点(Dashboard limit=100 / History limit=200)都不带
		// 这个参数,也就是说热路径永远走便宜的那条。
		const needsFullScan = q.feature !== undefined;

		for (const file of files) {
			const path = join(root, file);
			const collected = needsFullScan
				? await readJsonl(path)
				: await readTailEntries(path, limit - out.length);
			// In-file is chronological (append-only); reverse so newest first per day.
			for (let i = collected.length - 1; i >= 0; i--) {
				const entry = collected[i];
				if (!entry) continue;
				if (Date.parse(entry.createdAt) <= sinceMs) continue;
				if (q.feature && entry.feature !== q.feature) continue;
				out.push(entry);
				if (out.length >= limit) return out;
			}
		}
		return out;
	}

	async function aggregateDaily(opts: DailyAggregateOptions): Promise<DailyHistoryCount[]> {
		await ensureDirs();
		const tz = opts.tzOffsetMin ?? 0;
		const nowMs = (opts.now ?? new Date()).getTime();

		// 「本地日」= UTC 时刻平移 tz 偏移后的 UTC 日期。日文件名是 UTC 日,与本地日
		// 错位(北京凌晨 0~8 点在前一个 UTC 日文件里),所以归属必须按 entry.createdAt 逐条算,
		// 不能按文件名。
		const localKey = (utcMs: number) => new Date(utcMs - tz * 60_000).toISOString().slice(0, 10);

		// 窗口日序列在「墙钟毫秒」空间里做减法 —— 固定偏移下无 DST,天长恒为 24h。
		const todayWallMs = Date.parse(`${localKey(nowMs)}T00:00:00Z`);
		const out: DailyHistoryCount[] = [];
		const byDay = new Map<string, DailyHistoryCount>();
		for (let i = opts.days - 1; i >= 0; i--) {
			const d = new Date(todayWallMs - i * 86_400_000).toISOString().slice(0, 10);
			const bucket: DailyHistoryCount = { d, counts: zeroCounts(), total: 0, failures: 0 };
			out.push(bucket);
			byDay.set(d, bucket);
		}

		// 窗口首日 0 点的真实 UTC 时刻所在的 UTC 日 —— 比它更早的日文件不可能含窗口内
		// entry,直接跳过不读。窗口后侧不裁(顶多多读今天之后的空文件,不存在)。
		const windowStartUtcMs = todayWallMs - (opts.days - 1) * 86_400_000 + tz * 60_000;
		const firstFileDate = new Date(windowStartUtcMs).toISOString().slice(0, 10);

		let files: string[];
		try {
			files = (await readdir(root)).filter(
				(f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= firstFileDate,
			);
		} catch {
			return out;
		}
		for (const file of files) {
			for (const entry of await readJsonl(join(root, file))) {
				const ms = Date.parse(entry.createdAt);
				if (!Number.isFinite(ms)) continue;
				const bucket = byDay.get(localKey(ms));
				if (!bucket) continue;
				// 「今日推送」数的是推到了多少个地方,「今日失败」把部分失败也算进去 ——
				// 两条口径与面板上的乐观补丁同吃 internal 的那一份。
				if (!countsAsDelivery(entry.status)) continue;
				bucket.counts[entry.feature] += 1;
				bucket.total += 1;
				if (countsAsFailure(entry.status)) bucket.failures += 1;
			}
		}
		return out;
	}

	/**
	 * 一批 jsonl 原文行 → entry,补丁行并回它的行;坏行、不合 schema 的行、找不到
	 * 亲的补丁行静默跳过。
	 */
	function parseLines(lines: readonly string[]): HistoryEntry[] {
		const byId = new Map<string, HistoryEntry>();
		const order: HistoryEntry[] = [];
		for (const line of lines) {
			try {
				const json = JSON.parse(line);
				if (isPatchLine(line)) {
					const r = HistoryPatchSchema.safeParse(json);
					const base = r.success ? byId.get(r.data.rowId) : undefined;
					if (r.success && base) {
						base.messages.push(...r.data.messages);
						base.status = r.data.status;
					}
					continue;
				}
				const r = HistoryEntrySchema.safeParse(json);
				if (r.success) {
					byId.set(r.data.id, r.data);
					order.push(r.data);
				}
			} catch {
				// skip malformed line
			}
		}
		return order;
	}

	/**
	 * 一个日文件里**最新的那几条**(仍是时序,最新的在最后)。
	 *
	 * 为什么不直接 {@link readJsonl} 再取尾巴:那样每次请求都要把当天每一行都
	 * `JSON.parse` + zod 校验一遍,而返回的最多 `limit` 条 —— 解析开销跟「当天推了
	 * 多少」成正比,跟「要拿几条」无关。攒得越多越慢,而多出来的全是白干。
	 *
	 * 这里逐行流读(不把整份文件读进内存),只把最后 `limit` **行**(补丁行不算,
	 * 它们跟着自己的行一起留下)的原文留在窗口里,读完才解析那几行。
	 */
	async function readTailEntries(path: string, limit: number): Promise<HistoryEntry[]> {
		if (limit <= 0) return [];
		// 窗口只往后追加,丢掉的行用 head 下标跨过去 —— `shift()` 是 O(n),几万行的日文件
		// 上,省下来的那点解析开销会原样还回去。head 跑远了才整块裁一次(摊下来仍是每行
		// O(1)),免得整份文件的行都被这个数组攥着不放。
		const window: string[] = [];
		let head = 0;
		let rowsInWindow = 0;
		let rowsSeen = 0;
		try {
			const stream = createReadStream(path, { encoding: "utf8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (!line.trim()) continue;
				window.push(line);
				if (isPatchLine(line)) continue;
				rowsInWindow += 1;
				rowsSeen += 1;
				while (rowsInWindow > limit) {
					const dropped = window[head];
					head += 1;
					if (dropped !== undefined && !isPatchLine(dropped)) rowsInWindow -= 1;
				}
				if (head > limit) {
					window.splice(0, head);
					head = 0;
				}
			}
		} catch {
			// missing file is fine
			return [];
		}
		const entries = parseLines(window.slice(head));
		// **窗口按行取,结果按条算 —— 中间差的那几条不能靠更早的日文件来填。**
		// 尾窗里混进读不回来的行(崩在写一半的最后一行、旧 schema 的行)时,这一份
		// 就少给几条;调用方看见没凑够 limit,转头去前一天的文件里补 —— 夹在中间
		// 那些完好的记录于是从历史页上彻底消失,连翻页都翻不到。
		//
		// 坏行本就罕见,遇上了就把这一份老老实实全读一遍:慢一次(且只慢这一份),
		// 换的是「给出来的一定是连着的最新几条」。
		if (entries.length < rowsInWindow && rowsSeen > limit) {
			return (await readJsonl(path)).slice(-limit);
		}
		return entries;
	}

	async function readJsonl(path: string): Promise<HistoryEntry[]> {
		return parseLines(await readRawLines(path));
	}

	/** 一个日文件里 `createdAt` 落在窗内的行:本体行与它的补丁行一起丢。回被丢的行 id。 */
	async function deleteRangeInFile(
		path: string,
		fromMs: number,
		toMs: number,
	): Promise<Set<string>> {
		// 破坏性改写只认全有或全无的读:`readRawLines` 那份把任何错都咽掉、回读到一半的结果
		// (它服务的是只读路径,「文件不在」才是常态)。拿残缺的一半当全份写回去,窗外的行会
		// 被无声抹掉,回的 deleted 还小得像没事发生。
		const lines = await readAllLinesStrict(path);
		const doomed = new Set<string>();
		const kept: string[] = [];
		// 先认出窗内的本体行 —— 补丁行只带 id 不带 createdAt,得先知道谁是要删的。
		for (const line of lines) {
			if (isPatchLine(line)) continue;
			const r = HistoryEntrySchema.safeParse(tryParse(line));
			if (!r.success) continue;
			const createdMs = Date.parse(r.data.createdAt);
			if (createdMs >= fromMs && createdMs <= toMs) doomed.add(r.data.id);
		}
		if (doomed.size === 0) return doomed;
		for (const line of lines) {
			const json = tryParse(line);
			if (isPatchLine(line)) {
				const r = HistoryPatchSchema.safeParse(json);
				if (r.success && doomed.has(r.data.rowId)) continue;
			} else {
				const r = HistoryEntrySchema.safeParse(json);
				if (r.success && doomed.has(r.data.id)) continue;
			}
			kept.push(line);
		}
		// 原子写:**读的人**永远看不到半个日文件,fsync 之后掉电也不丢刚写下的这一份;
		// 写失败不留临时文件,被杀留下的由开机清扫收走。
		await atomicWriteFile(path, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
		return doomed;
	}

	async function deleteRangeSerialized({ fromMs, toMs }: DeleteRangeOptions): Promise<number> {
		await ensureDirs();
		let files: string[];
		try {
			files = (await readdir(root)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
		} catch {
			return 0;
		}
		let deleted = 0;
		for (const file of files) {
			// 日文件按 UTC 日切;整天都不沾窗的直接跳过,别把一年的文件全读一遍。
			const dayStart = Date.parse(`${file.slice(0, 10)}T00:00:00.000Z`);
			if (dayStart + DAY_MS <= fromMs || dayStart > toMs) continue;
			const doomed = await deleteRangeInFile(join(root, file), fromMs, toMs);
			if (doomed.size === 0) continue;
			deleted += doomed.size;
			open.deleteWhere((entry) => doomed.has(entry.id));
			// 行没了,它的原件就是没人认领的孤儿 —— 而且是盘上一份谁都读不到的推送内容。
			// 日文件名就是那一天,原件按同一个日子分目录。
			for (const id of doomed) await opts.repush?.drop(id, file.slice(0, 10));
		}
		return deleted;
	}

	function deleteRange(options: DeleteRangeOptions): Promise<number> {
		return writes.run(WRITE_KEY, () => deleteRangeSerialized(options));
	}

	async function clearSerialized(): Promise<void> {
		for (const name of await listDayFiles(opts.dataRoot)) {
			await rm(join(root, name), { force: true });
		}
		// 行没了:内存里「同一次推送还能追加」的那张表与刚补完的那一行都不能再指着它们,
		// 否则下一次 `record` 会往一个已经不存在的行后面追加。
		open.deleteWhere(() => true);
		hotRow = null;
		await rm(join(root, "repush"), { recursive: true, force: true });
	}

	function clear(): Promise<void> {
		return writes.run(WRITE_KEY, clearSerialized);
	}

	return {
		record,
		appendToRow,
		findRow,
		query,
		aggregateDaily,
		deleteRange,
		clear,
		close: () => writes.close(),
	};
}

const DAY_MS = 86_400_000;

function tryParse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** 整个文件的非空行,原样(不解析)。 */
/**
 * 整份读进来切行,**只**容忍「文件不在」。给要改写这份文件的那条路用:读不动就抛,
 * 让整趟停在动手之前。
 */
async function readAllLinesStrict(path: string): Promise<string[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		throw err;
	}
	return raw.split("\n").filter((line) => line.trim() !== "");
}

async function readRawLines(path: string): Promise<string[]> {
	const lines: string[] = [];
	try {
		const stream = createReadStream(path, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of rl) {
			if (line.trim()) lines.push(line);
		}
	} catch {
		// missing file is fine
	}
	return lines;
}

/** 补丁行的键序固定 `rowId` 打头(见 `applyPatch`),行首一眼认出,不用先 JSON.parse。迁移器认补丁行也用它。 */
export function isPatchLine(line: string): boolean {
	return line.startsWith('{"rowId":');
}

/**
 * 历史目录里的日文件名。目录还不在回空;**列不出来(不是「不在」)就抛** —— 图库的引用名单从这里起
 * (`retention.ts` 的 `listHistoryImageRefs`),把读错当成「一天都没有」,清扫会把还在用的图当垃圾删掉。
 */
export async function listDayFiles(dataRoot: string): Promise<string[]> {
	const root = dataPath(dataRoot, "history");
	let all: string[];
	try {
		all = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return all.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
}

/**
 * 一份日文件里所有行引用着的图库引用:每条消息的 `image`(本体行与补丁行都要数)和行的 `avatarSnapshot`。
 * 历史这一家引用方的名单(`retention.ts` 的 `listHistoryImageRefs`)用它。
 *
 * 🔴 **宁多勿少**:名单漏一张,清扫就把还在用的图当垃圾删了,而一切照常、门禁全绿。所以这里**不过 schema** ——
 * 一行因为别的格不合 schema 被读侧跳过,它引用的图照样算数,只认「形状对的引用字符串」。读不动文件(不是
 * 「文件不在」)就抛,清扫这一轮一张不删。
 */
export async function collectImageRefs(path: string): Promise<ImageRef[]> {
	const out: ImageRef[] = [];
	const take = (value: unknown) => {
		if (typeof value === "string" && IMAGE_REF_PATTERN.test(value)) out.push(value);
	};
	for (const line of await readAllLinesStrict(path)) {
		const record = tryParse(line);
		if (typeof record !== "object" || record === null) continue;
		const { messages, avatarSnapshot } = record as { messages?: unknown; avatarSnapshot?: unknown };
		take(avatarSnapshot);
		if (!Array.isArray(messages)) continue;
		for (const message of messages) {
			const payload = (message as { payload?: { image?: unknown } } | null)?.payload;
			take(payload?.image);
		}
	}
	return out;
}
