/**
 * 锐评提示词里粉丝那两格的现状钉子(㉘a):`近7日粉丝` 与 `近N日粉丝`,从**真的粉丝样本文件**经 overview 的行
 * (`net7d` / `netWindow`)一路到提示词里的数。榜单与单人各验一遍,没有样本的订阅写「无记录」。
 *
 * ㉘c 压缩粉丝样本文件之后,这两个数必须一个字不变:只许改 {@link sampleRow}(夹具行的形状)。
 *
 * 取数口径:近 7 日 = overview 行里最后 7 个本地日的净增之和,近 N 日 = 窗口内全部净增之和(净增 = 当日末值 − 前一个
 * 有数据的日的末值,窗口第一天没有基线)。这里 tz=-480,「现在」是 2026-06-30T12:00Z(本地 20:00)。
 *
 * 只假装 Date,不用 waitFor。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig, Subscription } from "@bilibili-notify/internal";
import { EMPTY_AI_PROVIDER_PROFILE, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createFollowersStore, FOLLOWERS_DIR } from "../../followers/store.js";
import { createStatsOverview } from "../../routes/stats.js";
import type { RouteDeps } from "../../routes/types.js";
import type { RoastGenDeps } from "../roast-generate.js";
import { generateBoardRoast, generateSoloRoast } from "../roast-generate.js";

const comment = vi.fn(async (_content: string) => "{}");

vi.mock("@bilibili-notify/ai", async (importOriginal) => ({
	PROMPT_NEUTRAL_NOUNS: (await importOriginal<typeof import("@bilibili-notify/ai")>())
		.PROMPT_NEUTRAL_NOUNS,
	renderPromptNouns: (await importOriginal<typeof import("@bilibili-notify/ai")>())
		.renderPromptNouns,
	CommentaryGenerator: class {
		comment = comment;
		setWebSearchSource = vi.fn();
	},
	webSearchExecutorFromSettings: () => null,
}));

const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
const TZ = -480;
const DAYS = 30;
const at = (iso: string) => Date.parse(iso);

/** ㉘c 只改这一个帮手:一条粉丝样本在盘上的行。 */
function sampleRow(atMs: number, value: number): { sampledAt: string; followers: number } {
	return { sampledAt: new Date(atMs).toISOString(), followers: value };
}
type Sample = [atMs: number, value: number];

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-followers-roast-"));
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	comment.mockClear();
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});

async function writeSamples(key: string, samples: Sample[]): Promise<void> {
	await mkdir(join(dataDir, ...FOLLOWERS_DIR), { recursive: true });
	await writeFile(
		join(dataDir, ...FOLLOWERS_DIR, `${key}.jsonl`),
		samples.map(([ms, v]) => `${JSON.stringify(sampleRow(ms, v))}\n`).join(""),
	);
}

const SUBS: Subscription[] = [
	{
		id: "b-a",
		identity: { sourceKey: "bilibili", externalId: "1001" },
		enabled: true,
		overrides: {},
	} as never,
	makeExtensionSubscription({ id: "e-b", extensionId: "douyin", externalId: "s1", enabled: true }),
	{
		id: "b-c",
		identity: { sourceKey: "bilibili", externalId: "1003" },
		enabled: true,
		overrides: {},
	} as never,
];

const NAMES: Record<string, string> = { "b-a": "甲", "e-b": "乙", "b-c": "丙" };

function makeRoastDeps(): { deps: RoastGenDeps; routeDeps: RouteDeps } {
	const globals = makeDefaultGlobalConfig();
	globals.ai = {
		...globals.ai,
		enabled: true,
		provider: "custom",
		providers: {
			custom: {
				...EMPTY_AI_PROVIDER_PROFILE,
				apiKey: "k",
				baseUrl: "https://example.invalid/v1",
				model: "m",
			},
		},
	} as GlobalConfig["ai"];
	const runtime = {
		engines: {
			liveSession: () => undefined,
			extensionPlatformLabel: () => "抖音",
			extensionPostNoun: () => undefined,
		},
		profileRefresh: null,
		fansStore: createFollowersStore({
			dataRoot: dataDir,
			logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
		}),
		statsStore: {
			listPosts: async () => [],
			listLiveSessions: async () => [],
			listRecording: async () => [],
		},
		subRuntimeStore: { get: (id: string) => ({ cachedProfile: { name: NAMES[id] } }) },
		// 「平台」一列读来源登记表的 label(拓展不在表里,问装载器)。
		sourceRegistry: {
			get: (key: string) => (key === "bilibili" ? { descriptor: { label: "B 站" } } : undefined),
		},
		serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
	};
	const store = { getSubscriptions: () => SUBS, getGlobals: () => globals };
	return {
		deps: { runtime, store } as unknown as RoastGenDeps,
		routeDeps: { runtime, store } as unknown as RouteDeps,
	};
}

