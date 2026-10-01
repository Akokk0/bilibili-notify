/**
 * 0.x 的统计与粉丝时序经迁移器进新代(`migration/stats.ts`,⑥c)。0.x 各个版本留下的形状:
 *
 *   - **文件键**(ADR-0020 决策 2 的 🔗):B 站的作品、直播、粉丝文件从 `<uid>.jsonl` 并进 `<订阅 id>.jsonl`
 *     (0.x 的 `stats/dyn`、`stats/live`、`fans/` → 新代的 `stats/dyn`、`stats/live`、`stats/followers/`);
 *   - **行**(决策 5 / 7 的 🔗):老作品行 `{id, type, ts}` → `{id, kind, ts}`,老下播帧的字符串峰值("1.2万")→ 数字。
 *
 * 两样都在搬家那一次由迁移器做,统计仓开机只认最新的形状、读时不翻。
 *
 * 前两大组用例原先钉在读时翻译与开机改名上(`stats/__tests__/legacy-rows.test.ts`、
 * `stats/__tests__/migrate-file-keys.test.ts`,两份已随它们删掉),抄到这里,期望值照旧:只是摆数据的位置从「代目录里
 * 直接写一份 uid 文件」换成「第 0 代(`stats/dyn|live`、`fans/`,订阅在 `state/subscriptions.json`、身份在顶层 uid)
 * → 迁移器 → 在新代上开真的统计仓 / 粉丝仓读回来」。**前提被迁移器推翻、不得不换写法的几处**(盘上字节断言、返回值的
 * 计数、日志、`.migrating` 残留、每次开机都跑)逐条在各用例旁边写明。
 *
 * 末一组是迁移器自己的钉:新代里不留老形状(直接读新代的文件);迁两遍和迁一遍一样。
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { CONFIG_DIR } from "../../config/store.js";
import { createFansStore, FOLLOWERS_DIR } from "../../fans/store.js";
import {
	countDynamics,
	dailyActivityCounts,
	dailyFansSeries,
	summarizeLiveSessions,
} from "../../stats/aggregate.js";
import { createStatsStore, STATS_DYN_DIR, STATS_LIVE_DIR } from "../../stats/store.js";
import { migrateStatsFiles } from "../stats.js";
import { readBiliSubscriptionKeys } from "../subscriptions.js";
import type { ZeroMigrationResult } from "../zero-generation.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-stats-");

const jsonl = (rows: readonly unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const readTarget = (rel: string) => readFile(join(sandbox.target, rel), "utf-8");

// ── 老行(原 stats/__tests__/legacy-rows.test.ts)────────────────────────────────────

const LEGACY_DYN = [
	{ id: "a", type: "DYNAMIC_TYPE_AV", ts: "2026-05-15T02:00:00.000Z" },
	{ id: "b", type: "DYNAMIC_TYPE_DRAW", ts: "2026-05-15T03:00:00.000Z" },
	{ id: "c", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: "2026-05-15T12:00:00.000Z" },
	{ id: "d", type: "DYNAMIC_TYPE_WORD", ts: "2026-05-16T01:00:00.000Z" },
	{ id: "e", type: "DYNAMIC_TYPE_FORWARD", ts: "2026-05-16T02:00:00.000Z" },
	{ id: "f", type: "DYNAMIC_TYPE_AV", ts: "2026-05-16T03:00:00.000Z" },
	{ id: "g", type: "DYNAMIC_TYPE_LIVE", ts: "2026-05-16T04:00:00.000Z" },
	{ id: "h", type: "DYNAMIC_TYPE_SOMETHING_NEW", ts: "2026-05-16T05:00:00.000Z" },
];

const LEGACY_LIVE = [
	{ k: "start", ts: "2026-05-15T12:00:00.000Z" },
	{ k: "end", ts: "2026-05-15T14:00:00.000Z", peak: "1.2万" },
	{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
	{ k: "end", ts: "2026-05-16T11:00:00.000Z" }, // 关服截断
	{ k: "start", ts: "2026-05-16T10:00:00.000Z" }, // 重启后接回同一场
	{ k: "end", ts: "2026-05-16T12:30:00.000Z", peak: "9000" },
	{ k: "start", ts: "2026-05-16T13:00:00.000Z" },
	{ k: "end", ts: "2026-05-16T13:30:00.000Z", peak: "3万" },
];

const SINCE = "2026-05-14T00:00:00.000Z";
const NOW = new Date("2026-05-16T20:00:00.000Z");

describe("老 B 站行经迁移器 → 与改之前同样的统计数(原 legacy-rows)", () => {
	// 夹具用的是 uid 当文件名(原件里就是 "1" … "5"),不配订阅:这一组只看行的翻译,文件改名归下一大组。
	beforeEach(async () => {
		await sandbox.placeZeroText("stats/dyn/1.jsonl", jsonl(LEGACY_DYN));
		await sandbox.placeZeroText("stats/live/1.jsonl", jsonl(LEGACY_LIVE));
	});

	/** 迁一代,再在新代上开真的统计仓。 */
	async function migrateAndOpen() {
		await sandbox.migrate();
		return createStatsStore({ dataRoot: sandbox.target, logger: silentLogger });
	}

	describe("老 B 站行 → 与改之前同样的统计数", () => {
		it("投稿 / 动态 / 热力图照原来的规矩归类:AV 算投稿,开播那两种不算作品也不加热力", async () => {
			const store = await migrateAndOpen();
			const events = await store.listDynamics("1", SINCE);
			const sessions = await store.listLiveSessions("1", SINCE);
			expect(countDynamics(events)).toEqual({ archives: 2, dynamics: 4 });
			expect(dailyActivityCounts(events, sessions, { days: 3, tzOffsetMin: 0, now: NOW })).toEqual([
				0, 3, 6,
			]);
		});

		it("读出来的是中立种类,B 站类型串不再往上漏;开播那两种留作 live(活动证据)", async () => {
			const store = await migrateAndOpen();
			const events = await store.listDynamics("1", SINCE);
			expect(events).toEqual([
				{ id: "a", kind: "video", ts: "2026-05-15T02:00:00.000Z" },
				{ id: "b", kind: "post", ts: "2026-05-15T03:00:00.000Z" },
				{ id: "c", kind: "live", ts: "2026-05-15T12:00:00.000Z" },
				{ id: "d", kind: "post", ts: "2026-05-16T01:00:00.000Z" },
				{ id: "e", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
				{ id: "f", kind: "video", ts: "2026-05-16T03:00:00.000Z" },
				{ id: "g", kind: "live", ts: "2026-05-16T04:00:00.000Z" },
				{ id: "h", kind: "post", ts: "2026-05-16T05:00:00.000Z" },
			]);
		});

		it("字符串峰值读成数字,场次 / 时长 / 最高 / 场均与改之前一致", async () => {
			const store = await migrateAndOpen();
			const sessions = await store.listLiveSessions("1", SINCE);
			expect(sessions.map((s) => s.peakViewers)).toEqual([12_000, 9000, 30_000]);
			expect(summarizeLiveSessions(sessions, { now: NOW, isLive: false })).toEqual({
				sessions: 3,
				hours: 5,
				timedSessions: 3,
				peakViewers: 30_000,
				avgPeakViewers: 17_000,
			});
		});

		// 原件叫「老行不迁移:读过、再往里记,盘上的老行原样还在」,断言 `raw.startsWith(jsonl(LEGACY_DYN))`。
		// 前提被迁移器推翻了(老行现在在搬家时就改写成现在的形状),那条字节断言不可能成立;留下它守的那件事:
		// **读与记都不动盘上已有的行**。写成形状无关的:迁完先记下字节,读过、再往里记之后,那串字节还在最前面。
		it("读过、再往里记,盘上已有的行原样还在", async () => {
			const store = await migrateAndOpen();
			const before = await readTarget("stats/dyn/1.jsonl");
			await store.listDynamics("1", SINCE);
			await store.appendDynamic("1", { id: "z", kind: "post", ts: "2026-05-16T19:00:00.000Z" });
			const raw = await readTarget("stats/dyn/1.jsonl");
			expect(raw.startsWith(before)).toBe(true);
			expect(raw.slice(before.length)).toContain('"id":"z"');
		});
	});

	// 这一组原件里有三处断言盘上字节 `toBe(jsonl(LEGACY_DYN))`(「老行里已有的 id」「老的开播伪动态」两条各一处),
	// 守的是「同 id 的重写不追加」。盘上现在是迁好的形状、不再等于 LEGACY_DYN,所以改成「追加前后盘上字节一样」
	// —— 形状无关,守的还是不追加。读回那半(`filter(id === "a")` 只有一条)原样。
	describe("按 id 去重跨过新老两种行", () => {
		it("老行里已有的 id,新写一条同 id 的 → 不追加,读回只有一条", async () => {
			const store = await migrateAndOpen();
			const before = await readTarget("stats/dyn/1.jsonl");
			await store.appendDynamic("1", { id: "a", kind: "video", ts: "2026-05-15T02:00:00.000Z" });
			expect(await readTarget("stats/dyn/1.jsonl")).toBe(before);
			const got = await store.listDynamics("1", SINCE);
			expect(got.filter((e) => e.id === "a")).toHaveLength(1);
		});

		it("老的开播伪动态也挡得住同 id 的重写", async () => {
			const store = await migrateAndOpen();
			const before = await readTarget("stats/dyn/1.jsonl");
			await store.appendDynamic("1", { id: "c", kind: "post", ts: "2026-05-15T12:00:00.000Z" });
			expect(await readTarget("stats/dyn/1.jsonl")).toBe(before);
		});

		it("新行之间照旧去重 —— 引擎重放同一条不虚增", async () => {
			const store = await migrateAndOpen();
			await store.appendDynamic("2", { id: "x", kind: "video", ts: "2026-05-16T01:00:00.000Z" });
			await store.appendDynamic("2", { id: "x", kind: "video", ts: "2026-05-16T01:00:00.000Z" });
			expect(await store.listDynamics("2", SINCE)).toEqual([
				{ id: "x", kind: "video", ts: "2026-05-16T01:00:00.000Z" },
			]);
		});

		it("降级期间旧版又追加了同 id 的老行 → 读的时候只认先落盘的那条,不重复计数", async () => {
			// 旧版的 append 去重只认得带 `type` 的老行,看不见新行的 id;`dynamic-detected`
			// 又不保证只发一次(投递失败走 markFail,下轮重发)。降级跑过一阵再升级回来,
			// 同一条作品在盘上就有两行 —— 不按 id 去重的话,投稿 / 动态 / 热力图全部翻倍。
			await sandbox.placeZeroText(
				"stats/dyn/5.jsonl",
				jsonl([
					{ id: "n1", kind: "video", ts: "2026-05-16T01:00:00.000Z" },
					{ id: "n1", type: "DYNAMIC_TYPE_WORD", ts: "2026-05-16T01:00:00.000Z" },
					{ id: "n2", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
					{ id: "n2", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
				]),
			);
			const store = await migrateAndOpen();
			const events = await store.listDynamics("5", SINCE);
			expect(events).toEqual([
				{ id: "n1", kind: "video", ts: "2026-05-16T01:00:00.000Z" },
				{ id: "n2", kind: "post", ts: "2026-05-16T02:00:00.000Z" },
			]);
			expect(countDynamics(events)).toEqual({ archives: 1, dynamics: 1 });
		});
	});

	describe("老峰值的边角", () => {
		it("同一场被接回、后一帧 end 的老峰值解析不出 → 这场没有峰值(与改之前同口径)", async () => {
			// 改之前:后一帧的字符串原样盖掉前一帧的,aggregate 解析失败就当这场没采到。
			// 迁移器的对应:逐帧翻不出「抹掉前一帧」,所以按场次把前面带峰值的下播帧一起剥掉。
			await sandbox.placeZeroText(
				"stats/live/3.jsonl",
				jsonl([
					{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
					{ k: "end", ts: "2026-05-16T11:00:00.000Z", peak: "1万" },
					{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
					{ k: "end", ts: "2026-05-16T12:00:00.000Z", peak: "看不懂" },
				]),
			);
			const store = await migrateAndOpen();
			const sessions = await store.listLiveSessions("3", SINCE);
			expect(sessions).toEqual([
				{ startedAt: "2026-05-16T10:00:00.000Z", endedAt: "2026-05-16T12:00:00.000Z" },
			]);
			expect(summarizeLiveSessions(sessions).peakViewers).toBeNull();
		});

		it("新老帧混在一个文件里:数字峰值与字符串峰值各自读对", async () => {
			await sandbox.placeZeroText(
				"stats/live/4.jsonl",
				jsonl([
					{ k: "start", ts: "2026-05-15T10:00:00.000Z" },
					{ k: "end", ts: "2026-05-15T11:00:00.000Z", peak: "2万" },
					{ k: "start", ts: "2026-05-16T10:00:00.000Z" },
					{ k: "end", ts: "2026-05-16T11:00:00.000Z", peak: 8000 },
				]),
			);
			const store = await migrateAndOpen();
			const sessions = await store.listLiveSessions("4", SINCE);
			expect(sessions.map((s) => s.peakViewers)).toEqual([20_000, 8000]);
		});
	});
});

// ── 文件键(原 stats/__tests__/migrate-file-keys.test.ts)────────────────────────────

const ID_A = "a0000000-0000-4000-8000-00000000000a";
const ID_B = "b0000000-0000-4000-8000-00000000000b";
const ID_EXT = "e0000000-0000-4000-8000-00000000000e";

/** 三个目录各在 0.x 的哪里(`zero`,摆数据用)、在新代的哪里(`target`,读回用)、汇报里的前缀(`report`)。 */
const DIRS = [
	{ zero: "stats/dyn", target: join(...STATS_DYN_DIR), report: STATS_DYN_DIR.join("/") },
	{ zero: "stats/live", target: join(...STATS_LIVE_DIR), report: STATS_LIVE_DIR.join("/") },
	{ zero: "fans", target: join(...FOLLOWERS_DIR), report: FOLLOWERS_DIR.join("/") },
] as const;
type Dir = (typeof DIRS)[number];

const bili = (id: string, uid: string, enabled = true) => ({
	kind: "bilibili" as const,
	id,
	uid,
	enabled,
});
const ext = (id: string) => ({
	kind: "extension" as const,
	id,
	extensionId: "douyin",
	externalId: `sec-${id}`,
});
type SubFixture = ReturnType<typeof bili> | ReturnType<typeof ext>;

const T = (d: number, h = 0) =>
	`2026-05-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

/**
 * 这一组的作品 / 直播夹具已经是现在的形状:迁移器改完名紧接着翻行,老形状的行(`type`、字符串峰值)会在改名之后
 * 被翻掉,「内容一字不动」就不成立了。这一组守的是**改名这件事**、不是行的形状(行的形状归上一大组),所以
 * 夹具摆已经翻好的行 —— 断言的形式(`toBe(DYN)` 等)原样。老形状的行跟着改名一起翻,在第一组末尾单列一条。
 */
const DYN = jsonl([{ id: "p1", kind: "video", ts: T(10) }]);
const LIVE = jsonl([
	{ k: "start", ts: T(10, 1) },
	{ k: "end", ts: T(10, 3), peak: 12_000 },
]);
const FANS = jsonl([
	{ ts: T(10), value: 100 },
	{ ts: T(11), value: 110 },
]);

describe("B 站 <uid>.jsonl → <订阅 id>.jsonl(原 migrate-file-keys)", () => {
	beforeEach(async () => {
		for (const d of DIRS) await mkdir(join(sandbox.zero, d.zero), { recursive: true });
	});

	const put = (dir: Dir, key: string, content: string) =>
		sandbox.placeZeroText(`${dir.zero}/${key}.jsonl`, content);
	const read = (dir: Dir, key: string) => readTarget(`${dir.target}/${key}.jsonl`);
	const ls = async (dir: Dir) => (await readdir(join(sandbox.target, dir.target))).sort();
	/** 汇报里统计与粉丝文件的那几条(新代里的路径,排好序):改了名的记新名字。 */
	const statsRewritten = (report: ZeroMigrationResult) =>
		report.rewritten.filter((path) => DIRS.some((d) => path.startsWith(`${d.report}/`))).sort();
	const rewrittenIn = (dir: Dir, ...keys: string[]) =>
		keys.map((key) => `${dir.report}/${key}.jsonl`);

	/** 订阅摆成 0.x 盘上的样子(B 站订阅身份在顶层 uid、没有 kind;拓展订阅在自己那份里),迁一代。 */
	async function run(subscriptions: readonly SubFixture[]) {
		await mkdir(sandbox.zero, { recursive: true });
		const bilibili = subscriptions.flatMap((s) =>
			s.kind === "bilibili" ? [{ id: s.id, uid: s.uid, enabled: s.enabled }] : [],
		);
		const extension = subscriptions.filter((s) => s.kind === "extension");
		if (bilibili.length > 0) await sandbox.placeZero("state/subscriptions.json", bilibili);
		if (extension.length > 0)
			await sandbox.placeZero("state/extension-subscriptions.json", extension);
		const report = await sandbox.migrate();
		return { rewritten: statsRewritten(report), skipped: report.skipped };
	}

	// 原件的返回值是 `{ renamed, merged, copied }` 三个计数;迁移器回的是 `report.rewritten`(改写过的文件,
	// 改了名的记新名字),下面的「改了几个」都换成「汇报里有哪几个新文件」。

	describe("第一次开机:改名", () => {
		it("三个目录各自 <uid>.jsonl → <订阅 id>.jsonl,内容一字不动", async () => {
			await put(DIRS[0], "101", DYN);
			await put(DIRS[1], "101", LIVE);
			await put(DIRS[2], "101", FANS);
			const got = await run([bili(ID_A, "101")]);
			expect(got.rewritten).toEqual(
				[
					...rewrittenIn(DIRS[0], ID_A),
					...rewrittenIn(DIRS[1], ID_A),
					...rewrittenIn(DIRS[2], ID_A),
				].sort(),
			);
			for (const [dir, content] of [
				[DIRS[0], DYN],
				[DIRS[1], LIVE],
				[DIRS[2], FANS],
			] as const) {
				expect(await ls(dir)).toEqual([`${ID_A}.jsonl`]);
				expect(await read(dir, ID_A)).toBe(content);
			}
		});

		it("老形状的行跟着改名一起翻:改好名的那份里已经是现在的形状(迁移器新增的一条,原件没有)", async () => {
			await put(DIRS[0], "101", jsonl([{ id: "p1", type: "DYNAMIC_TYPE_AV", ts: T(10) }]));
			await put(
				DIRS[1],
				"101",
				jsonl([
					{ k: "start", ts: T(10, 1) },
					{ k: "end", ts: T(10, 3), peak: "1.2万" },
				]),
			);
			const got = await run([bili(ID_A, "101")]);
			expect(got.rewritten).toEqual(
				[...rewrittenIn(DIRS[0], ID_A), ...rewrittenIn(DIRS[1], ID_A)].sort(),
			);
			expect(await ls(DIRS[0])).toEqual([`${ID_A}.jsonl`]);
			expect(await ls(DIRS[1])).toEqual([`${ID_A}.jsonl`]);
			expect(await read(DIRS[0], ID_A)).toBe(DYN);
			expect(await read(DIRS[1], ID_A)).toBe(LIVE);
		});

		it("只动有的:某个目录没有 uid 文件就跳过", async () => {
			await put(DIRS[2], "101", FANS);
			expect((await run([bili(ID_A, "101")])).rewritten).toEqual(rewrittenIn(DIRS[2], ID_A));
			expect(await ls(DIRS[0])).toEqual([]);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
		});

		it("停用的订阅照迁 —— 统计页照样列着他", async () => {
			await put(DIRS[2], "101", FANS);
			await run([bili(ID_A, "101", false)]);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
		});

		// 原件断言的是日志:迁了东西打一行 info 汇总、什么都没迁就不出声。迁移器不打日志,日志那半去掉;
		// 留下的是同一件事的汇报版 —— 迁了东西,汇报里有那份新文件;再迁一遍,什么都没迁、汇报里什么都没有。
		it("迁了东西,汇报里有那份新文件;再迁一遍什么都没迁", async () => {
			await put(DIRS[0], "101", DYN);
			const got = await run([bili(ID_A, "101")]);
			expect(got.rewritten).toEqual(rewrittenIn(DIRS[0], ID_A));
			expect(await migrateStatsFiles(sandbox.target, [{ id: ID_A, uid: "101" }])).toEqual([]);
		});

		it("数据目录还没有这几个子目录(全新安装)→ 不报错", async () => {
			// 第 0 代里什么统计目录都没有(beforeEach 摆的空目录也撤掉)。
			await rm(sandbox.zero, { recursive: true, force: true });
			await expect(run([bili(ID_A, "101")])).resolves.toMatchObject({ rewritten: [] });
		});
	});

	describe("回退过又升级回来:两份都在 → 并", () => {
		it("id 那份在前、uid 那份接在后面,uid 那份删掉", async () => {
			const before = jsonl([{ ts: T(10), value: 100 }]);
			const during = jsonl([
				{ ts: T(12), value: 120 },
				{ ts: T(13), value: 130 },
			]);
			await put(DIRS[2], ID_A, before);
			await put(DIRS[2], "101", during);
			expect((await run([bili(ID_A, "101")])).rewritten).toEqual(rewrittenIn(DIRS[2], ID_A));
			expect(await read(DIRS[2], ID_A)).toBe(before + during);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
		});

		it("id 那份末尾没换行 → 补一个再接,不把两行粘成一行", async () => {
			await put(DIRS[0], ID_A, JSON.stringify({ id: "n1", kind: "post", ts: T(10) }));
			await put(DIRS[0], "101", DYN);
			await run([bili(ID_A, "101")]);
			expect(await read(DIRS[0], ID_A)).toBe(
				`${JSON.stringify({ id: "n1", kind: "post", ts: T(10) })}\n${DYN}`,
			);
		});
	});

	// 原件还有一组「每次开机都跑 → 跑第二次什么都不动」(先把两份并好,再跑一次、各文件字节不变)。没有抄:它守的是
	// 「回退到老版本、它又写出 uid 文件、再升回来」这条每次开机重跑的路,有了代以后这条路不存在了 —— 回退再升级照用
	// 迁好的那一代,手动从第 0 代重迁也走迁移器,新代里不会冒出 uid 文件。同一件事的新版是末一大组的「迁两遍和迁一遍一样」。

	describe("半路崩了", () => {
		it("并好的内容已经换上、uid 那份还没删 → 再跑一次只删 uid 那份,不再接一遍", async () => {
			const during = jsonl([{ ts: T(12), value: 120 }]);
			await put(DIRS[2], ID_A, FANS + during); // 换上了
			await put(DIRS[2], "101", during); // 还没删
			// 原件这里 `merged: 1`(只删了 uid 那份、没有写);迁移器不写 id 那份,所以汇报里没有它。
			expect((await run([bili(ID_A, "101")])).rewritten).toEqual([]);
			expect(await read(DIRS[2], ID_A)).toBe(FANS + during);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
		});

		it("第一次开机崩在「id 那份已经写好、uid 那份还没删」→ 再跑一次只删 uid 那份,不重复", async () => {
			await put(DIRS[2], "101", FANS);
			await put(DIRS[2], ID_A, FANS); // 两份内容一样:id 那份是上次写好的
			await run([bili(ID_A, "101")]);
			expect(await read(DIRS[2], ID_A)).toBe(FANS);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
		});

		// 原件两条「.migrating」:0.x 迁到一半留下的临时文件,下次开机要清掉。迁移器搬的时候就把它当 0.x 的残留
		// 丢下了(进 `report.skipped`、不进新代),所以除了原来的断言(并的结果、目录里只剩一份),再断言这一点。
		it("临时文件写了一半没换上 → 两份原样都在,再跑一次正常并完、临时文件不留", async () => {
			const during = jsonl([{ ts: T(12), value: 120 }]);
			await put(DIRS[2], ID_A, FANS);
			await put(DIRS[2], "101", during);
			await writeFile(
				join(sandbox.zero, DIRS[2].zero, `${ID_A}.jsonl.migrating`),
				'{"ts":"2026-05-1',
			);
			const got = await run([bili(ID_A, "101")]);
			expect(await read(DIRS[2], ID_A)).toBe(FANS + during);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
			expect(got.skipped).toContainEqual({
				path: `${DIRS[2].zero}/${ID_A}.jsonl.migrating`,
				reason: expect.stringContaining("临时件"),
			});
		});

		it("走改名那条路时,上次留下的半截临时文件也清掉(读的人不认它,但别让它永远躺着)", async () => {
			// 同一个 uid 两条订阅、上次复制到一半崩了,这次其中一条已经删了 —— 剩下那条走改名。
			await put(DIRS[2], "101", FANS);
			await writeFile(
				join(sandbox.zero, DIRS[2].zero, `${ID_A}.jsonl.migrating`),
				'{"ts":"2026-05-1',
			);
			const got = await run([bili(ID_A, "101")]);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
			expect(await read(DIRS[2], ID_A)).toBe(FANS);
			expect(got.skipped).toContainEqual({
				path: `${DIRS[2].zero}/${ID_A}.jsonl.migrating`,
				reason: expect.stringContaining("临时件"),
			});
		});

		it("就算多出了重复的行,读的人也不多算:作品按 id 去重、场次照常配对、粉丝增量不变", async () => {
			const dynRows = [
				{ id: "p1", kind: "video", ts: T(10) },
				{ id: "p2", kind: "post", ts: T(11) },
			];
			const liveRows = [
				{ k: "start", ts: T(10, 1) },
				{ k: "end", ts: T(10, 3), peak: 12_000 },
				// ↓ 这三帧是「回退期间写的那段」,下面整段再接一遍
				{ k: "start", ts: T(11, 1) },
				{ k: "end", ts: T(11, 2), peak: 9000 },
				{ k: "start", ts: T(11, 20) },
			];
			const tail = [
				{ ts: T(12), value: 120 },
				{ ts: T(13), value: 90 },
			];
			const fansRows = [{ ts: T(10), value: 100 }, { ts: T(11), value: 110 }, ...tail];
			// 干净的一份
			await put(DIRS[0], "clean", jsonl(dynRows));
			await put(DIRS[1], "clean", jsonl(liveRows));
			await put(DIRS[2], "clean", jsonl(fansRows));
			// 「接了两遍」的一份:回退期间写的那段在末尾重复
			await put(DIRS[0], "dup", jsonl([...dynRows, ...dynRows.slice(1)]));
			await put(DIRS[1], "dup", jsonl([...liveRows, ...liveRows.slice(2)]));
			await put(DIRS[2], "dup", jsonl([...fansRows, ...tail]));

			// 没有订阅配 clean / dup:两组文件原名留着,读的人按这两个键读。
			await sandbox.migrate();
			const stats = createStatsStore({ dataRoot: sandbox.target, logger: silentLogger });
			const fans = createFansStore({ dataRoot: sandbox.target, logger: silentLogger });
			const since = T(1);
			expect(await stats.listDynamics("dup", since)).toEqual(
				await stats.listDynamics("clean", since),
			);
			expect(await stats.listLiveSessions("dup", since)).toEqual(
				await stats.listLiveSessions("clean", since),
			);
			const now = new Date(T(12));
			expect(
				summarizeLiveSessions(await stats.listLiveSessions("dup", since), { now, isLive: true }),
			).toEqual(
				summarizeLiveSessions(await stats.listLiveSessions("clean", since), { now, isLive: true }),
			);
			for (const target of [T(9), T(10), T(11, 12), T(12), T(13), T(20)]) {
				expect(await fans.findNearestBefore("dup", target), target).toEqual(
					await fans.findNearestBefore("clean", target),
				);
			}
			expect(await fans.findEarliest("dup")).toEqual(await fans.findEarliest("clean"));
			const series = async (key: string) =>
				dailyFansSeries(await fans.listSamplesSince(key, since), {
					days: 5,
					tzOffsetMin: 0,
					now: new Date(T(13, 12)),
				});
			expect(await series("dup")).toEqual(await series("clean"));
		});
	});

	describe("不该碰的不碰", () => {
		it("找不到 B 站订阅的 uid 文件原样留着", async () => {
			await put(DIRS[2], "999", FANS);
			await put(DIRS[2], "101", FANS);
			await run([bili(ID_A, "101"), ext(ID_EXT)]);
			expect(await ls(DIRS[2])).toEqual(["999.jsonl", `${ID_A}.jsonl`].sort());
			expect(await read(DIRS[2], "999")).toBe(FANS);
		});

		it("拓展订阅本来就按订阅 id 命名,没有什么可迁", async () => {
			await put(DIRS[0], ID_EXT, DYN);
			expect((await run([ext(ID_EXT)])).rewritten).toEqual([]);
			expect(await read(DIRS[0], ID_EXT)).toBe(DYN);
		});
	});

	// 原件里没有「单个文件出错」的用例(它的 warn 只在全新安装那条里断言过没有)。迁移器的语义是出错就抛:没有
	// 「下次开机再试」,吞掉等于把迁了一半的统计带进新代;抛出去整代作废、下次开机从第 0 代重迁。这一条是新增的钉。
	describe("出错就抛", () => {
		it("uid 文件读不了(这里造成一个目录)→ 迁移 reject,不吞", async () => {
			await mkdir(join(sandbox.zero, DIRS[2].zero, "101.jsonl"), { recursive: true });
			await expect(run([bili(ID_A, "101")])).rejects.toMatchObject({ code: "EISDIR" });
		});
	});

	describe("同一个 uid 两条 B 站订阅(服务端不判重,只有面板挡着)", () => {
		it("两条都拿到这份数据 —— 与改之前两行共读一个 uid 文件同一个结果", async () => {
			await put(DIRS[2], "101", FANS);
			const got = await run([bili(ID_A, "101"), bili(ID_B, "101", false)]);
			// 原件的 `renamed + copied === 2`:汇报里两条订阅各一份新文件。
			expect(got.rewritten).toEqual(rewrittenIn(DIRS[2], ID_A, ID_B).sort());
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`, `${ID_B}.jsonl`].sort());
			expect(await read(DIRS[2], ID_A)).toBe(FANS);
			expect(await read(DIRS[2], ID_B)).toBe(FANS);
		});

		it("复制到一半崩了 → 再跑一次补完,已经有的那份不重复", async () => {
			await put(DIRS[2], "101", FANS);
			await put(DIRS[2], ID_A, FANS); // 第一份已复制
			await run([bili(ID_A, "101"), bili(ID_B, "101")]);
			expect(await read(DIRS[2], ID_A)).toBe(FANS);
			expect(await read(DIRS[2], ID_B)).toBe(FANS);
			expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`, `${ID_B}.jsonl`].sort());
		});
	});
});

// ── 迁移器自己的钉 ──────────────────────────────────────────────────────────────────

describe("迁移器自己的钉", () => {
	const UID_A = "101";
	const UID_B = "102";
	const ORPHAN = "999";

	/**
	 * 一份有代表性的第 0 代:
	 *   - 作品:101(各类型老行 + 一行新形状的 + 一行坏行)、102、999(没有订阅,文件原名留着、行照样翻);
	 *   - 直播:101 —— 字符串峰值、接回同一场且后一帧解析不出、数字峰值、没收尾的一场;
	 *   - 粉丝:101(uid 那份)与 ID_A(回退之前的 id 那份)两份都在。
	 */
	const DYN_101 = [
		{ id: "a", type: "DYNAMIC_TYPE_AV", ts: T(10) },
		{ id: "b", type: "DYNAMIC_TYPE_WORD", ts: T(11) },
		{ id: "c", type: "DYNAMIC_TYPE_LIVE_RCMD", ts: T(12) },
		{ id: "d", kind: "video", ts: T(13) },
	];
	const BAD_LINE = '{"bad';
	const LIVE_101 = [
		{ k: "start", ts: T(10, 1) },
		{ k: "end", ts: T(10, 3), peak: "1.2万" },
		{ k: "start", ts: T(11, 1) },
		{ k: "end", ts: T(11, 2), peak: "1万" },
		{ k: "start", ts: T(11, 1) }, // 重启后接回同一场
		{ k: "end", ts: T(11, 5), peak: "看不懂" }, // 后一帧解析不出 → 这一场没有峰值,前一帧的也要剥掉
		{ k: "start", ts: T(12, 1) },
		{ k: "end", ts: T(12, 2), peak: 8000 },
		{ k: "start", ts: T(13, 1) },
	];
	const FANS_ID_BEFORE = [{ ts: T(8), value: 90 }];
	const FANS_UID = [
		{ ts: T(10), value: 100 },
		{ ts: T(11), value: 110 },
	];

	const SUBSCRIPTIONS = [
		{ id: ID_A, uid: UID_A, enabled: true },
		{ id: ID_B, uid: UID_B, enabled: false },
	];

	async function placeZeroGeneration(): Promise<void> {
		await sandbox.placeZero("state/subscriptions.json", SUBSCRIPTIONS);
		await sandbox.placeZeroText(
			`stats/dyn/${UID_A}.jsonl`,
			`${[...DYN_101.map((r) => JSON.stringify(r)), BAD_LINE].join("\n")}\n`,
		);
		await sandbox.placeZeroText(
			`stats/dyn/${UID_B}.jsonl`,
			jsonl([{ id: "e", type: "DYNAMIC_TYPE_DRAW", ts: T(10) }]),
		);
		await sandbox.placeZeroText(
			`stats/dyn/${ORPHAN}.jsonl`,
			jsonl([{ id: "f", type: "DYNAMIC_TYPE_FORWARD", ts: T(10) }]),
		);
		await sandbox.placeZeroText(`stats/live/${UID_A}.jsonl`, jsonl(LIVE_101));
		await sandbox.placeZeroText(`fans/${ID_A}.jsonl`, jsonl(FANS_ID_BEFORE));
		await sandbox.placeZeroText(`fans/${UID_A}.jsonl`, jsonl(FANS_UID));
	}

	/** 新代里统计与粉丝三个目录的每个文件:`目录/文件名 → 原文`。 */
	async function snapshot(): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const dir of [STATS_DYN_DIR, STATS_LIVE_DIR, FOLLOWERS_DIR]) {
			const abs = join(sandbox.target, ...dir);
			for (const name of (await readdir(abs).catch(() => [] as string[])).sort()) {
				out[`${dir.join("/")}/${name}`] = await readFile(join(abs, name), "utf-8");
			}
		}
		return out;
	}

	const rowsOf = (text: string) =>
		text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return line;
				}
			});

	it("新代里不留老形状:没有 <uid>.jsonl(有订阅的)、dyn 行没有 type、live 帧没有字符串 peak", async () => {
		await placeZeroGeneration();
		await sandbox.migrate();
		const files = await snapshot();

		// 改名:有订阅的 uid 文件一个都不在;新名字在;没有订阅的原名留着。
		expect(Object.keys(files).sort()).toEqual(
			[
				`stats/dyn/${ID_A}.jsonl`,
				`stats/dyn/${ID_B}.jsonl`,
				`stats/dyn/${ORPHAN}.jsonl`,
				`stats/live/${ID_A}.jsonl`,
				`stats/followers/${ID_A}.jsonl`,
			].sort(),
		);
		for (const uid of [UID_A, UID_B]) {
			for (const dir of ["stats/dyn", "stats/live", "stats/followers"]) {
				expect(Object.keys(files)).not.toContain(`${dir}/${uid}.jsonl`);
			}
		}

		// 行:每个作品文件(含没有订阅、原名留着的那份)里没有 `type`、每行有 kind;坏行与新形状行原样。
		for (const [path, text] of Object.entries(files).filter(([p]) => p.startsWith("stats/dyn/"))) {
			for (const row of rowsOf(text)) {
				if (typeof row === "string") continue;
				expect(row, path).not.toHaveProperty("type");
				expect(["video", "post", "live"], path).toContain(row.kind);
			}
		}
		const dynA = rowsOf(files[`stats/dyn/${ID_A}.jsonl`] ?? "");
		expect(dynA).toEqual([
			{ id: "a", kind: "video", ts: T(10) },
			{ id: "b", kind: "post", ts: T(11) },
			{ id: "c", kind: "live", ts: T(12) },
			{ id: "d", kind: "video", ts: T(13) },
			BAD_LINE,
		]);

		// 帧:没有字符串峰值;解析不出的那一场整场没有峰值(前一帧的 "1万" 也剥掉了),别的场峰值是数字。
		for (const [path, text] of Object.entries(files).filter(([p]) => p.startsWith("stats/live/"))) {
			for (const frame of rowsOf(text)) {
				if (typeof frame === "string") continue;
				expect(typeof frame.peak, path).not.toBe("string");
			}
		}
		expect(rowsOf(files[`stats/live/${ID_A}.jsonl`] ?? "")).toEqual([
			{ k: "start", ts: T(10, 1) },
			{ k: "end", ts: T(10, 3), peak: 12_000 },
			{ k: "start", ts: T(11, 1) },
			{ k: "end", ts: T(11, 2) },
			{ k: "start", ts: T(11, 1) },
			{ k: "end", ts: T(11, 5) },
			{ k: "start", ts: T(12, 1) },
			{ k: "end", ts: T(12, 2), peak: 8000 },
			{ k: "start", ts: T(13, 1) },
		]);

		// 两份都在的粉丝文件:id 那份在前、uid 那份接在后面。
		expect(files[`stats/followers/${ID_A}.jsonl`]).toBe(jsonl(FANS_ID_BEFORE) + jsonl(FANS_UID));
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],文件字节不变", async () => {
		await placeZeroGeneration();
		const report = await sandbox.migrate();
		expect(report.rewritten).toContain(`stats/dyn/${ID_A}.jsonl`);
		const before = await snapshot();
		expect(Object.keys(before)).toHaveLength(5);

		const subscriptions = await readBiliSubscriptionKeys(join(sandbox.target, ...CONFIG_DIR));
		expect(subscriptions).toEqual([
			{ id: ID_A, uid: UID_A },
			{ id: ID_B, uid: UID_B },
		]);
		expect(await migrateStatsFiles(sandbox.target, subscriptions ?? [])).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});
});
