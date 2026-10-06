import type {
	StatsOverviewResponse,
	StatsRoastPushResponse,
	StatsRoastResponse,
	StatsRoastRunNowResponse,
	StatsSoloRoastResponse,
	UpStatsRow,
} from "@bilibili-notify/contract";
import {
	BILIBILI_SOURCE_KEY,
	fail,
	issuesFromZod,
	ok,
	ROAST_MAX_DAYS,
	ROAST_MIN_DAYS,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { RoastRunOutcome } from "../runtime/roast-scheduler.js";
import {
	countPosts,
	dailyActivityCounts,
	dailyFansSeries,
	recordingDays,
	summarizeLiveSessions,
	windowSinceIso,
} from "../stats/aggregate.js";
import { statsFileKey } from "../stats/file-key.js";
import { deliverRoast } from "../stats/roast-deliver.js";
import {
	generateBoardRoast,
	generateSoloRoast,
	type OverviewFetcher,
} from "../stats/roast-generate.js";
import { ENGINES_NOT_READY_MESSAGE, respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/** 这条订阅订的是 B 站吗 —— 统计页两支的取数各算各的(ADR-0020 决策 9),分岔都看身份的来源。 */
const fromBilibili = (sub: Subscription): boolean =>
	subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY;

/**
 * `GET /api/stats/overview?days=30&tz=-480` —— 数据统计 Tab 的唯一数据源。
 *
 * 一次性返回每位订阅 UP 的完整行(含每日净增序列),前端的对比表、KPI、
 * 热力图、雷达、单 UP 钻取全部由它派生 —— 不做 per-UP 的第二个端点,免得
 * 切换 UP 时打一串瀑布请求。
 *
 * **窗口 clamp 到 1..90 天**:再长也没意义(history 侧默认只留 30 天),而且
 * 每多一天就多扫一天的 fans 采样。
 */

// 单一来源:定时锐评的 schema 校验用的是同一对边界(见 internal 的 constants),
// 在这儿另立一份的话,两条路对「90 天」的理解迟早会漂开。
const MIN_DAYS = ROAST_MIN_DAYS;
const MAX_DAYS = ROAST_MAX_DAYS;
/**
 * overview 结果的短 TTL 缓存。fans 采样每 ~2min 才动一次,而单次 overview 要
 * 逐 UP 流式扫 N 天的 jsonl(30 天 × 2min × 10 个 UP ≈ 20 万行),不缓存的话
 * 用户在页面上切一下时间范围就会把磁盘扫穿。TTL 取 30s:比采样周期短,所以
 * 用户永远看不到「明明刷新了却还是旧数」。
 */
const CACHE_TTL_MS = 30_000;
/**
 * 缓存条目数上限。
 *
 * 键是 `days:tz`,而 days ∈ 1..90、tz ∈ ±840,组合空间约 15 万种,每份都装着
 * 全部 UP 的整段序列。只靠 TTL 不设上限的话,换着参数刷就能在 30s 内把它们
 * 全塞进来 —— 独立端 Docker 镜像的堆上限只有 512MB,顶得爆。
 *
 * 正常用法(一个时区 × 三个档位)只占个位数,32 已经宽裕得多。
 */
export const MAX_CACHE_ENTRIES = 32;

interface CacheEntry {
	at: number;
	payload: StatsOverviewResponse;
}

function clampDays(raw: string | undefined): number {
	const n = Number(raw ?? 30);
	if (!Number.isFinite(n)) return 30;
	return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.trunc(n)));
}

function parseTz(raw: string | undefined): number {
	const n = Number(raw ?? 0);
	// getTimezoneOffset() 的合法范围是 ±840 分钟(UTC-14..+14)。
	return Number.isFinite(n) && Math.abs(n) <= 840 ? Math.trunc(n) : 0;
}

