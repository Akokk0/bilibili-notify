/**
 * 服务端自主生成锐评 —— 取数 → 调 AI → 解析,一条不依赖前端的路。
 *
 * 在这之前,锐评只能由页面发起:`POST /roast` 生成、前端拿到结果、再原样回传给
 * `/roast/push` 推出去。那条链路的地基是「主人看过卡片才决定推」,服务端从不自己
 * 生成。定时推送没有前端也没有人在场,于是把生成部分抽到这里,让路由和调度器共用
 * 同一份实现 —— 否则两条路会各自演化,页面上看到的和定时发出去的迟早不是一回事。
 *
 * **取数用注入的回调**,不在这里自己实现:`/overview` 那个 handler 背着 TTL 缓存、
 * 跨 UP 的热力图遮罩和时区对齐,把它拆成纯函数是另一场重构,与本功能无关。路由把
 * 自己的 `app.request('/overview')` 传进来,调度器传同一份。
 */

import { CommentaryGenerator } from "@bilibili-notify/ai";
import type {
	StatsOverviewResponse,
	StatsRoastResult,
	StatsSoloRoastResult,
} from "@bilibili-notify/contract";
import type { RouteDeps } from "../routes/types.js";
import { toGeneratorConfig } from "../runtime/ai-config.js";
import { resolveAiOverride } from "../runtime/engines.js";
import {
	buildRoastPrompt,
	buildSoloRoastPrompt,
	parseRoastReply,
	parseSoloRoastReply,
	type RoastInput,
} from "./roast.js";

/** 生成只用得到这两样,不牵整份 RouteDeps —— 调度器不该为了生成一份周报去凑 puppeteer。 */
export type RoastGenDeps = Pick<RouteDeps, "runtime" | "store">;

/** 取数回调。路由与调度器各自提供,内部都是代理一次 `/overview`。 */
export type OverviewFetcher = (days: number, tz: number) => Promise<StatsOverviewResponse | null>;

/**
 * 生成失败的分类。
 *
 * 分类而不是直接给字符串:同一个失败,路由要转成 HTTP 状态码,调度器要转成私聊里
 * 的一句人话。留成字符串的话两边各写一套措辞,改一处忘一处。
 */
export type RoastGenError =
	| { kind: "not-ready" }
	| { kind: "ai-disabled" }
	| { kind: "overview-failed" }
	/** 榜单特有:评鸽王需要对照组。 */
	| { kind: "too-few-ups" }
	/** 单人特有:uid 不在订阅列表里。 */
	| { kind: "not-subscribed" }
	/** 单人特有:订阅着但这个窗口内没有任何统计数据。 */
	| { kind: "no-data" }
	| { kind: "ai-error"; message: string }
	| { kind: "parse-failed" };

export type RoastGenResult<T> = { ok: true; result: T } | ({ ok: false } & RoastGenError);

/** 每种失败对用户说的话。路由的 `err` 与调度器的私聊共用这一套措辞。 */
export function roastGenErrorText(e: RoastGenError): string {
	switch (e.kind) {
		case "not-ready":
			return "服务尚未就绪,请稍后重试";
		case "ai-disabled":
			return "智能女仆尚未启用";
		case "overview-failed":
			return "统计数据读取失败,请稍后重试";
		case "too-few-ups":
			return "至少要订阅 2 位 UP 主才评得出鸽王";
		case "not-subscribed":
			return "该 UP 主不在订阅列表里";
		case "no-data":
			return "该 UP 主暂无统计数据";
		case "ai-error":
			return e.message;
		case "parse-failed":
			return "女仆的回复解析失败,请重试";
	}
}

/** 失败分类 → HTTP 状态码。只有路由用得上。 */
export function roastGenErrorStatus(e: RoastGenError): 400 | 404 | 500 | 502 | 503 {
	switch (e.kind) {
		case "not-ready":
			return 503;
		case "ai-disabled":
		case "too-few-ups":
			return 400;
		case "not-subscribed":
		case "no-data":
			return 404;
		case "overview-failed":
		case "ai-error":
			return 500;
		case "parse-failed":
			return 502;
	}
}

/** overview 的一行 → 喂给 prompt 的输入。两处生成同一套字段。 */
function toRoastInput(
	row: StatsOverviewResponse extends { rows: Array<infer R> } ? R : never,
	name: string,
): RoastInput {
	return {
		uid: row.uid,
		name,
		net7d: row.net7d,
		netWindow: row.netWindow,
		archives: row.archives,
		dynamics: row.dynamics,
		liveSessions: row.liveSessions,
		liveHours: row.liveHours,
		lastActivityAt: row.lastActivityAt,
	};
}

