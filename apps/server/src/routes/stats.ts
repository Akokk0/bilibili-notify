import { CommentaryGenerator } from "@bilibili-notify/ai";
import type {
	StatsOverviewResponse,
	StatsRoastResponse,
	StatsSoloRoastResponse,
	UpStatsRow,
} from "@bilibili-notify/contract";
import { Hono } from "hono";
import {
	countDynamics,
	dailyActivityCounts,
	dailyFansSeries,
	localDayKey,
	summarizeLiveSessions,
	windowSinceIso,
} from "../stats/aggregate.js";
import {
	buildRoastPrompt,
	buildSoloRoastPrompt,
	parseRoastReply,
	parseSoloRoastReply,
	type RoastInput,
} from "../stats/roast.js";
import { toGeneratorConfig } from "./ai.js";
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

const MIN_DAYS = 1;
const MAX_DAYS = 90;
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

/** 取数失败时给用户的话。两处锐评同一套措辞。 */
const OVERVIEW_FAILED = "统计数据读取失败,请稍后重试";

export function createStatsRoute(deps: RouteDeps): Hono {
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
			const activityCounts = dailyActivityCounts(events, sessions, { days, tzOffsetMin });
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
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json<StatsRoastResponse>({ ok: false, err: "服务尚未就绪,请稍后重试" }, 503);
		}
		const aiSettings = deps.store.getGlobals().defaults.ai;
		if (!aiSettings.enabled) {
			return c.json<StatsRoastResponse>({ ok: false, err: "智能女仆尚未启用" }, 400);
		}

		const days = clampDays(c.req.query("days"));
		const overview = await fetchOverview(app, days, parseTz(c.req.query("tz")));
		if (!overview) {
			return c.json<StatsRoastResponse>({ ok: false, err: OVERVIEW_FAILED }, 500);
		}

		// 名称在 SubRuntimeStore(cachedProfile 是外置运行时数据,不在配置里),
		// 与 `/api/subs` 的 join 同源。
		const nameByUid = new Map(
			deps.store
				.getSubscriptions()
				.map((s) => [
					s.uid,
					deps.runtime.subRuntimeStore.get(s.id)?.cachedProfile?.name?.trim() || `UID ${s.uid}`,
				]),
		);
		const ups: RoastInput[] = overview.rows.map((r) => ({
			uid: r.uid,
			name: nameByUid.get(r.uid) ?? `UID ${r.uid}`,
			net7d: r.net7d,
			netWindow: r.netWindow,
			archives: r.archives,
			dynamics: r.dynamics,
			liveSessions: r.liveSessions,
			liveHours: r.liveHours,
			lastActivityAt: r.lastActivityAt,
		}));
		if (ups.length < 2) {
			return c.json<StatsRoastResponse>(
				{ ok: false, err: "至少要订阅 2 位 UP 主才评得出鸽王" },
				400,
			);
		}

		const generator = new CommentaryGenerator({
			serviceCtx: deps.runtime.serviceCtx,
			api: engines.api,
			config: toGeneratorConfig(aiSettings),
		});
		let reply: string;
		try {
			// `comment()` 而不是 `chat()` —— 见文件末尾 ROAST_CALL 注释。
			reply = await generator.comment(buildRoastPrompt(ups, days));
		} catch (err) {
			return c.json<StatsRoastResponse>(
				{ ok: false, err: err instanceof Error ? err.message : String(err) },
				500,
			);
		}

		const result = parseRoastReply(reply, ups);
		if (!result) {
			// 解析不出来就直说,不把半截结构渲染成一张看着像模像样的卡。
			return c.json<StatsRoastResponse>({ ok: false, err: "女仆的回复解析失败,请重试" }, 502);
		}
		return c.json<StatsRoastResponse>({ ok: true, result });
	});

	/**
	 * `POST /api/stats/roast/:uid` —— 单 UP 锐评。
	 *
	 * 与榜单版共用取数与 AI 配置,但**没有「至少 2 位」那道闸门** —— 那道闸门是
	 * 榜单特有的(评鸽王需要对照组),单人只就他自己的数据说话。
	 */
	app.post("/roast/:uid", async (c) => {
		const uid = c.req.param("uid");
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json<StatsSoloRoastResponse>({ ok: false, err: "服务尚未就绪,请稍后重试" }, 503);
		}

		// 先确认这个 uid 真的订阅着。不校验的话,任何人构造一个 uid 就能让我们
		// 拿着一份空数据去请求模型 —— 白烧 token,还会渲染出一张查无此人的卡。
		const sub = deps.store.getSubscriptions().find((s) => s.uid === uid);
		if (!sub) {
			return c.json<StatsSoloRoastResponse>({ ok: false, err: "该 UP 主不在订阅列表里" }, 404);
		}

		const aiSettings = deps.store.getGlobals().defaults.ai;
		if (!aiSettings.enabled) {
			return c.json<StatsSoloRoastResponse>({ ok: false, err: "智能女仆尚未启用" }, 400);
		}

		const days = clampDays(c.req.query("days"));
		const overview = await fetchOverview(app, days, parseTz(c.req.query("tz")));
		if (!overview) {
			return c.json<StatsSoloRoastResponse>({ ok: false, err: OVERVIEW_FAILED }, 500);
		}
		const row = overview.rows.find((r) => r.uid === uid);
		if (!row) {
			return c.json<StatsSoloRoastResponse>({ ok: false, err: "该 UP 主暂无统计数据" }, 404);
		}

		const up: RoastInput = {
			uid: row.uid,
			name:
				deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile?.name?.trim() || `UID ${row.uid}`,
			net7d: row.net7d,
			netWindow: row.netWindow,
			archives: row.archives,
			dynamics: row.dynamics,
			liveSessions: row.liveSessions,
			liveHours: row.liveHours,
			lastActivityAt: row.lastActivityAt,
		};

		const generator = new CommentaryGenerator({
			serviceCtx: deps.runtime.serviceCtx,
			api: engines.api,
			config: toGeneratorConfig(aiSettings),
		});
		let reply: string;
		try {
			// 同上:一次性调用,不留会话历史 —— 否则评完 A 再评 B,B 的上下文里坐着 A。
			reply = await generator.comment(buildSoloRoastPrompt(up, days));
		} catch (err) {
			return c.json<StatsSoloRoastResponse>(
				{ ok: false, err: err instanceof Error ? err.message : String(err) },
				500,
			);
		}

		const result = parseSoloRoastReply(reply, up);
		if (!result) {
			return c.json<StatsSoloRoastResponse>({ ok: false, err: "女仆的回复解析失败,请重试" }, 502);
		}
		return c.json<StatsSoloRoastResponse>({ ok: true, result });
	});

	return app;
}

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
 */