/** ISO 时间串里最晚的一个;空数组返回 null。同长度的 ISO 串按字典序比较即时序。 */
function maxIso(values: readonly string[]): string | null {
	let out: string | null = null;
	for (const v of values) if (out === null || v > out) out = v;
	return out;
}

/** 取序列末 n 天的净增合计。全为 null(无记录)时返回 null 而不是 0。 */
function sumTail(series: Array<number | null>, n: number): number | null {
	const tail = series.slice(-n);
	let sum = 0;
	let seen = false;
	for (const v of tail) {
		if (v === null) continue;
		sum += v;
		seen = true;
	}
	return seen ? sum : null;
}

/**
 * `/overview` 的取数函数:入参是**已经校验过的**天数与时区偏移(范围与出错响应归路由层:`clampDays` /
 * `parseTz`),出参就是响应体。读盘 / 读仓抛错就原样抛出来:路由那头交给全局出错处理,锐评那头经
 * {@link roastOverviewFetcher} 收成 `null`。
 */
export type StatsOverviewReader = (
	days: number,
	tzOffsetMin: number,
) => Promise<StatsOverviewResponse>;

/** 取数只读这两样,不牵整份 RouteDeps(定时锐评的调度器手里就只有它们)。 */
export type StatsOverviewDeps = Pick<RouteDeps, "runtime" | "store">;

/**
 * 建一个取数函数,**路由与两处锐评(手动、定时)共用它**。短 TTL 缓存挂在返回函数的闭包里,所以走它的人
 * (面板、手动锐评、定时锐评)吃的是同一份缓存;要共用就得是同一个实例 —— `index.ts` 建一个、同时交给调度器与
 * `createApp`。
 */