async function seed(): Promise<void> {
	// 甲(B 站):06-02 900 → 06-10 950 → 06-24 1000 → 06-26 1040 → 06-30(本地 10:00)1100。
	await writeSamples("b-a", [
		[at("2026-06-02T10:00:00.000Z"), 900],
		[at("2026-06-10T10:00:00.000Z"), 950],
		[at("2026-06-24T10:00:00.000Z"), 1000],
		[at("2026-06-26T10:00:00.000Z"), 1040],
		[at("2026-06-30T02:00:00.000Z"), 1100],
	]);
	// 乙(拓展):只有最近两天。
	await writeSamples("e-b", [
		[at("2026-06-29T12:00:00.000Z"), 50],
		[at("2026-06-30T02:00:00.000Z"), 60],
	]);
	// 丙:没有样本文件。
}

describe("锐评提示词里的粉丝两格:从样本文件经 overview 一路到提示词", () => {
	// 验红:把 roast-generate 的 toRoastInput 里 `net7d: row.net7d` 改成取 `row.netWindow`,甲的「近7日粉丝」变 200,榜单与单人两条都红。
	// 另一处验红:把 stats.ts 里 `net7d: days >= 7 ? sumTail(series, 7) : null` 的 7 改成 3,甲的「近7日粉丝」变 60,红。
	it("榜单:近 7 日 = 最后 7 个本地日的净增和,近 30 日 = 窗口内净增和;没有样本 → 无记录", async () => {
		await seed();
		const { deps, routeDeps } = makeRoastDeps();
		const read = createStatsOverview(routeDeps);
		await generateBoardRoast(deps, { days: DAYS, tz: TZ, fetchOverview: read });

		const prompt = String(comment.mock.calls.at(-1)?.[0]);
		const table = JSON.parse(prompt.split("\n")[1] ?? "[]") as Array<Record<string, unknown>>;
		// 甲:净增 06-10 +50、06-24 +50(与 06-10 比)、06-26 +40、06-30 +60;06-02 是窗口里第一个有样本的日、没有基线。
		//   近 7 日(06-24..06-30)= 50 + 40 + 60 = 150;近 30 日 = 50 + 50 + 40 + 60 = 200。
		// 乙:06-30 比 06-29 涨 10。丙:没有样本。
		expect(table.map((t) => [t.名称, t.近7日粉丝, t.近30日粉丝])).toEqual([
			["甲", 150, 200],
			["乙", 10, 10],
			["丙", "无记录", "无记录"],
		]);
	});

	// 验红:同上(toRoastInput 取错格),单人这一条同样红。
	it("单人:同样两格、同样的数", async () => {
		await seed();
		const { deps, routeDeps } = makeRoastDeps();
		const read = createStatsOverview(routeDeps);
		await generateSoloRoast(deps, {
			subscriptionId: "b-a",
			days: DAYS,
			tz: TZ,
			fetchOverview: read,
		});
		const data = JSON.parse(
			String(comment.mock.calls.at(-1)?.[0]).split("\n")[1] ?? "{}",
		) as Record<string, unknown>;
		expect([data.名称, data.近7日粉丝, data.近30日粉丝]).toEqual(["甲", 150, 200]);

		await generateSoloRoast(deps, {
			subscriptionId: "b-c",
			days: DAYS,
			tz: TZ,
			fetchOverview: read,
		});
		const none = JSON.parse(
			String(comment.mock.calls.at(-1)?.[0]).split("\n")[1] ?? "{}",
		) as Record<string, unknown>;
		expect([none.名称, none.近7日粉丝, none.近30日粉丝]).toEqual(["丙", "无记录", "无记录"]);
	});
});
