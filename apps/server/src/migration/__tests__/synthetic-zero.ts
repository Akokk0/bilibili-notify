/**
 * 合成的第 0 代:一个把 0.x 用满一年的重度用户(`migration-timing.test.ts` 的输入)。
 *
 * 摆的都是 0.x 最新的形状、而且是迁移器真的会读会改写的那几种:订阅带顶层 `uid` / `extensionId`,推送历史是
 * 一行一个目标一条消息的老行(`source` / `result` / `payload`),作品行带 B 站类型串,直播下播帧带字符串
 * 峰值,会话文件没有面孔那三格,界面皮肤的 css 带着旧清洗层烙进去的两句。摆成别的形状,迁移器那一步就没跑,
 * 耗时测的只是硬链接。
 *
 * 全部内容由下标决定,不用随机数:同一个 `scale` 摆出来的树逐字节相同,耗时的差别只来自机器。
 *
 * 造的是 **0.x 的盘**。0.x 用户的推送历史保留天数最多能调到 365,文字和图一起留,所以 0.x 的最坏情况是「365 天的历史 +
 * 每行一张图」,满量就按这个摆。每张历史图的内容各不相同(图库按摘要起名,内容一样的并成几张就量不到复制的开销)。迁移(⑳d)
 * 只把**保留期内**的行引用的图复制进图库(此刻取历史的最后一天、保留 30 天 → 最后 31 天,两档都留一样多),更早的行只是
 * 拿掉图格、不读图文件 —— 所以复制那一步的活儿**不随量涨**(满量与四分之一量都 31 天 × 120 张),比值里量不到它,看
 * 它的绝对秒数;随天数涨的是日文件的读写与拿掉图格。
 *
 * **每一块会涨的东西,四分之一量都严格是满量的 1/4**(缩法见下表),总活儿因此近似线性于 `scale`:
 *
 * - **每订阅一份的东西靠缩订阅数**(B 站 40 → 10、拓展 4 → 1):统计(作品、直播、在记)与粉丝文件的个数和行数,各订阅
 *   在历史里出现的行数。统计与粉丝的天数不缩,两档都是一整年(365 天,每订阅 52,560 个粉丝点)。
 * - **每天一份的东西靠缩天数**:推送历史的日文件、行、图、重推原件。满量 365 天,四分之一量 `round(365 × 0.25) = 91` 天;
 *   每天的量不缩(每天 120 行、每行一张图,每天 5 份重推原件)。
 * - 会话与聊天附件不挂订阅也不挂日期,按 `scale` 取整(50 → 12、100 → 25)。每张附件内容各不相同(图库按摘要
 *   并同样的图,内容一样就量不到)、各被一场会话的一条用户消息引用着(没人引用的附件迁移时不搬,不引用就没活儿):
 *   第 k 张挂在第 `k mod 会话数` 场的第 `2 × ⌊k ÷ 会话数⌋` 条消息上,两档都是每场 2 张上下,仍近似线性。
 * - 拓展订阅的头像随拓展订阅数缩(4 → 1):每个拓展订阅一份头像文件、内容各不相同(图库按摘要并同样的图),资料缓存里
 *   带着 0.x 的同源相对地址(`?v=` 是内容摘要)引用它,迁移时逐个复制进图库。B 站订阅的资料带远端网址的头像。
 * - 皮肤、女仆技能、拓展、素材这些零碎是固定的几份,几乎不占活儿。
 *
 * 订阅数和天数是两把不同的尺子,各缩一次,不能叠:订阅数乘 `scale` 同时天数也乘,体量就成了 1/16。为什么这样缩,是
 * 2026-10-02 三次实测换来的:
 *
 * 1. 订阅数、天数、每天行数三样都乘:体量成了 1/16 而不是 1/4,四分之一量只剩 1/15 的文件,干净的迁移比值 6.1,
 *    没出毛病也过不了判据。
 * 2. 只缩天数、订阅数不变:每订阅一个的统计 / 粉丝文件(那 44 个,迁每个都要读、写、fsync)成了不随量变的底座,
 *    占掉四分之一量的大半,干净比值掉到 1.3。
 * 3. 只缩订阅数、历史两档都是同样的天数:历史日文件(每个要复制、改写、各 fsync)成了底座,干净比值 2.1–2.5。
 *
 * | 项                           | scale 1  | scale 0.25 |
 * | ---------------------------- | -------- | ---------- |
 * | B 站订阅                     | 40       | 10         |
 * | 拓展订阅                     | 4        | 1          |
 * | 天数(统计、粉丝)           | 365      | 365        |
 * | 粉丝点 / 订阅(十分钟)       | 52,560   | 52,560     |
 * | 推送历史天数(日文件数)     | 365      | 91         |
 * | 推送历史每天行数(每行一图) | 120      | 120        |
 * | 每天重推原件                 | 5        | 5          |
 * | 女仆对话(每场 40 条)       | 50       | 12         |
 * | 聊天附件                     | 100      | 25         |
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zeroBiliRow, zeroExtensionRow } from "./zero-fixtures.js";

/** 统计与粉丝的天数:一整年(两档一样)。 */
export const FULL_YEAR_DAYS = 365;
/** 粉丝采样间隔(分钟)。 */
export const FOLLOWER_SAMPLE_MINUTES = 10;
/** 一个订阅的粉丝文件有多少行:每天 144 个点。 */
export const followerRowsPerSubscription = (days: number) =>
	(days * 24 * 60) / FOLLOWER_SAMPLE_MINUTES;

