// @vitest-environment jsdom
/**
 * 「链接解析」卡片 —— 总开关 + 冷却秒数 + 默认行(所有群解不解析、回什么)+ 按群例外表。
 *
 * 缝在组件的 props:草稿与推送目标进、patch 出。不测样式,只测「按了控件草稿收到什么」
 * 和「关着时徽标说关着」—— 后者是主人一眼判断功能状态的地方。例外表每格三态:跟默认 /
 * 显式值;「跟默认」发的是删除哨兵(null),不是把默认值抄一份进例外。
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
		defaults: { parse: true, form: "image" },
		groups: {},
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

const row = (name: string) => within(screen.getByRole("group", { name }));

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

	it("徽标:关着写「已关闭」;开着写冷却;默认不解析加「仅例外群」;有例外加个数", () => {
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
		rerender(
			<MemoryRouter>
				<LinkParsingSettings
					draft={draftWith({
						defaults: { parse: false, form: "image" },
						groups: { [T_A]: { parse: true }, [T_B]: { form: "miniapp" } },
					})}
					onPatch={() => {}}
					targets={TARGETS}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("冷却 60 秒 · 仅例外群 · 2 个例外")).toBeTruthy();
	});

	describe("默认行(所有群)", () => {
		it("解析切到「关」→ 草稿收到 defaults.parse=false", () => {
			const onPatch = renderCard(draftWith());
			fireEvent.click(row("默认(所有群)").getByRole("button", { name: "关" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { defaults: { parse: false } } });
		});

		it("形式切到「小程序卡」→ 草稿收到 defaults.form=miniapp", () => {
			const onPatch = renderCard(draftWith());
			fireEvent.click(row("默认(所有群)").getByRole("button", { name: "小程序卡" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { defaults: { form: "miniapp" } } });
		});
	});

	describe("按群例外", () => {
		it("两格都调回「跟默认」→ 这一格不再算例外(草稿里那个空对象不算)", () => {
			renderCard(draftWith({ groups: { [T_A]: {}, [T_B]: { form: "miniapp" } } }));
			expect(screen.getByText("冷却 60 秒 · 1 个例外")).toBeTruthy();
		});

		it("只列群类且收得到入站消息的目标:私聊与 webhook 不出现,官机群算", () => {
			renderCard(draftWith());
			expect(screen.getByRole("group", { name: "群 A" })).toBeTruthy();
			expect(screen.getByRole("group", { name: "官机群 B" })).toBeTruthy();
			expect(screen.queryByRole("group", { name: "主人私聊" })).toBeNull();
			expect(screen.queryByRole("group", { name: "钩子" })).toBeNull();
		});

		it("没写例外的群两格都按在「跟默认」上,并把继承来的值写在旁边", () => {
			renderCard(draftWith({ defaults: { parse: false, form: "miniapp" } }));
			const a = row("群 A");
			expect(a.getByRole("button", { name: "跟默认 · 关" }).getAttribute("aria-pressed")).toBe(
				"true",
			);
			expect(
				a.getByRole("button", { name: "跟默认 · 小程序卡" }).getAttribute("aria-pressed"),
			).toBe("true");
		});

		it("解析格点「关」→ 草稿只收到这个群的 parse=false", () => {
			const onPatch = renderCard(draftWith());
			fireEvent.click(row("群 A").getByRole("button", { name: "关" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkParsing: { groups: { [T_A]: { parse: false } } },
			});
		});

		it("形式格点「小程序卡」→ 草稿只收到这个群的 form=miniapp", () => {
			const onPatch = renderCard(draftWith());
			fireEvent.click(row("群 A").getByRole("button", { name: "小程序卡" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkParsing: { groups: { [T_A]: { form: "miniapp" } } },
			});
		});

		it("有例外的格点「跟默认」→ 发删除哨兵,不是把默认值抄进例外", () => {
			const onPatch = renderCard(
				draftWith({ groups: { [T_A]: { parse: false, form: "miniapp" } } }),
			);
			const a = row("群 A");
			expect(a.getByRole("button", { name: "关" }).getAttribute("aria-pressed")).toBe("true");
			fireEvent.click(a.getByRole("button", { name: "跟默认 · 开" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { groups: { [T_A]: { parse: null } } } });
			fireEvent.click(a.getByRole("button", { name: "跟默认 · 图片卡" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { groups: { [T_A]: { form: null } } } });
		});

		it("停用的目标照列,标「已停用」", () => {
			renderCard(draftWith(), vi.fn(), [target(T_A, "群 A", { enabled: false })]);
			expect(row("群 A").getByText("已停用")).toBeTruthy();
		});

		it("官机群的形式格旁边说明它发不了小程序卡、会回落图片卡", () => {
			renderCard(draftWith());
			expect(row("官机群 B").getByText(/不支持小程序卡/)).toBeTruthy();
			expect(row("群 A").queryByText(/不支持小程序卡/)).toBeNull();
		});

		it("没有群类推送目标 → 空态 + 去推送目标页的链接", () => {
			renderCard(draftWith(), vi.fn(), [TARGETS[2] as PushTarget]);
			expect(screen.getByText(/还没有群类推送目标/)).toBeTruthy();
			expect(screen.getByRole("link", { name: /推送目标/ }).getAttribute("href")).toBe("/targets");
		});
	});
});