export function createStatsOverview(deps: StatsOverviewDeps): StatsOverviewReader {
	const cache = new Map<string, CacheEntry>();

	return async (days, tzOffsetMin) => {
		// 两支订阅都列(ADR-0020):停用的照样列 —— 统计页看的是「他这段时间做了什么」;拓展没在跑的
		// 也照样列,它仍是一条订阅。行的顺序跟着订阅列表走。
		const subs = deps.store.getSubscriptions();
		// 以下是**内存快照**,不经 jsonl —— 也就是说它们跟 TTL 没有半点关系,
		// 必须自己进 key(见下方 key 的说明)。放在缓存查询之前取。
		//
		// 在播:B 站认引擎(唯一权威);拓展认场次模块手里有没有这一场(盘上那一场的帧就是它发的)。
		const liveUids = new Set(
			(deps.runtime.engines?.listLiveRooms() ?? []).filter((r) => r.isLive).map((r) => r.uid),
		);
		const isLive = (sub: Subscription): boolean =>
			fromBilibili(sub)
				? liveUids.has(subscriptionIdentityOf(sub).externalId)
				: deps.runtime.engines?.extensionLiveSession(sub.id) !== undefined;
		// 此刻的粉丝数:B 站取粉丝轮询的快照(比 jsonl 末行新,只含启用着的);拓展取它最近报的资料
		// (决策 8,每报一次就更新,比稀释过的样本新)—— 只认启用着的,同 B 站的快照:停用的曲线停了,
		// 右端点不该再往前走。两边没有就回退到样本末值(见成行那里)。
		// 粉丝轮询的快照按订阅 id 记(一条订阅一行)。拓展的那几行它也有,可这里取资料缓存更直接(同一个数)。
		const fansBySub = new Map(
			(deps.runtime.fansPoller?.getLastEntries() ?? []).map((e) => [e.subscriptionId, e]),
		);
		const currentFans = (sub: Subscription): number | undefined =>
			fromBilibili(sub)
				? fansBySub.get(sub.id)?.current
				: sub.enabled
					? deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.fans
					: undefined;
		const liveNow = subs.map(isLive);
		const fansNow = subs.map(currentFans);
		// key 必须覆盖**响应里所有会变的输入**,否则缓存就在替页面撒谎。
		//
		// 订阅集合:退订后 recorder 已经 `drop` 物理删掉了那位 UP 的 jsonl,前端
		// 却还能从缓存里读到他一整行(数据背后的文件已不存在);刚加的订阅同理要等
		// 满 TTL 才出现。按订阅 id 记(行的键,两支都有)。不排序 —— rows 的顺序就跟着
		// subs 走,顺序变了输出也变。
		//
		// 在播状态 / 当前粉丝:两者都被原样嵌进响应,却都不来自被 TTL 兜住的 jsonl。
		// 漏掉在播状态的话,UP 一开播,统计页最长 30 秒仍报 live:false,而同一屏的
		// 「正在直播」面板走 WS 实时喂、早就亮了 —— 两块面板互相打脸,点刷新也没用。
		// 拓展行的这两样(场次模块、资料缓存)同理。
		const liveKey = subs
			.filter((_, i) => liveNow[i])
			.map((s) => s.id)
			.sort()
			.join(",");
		const fansKey = fansNow.map((v) => v ?? "").join(",");
		const key = `${days}:${tzOffsetMin}:${subs.map((s) => s.id).join(",")}|${liveKey}|${fansKey}`;

		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
			return hit.payload;
		}

		// 窗口起点对齐**本地日边界**,与页面上按本地日分桶的每一条序列同一把尺子
		// (详见 windowSinceIso)。用滚动的 N×24 小时会让合计数多吃进日轴从未画过的
		// 那小半天,KPI 与紧挨着它的热力图对不上。
		const since = windowSinceIso(days, tzOffsetMin);
		const sinceMs = Date.parse(since);

		// 每位订阅的原始序列与「在记」账。「那天有没有记录」只看账(ADR-0027 决策 13),不再拿粉丝样本并集、
		// 拓展的上报证据或采集水位线去猜。
		const perSub = await Promise.all(
			subs.map(async (sub, index) => {
				// 各个仓都按订阅 id 分文件(ADR-0020 决策 2 的 🔗 / 16);老的 uid 文件开机时已迁过来。
				const key = statsFileKey(sub);
				const [samples, events, sessions, ledger] = await Promise.all([
					deps.runtime.fansStore.listSamplesSince(key, since),
					deps.runtime.statsStore.listPosts(key, since),
					deps.runtime.statsStore.listLiveSessions(key, since),
					deps.runtime.statsStore.listRecording(key, since),
				]);
				return {
					sub,
					samples,
					events,
					sessions,
					ledger,
					live: liveNow[index] === true,
					followers: fansNow[index],
				};
			}),
		);

		const rows = perSub.map((one): UpStatsRow => {
			const { sub, samples, events, sessions, ledger } = one;
			const identity = subscriptionIdentityOf(sub);
			const daily = dailyFansSeries(samples, { days, tzOffsetMin });
			const series = daily.map((p) => p.net);
			// 三项各自在窗口里每天在不在记。
			const recording = {
				posts: recordingDays(ledger, "posts", { days, tzOffsetMin }),
				live: recordingDays(ledger, "live", { days, tzOffsetMin }),
				followers: recordingDays(ledger, "followers", { days, tzOffsetMin }),
			};
			const postsRecorded = recording.posts.some(Boolean);
			const liveRecorded = recording.live.some(Boolean);
			// 计数、场次、峰值两支同一套聚合。每天的活动 = 那天在记的那几项的计数之和;两项都没在记就是「无记录」。
			const dayCounts = dailyActivityCounts(events, sessions, { days, tzOffsetMin });
			const activity = dayCounts.posts.map((postCount, i) => {
				const postsOn = recording.posts[i] === true;
				const liveOn = recording.live[i] === true;
				if (!postsOn && !liveOn) return null;
				return (postsOn ? postCount : 0) + (liveOn ? (dayCounts.live[i] ?? 0) : 0);
			});
			const counts = countPosts(events);
			// 在播状态来自引擎(唯一权威;拓展是场次模块),用来区分「这场正在播」与「end 帧丢了」。
			const live = summarizeLiveSessions(sessions, { isLive: one.live, sinceMs });

			// 最后活动 = 最近一条作品 与 最近一次开播 里更晚的那个。两者都没有
			// 就是 null —— 这正是设计稿「鸽子榜」要的信号,不能拿窗口起点顶替。
			//
			// 开播公告不再记(ADR-0027):没开直播类推送的 UP 不记场次,他开过播也留不下痕迹。
			//
			// 作品取**最大发布时刻** 而不是末元素:`listPosts` 的契约是「按落盘顺序」
			// = 检测顺序,而 B 站动态流按惯例最新在前,一轮里检测到多条时末元素
			// 反而是最旧的那条。直播那侧同样按 startedAt 取:`listLiveSessions` 返回的是
			// 「首次出现顺序」,而场次按 startedAt 认,被重新打开的早场次未必排在末尾。
			const lastDynamic = maxIso(events.map((e) => e.publishedAt));
			const lastLive = maxIso(sessions.map((s) => s.startedAt));
			const lastActivityAt =
				lastDynamic && lastLive
					? lastDynamic > lastLive
						? lastDynamic
						: lastLive
					: (lastDynamic ?? lastLive);

			return {
				// 键是订阅 id,身份随行带着(ADR-0020 决策 1 的 🔗 / 18,同推送历史)。
				subscriptionId: sub.id,
				identity,
				// 当前粉丝优先用内存里的最新值(B 站的轮询快照 / 拓展的资料),它比 jsonl 末行更新;
				// 没有(轮询还没起来、停用了、拓展还没报过)时回退到采样末值。
				followers: one.followers ?? samples.at(-1)?.followers ?? null,
				net1d: sumTail(series, 1),
				// 窗口装不下 7 天就没法给出 7 天口径 —— 拿 3 天的和冒充 7 天更糟。
				net7d: days >= 7 ? sumTail(series, 7) : null,
				netWindow: sumTail(series, days),
				series,
				cumulative: daily.map((p) => p.value),
				activity,
				recording,
				// 「没记录」看账:窗口里这一项一天都没在记时,这些计数不是 0 而是「不知道」。
				// 0 会被读成「这位 UP 什么都没发」,而热力图同一行正画着一片「无记录」—— 两个数在一屏里互相打脸。
				videoPosts: postsRecorded ? counts.videoPosts : null,
				posts: postsRecorded ? counts.posts : null,
				liveSessions: liveRecorded ? live.sessions : null,
				liveHours: liveRecorded ? live.hours : null,
				liveTimedSessions: liveRecorded ? live.timedSessions : null,
				// 每场的数是本场累计观看,所以这两格叫单场最高 / 场均观看(决策 7 / 18)。
				maxViewers: liveRecorded ? live.maxViewers : null,
				avgViewers: liveRecorded ? live.avgViewers : null,
				lastActivityAt,
				live: one.live,
			};
		});

		const payload: StatsOverviewResponse = { days, rows };
		const at = Date.now();
		// 先清过期条目(稳态下这就够了),再按插入序挤掉最旧的顶住上限 ——
		// Map 的迭代序就是插入序,`keys().next()` 拿到的即最早那条。
		for (const [k, v] of cache) if (at - v.at >= CACHE_TTL_MS) cache.delete(k);
		cache.set(key, { at, payload });
		while (cache.size > MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next();
			if (oldest.done) break;
			cache.delete(oldest.value);
		}
		return payload;
	};
}