/**
 * **0.x** 推送历史保留天数的最大值:0.x 的设置里最多能调到 365,文字和图一起留。1.0 的新规则(文字不设上限、图片最多
 * 90 天)与这份 0.x 输入无关。
 */
export const ZERO_MAX_HISTORY_DAYS = 365;

/** 数据的第一天(UTC):2025-10-01,往后 365 天到 2026-09-30。 */
const START_MS = Date.UTC(2025, 9, 1);
const DAY_MS = 86_400_000;

/** 不随 `scale` 变的零碎份数。 */
const FIXED = { skins: 4, maidSkills: 6, cardBackgrounds: 6, fonts: 2 } as const;

/** 这一档摆多少:每一块会涨的东西随 `scale` 取 1/4,取法见文件头的表。 */
export interface SyntheticZeroPlan {
	scale: number;
	/** 统计与粉丝覆盖多少天:两档都是一整年。 */
	days: number;
	/** 推送历史摆多少天(日文件数):最近的 `round(365 × scale)` 天,最少 1、最多 365。 */
	historyDays: number;
	/**
	 * 0.x 的历史保留天数(`app.historyRetentionDays`),迁移照它定图留几天:满量 60、四分之一量 15,都是 1.0 的档位,
	 * 换算时原样留下。⑳d 起保留期内的历史图逐张复制进图库,这是迁移里最重的一步,所以它也得随量涨 ——
	 * 两档都用默认的 30 天时复制的张数一样多,比值掉到 1 点几,量不出越积越慢。
	 */
	historyRetentionDays: number;
	/** B 站订阅数:`floor(40 × scale)`,最少 1。 */
	subscriptions: number;
	/** 拓展订阅数:`floor(4 × scale)`,最少 1。 */
	extensionSubscriptions: number;
	/** 推送历史每天多少行(每行一张图):两档都是 120。 */
	historyRowsPerDay: number;
	/** 每天重推原件:两档都是 5。 */
	repushPerDay: number;
	conversations: number;
	attachments: number;
}

/** 乘完向下取整,最少一份(`40 × 0.25 → 10`、`4 × 0.25 → 1`、`50 × 0.25 → 12`、`100 × 0.25 → 25`)。 */
function scaled(full: number, scale: number): number {
	return Math.max(1, Math.floor(full * scale + 1e-9));
}

export function planSyntheticZero(scale: number): SyntheticZeroPlan {
	const days = FULL_YEAR_DAYS;
	return {
		scale,
		days,
		historyDays: Math.min(
			ZERO_MAX_HISTORY_DAYS,
			Math.max(1, Math.round(ZERO_MAX_HISTORY_DAYS * scale)),
		),
		historyRetentionDays: scaled(60, scale),
		subscriptions: scaled(40, scale),
		extensionSubscriptions: scaled(4, scale),
		historyRowsPerDay: 120,
		repushPerDay: 5,
		conversations: scaled(50, scale),
		attachments: scaled(100, scale),
	};
}

export interface SyntheticSubscription {
	id: string;
	uid: string;
}

