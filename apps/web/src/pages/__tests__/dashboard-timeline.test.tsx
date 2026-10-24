// @vitest-environment jsdom
/**
 * 概览页「最近推送活动」的行是谁(ADR-0019 决策 73)。
 *
 * 行先认订阅、再认人(与历史页、服务端重推同一条规矩);名字依次取写入期快照 → 对到的订阅 → 身份:
 * B 站行「UID xxx」,拓展行「平台名 · 外部 id」—— 平台名照已装拓展的清单,拓展卸载了取不到就写拓展 id。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { HistoryEntryView } from "../../services/dashboard";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import { TimelinePanel } from "../Dashboard";

afterEach(cleanup);

function row(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return {
		id: "h1",
		pushId: "p1",
		createdAt: new Date().toISOString(),
		feature: "post",
		status: "delivered",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: "s-gone",
		targetId: null,
		messages: [{ text: "一条推送", kind: "text", role: "main", ok: true }],
		...over,
	};
}

function extRow(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return row({ identity: { sourceKey: "douyin", externalId: "sec-1" }, ...over });
}

/** 装着的抖音订阅源 —— 平台名照它的清单。 */
const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 2,
	provides: ["subscription"],
	subscription: {
		display: { label: "抖音", shortLabel: "抖", color: "#161823" },
		events: ["post", "liveStart", "liveEnd"],
	},
} as ExtensionDTO;

function renderPanel(
	entries: HistoryEntryView[],
	subs: Subscription[] = [],
	extensions?: readonly ExtensionDTO[],
) {
	return render(
		<MemoryRouter initialEntries={["/"]}>
			<TimelinePanel entries={entries} subs={subs} targets={[]} extensions={extensions} />
		</MemoryRouter>,
	);
}

describe("最近推送活动 · 行是谁", () => {
	it("B 站行:没有快照、订阅也对不上 → 「UID xxx」(照旧)", () => {
		renderPanel([row()]);
		expect(screen.getByText("UID u1")).toBeTruthy();
	});

	it("拓展行:没有快照、订阅也对不上 → 「平台名 · 外部 id」", () => {
		renderPanel([extRow()], [], [DOUYIN]);
		expect(screen.getByText("抖音 · sec-1")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	it("拓展卸载了(清单里没有它)→ 平台名写拓展 id", () => {
		renderPanel([extRow()], [], []);
		expect(screen.getByText("douyin · sec-1")).toBeTruthy();
	});

	it("拓展行有名字快照 → 写快照", () => {
		renderPanel([extRow({ nameSnapshot: "某抖音号" })], [], [DOUYIN]);
		expect(screen.getByText("某抖音号")).toBeTruthy();
		expect(screen.queryByText("抖音 · sec-1")).toBeNull();
	});

	it("拓展行的订阅删了、同一个人又加了一条 → 写现在那条的名字", () => {
		const readded: Subscription = {
			...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-1" }),
			cachedProfile: {
				name: "现在的抖音号",
				refreshedAt: "2026-09-24T00:00:00Z",
			},
		};
		renderPanel([extRow()], [readded], [DOUYIN]);
		expect(screen.getByText("现在的抖音号")).toBeTruthy();
	});

	it("拓展行的外部 id 恰好等于某个 B 站 uid → 不认成那位 B 站 UP", () => {
		const bili: Subscription = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "u1" }),
			cachedProfile: {
				name: "某B站UP",
				refreshedAt: "2026-09-24T00:00:00Z",
			},
		};
		renderPanel(
			[extRow({ identity: { sourceKey: "douyin", externalId: "u1" } })],
			[bili],
			[DOUYIN],
		);
		expect(screen.queryByText("某B站UP")).toBeNull();
		expect(screen.getByText("抖音 · u1")).toBeTruthy();
	});
});

/**
 * 拓展行带一枚平台徽章(ADR-0019 决策 9「订阅删了也看得出是哪个平台的」),画法同「正在直播」:
 * 短名照清单,拓展卸载了取不到写拓展 id。名字取自快照还是身份兜底都带;B 站行不画。
 */
describe("最近推送活动 · 平台徽章", () => {
	/**
	 * 行上各枚徽章的字。按 `data-bn="badge"` 取而不是 `getByText`:头像画的是名字的首字,
	 * 「抖音 · sec-1」的头像恰好也是一个「抖」,按字找会把头像当成徽章。
	 */
	function badgeTexts(container: HTMLElement): (string | null)[] {
		return [...container.querySelectorAll('[data-bn="badge"]')].map((b) => b.textContent);
	}

	it("拓展行带平台徽章(短名照清单),名字取自快照也带", () => {
		const { container } = renderPanel([extRow({ nameSnapshot: "某抖音号" })], [], [DOUYIN]);
		expect(badgeTexts(container)).toContain("抖");
		expect(screen.getByText("某抖音号")).toBeTruthy();
	});

	it("名字是身份兜底的拓展行也带徽章", () => {
		const { container } = renderPanel([extRow()], [], [DOUYIN]);
		expect(badgeTexts(container)).toContain("抖");
		expect(screen.getByText("抖音 · sec-1")).toBeTruthy();
	});

	it("拓展卸载了(清单里没有它)→ 徽章写拓展 id", () => {
		const { container } = renderPanel([extRow({ nameSnapshot: "某抖音号" })], [], []);
		expect(badgeTexts(container)).toContain("douyin");
	});

	it("B 站行没有平台徽章:只有类型与状态那两枚", () => {
		const { container } = renderPanel([row({ nameSnapshot: "某UP" })], [], [DOUYIN]);
		expect(badgeTexts(container)).toEqual(["动态", "已送达"]);
	});
});

