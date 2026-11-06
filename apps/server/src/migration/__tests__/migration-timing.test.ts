/**
 * 迁移耗时:一个把 0.x 用满一年的重度用户,从第 0 代迁出新的一代要停多久推送。
 *
 * 迁移期间 BN 只答健康检查、别的接口 503(开机先 listen 再迁),所以迁多久就是推送停多久。这条要回答的是主人机器上
 * 「停几分钟」,不是 CI 上的某个固定秒数 —— 绝对时间随硬件变,卡不住,所以用 2026-10-02 主人拍板的判据 C:
 *
 * - **比值**:摆一份满量(scale 1)和一份四分之一量(scale 0.25)的树,各迁一遍计时,满量 ÷ 四分之一量 ≤ 5.5(主人
 *   2026-10-02 定,实测的余量与灵敏度见 `MAX_RATIO`)。两档的每一块会涨的东西都严格是 1/4:每订阅一份的(统计、粉丝文件
 *   和行数)靠缩订阅数(40 + 4 → 10 + 1),每天一份的(历史日文件、行、图、重推原件)靠缩天数(365 → 91)。纯线性比值
 *   是 4;超线性的步骤(对已处理的行再扫一遍、按文件数平方走的查找)会把比值推过上限。比值与硬件无关。
 *   造的是 0.x 的盘:0.x 历史保留天数最多 365、文字和图一起留,满量按这个最坏情况摆(见 `synthetic-zero.ts`)。
 * - **天花板**:满量的迁移不超过 5 分钟。灾难线,不是性能目标。
 * - **照实打印**:两个耗时(秒)、文件数、行数用 `console.info` 打出来,主人在自己的机器上看「推送停多久」。
 *
 * 默认不跑:要摆两棵树(满量约 270 MB、四万六千个文件、两百四十万行),迁两遍,将近一分钟。`BN_MIGRATION_TIMING=1` 才开(CI 的专门作业与
 * 本地的脚本设它),平常的 `vp test` 与发版闸只看到一条被跳过的用例。
 *
 * 计时包的是开机真的调的那几步:`selectGeneration` → `createGeneration`(`fill` 里是 `migrateZeroGeneration`),
 * 摆树不计时。迁完还要过几条轻量的正确性检查 —— 又快又错的迁移不能算过:每天一个的历史日文件,老行都改写成了
 * 现在的形状、图与重推原件一个没少、每个订阅一个粉丝文件(按订阅 id 命名)、女仆对话与技能没带过来、第 0 代没动。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { isValidImageRef } from "../../images/image-store.js";
import { createGeneration, FORMAT_VERSION, selectGeneration } from "../../runtime/generations.js";
import {
	MIGRATION_REVISION,
	migrateZeroGeneration,
	type ZeroMigrationResult,
	zeroGenerationExists,
} from "../zero-generation.js";
import { placeSyntheticZero, type SyntheticZeroCounts } from "./synthetic-zero.js";

/**
 * 满量 ÷ 四分之一量的上限,主人 2026-10-02 定为 5.5。纯线性是 4。
 *
 * 干净的迁移实测约 4.05(六次 4.01–4.10,M 系列 Mac,满量约 29 秒、四分之一量约 7.2 秒):每一块会涨的东西都是严格的
 * 1/4(每订阅一份的靠缩订阅数,每天一份的靠缩天数),不随量变的底座只剩皮肤、技能、素材这些固定件,所以比值贴着线性
 * 的 4。上限 5 时余量只有 0.9,GitHub 的共享机器抖一下就可能误红,所以放到 5.5(余量约 1.4)。
 *
 * 灵敏度大约到:往统计那一步(作品行,满量约 3.2 万行)注入一个平方级的拖慢「每行把前面处理过的行再扫一遍」,
 * 上限 5 时实测满量多出约 9 秒能抓到(8 秒 → 4.86 没抓到,10 秒 → 5.18 红);上限 5.5 按同样的量估约 16 秒。
 * 四分之一量只有 7 秒上下,一次测量的抖动就有零点几个比值,门槛附近的结果以多跑几次为准。
 * 线性的拖慢(整体慢了几倍)比值看不出来,那是满量天花板(5 分钟)的事。
 *
 * ⑲c 起迁移里先跑一次历史清扫:图与重推原件只留保留期以内的那几天(两档留下的一样多)。
 * ⑳d 起历史图不整目录搬:保留期内的行引用的图逐张读、复制进图库(每张内容各不相同,所以真的各落一份),更早的行
 * 只拿掉图格、不读图文件。复制是迁移里最重的一步,所以两档的保留天数也按 1/4 缩(满量 60 天、四分之一量 15 天,
 * 留下 61 与 16 个日子 × 120 张);两档都用默认 30 天的话复制的张数一样多,比值掉到 1 点几、量不出越积越慢。
 * 这样摆之后实测满量约 50 秒、四分之一量约 13 秒、比值约 3.75(10-05),其中复制历史图那一步占满量的 40 秒上下。
 * 3b-53 起会话、聊天附件、女仆技能不迁(摆在盘上、迁移不碰):实测满量约 41 秒、四分之一量约 10 秒、比值约 4.09(10-16)。
 */