/** 摆出来的树有多大、各族多少,以及测试要回头去找的几个名字。 */
export interface SyntheticZeroCounts {
	plan: SyntheticZeroPlan;
	/** 统计与粉丝覆盖的天数(同 `plan.days`)。 */
	days: number;
	/** 推送历史的天数,也是历史日文件数(同 `plan.historyDays`)。 */
	historyDays: number;
	/** 推送历史第一天与最后一天,`YYYY-MM-DD`。 */
	historyFirstDay: string;
	historyLastDay: string;
	/** 写下的普通文件数与字节数(逻辑大小)。 */
	files: number;
	bytes: number;
	/** 所有 jsonl 的行数。 */
	jsonlLines: number;
	historyRows: number;
	historyImages: number;
	repushSnapshots: number;
	followerFiles: number;
	/** 一个订阅的粉丝文件有多少行。 */
	followerRowsPerSubscription: number;
	/** 所有粉丝文件的总行数。 */
	followerRows: number;
	/** 作品行(B 站 + 拓展)。 */
	postRows: number;
	/** 直播帧(start + end,B 站 + 拓展)。 */
	liveFrames: number;
	/** 「在记」行:只有拓展订阅有。 */
	seenRows: number;
	conversations: number;
	conversationMessages: number;
	chatAttachments: number;
	skins: number;
	maidSkills: number;
	biliSubscriptions: SyntheticSubscription[];
	extensionSubscriptionIds: string[];
}

// ── 确定性的小工具 ─────────────────────────────────────────────────────────────────

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

/** 合法的 v4 形状 uuid(`z.uuid()` 认版本位与变体位):`ns` 分族,`n` 是族内下标。 */
const uuid = (ns: number, n: number) => `${hex(ns, 8)}-0000-4000-8000-${hex(n, 12)}`;

const NS = { bili: 1, ext: 2, connection: 3, target: 4, historyRow: 5 } as const;

/** 取第 `i` 个(下标绕回);空表直接抛,免得 `noUncheckedIndexedAccess` 逼出一串 `!`。 */
function pick<T>(list: readonly T[], i: number): T {
	const item = list[i % list.length];
	if (item === undefined) throw new Error("pick: 空表");
	return item;
}

const dayMs = (day: number) => START_MS + day * DAY_MS;
const dayName = (day: number) => new Date(dayMs(day)).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();

/** 同时最多 `limit` 个在跑。 */
async function pool<T>(
	items: Iterable<T>,
	limit: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	const iterator = items[Symbol.iterator]();
	await Promise.all(
		Array.from({ length: limit }, async () => {
			for (let next = iterator.next(); !next.done; next = iterator.next()) await run(next.value);
		}),
	);
}

function* range(count: number): Generator<number> {
	for (let i = 0; i < count; i += 1) yield i;
}

/** 摆文件的记账本:一份文件 = 一次 `put`,文件数、字节数、jsonl 行数都从这里出。 */
class Tree {
	files = 0;
	bytes = 0;
	jsonlLines = 0;
	private readonly dirs = new Set<string>();

	constructor(private readonly root: string) {}

	async put(rel: string, data: string | Uint8Array): Promise<void> {
		const path = join(this.root, rel);
		const dir = dirname(path);
		if (!this.dirs.has(dir)) {
			await mkdir(dir, { recursive: true });
			this.dirs.add(dir);
		}
		await writeFile(path, data);
		this.files += 1;
		this.bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
	}

	putJson(rel: string, value: unknown): Promise<void> {
		return this.put(rel, JSON.stringify(value));
	}

	/** 一份 jsonl:每行末尾带换行。 */
	putJsonl(rel: string, lines: readonly string[]): Promise<void> {
		this.jsonlLines += lines.length;
		return this.put(rel, `${lines.join("\n")}\n`);
	}
}

/** PNG 的 8 字节签名:图库按嗅探认格式,只看这个(解码不解码无所谓)。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 定长的假二进制(带个像样的文件头,内容无所谓)。`variant` 给了就写在文件头后面:同一个文件头、同样的长度,
 * 不同的 `variant` 是不同的内容 —— 图库按摘要起名,内容一样的图会并成一张。
 */
function fakeBinary(size: number, magic: string | Uint8Array, variant?: number): Buffer {
	const buffer = Buffer.alloc(size, 0x5a);
	const head = typeof magic === "string" ? Buffer.from(magic, "latin1") : magic;
	buffer.set(head, 0);
	if (variant !== undefined) buffer.writeUInt32BE(variant, head.length);
	return buffer;
}

