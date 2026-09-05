// @vitest-environment jsdom
/**
 * UP 抽屉「订阅项」里的下播:卡片是本体,词云 / AI 总结是挂在它下面的两个附加项。
 *
 * 守的是:附加项跟着下播的开关走(下播关了就灰掉);关一个附加项只写那一个键
 * (`overrides.features.liveEndExtras.wordcloud`),与默认值相同就不落 override。
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import { UpDialog } from "./UpDialog";

afterEach(cleanup);

function renderDialog(sub: Subscription) {
	const onSave = vi.fn();
	render(
		<UpDialog
			sub={sub}
			targets={[]}
			onClose={() => {}}
			onSave={onSave}
			onDelete={() => {}}
			saving={false}
		/>,
	);
	return { onSave };
}

/** 子开关按 aria-label 取 —— 按文案找再摸 parentElement 会被行内排版的改动带倒。 */
function extraToggle(label: string): HTMLButtonElement {
	return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("UpDialog · 下播的附加项", () => {
	it("下播下面挂着「弹幕词云」「AI 总结」两个子开关,默认都开", () => {
		renderDialog(makeEmptySubscription("100"));
		expect(extraToggle("弹幕词云").getAttribute("aria-pressed")).toBe("true");
		expect(extraToggle("AI 总结").getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByText("词云")).toBeNull();
		expect(screen.queryByText("直播总结")).toBeNull();
	});

	it("关掉词云 → 保存时只写 liveEndExtras.wordcloud:false", async () => {
		const { onSave } = renderDialog(makeEmptySubscription("100"));
		await userEvent.click(extraToggle("弹幕词云"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toEqual({ liveEndExtras: { wordcloud: false } });
	});

	it("再开回来 → override 清干净", async () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { liveEndExtras: { wordcloud: false } } };
		const { onSave } = renderDialog(sub);
		await userEvent.click(extraToggle("弹幕词云"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toBeUndefined();
	});

	it("下播关着 → 两个子开关灰掉、显示为关,点了也不写(草稿没动,保存钮不可点)", async () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { liveEnd: false } };
		const { onSave } = renderDialog(sub);
		expect(extraToggle("弹幕词云").disabled).toBe(true);
		expect(extraToggle("弹幕词云").getAttribute("aria-pressed")).toBe("false");
		expect(extraToggle("AI 总结").disabled).toBe(true);
		await userEvent.click(extraToggle("AI 总结"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		expect(onSave).not.toHaveBeenCalled();
	});
});