/**
 * 两处锐评要的取数:把 {@link StatsOverviewReader} 收成「失败是 `null`」的 {@link OverviewFetcher},由生成那头翻成
 * 一条可读的失败(`overview-failed`)。
 *
 * 抛出来的是 bug 或盘坏了:原话进错误日志(logger 现取,只有抛错时才用得上),调用方只拿到 `null`。
 */
export function roastOverviewFetcher(
	read: StatsOverviewReader,
	deps: Pick<RouteDeps, "runtime">,
): OverviewFetcher {
	return async (days, tz) => {
		try {
			return await read(days, tz);
		} catch (err) {
			deps.runtime.serviceCtx.logger.error("unhandled request error", err);
			return null;
		}
	};
}

export interface StatsRouteOptions {
	/**
	 * `/overview` 与手动锐评用的取数。`index.ts` 建好一个、同时交给定时锐评的调度器,两边吃同一份 30 秒缓存;
	 * 不传就自建一个(路由测试)。
	 */
	overview?: StatsOverviewReader;
	/**
	 * 立刻跑一轮 —— 面板上的「试一次」按它。带订阅 id 跑那条订阅的单人锐评(两支都行,ADR-0020
	 * 决策 18),不带则跑全局那条榜单周报。
	 *
	 * 由 `index.ts` late-bind 进来(调度器建得比路由晚):没传就等于「还没就绪」,
	 * 端点回 503 而不是假装成功。**它调的就是 cron 到点调的那个函数** —— 另写一条
	 * 「测试专用」的路径,测出来的就不是真到点时会发生的事。
	 */
	runRoastNow?: (subscriptionId?: string) => Promise<RoastRunOutcome>;
}

