/**
 * 0.x 的待审锐评草稿(按 uid 回指一位 UP)经迁移器进新代(`migration/roast-drafts.ts`,ADR-0020 决策 18):
 * 单人草稿的 `uid`、结果里每一处回指都换成 B 站订阅的 id;对不上订阅的丢掉。这一步在搬家时做,草稿库开机只认
 * 最新的形状、读盘不翻。
 *
 * 前四条原先钉在草稿库读盘时翻译上(`runtime/__tests__/roast-draft-store.test.ts` 的「盘上的老草稿按 uid 找回订阅」),
 * 读时翻译删掉时抄到这里,**期望值一个没改**:只是摆数据的位置从「代目录里直接写一份老草稿」换成「第 0 代
 * (`state/roast-drafts.json` + `state/subscriptions.json`)→ 迁移器 → 在新代上开真的草稿库读回来」。
 * 草稿库开机只认现在的形状、读盘不翻,所以读回来的东西只能是迁移器产出的。
 *
 * 末两条是迁移器自己的钉:新代里不留 `uid`(直接读新代的文件);迁两遍和迁一遍一样。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { CONFIG_DIR } from "../../config/store.js";
import {
	createRoastDraftStore,
	DRAFT_TTL_MS,
	ROAST_DRAFTS_FILE,
	type RoastDraftStore,
} from "../../runtime/roast-draft-store.js";
import { migrateRoastDraftsFile } from "../roast-drafts.js";
import { readBiliSubscriptionKeys } from "../subscriptions.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-roast-drafts-");

const NOW = Date.parse("2026-09-24T00:00:00.000Z");
const alive = {
	createdAt: new Date(NOW).toISOString(),
	expiresAt: new Date(NOW + DRAFT_TTL_MS).toISOString(),
};
const SUBS: Record<string, string> = { "100": "sub-100", "200": "sub-200" };

/** 0.x 盘上的 B 站订阅行(身份在顶层 uid、没有 kind)。迁移器只认 id 与 uid 两格。 */
const SUBSCRIPTION_ROWS = Object.entries(SUBS).map(([uid, id]) => ({ id, uid, enabled: true }));

/** 在新代上开一次真的草稿库。 */
async function openStore(): Promise<RoastDraftStore> {
	const store = createRoastDraftStore({ dataRoot: sandbox.target, logger: silentLogger });
	await store.load();
	return store;
}

/** 往第 0 代摆订阅与草稿 → 迁一代 → 在新代上开草稿库。 */
async function openWith(records: unknown[]): Promise<{ reopened: RoastDraftStore }> {
	await sandbox.placeZero("state/subscriptions.json", SUBSCRIPTION_ROWS);
	await sandbox.placeZero("state/roast-drafts.json", records);
	await sandbox.migrate();
	return { reopened: await openStore() };
}

describe("RoastDraftStore — 盘上的老草稿按 uid 找回订阅", () => {
	it("老的单人草稿 → 换成那位 B 站订阅的 id,结果里的 uid 也换;不再带 uid", async () => {
		const { reopened } = await openWith([
			{
				id: "a3",
				kind: "solo",
				uid: "200",
				days: 7,
				targets: ["t1"],
				result: { uid: "200", verdict: "鸽", score: 10, highlights: [], pushText: "" },
				...alive,
			},
		]);
		const got = reopened.get("a3", NOW);
		expect(got).toMatchObject({ kind: "solo", subscriptionId: "sub-200", targets: ["t1"] });
		expect(got && "uid" in got).toBe(false);
		expect(got?.result).toEqual({
			subscriptionId: "sub-200",
			verdict: "鸽",
			score: 10,
			highlights: [],
			pushText: "",
		});
	});

	it("老的单人草稿对不上任何订阅(期间退订了)→ 丢掉", async () => {
		const { reopened } = await openWith([
			{
				id: "b4",
				kind: "solo",
				uid: "999",
				days: 7,
				targets: ["t1"],
				result: { uid: "999", verdict: "鸽", score: 10, highlights: [], pushText: "" },
				...alive,
			},
		]);
		expect(reopened.list(NOW)).toEqual([]);
	});

	it("老的榜单草稿:结果里每一处 uid 换成订阅 id;锐评 / 评分里对不上的那几条丢掉", async () => {
		const { reopened } = await openWith([
			{
				id: "c5",
				kind: "board",
				days: 30,
				targets: ["t1", "t2"],
				result: {
					pigeon: { uid: "200", reason: "鸽" },
					diligent: { uid: "100", reason: "勤" },
					roast: [
						{ uid: "200", comment: "咕" },
						{ uid: "999", comment: "退订了" },
					],
					scores: [
						{ uid: "100", score: 90 },
						{ uid: "999", score: 5 },
					],
					pushText: "周报",
				},
				...alive,
			},
		]);
		expect(reopened.get("c5", NOW)?.result).toEqual({
			pigeon: { subscriptionId: "sub-200", reason: "鸽" },
			diligent: { subscriptionId: "sub-100", reason: "勤" },
			roast: [{ subscriptionId: "sub-200", comment: "咕" }],
			scores: [{ subscriptionId: "sub-100", score: 90 }],
			pushText: "周报",
		});
	});

	it("老的榜单草稿里鸽王或勤奋 UP 对不上 → 整份丢掉(卡的主体缺一半)", async () => {
		const { reopened } = await openWith([
			{
				id: "d6",
				kind: "board",
				days: 30,
				targets: ["t1"],
				result: {
					pigeon: { uid: "999", reason: "鸽" },
					diligent: { uid: "100", reason: "勤" },
					roast: [],
					scores: [],
					pushText: "周报",
				},
				...alive,
			},
		]);
		expect(reopened.list(NOW)).toEqual([]);
	});
});