/** 0.x 的聊天附件 id:32 位 hex + 后缀。 */
const attachmentId = (index: number) => `${hex(0xa7_7ac0 + index, 32)}.png`;

/** 第 `index` 个拓展订阅的头像字节:内容各不相同,迁移时各成图库里的一张。 */
const extensionAvatarBytes = (index: number) => fakeBinary(8192, PNG_SIGNATURE, 0xa0_0000 + index);

/** 0.x 资料缓存里拓展订阅头像的同源相对地址:`?v=` 取内容 sha256 的前 12 位。 */
const extensionAvatarAddress = (id: string, index: number) =>
	`/api/subs/${id}/avatar?v=${createHash("sha256").update(extensionAvatarBytes(index)).digest("hex").slice(0, 12)}`;

// ── 摆树 ────────────────────────────────────────────────────────────────────────

/**
 * 往 `zeroRoot` 摆一棵第 0 代的树(宿主根就是它:0.x 的文件直接在根上)。回树的大小与各族的数量。
 * 目录不在会建;摆在已有东西的目录里就和它们混在一起,调用方给个新的空目录。
 */
export async function placeSyntheticZero(
	zeroRoot: string,
	scale: number,
): Promise<SyntheticZeroCounts> {
	const plan = planSyntheticZero(scale);
	const tree = new Tree(zeroRoot);

	const biliSubscriptions: SyntheticSubscription[] = Array.from(
		{ length: plan.subscriptions },
		(_, i) => ({ id: uuid(NS.bili, i + 1), uid: String(10_000_000 + (i + 1) * 104_729) }),
	);
	const extensionSubscriptionIds = Array.from({ length: plan.extensionSubscriptions }, (_, i) =>
		uuid(NS.ext, i + 1),
	);
	const connectionIds = [uuid(NS.connection, 1), uuid(NS.connection, 2)];
	const targetIds = [uuid(NS.target, 1), uuid(NS.target, 2), uuid(NS.target, 3)];

	await placeState(
		tree,
		plan,
		biliSubscriptions,
		extensionSubscriptionIds,
		connectionIds,
		targetIds,
	);
	await placeSecrets(tree);
	const history = await placeHistory(tree, plan, biliSubscriptions, targetIds);
	const stats = await placeStats(tree, plan.days, biliSubscriptions, extensionSubscriptionIds);
	const followerRows = await placeFollowers(
		tree,
		plan.days,
		biliSubscriptions,
		extensionSubscriptionIds,
	);
	const conversations = await placeConversations(tree, plan);
	await placeLooseThings(tree, extensionSubscriptionIds);

	return {
		plan,
		days: plan.days,
		historyDays: plan.historyDays,
		historyFirstDay: dayName(plan.days - plan.historyDays),
		historyLastDay: dayName(plan.days - 1),
		files: tree.files,
		bytes: tree.bytes,
		jsonlLines: tree.jsonlLines,
		...history,
		...stats,
		followerFiles: biliSubscriptions.length + extensionSubscriptionIds.length,
		followerRowsPerSubscription: followerRowsPerSubscription(plan.days),
		followerRows,
		...conversations,
		chatAttachments: plan.attachments,
		skins: FIXED.skins,
		maidSkills: FIXED.maidSkills,
		biliSubscriptions,
		extensionSubscriptionIds,
	};
}

