/**
 * 统计页的 B 站数字**与改之前逐字一致**(ADR-0020 S1:统计仓改中立、B 站走适配)。
 *
 * 两条路径各钉一份,期望值全部是**改之前的 route + store + aggregate + recorder** 对同一份
 * 数据真跑出来的(S1 施工时从 git 取出老代码并排跑过,响应逐字节相同),不是按新代码抄的:
 *   A. 盘上的老数据(0.x 的 `<uid>.jsonl`、`{id, type, ts}` 行、字符串峰值)经迁移器(第 0 代 → 新的一代,
 *      `migration/stats.ts`)改成按订阅 id 命名(ADR-0020 决策 2 的 🔗)、行翻成现在的形状 —— 升级后数字不变;
 *   B. 同一串 B 站总线事件经新的 B 站适配(uid → 订阅 id)落盘,再读出来 —— 新数据与老版本
 *      记的同口径。
 *
 * ㉖d 起行上是 `videoPosts`(带视频的)与 `posts`(全部作品),原先的「动态」= `posts − videoPosts`;下面
 * 期望值里的 `posts` 就是改之前的 `archives + dynamics`,另有一条用例把「投稿 / 动态」两个显示数按相减读出来,
 * 与改之前逐个相同。
 *
 * S4 起两格峰值改名 `maxViewers` / `avgViewers`(ADR-0020 决策 18),只改名、数一个不变;行多了
 * `subscriptionId` 与身份两格,这里按 uid 取 B 站行、只比数字那几格。
 *
 * **㉖c 起有一处有意的不同**:开播公告不再记(ADR-0027)。原先的期望值里,只有公告、没有场次的 UP(直播推送全关)
 * 靠公告撑着「最后活动」与计数 0,公告比场次晚几分钟的那位「最后活动」落在公告上;现在这些格子要么落到场次 / 作品
 * 上、要么整行是「无记录」null —— 其余每一格仍是改之前的数。
 *
 * **3a-27 起(统计只听 `post-detected`)有一处有意的不同**:直播类动态(`DYNAMIC_TYPE_LIVE`)记成一条不带视频的作品
 * (主人定的);自动开播推送(`DYNAMIC_TYPE_LIVE_RCMD`)引擎不交作品、没有事件。B 组用例据此改了 202 那一行的几格。
 *
 * **㉖f 起又有一处有意的不同**:「近 1 日(UTC)」窗口里订阅 105 改前整行 null、现在是 0(详见该用例里的注释)。
 *
 * 要紧的几个角都在夹具里:只有开播公告、没有场次的 UP;开播公告比场次晚几分钟;接回的场次、解析不出的老峰值、
 * 孤立的 end、窗口外的老行、坏行。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { AuthState } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFollowersStore, FOLLOWERS_DIR } from "../followers/store.js";
import { migrateZeroGeneration } from "../migration/zero-generation.js";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";
import { createStatsRecorder } from "../stats/recorder.js";
import { createStatsStore } from "../stats/store.js";

const NOW = Date.UTC(2026, 4, 16, 12, 0, 0);
const H = 3_600_000;
const D = 86_400_000;
const at = (daysAgo: number, hoursAgo = 0, minutesLater = 0) =>
	new Date(NOW - daysAgo * D - hoursAgo * H + minutesLater * 60_000).toISOString();
const jsonl = (rows: unknown[]) =>
	`${rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const FIELDS = [
	"videoPosts",
	"posts",
	"liveSessions",
	"liveHours",
	"liveTimedSessions",
	"maxViewers",
	"avgViewers",
	"lastActivityAt",
	"activity",
] as const;

function bilibili(uids: string[]) {
	return uids.map((uid) => ({
		id: `s${uid}`,
		identity: { sourceKey: "bilibili", externalId: uid },
	}));
}

function makeDeps(dataDir: string, uids: string[], liveSubscriptionIds: string[]): RouteDeps {
	return {
		runtime: {
			fansStore: createFollowersStore({ dataRoot: dataDir, logger }),
			statsStore: createStatsStore({ dataRoot: dataDir, logger }),
			engines: {
				liveSession: (id: string) =>
					liveSubscriptionIds.includes(id) ? { subscriptionId: id } : undefined,
			},
			profileRefresh: null,
		},
		store: { getSubscriptions: () => bilibili(uids) },
		puppeteer: null,
		wsTicketStore: null,
	} as unknown as RouteDeps;
}

async function overview(
	deps: RouteDeps,
	qs: string,
	fields: readonly string[] = FIELDS,
): Promise<Record<string, Record<string, unknown>>> {
	const res = await createStatsRoute(deps).request(`/overview${qs}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as StatsOverviewResponse;
	return Object.fromEntries(
		body.rows.map((r) => [
			r.identity.externalId,
			Object.fromEntries(fields.map((f) => [f, (r as unknown as Record<string, unknown>)[f]])),
		]),
	);
}

let dataDir: string;

beforeEach(async () => {
	// 只假 Date:store 是真 fs 流,假掉 setImmediate 会把读盘卡死。
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	dataDir = await mkdtemp(join(tmpdir(), "bn-stats-overview-legacy-"));
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

describe("A. 盘上的老 B 站数据 → /overview 与改之前一致", () => {
	async function writeLegacyFixture() {
		// 0.x 的布局原样摆在第 0 代里(`zero`):作品 / 直播在 `stats/`、粉丝在 `fans/`、订阅在 `state/`
		// (盘上的 B 站订阅身份在顶层 uid),迁移器把它们迁进新的一代(`generation`),路由在新的一代上读。
		const zero = join(dataDir, "zero");
		const generation = join(dataDir, "generation");
		await mkdir(join(zero, "stats", "dyn"), { recursive: true });
		await mkdir(join(zero, "stats", "live"), { recursive: true });
		await mkdir(join(zero, "fans"), { recursive: true });
		await mkdir(join(zero, "state"), { recursive: true });
		await writeFile(join(zero, "stats", "since"), at(3, 2));
		const w = (p: string, rows: unknown[]) => writeFile(join(zero, p), jsonl(rows));
		// 101:直播推送全关(没有场次),最近的动静是一条开播公告。
		await w("stats/dyn/101.jsonl", [
			{ id: "a", type: "DYNAMIC_TYPE_AV", ts: at(5) },
			{ id: "b", type: "DYNAMIC_TYPE_WORD", ts: at(2) },
			{ id: "c", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(1) },
			{ id: "d", type: "DYNAMIC_TYPE_DRAW", ts: at(40) },
		]);
		await w(
			"fans/101.jsonl",
			Array.from({ length: 12 }, (_, i) => ({ ts: at(11 - i, 2), value: 1000 + 10 * i })),
		);
		// 102:窗口里只有开播公告,没有粉丝采样、没有场次 —— 计数该是 0,不是 null。
		await w("stats/dyn/102.jsonl", [
			{ id: "l1", type: "DYNAMIC_TYPE_LIVE", ts: at(2) },
			{ id: "l2", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(0, 3) },
		]);
		// 103:场次(含关服截断后接回、仍在播的一场)+ 比开播晚 5 分钟的开播公告。
		await w("stats/live/103.jsonl", [
			{ k: "start", ts: at(4, 5) },
			{ k: "end", ts: at(4, 2), peak: "1.2万" },
			{ k: "start", ts: at(1, 6) },
			{ k: "end", ts: at(1, 5) },
			{ k: "start", ts: at(1, 6) },
			{ k: "end", ts: at(1, 1), peak: "9000" },
			{ k: "start", ts: at(0, 2) },
		]);
		await w("stats/dyn/103.jsonl", [
			{ id: "p", type: "DYNAMIC_TYPE_DRAW", ts: at(3) },
			{ id: "r", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(0, 2, 5) },
		]);
		await w(
			"fans/103.jsonl",
			Array.from({ length: 4 }, (_, i) => ({ ts: at(3 - i, 1), value: 50_000 + 300 * i })),
		);
		// 104:一无所知。105:窗口外的老开播公告、坏行、孤立的 end、解析不出的峰值、亿。
		await w("stats/dyn/105.jsonl", [
			{ id: "old", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: at(95) },
			{ id: "v", type: "DYNAMIC_TYPE_AV", ts: at(20) },
			'{"bad',
			{ id: "x" },
			{ id: "n", type: "DYNAMIC_TYPE_SOMETHING_NEW", ts: at(6) },
		]);
		await w("stats/live/105.jsonl", [
			{ k: "end", ts: at(12), peak: "1万" },
			{ k: "start", ts: at(10, 5) },
			{ k: "end", ts: at(10, 3), peak: "看不懂" },
			{ k: "start", ts: at(8, 5) },
			{ k: "end", ts: at(8, 1), peak: "1.5亿" },
		]);
		const uids = ["101", "102", "103", "104", "105"];
		await writeFile(
			join(zero, "state", "subscriptions.json"),
			// 0.x 盘上的 B 站订阅:身份在顶层 uid、没有 identity(迁移器在迁移时收进去)。
			JSON.stringify(uids.map((uid) => ({ id: `s${uid}`, uid }))),
		);
		// 老数据按 uid 命名;迁移器把它们改成订阅 id(`s101` …)、行翻成现在的形状,路由按订阅 id 读。
		const report = await migrateZeroGeneration({
			zeroRoot: zero,
			targetDir: generation,
			// 迁移里那次历史清扫按这一刻算;这条用例不摆历史,给一个固定的时刻只为结果不随日历变。
			now: new Date("2000-01-01T00:00:00.000Z"),
		});
		// 原件断言的是旧函数的计数 `{ renamed: 8, merged: 0, copied: 0 }`;迁移器回的是改写过的文件:
		// 就是这八份(改名与翻行并成一条,粉丝文件只改名)。
		expect(
			report.rewritten.filter((path) => /^stats\/(posts|live|followers)\//.test(path)).sort(),
		).toEqual([
			"stats/followers/s101.jsonl",
			"stats/followers/s103.jsonl",
			"stats/live/s103.jsonl",
			"stats/live/s105.jsonl",
			"stats/posts/s101.jsonl",
			"stats/posts/s103.jsonl",
			"stats/posts/s105.jsonl",
		]);
		return makeDeps(generation, uids, ["s103"]);
	}

	it("近 7 日(UTC+8)", async () => {
		const deps = await writeLegacyFixture();
		expect(await overview(deps, "?days=7&tz=-480")).toEqual({
			"101": {
				videoPosts: 1,
				posts: 2,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-14T12:00:00.000Z",
				activity: [null, null, null, 0, 1, 0, 0],
			},
			"102": {
				videoPosts: null,
				posts: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [null, null, null, null, null, null, null],
			},
			"103": {
				videoPosts: 0,
				posts: 1,
				liveSessions: 3,
				liveHours: 10,
				liveTimedSessions: 3,
				maxViewers: 12000,
				avgViewers: 10500,
				lastActivityAt: "2026-05-16T10:00:00.000Z",
				activity: [null, null, null, 1, 0, 1, 1],
			},
			"104": {
				videoPosts: null,
				posts: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [null, null, null, null, null, null, null],
			},
			"105": {
				videoPosts: 0,
				posts: 1,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-10T12:00:00.000Z",
				activity: [null, null, null, 0, 0, 0, 0],
			},
		});
	});

	it("近 1 日(UTC)—— 只有开播公告的那位(公告不再记)整行是无记录 null;105 按账是 0(有意变化,见下)", async () => {
		const deps = await writeLegacyFixture();
		expect(await overview(deps, "?days=1&tz=0")).toEqual({
			"101": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
			"102": {
				videoPosts: null,
				posts: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [null],
			},
			"103": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 1,
				liveHours: 2,
				liveTimedSessions: 1,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-16T10:00:00.000Z",
				activity: [1],
			},
			"104": {
				videoPosts: null,
				posts: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [null],
			},
			// ㉖f 有意的变化:105 在 1 日窗口里改前是整行 null(老规则的「一无所知」只看窗口内的样本 / 作品 / 场次,
			// 它窗口内什么都没有),而 7 日、90 日窗口里它同一天显示 0。老规则随窗口长短变,按小时记的账表达不了;
			// 现在按账走,与它在 7 日 / 90 日窗口里的显示一致:在记、0。
			"105": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
		});
	});

	it("近 90 日(UTC-5)—— 窗口外的老行、孤立的 end、解析不出的峰值", async () => {
		const deps = await writeLegacyFixture();
		expect(
			await overview(
				deps,
				"?days=90&tz=300",
				FIELDS.filter((f) => f !== "activity"),
			),
		).toEqual({
			"101": {
				videoPosts: 1,
				posts: 3,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-14T12:00:00.000Z",
			},
			"102": {
				videoPosts: null,
				posts: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
			},
			"103": {
				videoPosts: 0,
				posts: 1,
				liveSessions: 3,
				liveHours: 10,
				liveTimedSessions: 3,
				maxViewers: 12000,
				avgViewers: 10500,
				lastActivityAt: "2026-05-16T10:00:00.000Z",
			},
			"104": {
				videoPosts: null,
				posts: null,
				liveSessions: null,
				liveHours: null,
				liveTimedSessions: null,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
			},
			"105": {
				videoPosts: 1,
				posts: 2,
				liveSessions: 2,
				liveHours: 6,
				liveTimedSessions: 2,
				maxViewers: 150000000,
				avgViewers: 150000000,
				lastActivityAt: "2026-05-10T12:00:00.000Z",
			},
		});
	});

	it("面板上的「投稿 / 动态」两个显示数(videoPosts 与 posts − videoPosts)与改之前逐个相同", async () => {
		// 下面两张表里的数是改之前 `archives` / `dynamics` 两格的值(S1 起就钉着的那批),不是按新代码抄的。
		const deps = await writeLegacyFixture();
		const shown = async (qs: string) =>
			Object.fromEntries(
				Object.entries(await overview(deps, qs, ["videoPosts", "posts"])).map(([uid, r]) => {
					const { videoPosts, posts } = r as { videoPosts: number | null; posts: number | null };
					return [
						uid,
						[videoPosts, posts === null || videoPosts === null ? null : posts - videoPosts],
					];
				}),
			);
		expect(await shown("?days=7&tz=-480")).toEqual({
			"101": [1, 1],
			"102": [null, null],
			"103": [0, 1],
			"104": [null, null],
			"105": [0, 1],
		});
		expect(await shown("?days=90&tz=300")).toEqual({
			"101": [1, 2],
			"102": [null, null],
			"103": [0, 1],
			"104": [null, null],
			"105": [1, 1],
		});
	});
});

describe("B. B 站总线事件经 B 站适配落盘 → /overview 与改之前一致", () => {
	async function recordEvents() {
		let clock = NOW - 3 * D;
		const now = () => new Date(clock);
		let authState: AuthState = {
			status: "logged-in",
			loggedInAt: "2026-05-13T00:00:00.000Z",
		};
		const handlers = new Map<string, Array<(payload?: unknown) => void>>();
		const bus = {
			on: (ev: string, h: (payload?: unknown) => void) => {
				handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
				return { dispose() {} };
			},
			emit() {},
		} as never;
		const store = createStatsStore({ dataRoot: dataDir, logger, now });
		const uids = ["201", "202", "203", "204"];
		const recorder = createStatsRecorder({
			isEnabled: () => true,
			bus,
			store,
			fans: createFollowersStore({ dataRoot: dataDir, logger }),
			fansCron: () => "*/10 * * * *",
			logger,
			now,
			// 作品与直播开关都开着(与老版本「不看开关都记」同一个结果)。
			subscriptions: () =>
				bilibili(uids).map((sub) => ({
					...sub,
					enabled: true,
					recordsPosts: true,
					recordsLive: true,
				})),
			sources: {
				get: (sourceKey) =>
					sourceKey === "bilibili"
						? ({ sourceKey, auth: { state: () => authState } } as never)
						: undefined,
			},
		});
		// 登录有效:「在记」按小时账记。老版本拿粉丝样本当「那天 B 站在看着」的证据,样本落在这几天(见文件尾);
		// 现在账记的是登记表适配对在册来源的检查(上面假登记表里放着一个已登录的 B 站来源),下面每到一天就让它看一眼
		// (`subscription-auth-changed` 立刻补记一次),天数与样本那几天一致。
		const loginChanged = () =>
			fire("subscription-auth-changed", { sourceKey: "bilibili", state: authState });
		// 落盘是 fire-and-forget,每条事件之后让它写完,免得同一文件的「先读再追加」互相踩。
		const fire = async (ev: string, payload?: unknown) => {
			for (const h of handlers.get(ev) ?? []) h(payload);
			await new Promise((r) => setTimeout(r, 15));
		};
		const open = new Map<
			string,
			{
				subscriptionId: string;
				sourceKey: string;
				startedAt: string;
				detectedAt: string;
			}
		>();
		const startLive = async (uid: string, startedAt: string) => {
			const session = {
				subscriptionId: `s${uid}`,
				sourceKey: "bilibili",
				startedAt,
				detectedAt: new Date(clock).toISOString(),
			};
			open.set(uid, session);
			await fire("live-session-changed", {
				kind: "start",
				subscriptionId: session.subscriptionId,
				session,
				trigger: "status-signal",
				details: {},
			});
		};
		const endLive = async (
			uid: string,
			endedAt: string,
			peakTotalViewers?: number,
			reason: "signal" | "stopped" = "signal",
		) => {
			const current = open.get(uid);
			if (!current) throw new Error(`live session ${uid} is not open`);
			open.delete(uid);
			await fire("live-session-changed", {
				kind: "end",
				subscriptionId: current.subscriptionId,
				session: {
					...current,
					...(peakTotalViewers === undefined ? {} : { peakTotalViewers }),
				},
				reason,
				endedAt,
			});
		};
		// 3a-27 起统计听核心入口发的 `post-detected`:有没有视频看 `post.video`,不再看 B 站的类型串;
		// 自动开播推送(`DYNAMIC_TYPE_LIVE_RCMD`)在引擎里就跳过、不交作品,所以不会有事件。
		const dyn = (uid: string, id: string, type: string, ts: string) =>
			fire("post-detected", {
				subscriptionId: `s${uid}`,
				identity: { sourceKey: "bilibili", externalId: uid },
				postId: id,
				url: `https://t.bilibili.com/${id}`,
				post: {
					creator: { name: `UP${uid}` },
					publishedAt: ts,
					text: "",
					...(type === "DYNAMIC_TYPE_AV"
						? { video: { cover: {}, title: "视频", description: "" } }
						: {}),
				},
			});

		// 201:直播推送全关,只有一条视频(开播公告引擎不交,没有事件)。
		await dyn("201", "v1", "DYNAMIC_TYPE_AV", at(2, 5));
		// 202:各种类型 + 重放。
		for (const [id, type, ts] of [
			["a", "DYNAMIC_TYPE_AV", at(2)],
			["b", "DYNAMIC_TYPE_DRAW", at(2, 1)],
			["c", "DYNAMIC_TYPE_WORD", at(1)],
			["d", "DYNAMIC_TYPE_FORWARD", at(1, 2)],
			["e", "DYNAMIC_TYPE_SOMETHING_NEW", at(0, 5)],
			["f", "DYNAMIC_TYPE_LIVE", at(0, 4)],
			["a", "DYNAMIC_TYPE_AV", at(2)],
		] as const) {
			await dyn("202", id, type, ts);
		}
		// 203:一场完整直播,本场峰值 12,000;下播带真实时刻。
		clock = NOW - 2 * D;
		await loginChanged();
		await startLive("203", at(2, 1));
		clock = NOW - 2 * D + 2 * H;
		await endLive("203", at(2, -1, 58), 12_000);
		// 204:开播时刻解析不出 → 回退此刻;登录失效之后再开一场;关服收尾。
		clock = NOW - D;
		await loginChanged();
		await startLive("204", "不是时间");
		authState = { status: "expired", message: "expired" };
		await fire("subscription-auth-changed", { sourceKey: "bilibili", state: authState });
		clock = NOW - 5 * H;
		await startLive("204", "还是不是时间");
		clock = NOW - H;
		await endLive("204", new Date(clock).toISOString(), 150_000_000, "stopped");
		await recorder.closeOpenSessions();
		clock = NOW;
		// 登录恢复了:账只在登录有效时记(从前读口恒回 true,这里要把登录口放回已登录)。
		authState = { status: "logged-in", loggedInAt: "2026-05-13T00:00:00.000Z" };
		await loginChanged();

		await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
		for (const uid of ["201", "202", "203"]) {
			await writeFile(
				join(dataDir, ...FOLLOWERS_DIR, `s${uid}.jsonl`),
				jsonl(
					Array.from({ length: 4 }, (_, i) => ({ sampledAt: at(3 - i, 1), followers: 10 * i })),
				),
			);
		}
		return makeDeps(dataDir, uids, ["s204"]);
	}

	it("近 7 日(UTC+8)", async () => {
		const deps = await recordEvents();
		expect(await overview(deps, "?days=7&tz=-480")).toEqual({
			"201": {
				videoPosts: 1,
				posts: 1,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-14T07:00:00.000Z",
				activity: [null, null, null, 0, 1, 0, 0],
			},
			"202": {
				// 3a-27 起直播类动态(`f`,08:00)记成一条不带视频的作品:作品 5 → 6、最后活动 07:00 → 08:00、
				// 当天活动数 1 → 2,其余每一格不变。
				videoPosts: 1,
				posts: 6,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-16T08:00:00.000Z",
				activity: [null, null, null, 0, 2, 2, 2],
			},
			"203": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 1,
				liveHours: 2.966666666666667,
				liveTimedSessions: 1,
				maxViewers: 12000,
				avgViewers: 12000,
				lastActivityAt: "2026-05-14T11:00:00.000Z",
				activity: [null, null, null, 0, 1, 0, 0],
			},
			"204": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 2,
				liveHours: 4,
				liveTimedSessions: 1,
				maxViewers: 150000000,
				avgViewers: 150000000,
				lastActivityAt: "2026-05-16T07:00:00.000Z",
				activity: [null, null, null, 0, 0, 1, 1],
			},
		});
	});

	it("近 1 日(UTC)", async () => {
		const deps = await recordEvents();
		expect(await overview(deps, "?days=1&tz=0")).toEqual({
			"201": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
			"202": {
				// 同上:直播类动态那一条(08:00)现在也记。
				videoPosts: 0,
				posts: 2,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: "2026-05-16T08:00:00.000Z",
				activity: [2],
			},
			"203": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 0,
				liveHours: 0,
				liveTimedSessions: 0,
				maxViewers: null,
				avgViewers: null,
				lastActivityAt: null,
				activity: [0],
			},
			"204": {
				videoPosts: 0,
				posts: 0,
				liveSessions: 1,
				liveHours: 4,
				liveTimedSessions: 1,
				maxViewers: 150000000,
				avgViewers: 150000000,
				lastActivityAt: "2026-05-16T07:00:00.000Z",
				activity: [1],
			},
		});
	});
});
