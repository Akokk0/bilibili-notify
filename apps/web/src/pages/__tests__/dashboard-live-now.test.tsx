// @vitest-environment jsdom
/**
 * 概览页「正在直播」按快照里的订阅 id 对订阅(ADR-0019 决策 50)。
 *
 * 同一个 UP 配了几条订阅时,按 uid 对就只能随手挑一条(今天是后出现的覆盖前面的);
 * 快照带着的 `subscriptionId` 说的才是这间直播间是替哪一条开的。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { LiveListenerSnapshot, LiveListeningEntry } from "../../services/dashboard";
import {
	type ExtensionSubscription,
	makeEmptyExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import { LiveNowPanel } from "../Dashboard";

afterEach(cleanup);

/** 一条 B 站订阅,资料缓存里的名字就是面板上显示的名字。 */
function biliSub(id: string, uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		id,
		cachedProfile: { name, avatar: "", sign: "", lastRefreshedAt: "2026-09-23T00:00:00Z" },
	};
}

describe("正在直播 · 房间对到哪条订阅", () => {
	it("同 uid 几条订阅都在 → 显示快照里那条订阅的名字", () => {
		const live: LiveListenerSnapshot[] = [
			{ subscriptionId: "s-own", uid: "u1", roomId: "r1", isLive: true, title: "在播标题" },
		];
		const subs = [
			biliSub("s-first", "u1", "先出现的那条"),
			biliSub("s-own", "u1", "快照里那条"),
			biliSub("s-last", "u1", "后出现的那条"),
		];
		render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel live={live} subs={subs} />
			</MemoryRouter>,
		);
		expect(screen.getByText("快照里那条")).toBeTruthy();
		expect(screen.queryByText("先出现的那条")).toBeNull();
		expect(screen.queryByText("后出现的那条")).toBeNull();
	});
});

/** 一条拓展订阅,资料缓存里的名字与头像就是面板上画的那两样。 */
function extSub(id: string, name: string): ExtensionSubscription {
	return {
		...makeEmptyExtensionSubscription("douyin", "sec-1"),
		id,
		cachedProfile: {
			name,
			avatar: `/api/subs/${id}/avatar?v=abc`,
			sign: "",
			lastRefreshedAt: "2026-09-23T00:00:00Z",
		},
	};
}

/** 装着的抖音订阅源 —— 平台徽章的名字与颜色照它的清单。 */
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
};

describe("正在直播 · 拓展订阅的在播(ADR-0019 决策 12)", () => {
	const thirtyMinutesAgo = () => new Date(Date.now() - 30 * 60_000 - 5_000).toISOString();

	function renderPanel(
		live: LiveListeningEntry[],
		subs: Subscription[],
		extensions?: ExtensionDTO[],
	) {
		return render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel live={live} subs={subs} extensions={extensions} />
			</MemoryRouter>,
		);
	}

	it("名字照订阅、平台徽章照清单、标题 / 分区 / 累计观看都画出来;头像是那条订阅的;不写开播多久", () => {
		const { container } = renderPanel(
			[
				{
					kind: "extension",
					subscriptionId: "s-dy",
					extensionId: "douyin",
					isLive: true,
					title: "抖音这一场",
					areaName: "聊天",
					startedAt: thirtyMinutesAgo(),
					totalViewers: 12_345,
				},
			],
			[extSub("s-dy", "抖音乙")],
			[DOUYIN],
		);
		expect(screen.getByText("抖音乙")).toBeTruthy();
		expect(screen.getByText("抖")).toBeTruthy();
		expect(screen.getByText("抖音这一场")).toBeTruthy();
		expect(screen.getByText("聊天")).toBeTruthy();
		// 那一列与 B 站行同一个口径:本场累计观看(决策 75)。
		expect(screen.getByText("1.2万")).toBeTruthy();
		// 面板只列正在播的,「开播」是多余的 —— 主人 09-23 定的,B 站行与拓展行都不写。
		expect(screen.queryByText(/开播/)).toBeNull();
		expect(screen.queryByText(/UID/)).toBeNull();
		expect(container.querySelector('img[src="/api/subs/s-dy/avatar?v=abc"]')).not.toBeNull();
	});

	it("订阅列表与拓展列表都还没回来:名字与徽章退拓展 id,不写「UID undefined」", () => {
		renderPanel(
			[{ kind: "extension", subscriptionId: "s-dy", extensionId: "douyin", isLive: true }],
			[],
		);
		expect(screen.getAllByText("douyin").length).toBeGreaterThan(0);
		expect(screen.queryByText(/UID/)).toBeNull();
		expect(screen.getByText("（未拉取到房间标题）")).toBeTruthy();
	});

	it("拓展没报累计观看:那一列是「—」", () => {
		renderPanel(
			[{ kind: "extension", subscriptionId: "s-dy", extensionId: "douyin", isLive: true }],
			[extSub("s-dy", "抖音乙")],
			[DOUYIN],
		);
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("与 B 站房间并排:各画各的,B 站那行照旧", () => {
		renderPanel(
			[
				{ subscriptionId: "s-bili", uid: "u1", roomId: "r1", isLive: true, viewers: "3456" },
				{ kind: "extension", subscriptionId: "s-dy", extensionId: "douyin", isLive: true },
			],
			[biliSub("s-bili", "u1", "B 站甲"), extSub("s-dy", "抖音乙")],
			[DOUYIN],
		);
		expect(screen.getByText("B 站甲")).toBeTruthy();
		expect(screen.getByText("3456")).toBeTruthy();
		expect(screen.getByText("抖音乙")).toBeTruthy();
		expect(screen.getByText("● 2 人在播")).toBeTruthy();
	});
});