export function createStatsRoute(deps: RouteDeps, options: StatsRouteOptions = {}): Hono {
	const app = new Hono();
	// 面板、手动锐评共用这一个取数(定时锐评那条在 index.ts 里拿到的是同一个实例,缓存才共用)。
	const overview = options.overview ?? createStatsOverview(deps);
	const roastOverview = roastOverviewFetcher(overview, deps);

	app.get("/overview", async (c) =>
		c.json<StatsOverviewResponse>(
			await overview(clampDays(c.req.query("days")), parseTz(c.req.query("tz"))),
		),
	);

	/**
	 * `POST /api/stats/roast` —— 把统计数据喂给智能女仆,评鸽王 / 勤奋榜。
	 *
	 * 用**已保存**的 AI 配置(不像 `/api/ai/test` 吃页面草稿):这里不是在
	 * 调人格,而是在用配好的女仆干活,草稿会让结果不可复现。
	 */
	app.post("/roast", async (c) => {
		// 生成本体在 `../stats/roast-generate.ts` —— 定时推送要走同一份实现,
		// 否则页面上看到的和到点自动发出去的迟早不是一回事。
		const gen = await generateBoardRoast(deps, {
			days: clampDays(c.req.query("days")),
			tz: parseTz(c.req.query("tz")),
			fetchOverview: roastOverview,
		});
		// 生成没成:码与话在 roast-generate.ts 产生的地方定好,这里直接回(状态码从码推)。
		if (!gen.ok) return respondFailure(c, gen);
		return c.json<StatsRoastResponse>(ok({ result: gen.result }));
	});

	/**
	 * `POST /api/stats/roast/push` —— 把**页面上已生成的那份**锐评推到一个目标。
	 *
	 * **必须注册在 `/roast/:subscriptionId` 之前。** Hono 按注册序匹配,反过来的话 `push`
	 * 会被当成订阅 id 吃掉,推送请求得到的是一句「该 UP 主不在订阅列表里」—— 类型、
	 * 构建、lint 全绿,只有真发一次才看得出来。
	 *
	 * 结果由请求体带来而不是服务端重新生成:主人是看过卡片才决定推的,重新生成
	 * 会推出一份谁都没审过的文本。请求体里**只有订阅 id 可信** —— 名称 / 头像 / 配色
	 * 一律服务端 join(见 `makeUpMeta`)。
	 *
	 * 开着图片渲染就推卡片图,否则推文字;渲染路上任何一步出问题都**降级成文字**
	 * 而不是整条失败 —— 一份已经生成好的周报,不该因为服务器上没装 Chrome 就发不出去。
	 *
	 * 试一次、回报结果:请求本身不成(引擎没起、体不对、没这个目标、目标已停用)是非 2xx 的错误体;
	 * 请求没问题、可是一个目标都没送到,照旧回 200 + `Result`(`message` 是投递那头给的原话)。
	 */
	app.post("/roast/push", async (c) => {
		const engines = deps.runtime.engines;
		if (!engines) return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));

		const parsed = RoastPushSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", "锐评推送的请求格式不对", { issues: issuesFromZod(parsed.error) }),
			);
		}
		const { targetId, days, kind, result } = parsed.data;

		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target) return respondFailure(c, fail("not_found", "推送目标不存在"));

		// 渲染与投递的本体在 `../stats/roast-deliver.ts` —— 定时推送走同一份,
		// 免得「渲染挂了降级成文字」这类行为将来只剩一条路上还留着。
		const out = await deliverRoast(deps, { kind, result, days, targetIds: [target.id] });
		// 停用的目标投递层会跳过(与周报同一条判定)。单目标手动推送遇到它得明说,不能是一句
		// 含糊的「推送失败」—— 那会让人去查网络。
		// 停用要主人去把开关打开,等是等不好的:`not_configured`。
		if (out.skipped.length > 0) {
			return respondFailure(c, fail("not_configured", "推送目标已停用"));
		}
		if (out.sent.length === 0) {
			// `DeliveryResult.err` 还是老形状(且落盘进历史),只在这个出口读它的话当 `message`。
			return c.json<StatsRoastPushResponse>(
				fail("unavailable", out.failed[0]?.err || "没有送达，对端没说原因"),
			);
		}
		return c.json<StatsRoastPushResponse>(ok({ mode: out.mode }));
	});
	/**
	 * `POST /api/stats/roast/run` —— 立刻跑一轮定时周报(面板上的「试一次」)。
	 *
	 * **必须注册在 `/roast/:subscriptionId` 之前**,理由同 `/roast/push`:Hono 按注册序匹配,
	 * 反过来 `run` 会被当成一个订阅 id 吃掉。
	 *
	 * 三件要紧事:
	 * - 走的是**和 cron 完全同一个函数**。另写一条「测试专用」的轻量路径,验的就
	 *   不是真到点时会发生的事 —— 那样的按钮绿了也不能说明什么。
	 * - 因此审批关着时它会**真的发进群里**。前端负责在点之前把这话讲清楚。
	 * - 读的是**已保存**的配置,不吃页面草稿(同 `/roast` 那条的理由:这里不是在调
	 *   参数,是在验一条已经配好的流水线)。
	 *
	 * 业务性失败(生成不出来、没配目标)一律 **200 + 结构化结局**,不用 4xx ——
	 * 前端的 error 分支只拿得到一句 HTTP 错误,原因就丢了(锐评卡踩过这个坑)。
	 *
	 * 这一轮里**抛出来**的不是业务性失败而是 bug:不在这里吞,交给出错处理(原话进错误日志,面板只拿
	 * 一句固定的话),`String(err)` 里可能带路径、内部状态。
	 */
	async function runNow(c: Context, subscriptionId?: string): Promise<Response> {
		if (!options.runRoastNow) {
			return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));
		}
		return c.json<StatsRoastRunNowResponse>(
			ok({ outcome: await options.runRoastNow(subscriptionId) }),
		);
	}

	app.post("/roast/run", (c) => runNow(c));
	/**
	 * 带订阅 id = 跑这条订阅的单人锐评。漏掉它就会发出一份全站榜单,完全不是主人要试的东西。
	 * 订阅 id 由面板编码进路径,这里拿到的是解码后的。
	 */
	app.post("/roast/run/:subscriptionId", (c) => runNow(c, c.req.param("subscriptionId")));

	/**
	 * `POST /api/stats/roast/:subscriptionId` —— 单 UP 锐评,两支订阅都行(ADR-0020 决策 18)。
	 *
	 * 与榜单版共用取数与 AI 配置,但**没有「至少 2 位」那道闸门** —— 那道闸门是
	 * 榜单特有的(评鸽王需要对照组),单人只就他自己的数据说话。
	 */
	app.post("/roast/:subscriptionId", async (c) => {
		const gen = await generateSoloRoast(deps, {
			subscriptionId: c.req.param("subscriptionId"),
			days: clampDays(c.req.query("days")),
			tz: parseTz(c.req.query("tz")),
			fetchOverview: roastOverview,
		});
		if (!gen.ok) return respondFailure(c, gen);
		return c.json<StatsSoloRoastResponse>(ok({ result: gen.result }));
	});

	return app;
}