describe("迁移器自己的钉", () => {
	/** 每种老草稿各一份,外加一份已经是新形状的:单人 / 榜单 / 对不上的单人 / 对不上的榜单 / 新的单人。 */
	const DRAFTS = [
		{
			id: "a3",
			kind: "solo",
			uid: "200",
			days: 7,
			targets: ["t1"],
			result: { uid: "200", verdict: "鸽", score: 10, highlights: [], pushText: "" },
			...alive,
		},
		{
			id: "c5",
			kind: "board",
			days: 30,
			targets: ["t1", "t2"],
			result: {
				pigeon: { uid: "200", reason: "鸽" },
				diligent: { uid: "100", reason: "勤" },
				roast: [
					{ uid: "200", comment: "咕" },
					{ uid: "999", comment: "退订了" },
				],
				scores: [
					{ uid: "100", score: 90 },
					{ uid: "999", score: 5 },
				],
				pushText: "周报",
			},
			...alive,
		},
		{
			id: "b4",
			kind: "solo",
			uid: "999",
			days: 7,
			targets: ["t1"],
			result: { uid: "999", verdict: "查无此人", score: 0, highlights: [], pushText: "" },
			...alive,
		},
		{
			id: "d6",
			kind: "board",
			days: 30,
			targets: ["t1"],
			result: {
				pigeon: { uid: "999", reason: "鸽" },
				diligent: { uid: "100", reason: "勤" },
				roast: [],
				scores: [],
				pushText: "周报",
			},
			...alive,
		},
		{
			id: "e7",
			kind: "solo",
			subscriptionId: "sub-100",
			days: 7,
			targets: ["t1"],
			result: { subscriptionId: "sub-100", verdict: "勤", score: 80, highlights: [], pushText: "" },
			...alive,
		},
	];

	const draftsPath = () => join(sandbox.target, ...ROAST_DRAFTS_FILE);

	/** 递归找某个键;老形状的 `uid` 可能在草稿本身,也可能在结果里的任何一处。 */
	function hasKeyDeep(value: unknown, key: string): boolean {
		if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
		if (typeof value !== "object" || value === null) return false;
		return Object.entries(value).some(([k, v]) => k === key || hasKeyDeep(v, key));
	}

	async function placeAll(): Promise<void> {
		await sandbox.placeZero("state/subscriptions.json", SUBSCRIPTION_ROWS);
		await sandbox.placeZero("state/roast-drafts.json", DRAFTS);
	}

	it("新代里不留老形状:草稿(含 result 里每一处)没有 uid;对不上订阅的整份不在", async () => {
		await placeAll();
		const report = await sandbox.migrate();
		expect(report.rewritten).toContain("runtime/roast-drafts.json");

		const text = await readFile(draftsPath(), "utf8");
		const drafts = JSON.parse(text) as Array<Record<string, unknown>>;
		// 两份对不上的(b4、d6)丢了;其余三份在,新的那份一个字不变。
		expect(drafts.map((d) => d.id)).toEqual(["a3", "c5", "e7"]);
		expect(drafts[2]).toEqual(DRAFTS[4]);
		expect(hasKeyDeep(drafts, "uid")).toBe(false);
		expect(text).not.toContain('"uid"');
		// 回指都换成了订阅 id。
		expect(drafts[0]).toMatchObject({
			subscriptionId: "sub-200",
			result: { subscriptionId: "sub-200" },
		});
		expect(drafts[1]?.result).toMatchObject({
			pigeon: { subscriptionId: "sub-200" },
			diligent: { subscriptionId: "sub-100" },
			roast: [{ subscriptionId: "sub-200" }],
			scores: [{ subscriptionId: "sub-100" }],
		});
	});

	it("迁两遍和迁一遍一样:对新代再迁一次回 [],文件字节不变", async () => {
		await placeAll();
		await sandbox.migrate();
		const before = await readFile(draftsPath(), "utf8");
		expect(before).not.toContain('"uid"');

		const subscriptions = await readBiliSubscriptionKeys(join(sandbox.target, ...CONFIG_DIR));
		expect(subscriptions).toEqual([
			{ id: "sub-100", uid: "100" },
			{ id: "sub-200", uid: "200" },
		]);
		expect(await migrateRoastDraftsFile(draftsPath(), subscriptions ?? [])).toEqual([]);
		expect(await readFile(draftsPath(), "utf8")).toBe(before);
	});
});
