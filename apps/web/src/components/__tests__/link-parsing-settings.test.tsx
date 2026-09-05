// @vitest-environment jsdom
/**
 * 「链接解析」卡片 —— 总开关 + 冷却秒数 + 默认行(所有群解不解析、回什么)+ 按群例外表。
 *
 * 缝在组件的 props:草稿与推送目标进、patch 出。不测样式,只测「按了控件草稿收到什么」
 * 和「关着时徽标说关着」—— 后者是主人一眼判断功能状态的地方。例外表每格三态:跟默认 /
 * 显式值;「跟默认」发的是删除哨兵(null),不是把默认值抄一份进例外。
 */

import type { AdapterCapabilitiesMap } from "@bilibili-notify/contract";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushAdapter, PushTarget } from "../../types/domain";
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

const A_OB = "11111111-1111-4111-8111-111111111111";
const A_OB2 = "22222222-2222-4222-8222-222222222222";
const A_QQ = "33333333-3333-4333-8333-333333333333";

function adapter(id: string, name: string, platform: PushAdapter["platform"]): PushAdapter {
	return { id, name, platform, enabled: true, config: {} } as unknown as PushAdapter;
}

const ADAPTERS: PushAdapter[] = [
	adapter(A_OB, "NapCat 主号", "onebot"),
	adapter(A_OB2, "Lagrange 备用", "onebot"),
	adapter(A_QQ, "官机", "qq-official"),
];

const CAPS: AdapterCapabilitiesMap = {
	[A_OB]: { miniAppCard: { state: "supported", checkedAt: 1 } },
	[A_OB2]: {
		miniAppCard: { state: "unsupported", reason: "这个实现没有 get_mini_app_ark", checkedAt: 1 },
	},
};

function renderCard(
	draft: GlobalConfig,
	onPatch = vi.fn(),
	targets: PushTarget[] = TARGETS,
	extra: { adapters?: PushAdapter[]; capabilities?: AdapterCapabilitiesMap } = {},
) {
	render(
		<MemoryRouter>
			<LinkParsingSettings
				draft={draft}
				onPatch={onPatch}
				targets={targets}
				adapters={extra.adapters ?? ADAPTERS}
				capabilities={extra.capabilities ?? CAPS}
			/>
		</MemoryRouter>,
	);
	return onPatch;
}

