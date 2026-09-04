// @vitest-environment jsdom
/**
 * 「链接解析」卡片 —— 总开关 + 冷却秒数 + 生效范围(所有群 / 仅以下群 + 群白名单)。
 *
 * 缝在组件的 props:草稿与推送目标进、patch 出。不测样式,只测「按了控件草稿收到什么」
 * 和「关着时徽标说关着」—— 后者是主人一眼判断功能状态的地方。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { LinkParsingSettings } from "../link-parsing-settings";

type LinkParsing = GlobalConfig["linkParsing"];

const T_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_PRIVATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T_WEBHOOK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function draftWith(over: Partial<LinkParsing> = {}): GlobalConfig {
	const linkParsing: LinkParsing = {
		enabled: true,
		cooldownSeconds: 60,
		scope: "all",
		targets: [],
		...over,
	};
	return { linkParsing } as unknown as GlobalConfig;
}

function target(id: string, name: string, over: Partial<PushTarget> = {}): PushTarget {
	return {
		id,
		name,
		adapterId: "11111111-1111-4111-8111-111111111111",
		scope: "group",
		enabled: true,
		platform: "onebot",
		session: { groupId: "123" },
		...over,
	} as PushTarget;
}

const TARGETS: PushTarget[] = [
	target(T_A, "群 A"),
	target(T_B, "官机群 B", { platform: "qq-official", session: { groupOpenid: "op" } } as never),
	target(T_PRIVATE, "主人私聊", { scope: "private", session: { userId: "1" } } as never),
	target(T_WEBHOOK, "钩子", { platform: "webhook", session: {} } as never),
];

function renderCard(draft: GlobalConfig, onPatch = vi.fn(), targets: PushTarget[] = TARGETS) {
	render(
		<MemoryRouter>
			<LinkParsingSettings draft={draft} onPatch={onPatch} targets={targets} />
		</MemoryRouter>,
	);
	return onPatch;
}

afterEach(cleanup);

describe("LinkParsingSettings", () => {
	it("拨开总开关 → 草稿收到 linkParsing.enabled=true", () => {
		const onPatch = renderCard(draftWith({ enabled: false }));
		fireEvent.click(screen.getByRole("button", { name: "链接解析总开关" }));
		expect(onPatch).toHaveBeenCalledWith({ linkParsing: { enabled: true } });
	});

	it("改冷却秒数 → 草稿收到 linkParsing.cooldownSeconds", () => {
		const onPatch = renderCard(draftWith());
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "120" } });
		expect(onPatch).toHaveBeenCalledWith({ linkParsing: { cooldownSeconds: 120 } });
	});

	it("关着时徽标写「已关闭」,开着时写冷却时长", () => {
		const { rerender } = render(
			<MemoryRouter>
				<LinkParsingSettings
					draft={draftWith({ enabled: false })}
					onPatch={() => {}}
					targets={TARGETS}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("已关闭")).toBeTruthy();
		rerender(
			<MemoryRouter>
				<LinkParsingSettings
					draft={draftWith({ enabled: true, cooldownSeconds: 90 })}
					onPatch={() => {}}
					targets={TARGETS}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("冷却 90 秒")).toBeTruthy();
	});

	describe("生效范围", () => {
		it("切到「仅以下群」→ 草稿收到 linkParsing.scope", () => {
			const onPatch = renderCard(draftWith({ scope: "all" }));
			fireEvent.click(screen.getByRole("button", { name: "仅以下群" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { scope: "selected" } });
		});

		it("「所有群」时不画群列表", () => {
			renderCard(draftWith({ scope: "all" }));
			expect(screen.queryByRole("button", { name: /群 A/ })).toBeNull();
		});

		it("「仅以下群」只列群类目标:私聊与 webhook 不出现,官机群算", () => {
			renderCard(draftWith({ scope: "selected" }));
			expect(screen.getByRole("button", { name: /群 A/ })).toBeTruthy();
			expect(screen.getByRole("button", { name: /官机群 B/ })).toBeTruthy();
			expect(screen.queryByRole("button", { name: /主人私聊/ })).toBeNull();
			expect(screen.queryByRole("button", { name: /钩子/ })).toBeNull();
		});

		it("点一个群 → 草稿收到整份 targets(对象数组,追加这一个)", () => {
			const onPatch = renderCard(draftWith({ scope: "selected", targets: [{ targetId: T_A }] }));
			fireEvent.click(screen.getByRole("button", { name: /官机群 B/ }));
			expect(onPatch).toHaveBeenCalledWith({
				linkParsing: { targets: [{ targetId: T_A }, { targetId: T_B }] },
			});
		});

		it("再点已勾的群 → 从 targets 里去掉", () => {
			const onPatch = renderCard(draftWith({ scope: "selected", targets: [{ targetId: T_A }] }));
			fireEvent.click(screen.getByRole("button", { name: /群 A/ }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { targets: [] } });
		});

		it("「仅以下群」但一个都没勾 → 明说现在哪个群都不解析", () => {
			renderCard(draftWith({ scope: "selected", targets: [] }));
			expect(screen.getByText(/当前不会在任何群解析/)).toBeTruthy();
		});

		it("「仅以下群」但没有群类推送目标 → 空态 + 去推送目标页的链接", () => {
			renderCard(draftWith({ scope: "selected" }), vi.fn(), [TARGETS[2] as PushTarget]);
			expect(screen.getByText(/还没有群类推送目标/)).toBeTruthy();
			expect(screen.getByRole("link", { name: /推送目标/ }).getAttribute("href")).toBe("/targets");
		});

		it("徽标在「仅以下群」时带上勾了几个群", () => {
			renderCard(draftWith({ scope: "selected", targets: [{ targetId: T_A }, { targetId: T_B }] }));
			expect(screen.getByText("冷却 60 秒 · 2 个群")).toBeTruthy();
		});
	});
});
