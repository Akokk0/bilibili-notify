// @vitest-environment jsdom

/**
 * 拓展订阅的配置弹层(ADR-0019 决策 5):特性开关只列这个源报的事件对应的那几把;B 站独有的
 * (上舰 / SC / 特别弹幕 / 特别关注进场,以及挂在下播下面的词云与 AI 总结)一律不露面 —— 摆出来
 * 就是一个永远不会响的开关。「动态」按平台的叫法走(`postNoun`)。头部写平台,不写 UID。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	type Connection,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "../../../types/domain";
import type { SubscriptionPlatform } from "../subscription-source";
import { UpDialog } from "../UpDialog";

const noop = () => {};

const TARGET: PushTarget = {
	id: "t-1",
	name: "主群",
	connectionId: "c-1",
	enabled: true,
	kind: "session",
	platform: "onebot",
	scope: "group",
	address: "123",
};

function extSub(over: Partial<Subscription> = {}): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" }),
		cachedProfile: { name: "抖音那位", sign: "", fans: 12, lastRefreshedAt: "t" },
		...over,
	};
}

function platform(over: Partial<SubscriptionPlatform> = {}): SubscriptionPlatform {
	return {
		label: "抖音",
		shortLabel: "抖",
		color: "#161823",
		postNoun: "作品",
		features: ["post", "liveStart"],
		absent: false,
		...over,
	};
}

function renderDialog(sub: Subscription, p: SubscriptionPlatform, targets: PushTarget[] = []) {
	return render(
		<UpDialog
			sub={sub}
			platform={p}
			targets={targets}
			connections={[{ id: "c-1", kind: "direct", platform: "onebot", enabled: true } as Connection]}
			onClose={noop}
			onSave={noop}
			onDelete={noop}
			saving={false}
		/>,
	);
}

afterEach(cleanup);

describe("UpDialog × 拓展订阅", () => {
	it("只列这个源报得出的特性,「动态」叫「作品」,B 站独有的一个不露", () => {
		renderDialog(extSub(), platform());
		expect(screen.getAllByText("作品").length).toBeGreaterThan(0);
		expect(screen.getAllByText("开播").length).toBeGreaterThan(0);
		for (const gone of ["动态", "下播", "上舰", "SC", "特别弹幕", "特别用户进房", "特别关注"]) {
			expect(screen.queryAllByText(gone), gone).toHaveLength(0);
		}
	});

	it("报下播的源:有「下播」,但不挂词云 / AI 总结 —— 那两样只有 B 站报;@全体 照留", () => {
		renderDialog(extSub(), platform({ features: ["post", "liveStart", "liveEnd"] }));
		expect(screen.getAllByText("下播").length).toBeGreaterThan(0);
		expect(screen.queryByText("+ 弹幕词云")).toBeNull();
		expect(screen.queryByText("+ AI 总结")).toBeNull();
		expect(screen.getAllByText("+ @全体").length).toBeGreaterThan(0);
	});

	it("头部写平台,不写 UID", () => {
		renderDialog(extSub(), platform());
		expect(screen.getByText("抖音")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	it("自定义推送的目标卡:计数与矩阵只算这个源的特性", () => {
		const sub = extSub();
		// 只给了作品 → 路由不完整 = 自定义,矩阵直接展开。
		sub.routing.post = [TARGET.id];
		renderDialog(sub, platform(), [TARGET]);
		expect(screen.getByText("1/2")).toBeTruthy();
		expect(screen.queryAllByText("上舰")).toHaveLength(0);
	});
});
