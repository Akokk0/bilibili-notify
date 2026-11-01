// @vitest-environment jsdom

/**
 * 拓展订阅的配置弹层(ADR-0019 决策 5):特性开关只列这个源报的事件对应的那几把;B 站独有的
 * (上舰 / SC / 特别弹幕 / 特别关注进场,以及挂在下播下面的词云与 AI 总结)一律不露面 —— 摆出来
 * 就是一个永远不会响的开关。「动态」按平台的叫法走(`postNoun`)。头部写平台,不写 UID。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
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
	scope: "group",
	address: "123",
};

function extSub(over: Partial<Subscription> = {}): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" }),
		cachedProfile: { name: "抖音那位", followers: 12, refreshedAt: "t" },
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
		supportedExtras: [],
		status: "running",
		showBadge: true,
		...over,
	};
}

function renderDialog(sub: Subscription, p: SubscriptionPlatform, targets: PushTarget[] = []) {
	return render(
		<UpDialog
			sub={sub}
			platform={p}
			targets={targets}
			connections={[
				{ id: "c-1", adapterKey: "onebot", platform: "onebot", enabled: true } as Connection,
			]}
			onClose={noop}
			onSave={noop}
			onDelete={noop}
			saving={false}
		/>,
	);
}

afterEach(cleanup);

describe("UpDialog × 拓展订阅", () => {
	it("来源描述和语言刷新保留 dirty 备注与隐藏路由，不自动保存", () => {
		const sub = extSub();
		sub.routing.membership = ["retired-target"];
		const save = vi.fn();
		const original = i18n.state();
		const props = {
			sub,
			targets: [],
			connections: [],
			onClose: noop,
			onSave: save,
			onDelete: noop,
			saving: false,
		};
		const view = render(
			<UpDialog {...props} platform={platform({ featureHints: { post: "Original post hint" } })} />,
		);
		expect(screen.getByText("Original post hint")).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "尚未保存" } });
		view.rerender(
			<UpDialog
				{...props}
				platform={platform({
					label: "New label",
					features: ["post"],
					featureHints: { post: "Current post hint" },
				})}
			/>,
		);
		expect(screen.queryByText("Original post hint")).toBeNull();
		expect(screen.getByText("Current post hint")).toBeTruthy();
		try {
			act(() => i18n.set({ locale: "en", voice: "plain" }));
			expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("尚未保存");
			expect(save).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
			expect(save).toHaveBeenCalledWith(
				expect.objectContaining({
					notes: "尚未保存",
					routing: expect.objectContaining({ membership: ["retired-target"] }),
				}),
			);
		} finally {
			act(() => i18n.set({ locale: original.locale, voice: original.voice }));
		}
	});
	it("只列这个源报得出的特性,「动态」叫「作品」,B 站独有的一个不露", () => {
		renderDialog(extSub(), platform());
		expect(screen.getAllByText("作品").length).toBeGreaterThan(0);
		expect(screen.getAllByText("开播").length).toBeGreaterThan(0);
		for (const gone of ["动态", "下播", "上舰", "SC", "特别弹幕", "特别用户进房", "特别关注"]) {
			expect(screen.queryAllByText(gone), gone).toHaveLength(0);
		}
	});

	it("报下播的源:有「下播」,但不挂词云 / AI 总结 —— 那两样只有 B 站报;@全体 照留", () => {
		renderDialog(
			extSub(),
			platform({
				features: ["post", "liveStart", "liveEnd"],
				supportedExtras: ["atAllPost", "atAllLiveStart"],
			}),
		);
		expect(screen.getAllByText("下播").length).toBeGreaterThan(0);
		expect(screen.queryByText("+ 弹幕词云")).toBeNull();
		expect(screen.queryByText("+ AI 总结")).toBeNull();
		expect(screen.getAllByText("+ @全体").length).toBeGreaterThan(0);
	});

	it("featureHints 同时覆盖订阅和自定义目标小字，不给未声明特性造开关", () => {
		const sub = extSub();
		sub.routing.post = [TARGET.id];
		renderDialog(
			sub,
			platform({ featureHints: { post: "Custom post hint", membership: "Invisible club hint" } }),
			[TARGET],
		);
		expect(screen.getAllByText("Custom post hint")).toHaveLength(2);
		expect(screen.queryByText("Invisible club hint")).toBeNull();
		expect(screen.getByText("1/2")).toBeTruthy();
	});

	it("缺省或空白提示用中性默认，下播只拼已声明附加项", () => {
		renderDialog(
			extSub(),
			platform({
				features: ["post", "superchat", "liveEnd"],
				supportedExtras: ["wordcloud"],
				featureHints: { post: " \n\t " },
			}),
		);
		expect(screen.getByText("作品提醒")).toBeTruthy();
		expect(screen.getByText("醒目留言提醒")).toBeTruthy();
		expect(screen.getByText("下播卡片 / 弹幕词云")).toBeTruthy();
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
