// @vitest-environment jsdom
/**
 * 概览页「正在直播」按快照里的订阅 id 对订阅(ADR-0019 决策 50)。
 *
 * 同一个 UP 配了几条订阅时,按 uid 对就只能随手挑一条(今天是后出现的覆盖前面的);
 * 快照带着的 `subscriptionId` 说的才是这间直播间是替哪一条开的。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { LiveListenerSnapshot } from "../../services/dashboard";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
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
