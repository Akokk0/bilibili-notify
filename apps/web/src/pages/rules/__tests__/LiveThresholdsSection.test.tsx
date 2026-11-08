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
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";

// These assertions describe the Chinese UI, independent of untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

import { chooseSelect, selectOptionsOf } from "../../../__tests__/select-controls";
import { LiveThresholdsSection } from "../sections";
import { makeDefaults, makeSource } from "./fixtures";

afterEach(cleanup);

/** 开关开没开:`Toggle` 没挂 aria-label 时不带 aria-pressed,「开」靠 data-bn 里多一档 `switch-on`。 */
const isOn = (toggle: Element | null | undefined): boolean =>
	(toggle?.getAttribute("data-bn") ?? "").split(" ").includes("switch-on");

function renderSection(
	over: {
		liveStreamingOn?: boolean;
		superchat?: Parameters<typeof LiveThresholdsSection>[0]["superchat"];
		membership?: Parameters<typeof LiveThresholdsSection>[0]["membership"];
	} = {},
) {
	const defaults = makeDefaults();
	const onPatch = vi.fn();
	const view = render(
		<LiveThresholdsSection
			programs={makeSource().descriptor.membershipPrograms}
			superchat={over.superchat ?? defaults.superchat}
			membership={over.membership ?? defaults.membership}
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
		expect(row?.textContent).toContain("重启时若订阅正在直播则立即推送一次");
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

/**
 * 两个直播门槛(㉓d):醒目留言金额落在 `defaults.superchat.minAmount`,上舰档位落在 `defaults.membership.minRank.guard`
 * (存的是 rank:舰长 1、提督 2、总督 3)。选项仍是三档、由低到高 —— 舰长 / 提督 / 总督,和今天用户看到的一样。
 */
describe("LiveThresholdsSection · 两个门槛", () => {
	const levelPicker = (field: Element | null) =>
		field?.querySelector('[role="combobox"]') as HTMLButtonElement;

	it("金额门槛没配:输入框显示 0(= 全推),上限 9999、单位元", () => {
		const { field } = renderSection();
		const input = field("superchat.minAmount")?.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("0");
		expect(input.getAttribute("min")).toBe("0");
		expect(input.getAttribute("max")).toBe("9999");
		expect(field("superchat.minAmount")?.textContent).toContain("元");
	});

	it("金额门槛有值:显示它;改它 → 补丁落在 defaults.superchat.minAmount,只带这一格", () => {
		const { onPatch, field } = renderSection({ superchat: { minAmount: 30 } });
		const input = field("superchat.minAmount")?.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("30");
		fireEvent.change(input, { target: { value: "50" } });
		expect(onPatch).toHaveBeenCalledWith({ defaults: { superchat: { minAmount: 50 } } });
	});

	it("上舰档位:三档由低到高 —— 舰长、提督、总督;没配时「舰长」(全推)是选中的", () => {
		const { field } = renderSection();
		const picker = levelPicker(field("membership.minRank.guard"));
		expect(picker.textContent).toBe("舰长");
		expect(selectOptionsOf(picker).map((option) => option.textContent)).toEqual([
			"舰长",
			"提督",
			"总督",
		]);
	});

	it("上舰档位有值(rank 2):「提督」选中;点「总督」→ 补丁是 rank 3,落在 defaults.membership.minRank.guard", () => {
		const { onPatch, field } = renderSection({ membership: { minRank: { guard: 2 } } });
		const picker = levelPicker(field("membership.minRank.guard"));
		expect(picker.textContent).toBe("提督");
		chooseSelect(picker, "总督");
		expect(onPatch).toHaveBeenCalledWith({
			defaults: { membership: { minRank: { guard: 3 } } },
		});
	});

	it("点回「舰长」(全推)→ rank 1 照样写下去(不是清掉)", () => {
		const { onPatch, field } = renderSection({ membership: { minRank: { guard: 3 } } });
		chooseSelect(levelPicker(field("membership.minRank.guard")), "舰长");
		expect(onPatch).toHaveBeenCalledWith({
			defaults: { membership: { minRank: { guard: 1 } } },
		});
	});
});