/** `state/`:设置、两份订阅、连接、目标,和程序自己记的小状态。 */
async function placeState(
	tree: Tree,
	plan: SyntheticZeroPlan,
	bili: readonly SyntheticSubscription[],
	extensionIds: readonly string[],
	connectionIds: readonly string[],
	targetIds: readonly string[],
): Promise<void> {
	await tree.putJson("state/globals.json", {
		app: {
			logLevel: "info",
			dynamicCron: "*/2 * * * *",
			healthCheckMinutes: 30,
			historyRetentionDays: plan.historyRetentionDays,
		},
		extensions: { "dev-bridge": { enabled: true, settings: { token: "synthetic-token" } } },
		defaults: {
			features: { liveEnd: true, liveEndExtras: { wordcloud: true, liveSummary: true } },
			ai: { apiKey: "sk-synthetic", baseUrl: "https://api.example.com", model: "m" },
			templates: { liveEnd: "{name} 下播了，直播时长 {duration}" },
		},
		linkParsing: {
			enabled: true,
			scope: "selected",
			targets: [{ targetId: pick(targetIds, 0) }],
		},
	});

	// B 站订阅:每四条里有一条是第一代 routing(词云 / 总结各一份目标)+ 订阅上的 @全体,让整行迁移真的跑;
	// 其余是最新形状。一部分带着主人起的别名(1.0 退役,迁移时丢)。
	await tree.putJson(
		"state/subscriptions.json",
		bili.map((sub, i) => {
			const row = zeroBiliRow({ id: sub.id, uid: sub.uid });
			const target = pick(targetIds, i);
			const routing = {
				...(row.routing as Record<string, unknown>),
				dynamic: [target],
				live: [target, pick(targetIds, i + 1)],
				liveEnd: [target],
			};
			const named = i % 3 === 0 ? { name: `UP 主 ${i + 1}` } : {};
			return i % 4 === 0
				? {
						...row,
						...named,
						routing: { ...routing, wordcloud: [target], liveSummary: [] },
						atAll: { live: { [target]: true } },
						atAllDefaults: { dynamic: false, live: false },
					}
				: { ...row, ...named, routing };
		}),
	);
	await tree.putJson(
		"state/extension-subscriptions.json",
		extensionIds.map((id, i) =>
			zeroExtensionRow({
				id,
				extensionId: pick(EXTENSION_IDS, i),
				externalId: `sec-uid-${i + 1}`,
			}),
		),
	);

	await tree.putJson(
		"state/connections.json",
		connectionIds.map((id, i) => ({
			id,
			name: `NapCat ${i + 1}`,
			enabled: true,
			platform: "onebot",
			config: { transport: "http", baseUrl: `http://127.0.0.1:${3000 + i}` },
		})),
	);
	await tree.putJson(
		"state/targets.json",
		targetIds.map((id, i) => ({
			id,
			name: `群 ${i + 1}`,
			adapterId: pick(connectionIds, i),
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: String(100_000 + i) },
		})),
	);

	// 资料缓存:每个订阅一份资料。拓展订阅的头像是同源相对地址(引用 `avatars/` 里那个文件),B 站的是远端网址。
	await tree.putJson(
		"state/sub-runtime.json",
		Object.fromEntries([
			...bili.map((sub, i) => [
				sub.id,
				{
					cachedProfile: {
						name: `B 站 UP ${i + 1}`,
						avatar: `https://i0.hdslb.com/bfs/face/${hex(0xface_0000 + i, 16)}.jpg`,
						sign: "",
						fans: 1000 + i,
						lastRefreshedAt: iso(START_MS),
					},
					roomId: String(21_000_000 + i),
					followed: true,
				},
			]),
			...extensionIds.map((id, i) => [
				id,
				{
					cachedProfile: {
						name: `拓展 UP ${i + 1}`,
						avatar: extensionAvatarAddress(id, i),
						sign: "",
						lastRefreshedAt: iso(START_MS),
					},
					roomId: String(21_000_100 + i),
					followed: true,
				},
			]),
		]),
	);
	// 0.x 按 uid 回指的待审草稿:前三位 UP 各一份。
	await tree.putJson(
		"state/roast-drafts.json",
		bili.slice(0, 3).map((sub, i) => ({
			id: hex(0xab + i, 2),
			kind: "solo",
			uid: sub.uid,
			days: 7,
			targets: [pick(targetIds, i)],
			result: { uid: sub.uid, text: "锐评" },
			createdAt: iso(dayMs(plan.days - 2)),
			expiresAt: iso(dayMs(plan.days)),
		})),
	);
}

const EXTENSION_IDS = ["douyin", "kuaishou", "weibo", "xiaohongshu"] as const;

/** `secrets/`:照 0.x 的夹具,袋子是个解不开的 `enc`(迁移器遇到解不开的原样留着)。 */
async function placeSecrets(tree: Tree): Promise<void> {
	await tree.put("secrets/master.key", "ab".repeat(32));
	await tree.put("secrets/kdf.salt", "cd".repeat(16));
	await tree.put("secrets/config-secrets.enc", "enc");
	await tree.put("secrets/cookies.json", "{}");
}

const HISTORY_SOURCES = [
	"dynamic",
	"live",
	"live-summary",
	"sc",
	"guard",
	"special-danmaku",
	"special-enter",
] as const;

