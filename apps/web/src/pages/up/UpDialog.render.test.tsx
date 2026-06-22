// @vitest-environment jsdom

/**
 * UpDialog 渲染回归:QQ 官方机器人不支持 @全体(后端 best-effort 跳过 at-all),
 * 故其 per-target「+ @全体」开关须禁用并显示不支持说明;onebot / webhook 不受影响。
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeEmptySubscription, type PushTarget, type Subscription } from "../../types/domain";
import { UpDialog } from "./UpDialog";

const UNSUPPORTED_NOTE = /QQ 官方.*不支持.*@全体/;

const noop = () => {};

function targetFor(platform: PushTarget["platform"]): PushTarget {
	const base = { id: `${platform}-1`, name: `${platform} 目标`, adapterId: "a-1", enabled: true };
	if (platform === "onebot") return { ...base, platform: "onebot", scope: "group", session: {} };
	if (platform === "qq-official")
		return { ...base, platform: "qq-official", scope: "group", session: {} };
	return { ...base, platform: "webhook", scope: "channel", session: {} };
}

/**
 * routing 仅含 dynamic → 该 target「routing 不完整」= 自定义模式,矩阵直接展开(无需
 * 点击),dynamic 行下方挂出 per-target「+ @全体」开关。atAllDefaults.dynamic=true 让
 * 「若平台支持则默认会 @全体」,以验证 QQ 官方仍被强制禁用。
 */
function customSubFor(targetId: string): Subscription {
	const sub = makeEmptySubscription("100");
	sub.routing.dynamic = [targetId];
	sub.atAllDefaults.dynamic = true;
	return sub;
}

function renderDialog(target: PushTarget) {
	return render(
		<UpDialog
			sub={customSubFor(target.id)}
			targets={[target]}
			onClose={noop}
			onSave={noop}
			onDelete={noop}
			saving={false}
		/>,
	);
}

afterEach(cleanup);

describe("UpDialog · QQ 官方 @全体 提示", () => {
	it("QQ 官方 target 的 @全体 开关被禁用并显示不支持说明", () => {
		renderDialog(targetFor("qq-official"));

		const note = screen.getByText(UNSUPPORTED_NOTE);
		expect(note).toBeTruthy();

		// note 与开关同处一个 wrapper;wrapper 内唯一的 button 即被禁用的 @全体 Toggle
		// (不支持时不渲染 reset 按钮)。
		const wrapper = note.parentElement as HTMLElement;
		const toggle = within(wrapper).getAllByRole("button")[0] as HTMLButtonElement;
		expect(toggle.disabled).toBe(true);
	});

	it("onebot target 不显示不支持说明", () => {
		renderDialog(targetFor("onebot"));
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});

	it("webhook target 不显示不支持说明", () => {
		renderDialog(targetFor("webhook"));
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});
});