const MAX_RATIO = 5.5;
/** 满量迁移的天花板(秒)。 */
const MAX_FULL_SECONDS = 5 * 60;

interface Timed {
	seconds: number;
	report: ZeroMigrationResult;
	/** 每一步花的秒数(按 `onProgress` 报的一级项 / 改写族分)。 */
	steps: { label: string; seconds: number }[];
}

/** 照开机的样子迁一遍:选代 → 开新代,`fill` 里跑迁移器。计时包住这一整段。 */
async function migrateLikeBoot(hostRoot: string, now: Date): Promise<Timed> {
	const started = performance.now();
	const selection = await selectGeneration({
		hostRoot,
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		zeroGenerationExists: await zeroGenerationExists(hostRoot),
	});
	if (selection.kind !== "create" || selection.source.kind !== "zero") {
		throw new Error(`应当从第 0 代开新的一代,选到的是 ${JSON.stringify(selection)}`);
	}
	const marks: { label: string; at: number }[] = [];
	const result: { report?: ZeroMigrationResult } = {};
	await createGeneration(selection, {
		formatVersion: FORMAT_VERSION,
		migrationRevision: MIGRATION_REVISION,
		createdBy: "migration-timing",
		fill: async (partialDir) => {
			result.report = await migrateZeroGeneration({
				zeroRoot: hostRoot,
				targetDir: partialDir,
				now,
				onProgress: ({ label }) => marks.push({ label, at: performance.now() }),
			});
		},
	});
	const seconds = (performance.now() - started) / 1000;
	if (!result.report) throw new Error("迁移器没有回报告");
	// 进度是「开始做某一项」时报的,一项花的时间 = 下一次报进度的时刻 − 这一次;最后一次是「搬完了」。
	// 搬位置和改写各有一族同名(推送历史、统计……),第二次出现的标上「改写」。
	const seen = new Set<string>();
	const steps = marks.slice(0, -1).map((mark, i) => {
		const label = seen.has(mark.label) ? `${mark.label}(改写)` : mark.label;
		seen.add(mark.label);
		return { label, seconds: ((marks[i + 1]?.at ?? mark.at) - mark.at) / 1000 };
	});
	return { seconds, report: result.report, steps };
}

/** 各步耗时一行说完;不到 0.05 秒的略去。 */
const describeSteps = ({ steps }: Timed): string =>
	steps
		.filter((step) => step.seconds >= 0.05)
		.map((step) => `${step.label} ${step.seconds.toFixed(1)} 秒`)
		.join(",");

const readLines = async (path: string): Promise<string[]> =>
	(await readFile(path, "utf8")).split("\n").filter(Boolean);

