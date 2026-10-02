// @vitest-environment jsdom
/**
 * 规则页「直播推送阈值」(全局)里直播拆键(⑬d)的那几格:
 *
 * - 周期「正在直播」的**开关**(`features.liveStreaming`)、**间隔**(`liveStreaming.streamingIntervalHours`,整数 1–24)、
 *   启动补报(`liveStart.catchUpOnBoot`)。旧的「间隔 0 = 关」不再有;
 * - 间隔输入的上下限是 1 与 24(面板从前的上限 23 对齐到 24,0 不再合法 —— 「关」交给开关);
 * - 改一格只发那一格的补丁,落在各自的段上,不再往 `schedule` 里写;
 * - 静音时段与断流接续这几格(随 3a)原样留在这一节。
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveThresholdsSection } from "../sections";
import { makeDefaults } from "./fixtures";

afterEach(cleanup);

/** 开关开没开:`Toggle` 没挂 aria-label 时不带 aria-pressed,「开」靠 data-bn 里多一档 `switch-on`。 */
const isOn = (toggle: Element | null | undefined): boolean =>
	(toggle?.getAttribute("data-bn") ?? "").split(" ").includes("switch-on");

function renderSection(over: { liveStreamingOn?: boolean } = {}) {
	const defaults = makeDefaults();
	const onPatch = vi.fn();
	const view = render(
		<LiveThresholdsSection
			filters={defaults.filters}
			schedule={defaults.schedule}
			liveStart={defaults.liveStart}
			liveStreaming={defaults.liveStreaming}
			liveStreamingOn={over.liveStreamingOn ?? false}
			onPatch={onPatch}
		/>,
	);
	const field = (code: string) => view.container.querySelector(`[data-code="${code}"]`);
	return { onPatch, field, ...view };
}

describe("LiveThresholdsSection · 直播拆键", () => {
	it("周期间隔输入的上下限是 1 与 24,出厂值 1", () => {
		const { field } = renderSection();
		const input = field("liveStreaming.streamingIntervalHours")?.querySelector("input");
		expect(input?.getAttribute("min")).toBe("1");
		expect(input?.getAttribute("max")).toBe("24");
		expect(input?.value).toBe("1");
	});

	it("间隔说明里没有「0 = 不推送」那类话 —— 关不关由开关管", () => {
		const { field } = renderSection();
		const row = field("liveStreaming.streamingIntervalHours");
		expect(row?.textContent).toContain("状态推送间隔");
		expect(row?.textContent).not.toMatch(/0\s*=|填 0|不推送/);
	});

	it("改间隔 → 补丁落在 defaults.liveStreaming 上,只带这一格", () => {
		const { onPatch, field } = renderSection();
		const input = field("liveStreaming.streamingIntervalHours")?.querySelector(
			"input",
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "24" } });
		expect(onPatch).toHaveBeenCalledWith({
			defaults: { liveStreaming: { streamingIntervalHours: 24 } },
		});
	});

	it("启动补报开关:标签与说明沿用旧的,补丁落在 defaults.liveStart", () => {
		const { onPatch, field } = renderSection();
		const row = field("liveStart.catchUpOnBoot");
		expect(row?.textContent).toContain("启动后立即推送");
		expect(row?.textContent).toContain("重启时若 UP 在播则立即推送一次");
		fireEvent.click(row?.querySelector("button") as HTMLButtonElement);
		expect(onPatch).toHaveBeenCalledWith({ defaults: { liveStart: { catchUpOnBoot: true } } });
	});

	it("全局的周期开关与别的开关一样:显示当前值,点一下发 defaults.features.liveStreaming", () => {
		const off = renderSection({ liveStreamingOn: false });
		const offButton = off.field("features.liveStreaming")?.querySelector("button");
		expect(isOn(offButton)).toBe(false);
		fireEvent.click(offButton as HTMLButtonElement);
		expect(off.onPatch).toHaveBeenCalledWith({ defaults: { features: { liveStreaming: true } } });
		cleanup();

		const on = renderSection({ liveStreamingOn: true });
		const onButton = on.field("features.liveStreaming")?.querySelector("button");
		expect(isOn(onButton)).toBe(true);
		fireEvent.click(onButton as HTMLButtonElement);
		expect(on.onPatch).toHaveBeenCalledWith({ defaults: { features: { liveStreaming: false } } });
	});

	it("schedule 里留着的几格(断流接续、免扰时段)照旧在这一节", () => {
		const { field } = renderSection();
		expect(field("schedule.liveEndGrace")).not.toBeNull();
		expect(field("schedule.quietHours")).not.toBeNull();
	});
});
