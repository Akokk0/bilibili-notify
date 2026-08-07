import type {
	StatsOverviewResponse,
	StatsRoastPushResponse,
	StatsRoastResponse,
	StatsRoastRunNowResponse,
	StatsSoloRoastResponse,
	UpStatsRow,
} from "@bilibili-notify/contract";
import { ROAST_MAX_DAYS, ROAST_MIN_DAYS } from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { RoastRunOutcome } from "../runtime/roast-scheduler.js";
import {
	countDynamics,
	dailyActivityCounts,
	dailyFansSeries,
	localDayKey,
	summarizeLiveSessions,
	windowSinceIso,
} from "../stats/aggregate.js";
import { deliverRoast } from "../stats/roast-deliver.js";
import {
	generateBoardRoast,
	generateSoloRoast,
	roastGenErrorStatus,
	roastGenErrorText,
} from "../stats/roast-generate.js";
import type { RouteDeps } from "./types.js";

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
 * 全塞进来 —— 独立端 Docker 镜像的堆上限只有 384MB,顶得爆。
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

/** 一串时刻里最早的那个本地日键。空串 / 全是脏值时返回 null。 */
function minLocalDay(values: readonly string[], tzOffsetMin: number): string | null {
	let out: string | null = null;
	for (const v of values) {
		const d = localDayKey(v, tzOffsetMin);
		if (d && (out === null || d < out)) out = d;
	}
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
 * 两处锐评共用的取数:内部代理一次自己的 `/overview`。
 *
 * **必须先看状态码再 `.json()`。** `/overview` 一旦抛错(某个 store 方法在 try 之外
 * reject),Hono 默认的 onError 回的是纯文本 `Internal Server Error`,对它调 `.json()`
 * 会 reject 出 `SyntaxError: Unexpected token 'I'`;那个异常逃出 handler 后变成一个
 * 没有 body 的裸 500,前端只能显示一行生硬的 `POST /api/stats/roast → 500`。
 * 这条路由里其他每一个错误分支都精心返回了可读的 `err`,这里不能例外。
 */
async function fetchOverview(
	app: Hono,
	days: number,
	tz: number,
): Promise<StatsOverviewResponse | null> {
	const res = await app.request(`/overview?days=${days}&tz=${tz}`);
	if (!res.ok) return null;
	try {
		return (await res.json()) as StatsOverviewResponse;
	} catch {
		return null;
	}
}

export interface StatsRouteOptions {
	/**
	 * 立刻跑一轮 —— 面板上的「试一次」按它。带 uid 跑那位 UP 的单人锐评,
	 * 不带则跑全局那条榜单周报。
	 *
	 * 由 `index.ts` late-bind 进来(调度器建得比路由晚):没传就等于「还没就绪」,
	 * 端点回 503 而不是假装成功。**它调的就是 cron 到点调的那个函数** —— 另写一条
	 * 「测试专用」的路径,测出来的就不是真到点时会发生的事。
	 */
	runRoastNow?: (uid?: string) => Promise<RoastRunOutcome>;
}

export function createStatsRoute(deps: RouteDeps, options: StatsRouteOptions = {}): Hono {
	const app = new Hono();
	const cache = new Map<string, CacheEntry>();

	app.get("/overview", async (c) => {
		const days = clampDays(c.req.query("days"));
		const tzOffsetMin = parseTz(c.req.query("tz"));
		const subs = deps.store.getSubscriptions();
		// 这两份是**内存快照**,不经 jsonl —— 也就是说它们跟 TTL 没有半点关系,
		// 必须自己进 key(见下方 key 的说明)。放在缓存查询之前取。
		const liveUids = new Set(
			(deps.runtime.engines?.listLiveRooms() ?? []).filter((r) => r.isLive).map((r) => r.uid),
		);
		const fansByUid = new Map(
			(deps.runtime.fansPoller?.getLastEntries() ?? []).map((e) => [e.uid, e]),
		);
		// key 必须覆盖**响应里所有会变的输入**,否则缓存就在替页面撒谎。
		//
		// 订阅集合:退订后 recorder 已经 `dropUid` 物理删掉了那位 UP 的 jsonl,前端
		// 却还能从缓存里读到他一整行(数据背后的文件已不存在);刚加的订阅同理要等
		// 满 TTL 才出现。不排序 —— rows 的顺序就跟着 subs 走,顺序变了输出也变。
		//
		// 在播状态 / 粉丝快照:两者都被原样嵌进响应,却都不来自被 TTL 兜住的 jsonl。
		// 漏掉在播状态的话,UP 一开播,统计页最长 30 秒仍报 live:false,而同一屏的
		// 「正在直播」面板走 WS 实时喂、早就亮了 —— 两块面板互相打脸,点刷新也没用。
		const liveKey = [...liveUids].sort().join(",");
		const fansKey = subs.map((s) => fansByUid.get(s.uid)?.current ?? "").join(",");
		const key = `${days}:${tzOffsetMin}:${subs.map((s) => s.uid).join(",")}|${liveKey}|${fansKey}`;

		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
			return c.json<StatsOverviewResponse>(hit.payload);
		}

		// 窗口起点对齐**本地日边界**,与页面上按本地日分桶的每一条序列同一把尺子
		// (详见 windowSinceIso)。用滚动的 N×24 小时会让合计数多吃进日轴从未画过的
		// 那小半天,KPI 与紧挨着它的热力图对不上。
		const since = windowSinceIso(days, tzOffsetMin);
		const sinceMs = Date.parse(since);
		// 活动采集的起始日:早于它的日子没有活动数据可言,热力图必须显示成
		// 「无记录」而不是「活跃度 0」。详见 StatsStore.recordingSince 的说明。
		const recordingSinceDay = localDayKey(
			await deps.runtime.statsStore.recordingSince(),
			tzOffsetMin,
		);

		// 先把每位 UP 的原始序列取回来。热力图的遮罩要用到**跨 UP** 的全局事实,
		// 在单个 UP 的闭包里判不出来,所以取数与成行分成两趟。
		const perSub = await Promise.all(
			subs.map(async (sub) => {
				const [samples, events, sessions] = await Promise.all([
					deps.runtime.fansStore.listSamplesSince(sub.uid, since),
					deps.runtime.statsStore.listDynamics(sub.uid, since),
					deps.runtime.statsStore.listLiveSessions(sub.uid, since),
				]);
				return { sub, samples, events, sessions };
			}),
		);

		// 哪些天服务器确实在跑 —— fans poller 每 2min 一次,有采样就说明我们当时看着。
		//
		// 取**所有 UP 的并集**,而不是每位 UP 各看各的:服务器在不在跑是服务器的
		// 属性,与具体订阅了谁无关。按 UP 各判会踩一个很难发现的坑 —— 禁用订阅会
		// `dropUid` 物理删掉那位 UP 的 fans jsonl,于是订阅了三个月的 UP 只要被禁用
		// 再启用,热力图整片变「无记录」,尽管它的动态和场次原封不动在盘上。
		//
		// 残留的空档:所有 UP 的采样都缺失时(只订阅了一位且刚被禁用过)仍会判成
		// 「没在跑」。那种情况下盘上确实不存在任何佐证,宁可显示「无记录」也不瞎猜。
		const coveredDays = new Set<string>();
		for (const { samples } of perSub) {
			for (const s of samples) {
				const d = localDayKey(s.ts, tzOffsetMin);
				if (d) coveredDays.add(d);
			}
		}

		const rows = perSub.map(({ sub, samples, events, sessions }): UpStatsRow => {
			const daily = dailyFansSeries(samples, { days, tzOffsetMin });
			const series = daily.map((p) => p.net);
			// 活动热力图:计数本身恒有值(没活动就是 0),但有两种情况必须显示成
			// 空格而不是 0 —— 0 会被读成「这位 UP 那天什么都没发」:
			//   · 那天服务根本没跑 —— 见上方 coveredDays;
			//   · 那天还没开始采集活动 —— fans 采样比统计功能上线得早,光看采样
			//     会把上线之前的日子全判成「活跃度 0」。
			//   · 那天我们还没在看**这一位** —— 见下方 firstSampleDay。
			const activityCounts = dailyActivityCounts(events, sessions, { days, tzOffsetMin });
			// 这位 UP 自己的首个 fans 采样日。fans poller 只采**订阅中**的 UP、每 2min
			// 一轮,稠密到足以当「那天我们在看着他」的凭证 —— 而 coveredDays 是跨 UP
			// 并集,只证明得了服务器在跑,证明不了这一位在不在册。
			const firstSampleDay = minLocalDay(
				samples.map((s) => s.ts),
				tzOffsetMin,
			);
			// 盘上关于这位 UP 有没有任何东西。三样全空 = 一无所知,整行留白。
			const hasEvidence = samples.length > 0 || events.length > 0 || sessions.length > 0;
			const activity = activityCounts.map((c, i) => {
				const day = daily[i];
				if (!day || !coveredDays.has(day.d)) return null;
				// 严格小于:采集起始日**当天**照常出数。
				//
				// 已知的精度损失 —— 那天多半只采到了后半天(18:00 才装上的话,之前的
				// 活动没记到),格子却和其他整天一样着色。权衡过:遮成 null 会把那天
				// 真实记到的活动一并抹掉,那是拿「不完整」换「假装没有」,更不诚实。
				// 页面上另有「已记录 N 日」的提示告诉用户采集覆盖了多久。
				if (recordingSinceDay && day.d < recordingSinceDay) return null;
				// 别的 UP 的采样能证明服务器在跑,证明不了我们在看他。
				if (!hasEvidence) return null;
				// 早于本 UP 首采日、且那天什么都没发生 → 留白。昨天开服、今天新订阅
				// 一位 UP,他昨天那格本会被画成灰色的 0,读起来是「他昨天什么都没发」,
				// 而那天他还不在订阅列表里。
				//
				// **只遮 0** 是要紧的:禁用订阅会 `dropUid` 物理删掉 fans jsonl(退订
				// 才连带删 stats),订阅了三个月的 UP 被禁用再启用,首采日就成了今天,
				// 而他更早的动态与场次原封不动在盘上 —— 那些格子有铁证,一刀切会把
				// 已经知道的事实重新抹成「不知道」。
				if (firstSampleDay && day.d < firstSampleDay && c === 0) return null;
				return c;
			});
			// 窗口内是否有**任何**采集覆盖。三种证据取并集:
			//   · `activity` 有非 null 位 —— fans 采样证明服务当时在跑;
			//   · 盘上有动态 / 场次记录 —— 能记下来本身就说明我们在记。
			// 只认第一种是不够的:fans jsonl 会被 `dropUid` 物理删掉(禁用订阅),
			// 而动态与场次记录原封不动留着 —— 那时把计数判成「无记录」就是睁眼说瞎话。
			const hasCoverage =
				activity.some((v) => v !== null) || events.length > 0 || sessions.length > 0;
			const counts = countDynamics(events);
			// 在播状态来自引擎(唯一权威),用来区分「这场正在播」与「end 帧丢了」。
			const live = summarizeLiveSessions(sessions, { isLive: liveUids.has(sub.uid), sinceMs });

			// 最后活动 = 最近一条动态 与 最近一次开播 里更晚的那个。两者都没有
			// 就是 null —— 这正是设计稿「鸽子榜」要的信号,不能拿窗口起点顶替。
			//
			// 动态取**最大 ts** 而不是末元素:`listDynamics` 的契约是「按落盘顺序」
			// = 检测顺序,而 B 站动态流按惯例最新在前,一轮里检测到多条时末元素
			// 反而是最旧的那条。直播那侧同样按 ts 取:`listLiveSessions` 返回的是
			// 「首次出现顺序」,而场次按 startedAt 认,被重新打开的早场次未必排在末尾。
			const lastDynamic = maxIso(events.map((e) => e.ts));
			const lastLive = maxIso(sessions.map((s) => s.startedAt));
			const lastActivityAt =
				lastDynamic && lastLive
					? lastDynamic > lastLive
						? lastDynamic
						: lastLive
					: (lastDynamic ?? lastLive);

			return {
				uid: sub.uid,
				// 当前粉丝优先用 poller 的最新快照,它比 jsonl 末行更新;
				// poller 还没起来时回退到采样末值。
				fans: fansByUid.get(sub.uid)?.current ?? samples.at(-1)?.value ?? null,
				net1d: sumTail(series, 1),
				// 窗口装不下 7 天就没法给出 7 天口径 —— 拿 3 天的和冒充 7 天更糟。
				net7d: days >= 7 ? sumTail(series, 7) : null,
				netWindow: sumTail(series, days),
				series,
				cumulative: daily.map((p) => p.value),
				activity,
				// 与 `activity` 同一把尺子:窗口内一天都没覆盖到时,这些计数不是 0
				// 而是「不知道」。0 会被读成「这位 UP 什么都没发」,而热力图同一行
				// 正画着一片「无记录」—— 两个数在一屏里互相打脸。
				archives: hasCoverage ? counts.archives : null,
				dynamics: hasCoverage ? counts.dynamics : null,
				liveSessions: hasCoverage ? live.sessions : null,
				liveHours: hasCoverage ? live.hours : null,
				liveTimedSessions: hasCoverage ? live.timedSessions : null,
				peakViewers: live.peakViewers,
				avgPeakViewers: live.avgPeakViewers,
				lastActivityAt,
				live: liveUids.has(sub.uid),
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
		return c.json<StatsOverviewResponse>(payload);
	});

	/**
	 * `POST /api/stats/roast` —— 把统计数据喂给智能女仆,评鸽王 / 勤奋榜。
	 *
	 * 用**已保存**的 AI 配置(不像 `/api/ai/test-push` 吃页面草稿):这里不是在
	 * 调人格,而是在用配好的女仆干活,草稿会让结果不可复现。
	 */
	app.post("/roast", async (c) => {
		// 生成本体在 `../stats/roast-generate.ts` —— 定时推送要走同一份实现,
		// 否则页面上看到的和到点自动发出去的迟早不是一回事。
		const gen = await generateBoardRoast(deps, {
			days: clampDays(c.req.query("days")),
			tz: parseTz(c.req.query("tz")),
			fetchOverview: (d, t) => fetchOverview(app, d, t),
		});
		if (!gen.ok) {
			return c.json<StatsRoastResponse>(
				{ ok: false, err: roastGenErrorText(gen) },
				roastGenErrorStatus(gen),
			);
		}
		return c.json<StatsRoastResponse>({ ok: true, result: gen.result });
	});

	/**
	 * `POST /api/stats/roast/push` —— 把**页面上已生成的那份**锐评推到一个目标。
	 *
	 * **必须注册在 `/roast/:uid` 之前。** Hono 按注册序匹配,反过来的话 `push` 会
	 * 被当成 uid 吃掉,推送请求得到的是一句「该 UP 主不在订阅列表里」—— 类型、
	 * 构建、lint 全绿,只有真发一次才看得出来。
	 *
	 * 结果由请求体带来而不是服务端重新生成:主人是看过卡片才决定推的,重新生成
	 * 会推出一份谁都没审过的文本。请求体里**只有 uid 可信** —— 名称 / 头像 / 配色
	 * 一律服务端 join(见 `upMeta`)。
	 *
	 * 开着图片渲染就推卡片图,否则推文字;渲染路上任何一步出问题都**降级成文字**
	 * 而不是整条失败 —— 一份已经生成好的周报,不该因为服务器上没装 Chrome 就发不出去。
	 */
	app.post("/roast/push", async (c) => {
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json<StatsRoastPushResponse>({ ok: false, err: "服务尚未就绪,请稍后重试" }, 503);
		}

		const parsed = RoastPushSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json<StatsRoastPushResponse>({ ok: false, err: "请求格式不正确" }, 400);
		}
		const { targetId, days, kind, result } = parsed.data;

		const target = deps.store.getTargets().find((t) => t.id === targetId);
		if (!target) {
			return c.json<StatsRoastPushResponse>({ ok: false, err: "推送目标不存在" }, 404);
		}

		// 渲染与投递的本体在 `../stats/roast-deliver.ts` —— 定时推送走同一份,
		// 免得「渲染挂了降级成文字」这类行为将来只剩一条路上还留着。
		const out = await deliverRoast(deps, { kind, result, days, targetIds: [target.id] });
		if (out.sent.length === 0) {
			return c.json<StatsRoastPushResponse>(
				{ ok: false, err: out.failed[0]?.err ?? "推送失败" },
				502,
			);
		}
		const mode = out.mode;
		return c.json<StatsRoastPushResponse>({ ok: true, mode });
	});
	/**
	 * `POST /api/stats/roast/run-now` —— 立刻跑一轮定时周报(面板上的「试一次」)。
	 *
	 * **必须注册在 `/roast/:uid` 之前**,理由同 `/roast/push`:Hono 按注册序匹配,
	 * 反过来 `run-now` 会被当成一个 uid 吃掉。
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
	 */
	async function runNow(c: Context, uid?: string): Promise<Response> {
		if (!options.runRoastNow) {
			return c.json<StatsRoastRunNowResponse>({ ok: false, err: "服务尚未就绪,请稍后重试" }, 503);
		}
		try {
			return c.json<StatsRoastRunNowResponse>({
				ok: true,
				outcome: await options.runRoastNow(uid),
			});
		} catch (err) {
			// 这一轮里任何一步炸了都收在这儿:端点是给人点的,不能把异常漏出去。
			const why = err instanceof Error ? err.message : String(err);
			deps.runtime.serviceCtx.logger.warn(`[stats] 手动跑锐评失败: ${why}`);
			return c.json<StatsRoastRunNowResponse>({ ok: false, err: why }, 502);
		}
	}

	app.post("/roast/run-now", (c) => runNow(c));
	/** 带 uid = 跑这位 UP 的单人锐评。漏掉它就会发出一份全站榜单,完全不是主人要试的东西。 */
	app.post("/roast/run-now/:uid", (c) => runNow(c, c.req.param("uid")));

	/**
	 * `POST /api/stats/roast/:uid` —— 单 UP 锐评。
	 *
	 * 与榜单版共用取数与 AI 配置,但**没有「至少 2 位」那道闸门** —— 那道闸门是
	 * 榜单特有的(评鸽王需要对照组),单人只就他自己的数据说话。
	 */
	app.post("/roast/:uid", async (c) => {
		const gen = await generateSoloRoast(deps, {
			uid: c.req.param("uid"),
			days: clampDays(c.req.query("days")),
			tz: parseTz(c.req.query("tz")),
			fetchOverview: (d, t) => fetchOverview(app, d, t),
		});
		if (!gen.ok) {
			return c.json<StatsSoloRoastResponse>(
				{ ok: false, err: roastGenErrorText(gen) },
				roastGenErrorStatus(gen),
			);
		}
		return c.json<StatsSoloRoastResponse>({ ok: true, result: gen.result });
	});

	return app;
}

// ── 锐评推送 ─────────────────────────────────────────────────────────────────

const BoardResultSchema = z.object({
	pigeon: z.object({ uid: z.string(), reason: z.string() }),
	diligent: z.object({ uid: z.string(), reason: z.string() }),
	roast: z.array(z.object({ uid: z.string(), comment: z.string() })).default([]),
	scores: z.array(z.object({ uid: z.string(), score: z.number() })).default([]),
	pushText: z.string().default(""),
});

const SoloResultSchema = z.object({
	uid: z.string(),
	verdict: z.string(),
	score: z.number(),
	highlights: z.array(z.object({ label: z.string(), comment: z.string() })).default([]),
	pushText: z.string().default(""),
});

const RoastPushSchema = z.intersection(
	z.object({ targetId: z.string().min(1), days: z.number().int().min(MIN_DAYS).max(MAX_DAYS) }),
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("board"), result: BoardResultSchema }),
		z.object({ kind: z.literal("solo"), result: SoloResultSchema }),
	]),
);