/** 迁出来的这一代每一族都在、改写成了现在的形状,第 0 代没动。 */
async function expectMigrated(
	hostRoot: string,
	counts: SyntheticZeroCounts,
	{ report }: Timed,
): Promise<void> {
	const generation = join(hostRoot, "generations", "1");
	expect(existsSync(join(generation, "generation.json"))).toBe(true);
	expect(existsSync(join(hostRoot, "generations", "1.partial"))).toBe(false);

	// 报告:「拓展订阅」那份只作输入、没进新代;历史图与拓展订阅的头像目录也是输入(每个头像被资料引用着、每张历史图被一行
	// 引用着,没有孤儿、没有对不上的,所以各只有一条);聊天附件、女仆技能、女仆对话不迁(3b-53),各记一条;过了保留期的
	// 原件与图不带过来,各记一句(⑲c、⑳d)。
	// 4-11 后房号迁到 B 站自己的状态仓;合成盘还给拓展订阅摆了房号,这些不能写进 B 站,报告合记一条。
	// 合成的 0.x 设置按两档写保留天数(满量60天、四分之一量15天);此刻取历史的最后一天。
	// 「N 天」那一档按 UTC 日界算,留下的是 N + 1 个日子。
	const keptDays = Math.min(counts.historyDays, counts.plan.historyRetentionDays + 1);
	const expiredDays = counts.historyDays - keptDays;
	const keptImages = keptDays * counts.plan.historyRowsPerDay;
	expect(report.skipped.map((s) => s.path)).toEqual(
		expiredDays > 0
			? [
					"state/extension-subscriptions.json",
					"history/img",
					"assets/chat",
					"avatars",
					"maid-skills",
					"ai",
					"history/repush",
					"history/img",
					"runtime/bilibili/state.json",
				]
			: [
					"state/extension-subscriptions.json",
					"history/img",
					"assets/chat",
					"avatars",
					"maid-skills",
					"ai",
					"runtime/bilibili/state.json",
				],
	);
	const biliState = JSON.parse(
		await readFile(join(generation, "runtime", "bilibili", "state.json"), "utf8"),
	);
	expect(biliState).toEqual({
		version: 1,
		entries: Object.fromEntries(
			counts.biliSubscriptions.map(({ uid }, i) => [`room:${uid}`, String(21_000_000 + i)]),
		),
	});
	// 搬过去的:除了不进新代的(拓展订阅那份、全部历史图文件、会话、聊天附件、女仆技能),加上过了保留期的原件;反过来,
	// 保留期内的历史图各记一条复制。
	expect(report.transfers).toHaveLength(
		counts.files -
			1 -
			counts.historyImages -
			expiredDays * counts.plan.repushPerDay +
			keptImages -
			(counts.conversations + counts.chatAttachments + counts.maidSkills),
	);

	// 推送历史:每天一个日文件,老行一行不少地改写成现在的行;图与重推原件只留保留期以内的那几天。
	const historyDir = join(generation, "history");
	const dayFiles = (await readdir(historyDir)).filter((name) => name.endsWith(".jsonl")).sort();
	const keptFirstDay = (dayFiles[expiredDays] ?? "").slice(0, 10);
	expect(dayFiles).toHaveLength(counts.historyDays);
	expect(dayFiles[0]).toBe(`${counts.historyFirstDay}.jsonl`);
	expect(dayFiles.at(-1)).toBe(`${counts.historyLastDay}.jsonl`);
	let rows = 0;
	let notMigrated = 0;
	/** 行里的配图引用(保留期内的行才有)。 */
	const historyRefs = new Set<string>();
	let rowsWithImage = 0;
	for (const name of dayFiles) {
		const kept = name.slice(0, 10) >= keptFirstDay;
		for (const line of await readLines(join(historyDir, name))) {
			const row = JSON.parse(line) as Record<string, unknown>;
			// 配图格:保留期内的行是图库引用(`image`),过了保留期的拿掉了;0.x 的 `imageRef` 与头像网址都不留。
			const payload = (row.messages as { payload: Record<string, unknown> }[] | undefined)?.[0]
				?.payload;
			if (payload?.imageRef !== undefined || "uavatarSnapshot" in row) notMigrated += 1;
			if (typeof payload?.image === "string") {
				historyRefs.add(payload.image);
				rowsWithImage += 1;
				if (!kept || !isValidImageRef(payload.image)) notMigrated += 1;
			} else if (kept) {
				notMigrated += 1;
			}
			// 现在的行:推送种类那一格叫 `feature`(⑬f)、身份是一格 `identity`、时刻叫 `createdAt`(⑱b),
			// 0.x 的 `kind` / `source` / `ts` / `uid` / `unameSnapshot` 都不该再留着。
			if (
				row.feature === undefined ||
				row.identity === undefined ||
				row.createdAt === undefined ||
				"kind" in row ||
				"source" in row ||
				"ts" in row ||
				"uid" in row ||
				"unameSnapshot" in row ||
				!Array.isArray(row.messages)
			) {
				notMigrated += 1;
			}
			rows += 1;
		}
	}
	expect(rows).toBe(counts.historyRows);
	expect(notMigrated).toBe(0);
	// 保留期内的每行一张互不相同的图,各落一份进图库;过了保留期的行一张都没有。
	expect(rowsWithImage).toBe(keptImages);
	expect(historyRefs.size).toBe(keptImages);
	const rewrittenHistory = report.rewritten.filter((path) => path.startsWith("history/"));
	expect(rewrittenHistory.filter((path) => path.endsWith(".jsonl"))).toHaveLength(
		counts.historyDays,
	);
	// 迁移里先跑一次清扫(⑲c):图与重推原件只留保留期以内的那几天(`keptDays`),文字(日文件)一份不少。
	// 重推原件 `v` → `version`(⑱c):留下的每份都改写了一遍,要删的不白改写。
	expect(rewrittenHistory.filter((path) => path.startsWith("history/repush/"))).toHaveLength(
		keptDays * counts.plan.repushPerDay,
	);
	// 历史图不进新代(留在图库里)。
	expect(existsSync(join(historyDir, "img"))).toBe(false);
	const repushDays = await readdir(join(historyDir, "repush"));
	expect(repushDays).toHaveLength(keptDays);
	let snapshots = 0;
	let snapshotsNotMigrated = 0;
	for (const day of repushDays) {
		for (const name of await readdir(join(historyDir, "repush", day))) {
			const snapshot = JSON.parse(await readFile(join(historyDir, "repush", day, name), "utf8"));
			if (snapshot.version !== 1 || "v" in snapshot) snapshotsNotMigrated += 1;
			// 原件里的图格是图库引用(字符串),不再是 `{ ref, mime }`。
			const image = snapshot.messages?.[0]?.payload?.image;
			if (typeof image !== "string" || !isValidImageRef(image)) snapshotsNotMigrated += 1;
			snapshots += 1;
		}
	}
	expect(snapshots).toBe(keptDays * counts.plan.repushPerDay);
	expect(snapshotsNotMigrated).toBe(0);

	// 粉丝:每个订阅一个文件、按订阅 id 命名(uid 文件并进去了,不剩),都是新形状、压过了(㉘c,「现在」是历史的最后一天
	// 的 12:00Z,切线是 09-22T12:00Z)。每个文件的行数闭式可算:
	//   - 样本是 2025-10-01T00:00Z 起每 10 分钟一条、一年(最后一条 2026-09-30T23:50Z)。
	//   - 切线之后原样:09-22 的 12:00–23:50 是 72 条,之后 8 天各 144 条 = 1152,共 1224 行。
	//   - 切线之前是 2025-10-01 00 点到 2026-09-22 11 点的小时,356 × 24 + 12 = 8556 个,每小时都有样本。值每十分钟都在变的
	//     文件,每小时留最晚的一条(小时序号 h 的值 = base + ⌊h/2⌋ + h % 5,相邻小时的差只会是 1、2、−3、−4,永远合不了),
	//     就是 8556 行,合计 8556 + 1224 = 9780;粉丝数一整年不变的文件,8556 个小时连着、同值,合成 1 段,合计 1 + 1224 = 1225。
	const FLAT_ROWS = 1225;
	const VARYING_ROWS = 9780;
	const followersDir = join(generation, "stats", "followers");
	const subscriptionIds = [
		...counts.biliSubscriptions.map((s) => s.id),
		...counts.extensionSubscriptionIds,
	];
	expect((await readdir(followersDir)).sort()).toEqual(
		subscriptionIds.map((id) => `${id}.jsonl`).sort(),
	);
	const followerLines: Record<string, string[]> = {};
	for (const id of subscriptionIds) {
		followerLines[id] = await readLines(join(followersDir, `${id}.jsonl`));
	}
	const lengths = Object.values(followerLines).map((lines) => lines.length);
	expect(lengths.filter((n) => n === FLAT_ROWS)).toHaveLength(counts.flatFollowerFiles);
	expect(lengths.filter((n) => n === VARYING_ROWS)).toHaveLength(
		subscriptionIds.length - counts.flatFollowerFiles,
	);
	// 第 0 份(base = 100000)是不变的那种:一整段;第 1 份(base = 105000)每小时一个点,末一条是最后一个样本。
	const [flatId, varyingId] = subscriptionIds as [string, string];
	expect(followerLines[flatId]?.[0]).toBe(
		'{"sampledAt":"2025-10-01T00:50:00.000Z","followers":100000,"lastSampledAt":"2026-09-22T11:50:00.000Z"}',
	);
	expect(followerLines[flatId]?.[1]).toBe(
		'{"sampledAt":"2026-09-22T12:00:00.000Z","followers":100000}',
	);
	expect(followerLines[varyingId]?.[0]).toBe(
		'{"sampledAt":"2025-10-01T00:50:00.000Z","followers":105000}',
	);
	expect(followerLines[varyingId]?.at(-1)).toBe(
		'{"sampledAt":"2026-09-30T23:50:00.000Z","followers":109383}',
	);
	// 没有一行还是 0.x 的形状。
	for (const lines of Object.values(followerLines)) {
		expect(lines.some((line) => line.includes('"ts"') || line.includes('"value"'))).toBe(false);
	}

	// 作品与直播:文件都按订阅 id 命名,老行翻成了现在的行(作品住 stats/posts、没有 `type` / `kind`,帧是
	// { kind, occurredAt, peakTotalViewers? }、峰值是数字);开播公告没带过来,所以作品行数是留下的那些。
	let posts = 0;
	let frames = 0;
	let oldShape = 0;
	for (const id of subscriptionIds) {
		for (const line of await readLines(join(generation, "stats", "posts", `${id}.jsonl`))) {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (
				Object.keys(row).sort().join() !== "hasVideo,id,publishedAt" ||
				typeof row.hasVideo !== "boolean"
			) {
				oldShape += 1;
			}
			posts += 1;
		}
		for (const line of await readLines(join(generation, "stats", "live", `${id}.jsonl`))) {
			const frame = JSON.parse(line) as Record<string, unknown>;
			if ("k" in frame || "ts" in frame || "peak" in frame) oldShape += 1;
			if (frame.kind === "end" && typeof frame.peakTotalViewers !== "number") oldShape += 1;
			frames += 1;
		}
	}
	expect(posts).toBe(counts.postRows);
	expect(frames).toBe(counts.liveFrames);
	expect(oldShape).toBe(0);
	for (const { uid } of counts.biliSubscriptions) {
		expect(existsSync(join(generation, "stats", "dyn"))).toBe(false);
		expect(existsSync(join(generation, "stats", "posts", `${uid}.jsonl`))).toBe(false);
	}

	// 「在记」小账由迁移从老数据推出来(㉖f):每条有数据的订阅一个文件、行是 `{kind, startedAt, endedAt}` 的区间;
	// 旧的 `stats/seen/` 与水位线 `stats/since` 读完就删,新代里没有。
	expect(existsSync(join(generation, "stats", "seen"))).toBe(false);
	expect(existsSync(join(generation, "stats", "since"))).toBe(false);
	const recordingFiles = await readdir(join(generation, "stats", "recording"));
	expect(recordingFiles.length).toBeGreaterThan(0);
	for (const name of recordingFiles) {
		for (const line of await readLines(join(generation, "stats", "recording", name))) {
			const row = JSON.parse(line) as Record<string, unknown>;
			expect(Object.keys(row).sort().join()).toBe("endedAt,kind,startedAt");
		}
	}

	// 运行记录由迁移从粉丝样本推出来(㉗b):合成盘每个订阅都是 2025-10-01 00:00 起每 10 分钟一条、连续 365 天
	// (最后一条在 2026-09-30 23:50),各订阅时刻对齐、合并去重后是一整段,于是 365 × 24 = 8760 个小时一小时一行,
	// 前 8759 行各 60 分钟、最后一行(23 点)50 分钟,合计 8759 × 60 + 50 = 525590 分钟。
	const uptimeRows = (await readLines(join(generation, "uptime", "hours.jsonl"))).map(
		(line) => JSON.parse(line) as { hourStartedAt: string; minutes: number },
	);
	expect(uptimeRows).toHaveLength(8760);
	expect(uptimeRows[0]).toEqual({ hourStartedAt: "2025-10-01T00:00:00.000Z", minutes: 60 });
	expect(uptimeRows[8758]).toEqual({ hourStartedAt: "2026-09-30T22:00:00.000Z", minutes: 60 });
	expect(uptimeRows[8759]).toEqual({ hourStartedAt: "2026-09-30T23:00:00.000Z", minutes: 50 });
	expect(uptimeRows.reduce((sum, row) => sum + row.minutes, 0)).toBe(525_590);

	// 订阅:两份合成一个文件({ tags, subscriptions },ADR-0034),每行带身份。
	const { subscriptions } = JSON.parse(
		await readFile(join(generation, "config", "subscriptions.json"), "utf8"),
	) as { subscriptions: { id: string; identity?: unknown }[] };
	expect(subscriptions.map((s) => s.id)).toEqual(subscriptionIds);
	expect(subscriptions.every((s) => s.identity !== undefined)).toBe(true);

	// 女仆对话、女仆技能、聊天附件不迁(3b-53):新代里没有它们,图库里也没有 0.x 的附件;界面皮肤过来了。
	expect(existsSync(join(generation, "ai"))).toBe(false);
	expect(existsSync(join(generation, "maid-skills"))).toBe(false);
	// 聊天附件与拓展订阅的头像都不整目录搬:头像每个都被资料缓存引用着、内容各不相同,所以图库里正好一张不少,
	// 资料里全是图库引用;附件一张都不进图库。
	expect(existsSync(join(generation, "assets", "chat"))).toBe(false);
	expect(existsSync(join(generation, "avatars"))).toBe(false);
	const libraryImages = (await readdir(join(generation, "images"))).sort();
	expect(libraryImages).toHaveLength(counts.extensionSubscriptionIds.length + keptImages);
	expect(libraryImages.every(isValidImageRef)).toBe(true);
	// 引用图库的有两家:资料缓存,和保留期内的历史行(原件指的是这些行的同一批图)。
	const referenced = new Set<string>(historyRefs);
	// 资料缓存:拓展订阅头像是图库引用;B 站远端头像地址不保留。
	const profiles = JSON.parse(
		await readFile(join(generation, "runtime", "subscription-state.json"), "utf8"),
	) as Record<string, { cachedProfile?: { avatar?: string; avatarUrl?: string } }>;
	for (const id of counts.extensionSubscriptionIds) {
		const avatar = profiles[id]?.cachedProfile?.avatar ?? "";
		expect(isValidImageRef(avatar), `${id} 的头像`).toBe(true);
		referenced.add(avatar);
	}
	for (const { id } of counts.biliSubscriptions) {
		expect(profiles[id]?.cachedProfile).not.toHaveProperty("avatarUrl");
		expect(profiles[id]?.cachedProfile).not.toHaveProperty("avatar");
	}
	expect([...referenced].sort()).toEqual(libraryImages);
	const active = JSON.parse(
		await readFile(join(generation, "skins", "dashboard", "active.json"), "utf8"),
	) as Record<string, unknown>;
	expect(active).toEqual({ light: "skin-1" });

	// 第 0 代没动:历史还是老行,uid 命名的粉丝文件还在。
	const firstUid = counts.biliSubscriptions[0]?.uid ?? "";
	expect(
		(await readLines(join(hostRoot, "history", `${counts.historyFirstDay}.jsonl`)))[0],
	).toContain('"source"');
	expect(existsSync(join(hostRoot, "fans", `${firstUid}.jsonl`))).toBe(true);
}

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

