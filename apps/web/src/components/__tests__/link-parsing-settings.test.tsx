// @vitest-environment jsdom
/**
 * 「链接解析」卡片 —— 总开关 + 冷却秒数,两个控件各自直接 patch 草稿。
 *
 * 缝在组件的 props:草稿进、patch 出。不测样式,只测「按了开关草稿收到什么」
 * 和「关着时徽标说关着」—— 后者是主人一眼判断功能状态的地方。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { GlobalConfig } from "../../types/globals";
import { LinkParsingSettings } from "../link-parsing-settings";

function draftWith(linkParsing: { enabled: boolean; cooldownSeconds: number }): GlobalConfig {
	return { linkParsing } as unknown as GlobalConfig;
}

afterEach(cleanup);

describe("LinkParsingSettings", () => {
	it("拨开总开关 → 草稿收到 linkParsing.enabled=true", () => {
		const onPatch = vi.fn();
		render(
			<LinkParsingSettings
				draft={draftWith({ enabled: false, cooldownSeconds: 60 })}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "链接解析总开关" }));
		expect(onPatch).toHaveBeenCalledWith({ linkParsing: { enabled: true } });
	});

	it("改冷却秒数 → 草稿收到 linkParsing.cooldownSeconds", () => {
		const onPatch = vi.fn();
		render(
			<LinkParsingSettings
				draft={draftWith({ enabled: true, cooldownSeconds: 60 })}
				onPatch={onPatch}
			/>,
		);
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "120" } });
		expect(onPatch).toHaveBeenCalledWith({ linkParsing: { cooldownSeconds: 120 } });
	});

	it("关着时徽标写「已关闭」,开着时写冷却时长", () => {
		const { rerender } = render(
			<LinkParsingSettings
				draft={draftWith({ enabled: false, cooldownSeconds: 60 })}
				onPatch={() => {}}
			/>,
		);
		expect(screen.getByText("已关闭")).toBeTruthy();
		rerender(
			<LinkParsingSettings
				draft={draftWith({ enabled: true, cooldownSeconds: 90 })}
				onPatch={() => {}}
			/>,
		);
		expect(screen.getByText("冷却 90 秒")).toBeTruthy();
	});
});