/**
 * ROAST_CALL —— 为什么两处锐评都走 `comment()` 而不是 `chat()`。
 *
 * `CommentaryGenerator` 有两个入口,都会前置人格 system prompt,但历史语义相反:
 *
 * - `chat(content, sessionId)` 按 sessionId **保存多轮历史**(TTL 2h)并自动挂上
 *   工具能力。给 `bili chat` 指令那种真·对话用的。
 * - `comment(content, scene?)` 单次调用,不存历史、不带工具。
 *
 * 锐评是一次性任务,必须走后者。早先误用了 `chat()` 并且写死 sessionId,三个后果:
 *
 * 1. `"stats-roast-solo"` 是所有 UP 共用的 —— 评完 A 再评 B,B 的上下文里坐着
 *    A 的数据和上一次回复,而提示词明写着「只针对这一位 UP 主」;
 * 2. 点「重新生成」时模型看得见自己上一次的答案,倾向照抄而不是重新判断;
 * 3. 工具对锐评毫无用处,却多出一条「模型中途发起 tool call 而不是回 JSON」的
 *    失败路径。
 *
 * 人格**不受影响**:`comment()` 内部同样调 `getSystemPrompt()`,主人配的女仆人格
 * 照常生效。这里只是不传 `scene`,因为动态点评 / 下播总结的场景补充提示词与锐评
 * 无关。
 *
 * per-UP 人格只有**单人锐评**接得上(`resolveAiOverride(sub, …)`)。榜单卡评的是
 * 一群 UP,他们各自配的人格选谁都是错的,所以它恒走全局 —— 人格是女仆的,只是
 * 按 UP 分别配置,而这张卡不属于任何单个 UP(同理它也不吃 per-kind 卡片样式)。
 */
