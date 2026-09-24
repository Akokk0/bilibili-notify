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
import {
	makeEmptyExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import { TimelinePanel } from "../Dashboard";

afterEach(cleanup);

function row(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return {
		id: "h1",
		pushId: "p1",
		ts: new Date().toISOString(),
		kind: "dynamic",
		status: "delivered",
		uid: "u1",
		subscriptionId: "s-gone",
		targetId: null,
		messages: [{ text: "一条推送", role: "main", ok: true }],
		...over,
	};
}

function extRow(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return row({ uid: undefined, extensionId: "douyin", externalId: "sec-1", ...over });
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
		renderPanel([extRow({ unameSnapshot: "某抖音号" })], [], [DOUYIN]);
		expect(screen.getByText("某抖音号")).toBeTruthy();
		expect(screen.queryByText("抖音 · sec-1")).toBeNull();
	});

	it("拓展行的订阅删了、同一个人又加了一条 → 写现在那条的名字", () => {
		const readded: Subscription = {
			...makeEmptyExtensionSubscription("douyin", "sec-1"),
			cachedProfile: {
				name: "现在的抖音号",
				avatar: "",
				sign: "",
				lastRefreshedAt: "2026-09-24T00:00:00Z",
			},
		};
		renderPanel([extRow()], [readded], [DOUYIN]);
		expect(screen.getByText("现在的抖音号")).toBeTruthy();
	});

	it("拓展行的外部 id 恰好等于某个 B 站 uid → 不认成那位 B 站 UP", () => {
		const bili: Subscription = {
			...makeEmptySubscription("u1"),
			cachedProfile: {
				name: "某B站UP",
				avatar: "",
				sign: "",
				lastRefreshedAt: "2026-09-24T00:00:00Z",
			},
		};
		renderPanel([extRow({ externalId: "u1" })], [bili], [DOUYIN]);
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
		const { container } = renderPanel([extRow({ unameSnapshot: "某抖音号" })], [], [DOUYIN]);
		expect(badgeTexts(container)).toContain("抖");
		expect(screen.getByText("某抖音号")).toBeTruthy();
	});

	it("名字是身份兜底的拓展行也带徽章", () => {
		const { container } = renderPanel([extRow()], [], [DOUYIN]);
		expect(badgeTexts(container)).toContain("抖");
		expect(screen.getByText("抖音 · sec-1")).toBeTruthy();
	});

	it("拓展卸载了(清单里没有它)→ 徽章写拓展 id", () => {
		const { container } = renderPanel([extRow({ unameSnapshot: "某抖音号" })], [], []);
		expect(badgeTexts(container)).toContain("douyin");
	});

	it("B 站行没有平台徽章:只有类型与状态那两枚", () => {
		const { container } = renderPanel([row({ unameSnapshot: "某UP" })], [], [DOUYIN]);
		expect(badgeTexts(container)).toEqual(["动态", "已送达"]);
	});
});
