/**
 * 守卫 10 的判官:一份出图字节是不是清单批准过的(ADR-0028 决策 2)。
 *
 * 用合成的样例名与 hash 测,不碰真卡片 —— 真卡片的接线在 `card-baseline.test.ts`。
 */

import { describe, expect, it } from "vite-plus/test";
import { type CardDiffList, cardDiffIssues, orphanedCardDiffIssues } from "./card-diff-check";

const LIST: CardDiffList = {
	baseline: { "live-on": "aaaa", "sc-basic": "bbbb" },
	approvals: [
		{
			sample: "sc-basic",
			category: "platform-neutral-naming",
			change: "「SC」改写成「醒目留言」",
			basis: "示例",
			hash: "cccc",
		},
		{
			sample: "sc-basic",
			category: "master-approved",
			change: "金额去掉千分位",
			basis: "示例",
			approvedOn: "2026-10-02",
			hash: "dddd",
		},
	],
};

describe("cardDiffIssues", () => {
	it("和起点一致、清单里没有后续批准 → 没问题", () => {
		expect(cardDiffIssues("live-on", "aaaa", LIST)).toEqual([]);
	});

	it("认的是这个样例**最后一条**批准,不是起点也不是中间那条", () => {
		expect(cardDiffIssues("sc-basic", "dddd", LIST)).toEqual([]);
		expect(cardDiffIssues("sc-basic", "bbbb", LIST)).toHaveLength(1);
		expect(cardDiffIssues("sc-basic", "cccc", LIST)).toHaveLength(1);
	});

	it("字节变了而清单没跟上 → 一条问题,写明现在的 hash 和要补的那一条", () => {
		const [issue] = cardDiffIssues("live-on", "eeee", LIST);
		expect(issue?.path).toEqual(["live-on"]);
		expect(issue?.message).toContain("eeee");
		expect(issue?.message).toContain("aaaa");
		expect(issue?.message).toContain('sample: "live-on"');
	});

	it("清单里压根没有这个样例(新加的夹具) → 一条问题,叫人在起点里补一行", () => {
		const [issue] = cardDiffIssues("wordcloud-new", "ffff", LIST);
		expect(issue?.path).toEqual(["wordcloud-new"]);
		expect(issue?.message).toContain("ffff");
		expect(issue?.message).toContain("baseline");
	});
});

describe("orphanedCardDiffIssues", () => {
	it("起点与批准里点名的样例都还在 → 没问题", () => {
		expect(orphanedCardDiffIssues(["live-on", "sc-basic"], LIST)).toEqual([]);
	});

	it("点名了一个已经没有的样例(改名、删夹具、打错字) → 起点和批准各报一条", () => {
		const issues = orphanedCardDiffIssues(["live-on"], LIST);
		expect(issues.map((i) => i.path)).toEqual([
			["baseline", "sc-basic"],
			["approvals", 0],
			["approvals", 1],
		]);
	});
});