/** 推送历史:每天一个 jsonl(老行)、每行一张图、每天几份重推原件。 */
async function placeHistory(
	tree: Tree,
	plan: SyntheticZeroPlan,
	bili: readonly SyntheticSubscription[],
	targetIds: readonly string[],
): Promise<{ historyRows: number; historyImages: number; repushSnapshots: number }> {
	const perDay = plan.historyRowsPerDay;
	// 历史只摆最近 `historyDays` 天;`h` 是这一段里的第几天,`day` 是它在整段数据里的序号。
	const firstDay = plan.days - plan.historyDays;
	const imageSizes = [2048, 2560, 3072, 3584, 4096];
	const rowId = (h: number, r: number) => uuid(NS.historyRow, h * perDay + r + 1);

	for (let h = 0; h < plan.historyDays; h += 1) {
		const day = firstDay + h;
		const lines: string[] = [];
		for (let r = 0; r < perDay; r += 1) {
			const n = h * perDay + r;
			const sub = pick(bili, n);
			const target = pick(targetIds, n);
			const id = rowId(h, r);
			const ok = n % 17 !== 0;
			lines.push(
				JSON.stringify({
					id,
					ts: iso(dayMs(day) + Math.floor((r * DAY_MS) / perDay)),
					source: pick(HISTORY_SOURCES, n),
					uid: sub.uid,
					subscriptionId: sub.id,
					targetIds: [target],
					result: {
						ok,
						per: [
							{
								targetId: target,
								ok,
								latencyMs: 40 + (n % 300),
								...(ok ? {} : { err: "send failed: 网络超时" }),
							},
						],
					},
					payload: { kind: "image", imageRef: `${id}-0.png`, text: `第 ${n + 1} 条推送` },
					unameSnapshot: `UP 主 ${(n % bili.length) + 1}`,
					uavatarSnapshot: `https://i0.hdslb.com/bfs/face/${hex(n, 16)}.jpg`,
				}),
			);
		}
		await tree.putJsonl(`history/${dayName(day)}.jsonl`, lines);
	}

	// 图:每行一张,几 KB,**每张内容各不相同**(图库按摘要起名,内容一样的图会并成几张,量不到复制的开销)。
	// 迁移只复制保留期内的那一小段(两档一样多),其余的行拿掉图格、不读文件。
	await pool(range(plan.historyDays * perDay), 96, (n) => {
		const h = Math.floor(n / perDay);
		return tree.put(
			`history/img/${rowId(h, n % perDay)}-0.png`,
			fakeBinary(pick(imageSizes, n), PNG_SIGNATURE, 0xb0_0000 + n),
		);
	});

	// 重推原件:`history/repush/<日>/<行 id>.json`,0.x 盘上就是 `{ v, messages }` 这两格(⑱c 起迁成 `version`)。
	for (let h = 0; h < plan.historyDays; h += 1) {
		const day = firstDay + h;
		for (let k = 0; k < plan.repushPerDay; k += 1) {
			const id = rowId(h, k);
			await tree.putJson(`history/repush/${dayName(day)}/${id}.json`, {
				v: 1,
				messages: [
					{
						payload: { kind: "image", image: { ref: `${id}-0.png`, mime: "image/png" } },
						role: "main",
					},
				],
			});
		}
	}

	return {
		historyRows: plan.historyDays * perDay,
		historyImages: plan.historyDays * perDay,
		repushSnapshots: plan.historyDays * plan.repushPerDay,
	};
}

const BILI_POST_TYPES = [
	"DYNAMIC_TYPE_AV",
	"DYNAMIC_TYPE_DRAW",
	"DYNAMIC_TYPE_WORD",
	"DYNAMIC_TYPE_FORWARD",
	"DYNAMIC_TYPE_LIVE_RCMD",
] as const;
const NEUTRAL_POST_KINDS = ["video", "post", "post", "live"] as const;
const BILI_PEAKS = ["856", "1.2万", "3.4万", "9500", "12.5万"] as const;
const POSTS_PER_DAY = 2;

