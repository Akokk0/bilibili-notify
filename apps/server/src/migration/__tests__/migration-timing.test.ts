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
 * 现在的形状、图与重推原件一个没少、每个订阅一个粉丝文件(按订阅 id 命名)、会话补齐了面孔、第 0 代没动。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HISTORY_RETENTION_DAYS } from "@bilibili-notify/internal";
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
 * ⑲c 起迁移里先跑一次历史清扫:图与重推原件只留保留期以内的那几天(两档留下的一样多),过了期的搬过来再删掉。
 * 搬与删仍随天数线性涨,留下来要改写的原件不涨,所以比值比 4 略低:实测约 3.7(满量约 35 秒、四分之一量约 9.5 秒)。
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

const countNewlines = (buffer: Buffer): number => {
	let count = 0;
	for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10, at + 1)) count += 1;
	return count;
};

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

	// 报告:「拓展订阅」那份只作输入、没进新代;聊天附件目录也是输入(每张附件都被会话引用着,没有孤儿、没有对不上的,
	// 所以只有这一条);过了保留期的图与重推原件不带过来,各记一句(⑲c)。
	// 合成的 0.x 设置没写保留天数,按默认 30 天;此刻取历史的最后一天,所以留下的是最后 31 个 UTC 日。
	const keptDays = Math.min(counts.historyDays, DEFAULT_HISTORY_RETENTION_DAYS + 1);
	const expiredDays = counts.historyDays - keptDays;
	expect(report.skipped.map((s) => s.path)).toEqual(
		expiredDays > 0
			? ["state/extension-subscriptions.json", "assets/chat", "history/img", "history/repush"]
			: ["state/extension-subscriptions.json", "assets/chat"],
	);
	expect(report.transfers).toHaveLength(
		counts.files - 1 - expiredDays * (counts.plan.historyRowsPerDay + counts.plan.repushPerDay),
	);

	// 推送历史:每天一个日文件,老行一行不少地改写成现在的行;图与重推原件只留保留期以内的那几天。
	const historyDir = join(generation, "history");
	const dayFiles = (await readdir(historyDir)).filter((name) => name.endsWith(".jsonl")).sort();
	expect(dayFiles).toHaveLength(counts.historyDays);
	expect(dayFiles[0]).toBe(`${counts.historyFirstDay}.jsonl`);
	expect(dayFiles.at(-1)).toBe(`${counts.historyLastDay}.jsonl`);
	let rows = 0;
	let notMigrated = 0;
	for (const name of dayFiles) {
		for (const line of await readLines(join(historyDir, name))) {
			const row = JSON.parse(line) as Record<string, unknown>;
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
	const rewrittenHistory = report.rewritten.filter((path) => path.startsWith("history/"));
	expect(rewrittenHistory.filter((path) => path.endsWith(".jsonl"))).toHaveLength(
		counts.historyDays,
	);
	// 迁移里先跑一次清扫(⑲c):图与重推原件只留保留期以内的那几天(`keptDays`),文字(日文件)一份不少。
	// 重推原件 `v` → `version`(⑱c):留下的每份都改写了一遍,要删的不白改写。
	expect(rewrittenHistory.filter((path) => path.startsWith("history/repush/"))).toHaveLength(
		keptDays * counts.plan.repushPerDay,
	);
	expect(await readdir(join(historyDir, "img"))).toHaveLength(
		keptDays * counts.plan.historyRowsPerDay,
	);
	const repushDays = await readdir(join(historyDir, "repush"));
	expect(repushDays).toHaveLength(keptDays);
	let snapshots = 0;
	let snapshotsNotMigrated = 0;
	for (const day of repushDays) {
		for (const name of await readdir(join(historyDir, "repush", day))) {
			const snapshot = JSON.parse(await readFile(join(historyDir, "repush", day, name), "utf8"));
			if (snapshot.version !== 1 || "v" in snapshot) snapshotsNotMigrated += 1;
			snapshots += 1;
		}
	}
	expect(snapshots).toBe(keptDays * counts.plan.repushPerDay);
	expect(snapshotsNotMigrated).toBe(0);

	// 粉丝:每个订阅一个文件、按订阅 id 命名(uid 文件并进去了,不剩),一年的点一个不少。
	const followersDir = join(generation, "stats", "followers");
	const subscriptionIds = [
		...counts.biliSubscriptions.map((s) => s.id),
		...counts.extensionSubscriptionIds,
	];
	expect((await readdir(followersDir)).sort()).toEqual(
		subscriptionIds.map((id) => `${id}.jsonl`).sort(),
	);
	for (const id of subscriptionIds) {
		const lines = countNewlines(await readFile(join(followersDir, `${id}.jsonl`)));
		expect(lines, `${id} 的粉丝点`).toBe(counts.followerRowsPerSubscription);
	}

	// 作品与直播:文件都按订阅 id 命名,老行翻成了现在的行(没有 `type`、峰值是数字)。
	let posts = 0;
	let frames = 0;
	let oldShape = 0;
	for (const id of subscriptionIds) {
		for (const line of await readLines(join(generation, "stats", "dyn", `${id}.jsonl`))) {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (row.type !== undefined || !["video", "post", "live"].includes(String(row.kind))) {
				oldShape += 1;
			}
			posts += 1;
		}
		for (const line of await readLines(join(generation, "stats", "live", `${id}.jsonl`))) {
			const frame = JSON.parse(line) as Record<string, unknown>;
			if (frame.k === "end" && typeof frame.peak !== "number") oldShape += 1;
			frames += 1;
		}
	}
	expect(posts).toBe(counts.postRows);
	expect(frames).toBe(counts.liveFrames);
	expect(oldShape).toBe(0);
	for (const { uid } of counts.biliSubscriptions) {
		expect(existsSync(join(generation, "stats", "dyn", `${uid}.jsonl`))).toBe(false);
	}

	// 订阅:两份合成一个文件({ tags, subscriptions },ADR-0034),每行带身份。
	const { subscriptions } = JSON.parse(
		await readFile(join(generation, "config", "subscriptions.json"), "utf8"),
	) as { subscriptions: { id: string; identity?: unknown }[] };
	expect(subscriptions.map((s) => s.id)).toEqual(subscriptionIds);
	expect(subscriptions.every((s) => s.identity !== undefined)).toBe(true);

	// 女仆对话补齐了面孔,技能、界面皮肤、聊天附件都过来了。
	const conversations = await readdir(join(generation, "ai", "conversations"));
	expect(conversations).toHaveLength(counts.conversations);
	for (const name of conversations) {
		const conversation = JSON.parse(
			await readFile(join(generation, "ai", "conversations", name), "utf8"),
		) as Record<string, unknown>;
		expect(conversation).toMatchObject({ persona: true });
		expect(["chat", "skin"]).toContain(conversation.mode);
		expect(conversation.messages).toHaveLength(counts.conversationMessages / counts.conversations);
	}
	expect(await readdir(join(generation, "maid-skills"))).toHaveLength(counts.maidSkills);
	// 聊天附件不整目录搬:每张都被会话引用着、内容各不相同,所以图库里正好一张不少,会话里全是图库引用。
	expect(existsSync(join(generation, "assets", "chat"))).toBe(false);
	const libraryImages = (await readdir(join(generation, "images"))).sort();
	expect(libraryImages).toHaveLength(counts.chatAttachments);
	expect(libraryImages.every(isValidImageRef)).toBe(true);
	const referenced = new Set<string>();
	for (const name of conversations) {
		const conversation = JSON.parse(
			await readFile(join(generation, "ai", "conversations", name), "utf8"),
		) as { messages: { images?: string[] }[] };
		for (const message of conversation.messages) {
			for (const ref of message.images ?? []) referenced.add(ref);
		}
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

	it("满量与四分之一量各迁一遍:比值 ≤ 6、满量 ≤ 5 分钟,耗时照实打印", {
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