describe.skipIf(process.env.BN_MIGRATION_TIMING !== "1")("迁移耗时:一年的重数据", () => {
	const roots: string[] = [];

	// 删五万个文件要几秒到几十秒,比钩子默认的 10 秒长。
	afterAll(async () => {
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	}, 5 * 60_000);

	it("满量与四分之一量各迁一遍:比值 ≤ 5.5、满量 ≤ 5 分钟,耗时照实打印", {
		timeout: 15 * 60_000,
	}, async () => {
		const quarterRoot = await mkdtemp(join(tmpdir(), "bn-migration-timing-quarter-"));
		const fullRoot = await mkdtemp(join(tmpdir(), "bn-migration-timing-full-"));
		roots.push(quarterRoot, fullRoot);

		// 摆树不计时。
		const quarterCounts = await placeSyntheticZero(quarterRoot, 0.25);
		const fullCounts = await placeSyntheticZero(fullRoot, 1);
		expect([fullCounts.biliSubscriptions.length, quarterCounts.biliSubscriptions.length]).toEqual([
			40, 10,
		]);
		expect([
			fullCounts.extensionSubscriptionIds.length,
			quarterCounts.extensionSubscriptionIds.length,
		]).toEqual([4, 1]);
		expect([fullCounts.days, quarterCounts.days]).toEqual([365, 365]);
		expect([fullCounts.historyDays, quarterCounts.historyDays]).toEqual([365, 91]);
		expect([fullCounts.historyRows, quarterCounts.historyRows]).toEqual([43_800, 10_920]);
		expect([fullCounts.repushSnapshots, quarterCounts.repushSnapshots]).toEqual([1825, 455]);
		expect([
			fullCounts.followerRowsPerSubscription,
			quarterCounts.followerRowsPerSubscription,
		]).toEqual([52_560, 52_560]);

		// 迁移里那次历史清扫按「历史的最后一天」算,结果不随跑测试的日历变。
		const now = new Date(`${fullCounts.historyLastDay}T12:00:00.000Z`);
		const quarter = await migrateLikeBoot(quarterRoot, now);
		const full = await migrateLikeBoot(fullRoot, now);
		const ratio = full.seconds / quarter.seconds;

		console.info(
			`[迁移耗时] 一年的重数据:1 倍 ${full.seconds.toFixed(1)} 秒(${fullCounts.files} 个文件、${fullCounts.jsonlLines} 行),1/4 倍 ${quarter.seconds.toFixed(1)} 秒(${quarterCounts.files} 个文件、${quarterCounts.jsonlLines} 行),比值 ${ratio.toFixed(2)}`,
		);
		console.info(
			`[迁移耗时] 数据量:1 倍 ${fullCounts.days} 天、${megabytes(fullCounts.bytes)} MB(推送历史 ${fullCounts.historyDays} 天 ${fullCounts.historyRows} 行、图 ${fullCounts.historyImages} 张、粉丝 ${fullCounts.followerRows} 行),1/4 倍 ${quarterCounts.days} 天、${megabytes(quarterCounts.bytes)} MB(推送历史 ${quarterCounts.historyDays} 天 ${quarterCounts.historyRows} 行、粉丝 ${quarterCounts.followerRows} 行)`,
		);
		console.info(`[迁移耗时] 1 倍各步:${describeSteps(full)}`);
		console.info(`[迁移耗时] 1/4 倍各步:${describeSteps(quarter)}`);

		await expectMigrated(quarterRoot, quarterCounts, quarter);
		await expectMigrated(fullRoot, fullCounts, full);

		// 比值在前:超线性的步骤要先点它的名,不能被天花板抢先。
		expect(
			ratio,
			`1 倍 ${full.seconds.toFixed(1)} 秒 ÷ 1/4 倍 ${quarter.seconds.toFixed(1)} 秒:数据量 4 倍、耗时超过 ${MAX_RATIO} 倍,有超线性的步骤`,
		).toBeLessThanOrEqual(MAX_RATIO);
		expect(
			full.seconds,
			`1 倍的迁移 ${full.seconds.toFixed(1)} 秒,超过了 ${MAX_FULL_SECONDS} 秒的灾难线`,
		).toBeLessThanOrEqual(MAX_FULL_SECONDS);
	});
});