/** 数据统计:作品、直播、「在记」。B 站按 uid 命名、老行;拓展按订阅 id 命名、已经是最新的行。 */
async function placeStats(
	tree: Tree,
	days: number,
	bili: readonly SyntheticSubscription[],
	extensionIds: readonly string[],
): Promise<{ postRows: number; liveFrames: number; seenRows: number }> {
	let postRows = 0;
	let liveFrames = 0;
	let seenRows = 0;

	/** 一年的直播:一周三场(周一、三、五晚上),每场一对 start / end 帧。 */
	const liveFramesOf = (index: number, peakOf: (session: number) => string | number): string[] => {
		const frames: string[] = [];
		let session = 0;
		for (let day = 0; day < days; day += 1) {
			const weekday = new Date(dayMs(day)).getUTCDay();
			if (weekday !== 1 && weekday !== 3 && weekday !== 5) continue;
			const start = dayMs(day) + (19 + (index % 4)) * 3_600_000;
			const end = start + 2 * 3_600_000 + (day % 3) * 1_800_000;
			frames.push(JSON.stringify({ k: "start", ts: iso(start) }));
			frames.push(JSON.stringify({ k: "end", ts: iso(end), peak: peakOf(session) }));
			session += 1;
		}
		return frames;
	};
	const postIds = (index: number, day: number, k: number) =>
		`9${String((index * 1000 + day) * POSTS_PER_DAY + k).padStart(17, "0")}`;
	const postTime = (index: number, day: number, k: number) =>
		dayMs(day) + (8 + k * 6) * 3_600_000 + (index % 60) * 60_000;

	for (const [index, sub] of bili.entries()) {
		const dyn: string[] = [];
		for (let day = 0; day < days; day += 1) {
			for (let k = 0; k < POSTS_PER_DAY; k += 1) {
				dyn.push(
					JSON.stringify({
						id: postIds(index, day, k),
						type: pick(BILI_POST_TYPES, index + day + k),
						ts: iso(postTime(index, day, k)),
					}),
				);
			}
		}
		const live = liveFramesOf(index, (session) => pick(BILI_PEAKS, session));
		await tree.putJsonl(`stats/dyn/${sub.uid}.jsonl`, dyn);
		await tree.putJsonl(`stats/live/${sub.uid}.jsonl`, live);
		postRows += dyn.length;
		liveFrames += live.length;
	}

	for (const [index, id] of extensionIds.entries()) {
		const dyn: string[] = [];
		const seen: string[] = [];
		for (let day = 0; day < days; day += 1) {
			for (let k = 0; k < POSTS_PER_DAY; k += 1) {
				dyn.push(
					JSON.stringify({
						id: `ext-${index}-${day}-${k}`,
						kind: pick(NEUTRAL_POST_KINDS, index + day + k),
						ts: iso(postTime(index, day, k)),
					}),
				);
			}
			seen.push(JSON.stringify({ ts: iso(dayMs(day) + 12 * 3_600_000) }));
		}
		const live = liveFramesOf(index, (session) => 800 + ((session * 37) % 9000));
		await tree.putJsonl(`stats/dyn/${id}.jsonl`, dyn);
		await tree.putJsonl(`stats/live/${id}.jsonl`, live);
		await tree.putJsonl(`stats/seen/${id}.jsonl`, seen);
		postRows += dyn.length;
		liveFrames += live.length;
		seenRows += seen.length;
	}

	await tree.put("stats/since", dayName(0));
	return { postRows, liveFrames, seenRows };
}

/** 粉丝时序:每个订阅一个文件,十分钟一个点、覆盖全部天数(B 站的按 uid 命名)。回总行数。 */
async function placeFollowers(
	tree: Tree,
	days: number,
	bili: readonly SyntheticSubscription[],
	extensionIds: readonly string[],
): Promise<number> {
	const rowsPerFile = followerRowsPerSubscription(days);
	const keys = [...bili.map((s) => s.uid), ...extensionIds];
	const stepMs = FOLLOWER_SAMPLE_MINUTES * 60_000;
	await pool(keys.entries(), 4, async ([index, key]) => {
		const lines = new Array<string>(rowsPerFile);
		const base = 100_000 + index * 5_000;
		for (let i = 0; i < rowsPerFile; i += 1) {
			const value = base + Math.floor(i / 12) + (i % 5);
			lines[i] = `{"ts":"${iso(START_MS + i * stepMs)}","value":${value}}`;
		}
		await tree.putJsonl(`fans/${key}.jsonl`, lines);
	});
	return keys.length * rowsPerFile;
}

const MESSAGES_PER_CONVERSATION = 40;