const row = (name: string) => within(screen.getByRole("group", { name }));
/** 逐群表默认收起,要看行先展开。 */
const openGroups = () => fireEvent.click(screen.getByRole("button", { name: "展开" }));

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
					adapters={ADAPTERS}
					capabilities={CAPS}
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
					adapters={ADAPTERS}
					capabilities={CAPS}
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
					adapters={ADAPTERS}
					capabilities={CAPS}
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
			expect(screen.getByText("2 个群 · 1 个例外")).toBeTruthy();
			expect(screen.getByText("冷却 60 秒 · 1 个例外")).toBeTruthy();
		});

		it("默认收起,只有一行摘要;点「展开」才列群,再点「收起」", () => {
			renderCard(draftWith({ groups: { [T_A]: { form: "miniapp" } } }));
			expect(screen.getByText("2 个群 · 1 个例外")).toBeTruthy();
			expect(screen.queryByRole("group", { name: "群 A" })).toBeNull();
			openGroups();
			expect(screen.getByRole("group", { name: "群 A" })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "收起" }));
			expect(screen.queryByRole("group", { name: "群 A" })).toBeNull();
		});

		it("只列群类且收得到入站消息的目标:私聊与 webhook 不出现,官机群算", () => {
			renderCard(draftWith());
			openGroups();
			expect(screen.getByRole("group", { name: "群 A" })).toBeTruthy();
			expect(screen.getByRole("group", { name: "官机群 B" })).toBeTruthy();
			expect(screen.queryByRole("group", { name: "主人私聊" })).toBeNull();
			expect(screen.queryByRole("group", { name: "钩子" })).toBeNull();
		});

		it("没写例外的群两格都按在「跟默认」上,并把继承来的值写在旁边", () => {
			renderCard(draftWith({ defaults: { parse: false, form: "miniapp" } }));
			openGroups();
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
			openGroups();
			fireEvent.click(row("群 A").getByRole("button", { name: "关" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkParsing: { groups: { [T_A]: { parse: false } } },
			});
		});

		it("形式格点「小程序卡」→ 草稿只收到这个群的 form=miniapp", () => {
			const onPatch = renderCard(draftWith());
			openGroups();
			fireEvent.click(row("群 A").getByRole("button", { name: "小程序卡" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkParsing: { groups: { [T_A]: { form: "miniapp" } } },
			});
		});

		it("有例外的格点「跟默认」→ 发删除哨兵,不是把默认值抄进例外", () => {
			const onPatch = renderCard(
				draftWith({ groups: { [T_A]: { parse: false, form: "miniapp" } } }),
			);
			openGroups();
			const a = row("群 A");
			expect(a.getByRole("button", { name: "关" }).getAttribute("aria-pressed")).toBe("true");
			fireEvent.click(a.getByRole("button", { name: "跟默认 · 开" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { groups: { [T_A]: { parse: null } } } });
			fireEvent.click(a.getByRole("button", { name: "跟默认 · 图片卡" }));
			expect(onPatch).toHaveBeenCalledWith({ linkParsing: { groups: { [T_A]: { form: null } } } });
		});

		it("停用的目标照列,标「已停用」;适配器停用的也算(运行时一样不解析)", () => {
			renderCard(draftWith(), vi.fn(), [target(T_A, "群 A", { enabled: false })]);
			openGroups();
			expect(row("群 A").getByText("已停用")).toBeTruthy();
			cleanup();

			renderCard(draftWith(), vi.fn(), [target(T_A, "群 A")], {
				adapters: [{ ...ADAPTERS[0], enabled: false } as PushAdapter, ...ADAPTERS.slice(1)],
			});
			openGroups();
			expect(row("群 A").getByText("已停用")).toBeTruthy();
		});

		it("官机群的形式格旁边说明它发不了小程序卡、会回落图片卡", () => {
			renderCard(draftWith());
			openGroups();
			expect(row("官机群 B").getByText(/不支持小程序卡/)).toBeTruthy();
			expect(row("群 A").queryByText(/不支持小程序卡/)).toBeNull();
		});

		it("没有群类推送目标 → 空态 + 去推送目标页的链接", () => {
			renderCard(draftWith(), vi.fn(), [TARGETS[2] as PushTarget]);
			expect(screen.getByText(/还没有群类推送目标/)).toBeTruthy();
			expect(screen.getByRole("link", { name: /推送目标/ }).getAttribute("href")).toBe("/targets");
		});
	});
	describe("适配器支持情况", () => {
		it("只列 OneBot 适配器,三态各有说法:支持 / 不支持带原因 / 未探测", () => {
			renderCard(draftWith(), vi.fn(), TARGETS, {
				capabilities: { ...CAPS, [A_OB2]: CAPS[A_OB2] as never },
			});
			const panel = within(screen.getByRole("region", { name: "适配器支持情况" }));
			expect(panel.getByText("NapCat 主号")).toBeTruthy();
			expect(panel.getByText("支持小程序卡")).toBeTruthy();
			expect(panel.getByText("Lagrange 备用")).toBeTruthy();
			expect(panel.getByText("不支持,回落图片卡")).toBeTruthy();
			expect(panel.getByText(/没有 get_mini_app_ark/)).toBeTruthy();
			expect(panel.queryByText("官机")).toBeNull();
		});

		it("表里没有的 OneBot 适配器(引擎还没探)显示「未探测」", () => {
			renderCard(draftWith(), vi.fn(), TARGETS, { capabilities: {} });
			const panel = within(screen.getByRole("region", { name: "适配器支持情况" }));
			expect(panel.getAllByText("未探测")).toHaveLength(2);
		});

		it("官机与 webhook 用一句话说明不支持;没有 OneBot 适配器时只剩这句", () => {
			renderCard(draftWith(), vi.fn(), TARGETS, { adapters: [ADAPTERS[2] as PushAdapter] });
			const panel = within(screen.getByRole("region", { name: "适配器支持情况" }));
			expect(panel.getByText(/QQ 官方机器人与 webhook 不支持小程序卡/)).toBeTruthy();
			expect(panel.getByText(/还没有 OneBot 适配器/)).toBeTruthy();
		});

		it("群所在的适配器不支持 → 那一行形式格旁提示会回落图片卡;支持的不提示", () => {
			renderCard(draftWith(), vi.fn(), [
				target(T_A, "群 A", { adapterId: A_OB2 } as never),
				target(T_B, "群 B", { adapterId: A_OB } as never),
			]);
			openGroups();
			expect(row("群 A").getByText(/会回落图片卡/)).toBeTruthy();
			expect(row("群 B").queryByText(/回落图片卡/)).toBeNull();
		});
	});
});
