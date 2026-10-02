// @vitest-environment jsdom
/**
 * UP 抽屉「订阅项」里的周期「正在直播」(`liveStreaming`,⑬d 直播拆键):
 *
 * - 直播那一组里,开播(`liveStart`)之后多一行「直播中」,小字说它是什么;
 * - 开关与别的特性一样只写 `overrides.features.liveStreaming`,与继承的基线相同就不落 override;
 * - **基线是真正的全局值**:旧的「周期间隔大于 0」迁成全局的 `features.liveStreaming = true`,而面板没有
 *   全局特性开关的界面 —— 弹层得拿调用方给的全局特性当基线,否则继承着全局「开」的订阅显示成关、也关不掉;
 * - 拓展订阅:声明了开播与下播两种事件的源才有这一行(规则在 internal 的 `featuresForEvents`)。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	DEFAULT_FEATURE_FLAGS,
	makeEmptySubscription,
	type Subscription,
} from "../../../types/domain";
import { subscriptionPlatformOf } from "../subscription-source";
import { UpDialog } from "../UpDialog";

afterEach(cleanup);

const biliSub = (): Subscription =>
	makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });

function renderDialog(sub: Subscription, extra: Partial<Parameters<typeof UpDialog>[0]> = {}) {
	const onSave = vi.fn();
	render(
		<UpDialog
			sub={sub}
			targets={[]}
			onClose={() => {}}
			onSave={onSave}
			onDelete={() => {}}
			saving={false}
			{...extra}
		/>,
	);
	return { onSave };
}

/** 开关开没开:`Toggle` 没挂 aria-label 时不带 aria-pressed,「开」靠 data-bn 里多一档 `switch-on`。 */
const isOn = (toggle: HTMLElement): boolean =>
	(toggle.getAttribute("data-bn") ?? "").split(" ").includes("switch-on");

/** 「直播中」那一行里的开关:行是 `开关 + (标签 / 小字)`,从标签往上两层。 */
function streamingToggle(): HTMLButtonElement {
	const label = screen.getByText("直播中");
	const row = label.parentElement?.parentElement as HTMLElement;
	return within(row).getByRole("button") as HTMLButtonElement;
}

describe("UpDialog · B 站订阅的「直播中」", () => {
	it("直播组里开播之后多一行「直播中」,小字写明它是开播后隔几小时再提醒一次;出厂是关的", () => {
		renderDialog(biliSub());
		expect(screen.getByText("直播中")).toBeTruthy();
		expect(screen.getByText("开播后每隔几小时再提醒一次")).toBeTruthy();
		expect(isOn(streamingToggle())).toBe(false);
		// 排在「开播」与「下播」之间。
		const labels = screen.getAllByText(/^(开播|直播中|下播)$/).map((el) => el.textContent);
		expect(labels).toEqual(["开播", "直播中", "下播"]);
	});

	it("打开 → 保存时只写 overrides.features.liveStreaming:true", async () => {
		const { onSave } = renderDialog(biliSub());
		await userEvent.click(streamingToggle());
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toEqual({ liveStreaming: true });
	});

	it("再关回去 → 与基线相同,override 清干净", async () => {
		const sub = biliSub();
		sub.overrides = { features: { liveStreaming: true } };
		const { onSave } = renderDialog(sub);
		expect(isOn(streamingToggle())).toBe(true);
		await userEvent.click(streamingToggle());
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toBeUndefined();
	});

	it("基线来自全局:全局「周期开」时继承的订阅显示为开,关掉写 liveStreaming:false(不是悄悄不动)", async () => {
		const globalFeatures = { ...DEFAULT_FEATURE_FLAGS, liveStreaming: true };
		const { onSave } = renderDialog(biliSub(), { globalFeatures });
		expect(isOn(streamingToggle())).toBe(true);
		await userEvent.click(streamingToggle());
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toEqual({ liveStreaming: false });
	});

	it("基线来自全局:订阅自己写了 false 压过全局的开", () => {
		const sub = biliSub();
		sub.overrides = { features: { liveStreaming: false } };
		renderDialog(sub, { globalFeatures: { ...DEFAULT_FEATURE_FLAGS, liveStreaming: true } });
		expect(isOn(streamingToggle())).toBe(false);
	});
});

describe("UpDialog · 拓展订阅的「直播中」", () => {
	function source(subscription: NonNullable<ExtensionDTO["subscription"]>): ExtensionDTO {
		return {
			id: "douyin",
			name: "抖音订阅",
			dir: "/data/extensions/douyin",
			enabled: true,
			state: "running",
			apiVersion: 2,
			provides: ["subscription"],
			subscription,
		};
	}

	function extSub(): Subscription {
		return makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" });
	}

	it("声明了开播与下播 → 露「直播中」(小字照样是那句)", () => {
		const platform = subscriptionPlatformOf({ extensionId: "douyin" }, [
			source({
				display: { label: "抖音", shortLabel: "抖", color: "#161823" },
				events: ["post", "liveStart", "liveEnd"],
			}),
		]);
		renderDialog(extSub(), { platform });
		expect(screen.getByText("直播中")).toBeTruthy();
		expect(screen.getByText("开播后每隔几小时再提醒一次")).toBeTruthy();
	});

	it("只声明了开播 → 不露:没有下播事件收这一场,周期推送一开就没有尽头", () => {
		const platform = subscriptionPlatformOf({ extensionId: "douyin" }, [
			source({
				display: { label: "抖音", shortLabel: "抖", color: "#161823" },
				events: ["post", "liveStart"],
			}),
		]);
		renderDialog(extSub(), { platform });
		expect(screen.queryByText("直播中")).toBeNull();
	});
});