// ── 锐评推送 ─────────────────────────────────────────────────────────────────

// UP 一律按订阅 id 回指(ADR-0020 决策 18)。请求体里只有它可信 —— 名称 / 头像 / 配色服务端自己 join。
const BoardResultSchema = z.object({
	pigeon: z.object({ subscriptionId: z.string(), reason: z.string() }),
	diligent: z.object({ subscriptionId: z.string(), reason: z.string() }),
	roast: z.array(z.object({ subscriptionId: z.string(), comment: z.string() })).default([]),
	scores: z.array(z.object({ subscriptionId: z.string(), score: z.number() })).default([]),
	pushText: z.string().default(""),
});

const SoloResultSchema = z.object({
	subscriptionId: z.string(),
	verdict: z.string(),
	score: z.number(),
	highlights: z.array(z.object({ label: z.string(), comment: z.string() })).default([]),
	pushText: z.string().default(""),
});

const RoastPushSchema = z.intersection(
	z.object({ targetId: z.uuid(), days: z.number().int().min(MIN_DAYS).max(MAX_DAYS) }),
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("board"), result: BoardResultSchema }),
		z.object({ kind: z.literal("solo"), result: SoloResultSchema }),
	]),
);

/**
 * ROAST_CALL —— 为什么两处锐评都走 `comment()` 而不是 `chat()`。
 *
 * `CommentaryGenerator` 这两个入口都是单发、都会前置人格 system prompt,差别在工具:
 *
 * - `chat(content)` 自动挂上 B 站只读工具,system 里带工具铁律。给 AI 页的「试推送」用。
 * - `comment(content, scene?)` 不带工具(开了联网搜索时只挂 web_search)。
 *
 * 锐评是一次性、要回 JSON 的任务,必须走后者。早先误用过 `chat()` 并且写死 sessionId
 * (那时它还按 sessionId 保存多轮历史),三个后果:
 *
 * 1. `"stats-roast-solo"` 是所有 UP 共用的 —— 评完 A 再评 B,B 的上下文里坐着
 *    A 的数据和上一次回复,而提示词明写着「只针对这一位 UP 主」;
 * 2. 点「重新生成」时模型看得见自己上一次的答案,倾向照抄而不是重新判断;
 * 3. 工具对锐评毫无用处,却多出一条「模型中途发起 tool call 而不是回 JSON」的
 *    失败路径。
 *
 * 前两条随 `chat()` 的会话记忆一起删掉了,第三条至今成立。
 *
 * 人格**不受影响**:`comment()` 内部同样调 `getSystemPrompt()`,主人配的女仆人格
 * 照常生效。这里只是不传 `scene`,因为动态点评 / 下播总结的场景补充提示词与锐评
 * 无关。
 *
 * per-UP 人格只有**单人锐评**接得上(`resolveAiOverride(sub, …)`)。榜单卡评的是
 * 一群 UP,他们各自配的人格选谁都是错的,所以它恒走全局 —— 人格是女仆的,只是
 * 按 UP 分别配置,而这张卡不属于任何单个 UP(同理它也不吃 per-kind 卡片样式)。
 */