/** 女仆对话(0.x 早期的会话:没有面孔那三格)和聊天附件。 */
async function placeConversations(
	tree: Tree,
	plan: SyntheticZeroPlan,
): Promise<{ conversations: number; conversationMessages: number }> {
	for (let i = 0; i < plan.conversations; i += 1) {
		const id = `conv-${String(i + 1).padStart(3, "0")}`;
		const started = dayMs((i * 7) % Math.max(1, plan.days - 1));
		const messages = Array.from({ length: MESSAGES_PER_CONVERSATION }, (_, m) => {
			const assistant = m % 2 === 1;
			// 附件挂在用户消息(偶数条)上,一条一张,轮着把 `plan.attachments` 张分给各场会话。
			const attached = assistant ? plan.attachments : (m / 2) * plan.conversations + i;
			return {
				id: `${id}-m${m}`,
				role: assistant ? "assistant" : "user",
				content:
					`${assistant ? "好的主人，" : "帮我看看"}第 ${i + 1} 场对话的第 ${m + 1} 条。`.repeat(
						4 + (m % 5),
					),
				ts: iso(started + m * 60_000),
				// 每五场里有一场用过做皮肤的工具,每七场里有一场的回复碰过卡片皮肤。
				...(attached < plan.attachments ? { images: [attachmentId(attached)] } : {}),
				...(assistant && m === 1 && i % 5 === 0
					? { tools: [{ name: "create_skin", args: {}, ok: true }] }
					: {}),
				...(assistant && m === 3 && i % 7 === 0 ? { cardSkins: ["card-1"] } : {}),
			};
		});
		await tree.putJson(`ai/chat/${id}.json`, {
			id,
			title: `第 ${i + 1} 场对话`,
			createdAt: iso(started),
			updatedAt: iso(started + MESSAGES_PER_CONVERSATION * 60_000),
			messages,
			...(i % 7 === 0 ? { cardSkinLedger: { "card-1": { touched: true } } } : {}),
		});
	}

	await pool(range(plan.attachments), 32, (i) =>
		tree.put(`assets/chat/${attachmentId(i)}`, fakeBinary(24_576, PNG_SIGNATURE, i + 1)),
	);
	return {
		conversations: plan.conversations,
		conversationMessages: plan.conversations * MESSAGES_PER_CONVERSATION,
	};
}

/** 皮肤、女仆技能、拓展、素材、头像、游标:固定的几份,不随 `scale` 变。 */
async function placeLooseThings(tree: Tree, extensionIds: readonly string[]): Promise<void> {
	// 界面皮肤:css 上带着 v0.7.0 及之前清洗层烙进去的两句;0.x 的单指针指着第一套。
	const css = Array.from(
		{ length: 120 },
		(_, i) => `.card-${i}{color:#${hex(0x100000 + i * 997, 6)};padding:${i % 12}px}`,
	).join("\n");
	for (let i = 1; i <= FIXED.skins; i += 1) {
		const mode = { css: `${css}\n.x::before{content:"";pointer-events:none;z-index:-1}` };
		await tree.putJson(`skins/skin-${i}/skin.json`, {
			name: `皮肤 ${i}`,
			modes: i === 1 ? { light: mode } : { light: mode, dark: mode },
		});
	}
	await tree.put("skins/active.json", '{"id":"skin-1"}');

	for (let i = 1; i <= FIXED.maidSkills; i += 1) {
		await tree.put(
			`maid-skills/skill-${i}/SKILL.md`,
			`# 技能 ${i}\n\n${"每天早上先看一遍订阅的动态，再决定要不要提醒主人。\n".repeat(20)}`,
		);
	}

	await tree.put("extensions/probe/extension.json", '{"id":"probe","version":"1.0.0"}');
	await tree.put(
		"extensions/probe/index.mjs",
		`export const probe = ${JSON.stringify("x".repeat(4096))}`,
	);
	await tree.put("extensions/load-state.json", "{}");
	await tree.put("extensions/.marketplace.json", "{}");

	for (let i = 1; i <= FIXED.cardBackgrounds; i += 1) {
		await tree.put(
			`assets/card-bg/${hex(0x1000_0000 + i, 8)}.png`,
			fakeBinary(61_440, PNG_SIGNATURE),
		);
	}
	await tree.put("assets/font/index.json", "{}");
	for (let i = 1; i <= FIXED.fonts; i += 1) {
		await tree.put(`assets/font/f${i}.woff2`, fakeBinary(51_200, "wOF2"));
	}
	for (const [i, id] of extensionIds.entries())
		await tree.put(`avatars/${id}.png`, extensionAvatarBytes(i));
	await tree.put("card-bg-cursors.json", '{"cursor":3}');
}