/**
 * UP 名字。取自 SubRuntimeStore 的 `cachedProfile`(平台实时资料缓存,是外置运行时
 * 数据、不在配置里),与 `/api/subs` 的 join 同源。
 */
function displayName(deps: RoastGenDeps, subId: string, uid: string): string {
	return deps.runtime.subRuntimeStore.get(subId)?.cachedProfile?.name?.trim() || `UID ${uid}`;
}

/** 榜单锐评:全体订阅一起评,需要至少 2 位做对照。 */
export async function generateBoardRoast(
	deps: RoastGenDeps,
	opts: { days: number; tz: number; fetchOverview: OverviewFetcher },
): Promise<RoastGenResult<StatsRoastResult>> {
	const engines = deps.runtime.engines;
	if (!engines) return { ok: false, kind: "not-ready" };

	const aiSettings = deps.store.getGlobals().defaults.ai;
	if (!aiSettings.enabled) return { ok: false, kind: "ai-disabled" };

	const overview = await opts.fetchOverview(opts.days, opts.tz);
	if (!overview) return { ok: false, kind: "overview-failed" };

	const subs = deps.store.getSubscriptions();
	const nameByUid = new Map(subs.map((s) => [s.uid, displayName(deps, s.id, s.uid)]));
	const ups = overview.rows.map((r) => toRoastInput(r, nameByUid.get(r.uid) ?? `UID ${r.uid}`));
	if (ups.length < 2) return { ok: false, kind: "too-few-ups" };

	const generator = new CommentaryGenerator({
		serviceCtx: deps.runtime.serviceCtx,
		api: engines.api,
		config: toGeneratorConfig(aiSettings),
	});
	let reply: string;
	try {
		// `comment()` 而不是 `chat()` —— 一次性调用,不留会话历史、不挂工具。
		// 走 chat() 的话评完 A 再评 B,B 的上下文里坐着 A(详见 stats-roast-call.test.ts)。
		reply = await generator.comment(buildRoastPrompt(ups, opts.days));
	} catch (err) {
		return {
			ok: false,
			kind: "ai-error",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	const result = parseRoastReply(reply, ups);
	// 解析不出来就直说,不把半截结构渲染成一张看着像模像样的卡。
	if (!result) return { ok: false, kind: "parse-failed" };
	return { ok: true, result };
}

/** 单人锐评:只就这一位说话,没有「至少 2 位」那道闸门,但带上他自己的人格。 */
export async function generateSoloRoast(
	deps: RoastGenDeps,
	opts: { uid: string; days: number; tz: number; fetchOverview: OverviewFetcher },
): Promise<RoastGenResult<StatsSoloRoastResult>> {
	const engines = deps.runtime.engines;
	if (!engines) return { ok: false, kind: "not-ready" };

	// 先确认这个 uid 真的订阅着。不校验的话,任何人构造一个 uid 就能让我们拿着
	// 一份空数据去请求模型 —— 白烧 token,还会渲染出一张查无此人的卡。
	const sub = deps.store.getSubscriptions().find((s) => s.uid === opts.uid);
	if (!sub) return { ok: false, kind: "not-subscribed" };

	const aiSettings = deps.store.getGlobals().defaults.ai;
	if (!aiSettings.enabled) return { ok: false, kind: "ai-disabled" };

	const overview = await opts.fetchOverview(opts.days, opts.tz);
	if (!overview) return { ok: false, kind: "overview-failed" };
	const row = overview.rows.find((r) => r.uid === opts.uid);
	if (!row) return { ok: false, kind: "no-data" };

	const up = toRoastInput(row, displayName(deps, sub.id, row.uid));

	const generator = new CommentaryGenerator({
		serviceCtx: deps.runtime.serviceCtx,
		api: engines.api,
		config: toGeneratorConfig(aiSettings),
	});
	// per-UP 人格:与动态点评 / 下播总结同源。评的就是这一位 UP,主人给他单配的
	// 人格没有理由不算数。
	const aiOverride = resolveAiOverride(sub, deps.store.getGlobals().defaults);
	let reply: string;
	try {
		// scene / imageUrls 留空:锐评既不属于 dynamic 也不属于 liveSummary,更没有图。
		reply = await generator.comment(
			buildSoloRoastPrompt(up, opts.days),
			undefined,
			undefined,
			aiOverride,
		);
	} catch (err) {
		return {
			ok: false,
			kind: "ai-error",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	const result = parseSoloRoastReply(reply, up);
	if (!result) return { ok: false, kind: "parse-failed" };
	return { ok: true, result };
}