describe("最近推送活动 · 左列时间", () => {
	const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

	it("写「N 分钟前」(数字和单位之间带空格);解析不了的时刻写「—」", () => {
		renderPanel([
			row({ id: "h1", createdAt: agoIso(59 * 60_000 + 5_000) }),
			row({ id: "h2", createdAt: agoIso(3 * 3_600_000 + 5_000) }),
			row({ id: "h3", createdAt: agoIso(10_000) }),
			row({ id: "h4", createdAt: "不是时刻" }),
		]);
		expect(screen.getByText("59 分钟前")).toBeTruthy();
		expect(screen.getByText("3 小时前")).toBeTruthy();
		expect(screen.getByText("刚刚")).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("左列不换行,竖线的横位置跟着左列宽度走(宽 N → 线在 N+4)", () => {
		// 带空格的「59 分钟前」比不带空格时更宽,窄槽里会折行;所以这一列不许换行。
		// 竖线 `left-M` 要压在圆点那一列的起点上:列宽 N + 行间距 gap-3(3) + 容器 pl-1(1) = N + 4。
		// 单测里没有布局,只能钉这条换算 —— 改了一边忘了另一边,线就偏出圆点。
		const { container } = renderPanel([row({ createdAt: agoIso(59 * 60_000 + 5_000) })]);
		const col = screen.getByText("59 分钟前");
		expect(col.className).toContain("whitespace-nowrap");
		const width = Number(/(?:^|\s)w-(\d+)(?:\s|$)/.exec(col.className)?.[1]);
		const rail = container.querySelector(".absolute.w-0\\.5");
		const left = Number(/(?:^|\s)left-(\d+)(?:\s|$)/.exec(rail?.className ?? "")?.[1]);
		expect(Number.isFinite(width)).toBe(true);
		expect(left).toBe(width + 4);
	});
});

/**
 * 被静音 / 免扰挡下的行不算推送:首页这一栏说的是「发出去的推送」,不列它(历史页照列)。
 */
describe("最近推送活动 · 不列被挡下的行", () => {
	const silenced = (id: string, name: string) =>
		row({
			id,
			status: "silenced",
			targetId: "22222222-2222-4222-8222-222222222222",
			nameSnapshot: name,
			messages: [{ text: "被挡的", kind: "text", role: "main", isSilenced: true }],
		});

	it("混在一起:只列发出去过的", () => {
		renderPanel([
			silenced("s1", "静音甲"),
			row({ id: "d1", nameSnapshot: "发出去的" }),
			silenced("s2", "静音乙"),
		]);
		expect(screen.getByText("发出去的")).toBeTruthy();
		expect(screen.queryByText("静音甲")).toBeNull();
		expect(screen.queryByText("静音乙")).toBeNull();
		expect(screen.queryByText("已静音")).toBeNull();
	});

	it("被挡的行不占那六个位子:前面全是被挡的,后面发出去的照样列得出来", () => {
		renderPanel([
			...Array.from({ length: 8 }, (_, i) => silenced(`s${i}`, `静音${i}`)),
			row({ id: "d1", nameSnapshot: "第九条" }),
		]);
		expect(screen.getByText("第九条")).toBeTruthy();
	});

	it("全是被挡的 → 空态", () => {
		renderPanel([silenced("s1", "静音甲")]);
		expect(screen.getByText("还没有推送活动")).toBeTruthy();
	});

	// 被过滤的作品留的那一行同理:它压根不是推送。它的目标那一格也空着,但不当无目标行列出来。
	it("被过滤的行也不列、不占位子", () => {
		const filtered = (id: string, name: string) =>
			row({
				id,
				status: "filtered",
				filteredBy: "blocked-keyword",
				targetId: null,
				nameSnapshot: name,
				messages: [{ text: "摘要", kind: "text", role: "main" }],
			});
		renderPanel([
			...Array.from({ length: 8 }, (_, i) => filtered(`f${i}`, `过滤${i}`)),
			row({ id: "d1", nameSnapshot: "第九条" }),
		]);
		expect(screen.getByText("第九条")).toBeTruthy();
		expect(screen.queryByText("过滤0")).toBeNull();
		expect(screen.queryByText("已过滤")).toBeNull();
	});
});
