// @vitest-environment jsdom
/**
 * 「链接解析」卡片 —— 总开关 + 冷却秒数 + 默认行(所有群解不解析、回什么)+ 按群例外表。
 *
 * 缝在组件的 props:草稿与推送目标进、patch 出。不测样式,只测「按了控件草稿收到什么」
 * 和「关着时徽标说关着」—— 后者是主人一眼判断功能状态的地方。例外表每格三态:跟默认 /
 * 显式值;「跟默认」发的是删除哨兵(null),不是把默认值抄一份进例外。
 */

import type { ConnectionCapabilitiesMap } from "@bilibili-notify/contract";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { adapterKeyFor, snapshotFor } from "../../__tests__/platform-snapshot";
import type { Connection, PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { LinkPreviewSettings } from "../link-preview-settings";

type LinkPreviewValue = GlobalConfig["linkPreview"];

const T_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_PRIVATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T_WEBHOOK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function draftWith(over: Partial<LinkPreviewValue> = {}): GlobalConfig {
	const linkPreview: LinkPreviewValue = {
		enabled: true,
		cooldownSec: 60,
		isOnByDefault: true,
		replyForm: "image",
		byTarget: {},
		...over,
	};
	return { linkPreview } as unknown as GlobalConfig;
}

function target(id: string, name: string, over: Partial<PushTarget> = {}): PushTarget {
	return {
		id,
		name,
		connectionId: "11111111-1111-4111-8111-111111111111",
		scope: "group",
		enabled: true,
		kind: "session",
		address: "123",
		...over,
	} as PushTarget;
}

// 目标的平台取自它挂着的连接:官机群挂官机连接、webhook 终点挂 webhook 连接。
const A_HOOK = "44444444-4444-4444-8444-444444444444";
const A_OB = "11111111-1111-4111-8111-111111111111";
const A_OB2 = "22222222-2222-4222-8222-222222222222";
const A_QQ = "33333333-3333-4333-8333-333333333333";

const TARGETS: PushTarget[] = [
	target(T_A, "群 A"),
	target(T_B, "官机群 B", { connectionId: A_QQ, platform: "qq-official", address: "op" } as never),
	target(T_PRIVATE, "主人私聊", { scope: "private", address: "1" } as never),
	target(T_WEBHOOK, "钩子", {
		connectionId: A_HOOK,
		kind: "endpoint",
	} as never),
];

function connection(id: string, name: string, platform: string): Connection {
	return {
		id,
		name,
		adapterKey: adapterKeyFor(platform),
		platform,
		enabled: true,
		settings: {},
		platformSnapshot: snapshotFor(platform),
	};
}

const ADAPTERS: Connection[] = [
	connection(A_OB, "NapCat 主号", "onebot"),
	connection(A_OB2, "Lagrange 备用", "onebot"),
	connection(A_QQ, "官机", "qq-official"),
	connection(A_HOOK, "飞书钩子", "feishu"),
];

const UNKNOWN = { state: "unknown" } as const;
const SUPPORTED = { state: "supported", checkedAt: 1 } as const;

/** 一级索引:连接 id → 这条连接的能力(适配器的回答)。直连与拓展连接都在里面。 */
const CAPS: ConnectionCapabilitiesMap = {
	[A_OB]: { atAll: SUPPORTED, inbound: SUPPORTED, nativeShare: SUPPORTED },
	[A_OB2]: {
		atAll: SUPPORTED,
		inbound: SUPPORTED,
		nativeShare: {
			state: "unsupported",
			reason: "这个实现没有 get_mini_app_ark",
			checkedAt: 1,
		},
	},
	// 官机:收得到回复,发不了 @全体 / 小程序卡。
	[A_QQ]: {
		atAll: { state: "unsupported", reason: "要特殊权限", checkedAt: 1 },
		inbound: SUPPORTED,
		nativeShare: { state: "unsupported", reason: "没实现", checkedAt: 1 },
	},
	// webhook:没有回程。
	[A_HOOK]: {
		atAll: SUPPORTED,
		inbound: { state: "unsupported", reason: "没有回程", checkedAt: 1 },
		nativeShare: { state: "unsupported", reason: "发不了", checkedAt: 1 },
	},
};

function renderCard(
	draft: GlobalConfig,
	onPatch = vi.fn(),
	targets: PushTarget[] = TARGETS,
	extra: { connections?: Connection[]; capabilities?: ConnectionCapabilitiesMap } = {},
) {
	render(
		<MemoryRouter>
			<LinkPreviewSettings
				draft={draft}
				onPatch={onPatch}
				targets={targets}
				connections={extra.connections ?? ADAPTERS}
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

describe("LinkPreviewSettings", () => {
	it("拨开总开关 → 草稿收到 linkPreview.enabled=true", () => {
		const onPatch = renderCard(draftWith({ enabled: false }));
		fireEvent.click(screen.getByRole("button", { name: "链接解析总开关" }));
		expect(onPatch).toHaveBeenCalledWith({ linkPreview: { enabled: true } });
	});

	it("改冷却秒数 → 草稿收到 linkPreview.cooldownSec", () => {
		const onPatch = renderCard(draftWith());
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "120" } });
		expect(onPatch).toHaveBeenCalledWith({ linkPreview: { cooldownSec: 120 } });
	});

	it("徽标:关着写「已关闭」;开着写冷却;默认不解析加「仅例外群」;有例外加个数", () => {
		const { rerender } = render(
			<MemoryRouter>
				<LinkPreviewSettings
					draft={draftWith({ enabled: false })}
					onPatch={() => {}}
					targets={TARGETS}
					connections={ADAPTERS}
					capabilities={CAPS}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("已关闭")).toBeTruthy();
		rerender(
			<MemoryRouter>
				<LinkPreviewSettings
					draft={draftWith({ enabled: true, cooldownSec: 90 })}
					onPatch={() => {}}
					targets={TARGETS}
					connections={ADAPTERS}
					capabilities={CAPS}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("冷却 90 秒")).toBeTruthy();
		rerender(
			<MemoryRouter>
				<LinkPreviewSettings
					draft={draftWith({
						isOnByDefault: false,
						replyForm: "image",
						byTarget: { [T_A]: { isOn: true }, [T_B]: { replyForm: "nativeShare" } },
					})}
					onPatch={() => {}}
					targets={TARGETS}
					connections={ADAPTERS}
					capabilities={CAPS}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("冷却 60 秒 · 仅例外群 · 2 个例外")).toBeTruthy();
	});

	describe("默认行(所有群)", () => {
		it("解析切到「关」→ 草稿收到 isOnByDefault=false", () => {
			const onPatch = renderCard(draftWith());
			fireEvent.click(row("默认(所有群)").getByRole("button", { name: "关" }));
			expect(onPatch).toHaveBeenCalledWith({ linkPreview: { isOnByDefault: false } });
		});

		it("形式那一格有三个选项:图片卡、小程序卡、文字;点「文字」→ 草稿收到 replyForm=text", () => {
			const onPatch = renderCard(draftWith());
			const defaults = row("默认(所有群)");
			for (const name of ["图片卡", "小程序卡", "文字"]) {
				expect(defaults.getByRole("button", { name })).toBeTruthy();
			}
			fireEvent.click(defaults.getByRole("button", { name: "文字" }));
			expect(onPatch).toHaveBeenCalledWith({ linkPreview: { replyForm: "text" } });
		});

		it("形式切到「小程序卡」→ 草稿收到 replyForm=nativeShare", () => {
			const onPatch = renderCard(draftWith());
			fireEvent.click(row("默认(所有群)").getByRole("button", { name: "小程序卡" }));
			expect(onPatch).toHaveBeenCalledWith({ linkPreview: { replyForm: "nativeShare" } });
		});
	});

	describe("按群例外", () => {
		it("两格都调回「跟默认」→ 这一格不再算例外(草稿里那个空对象不算)", () => {
			renderCard(draftWith({ byTarget: { [T_A]: {}, [T_B]: { replyForm: "nativeShare" } } }));
			expect(screen.getByText("2 个群 · 1 个例外")).toBeTruthy();
			expect(screen.getByText("冷却 60 秒 · 1 个例外")).toBeTruthy();
		});

		it("默认收起,只有一行摘要;点「展开」才列群,再点「收起」", () => {
			renderCard(draftWith({ byTarget: { [T_A]: { replyForm: "nativeShare" } } }));
			expect(screen.getByText("2 个群 · 1 个例外")).toBeTruthy();
			expect(screen.queryByRole("group", { name: "群 A" })).toBeNull();
			openGroups();
			expect(screen.getByRole("group", { name: "群 A" })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "收起" }));
			expect(screen.queryByRole("group", { name: "群 A" })).toBeNull();
		});

		/**
		 * 🔴 桥借来的平台(telegram / discord …)是**握手时才知道的开放字符串**,平台注册表
		 * 里压根没有它 —— 按注册表筛,这些群整批被漏掉,而运行时照样会解析它们发的链接。
		 * 判据只能是「这条连接是拓展借来的」。
		 */
		it("拓展连接底下的群也算候选 —— 它的平台不在注册表里,但链接照样会被解析", () => {
			const EXT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
			renderCard(
				draftWith(),
				vi.fn(),
				[target(T_A, "电报群", { connectionId: EXT, platform: "telegram" } as never)],
				{
					connections: [
						{
							id: EXT,
							name: "小电视",
							adapterKey: "bridge",
							platform: "telegram",
							enabled: true,
							settings: {},
							platformSnapshot: snapshotFor("telegram"),
						} satisfies Connection,
					],
				},
			);
			openGroups();
			expect(screen.getByRole("group", { name: "电报群" })).toBeTruthy();
		});

		it("拓展连接上的**私聊**目标还是不列 —— 例外表讲的只是群", () => {
			const EXT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
			renderCard(
				draftWith(),
				vi.fn(),
				[
					target(T_A, "电报群", { connectionId: EXT, platform: "telegram" } as never),
					target(T_PRIVATE, "电报私聊", {
						connectionId: EXT,
						platform: "telegram",
						scope: "private",
					} as never),
				],
				{
					connections: [
						{
							id: EXT,
							name: "小电视",
							adapterKey: "bridge",
							platform: "telegram",
							enabled: true,
							settings: {},
							platformSnapshot: snapshotFor("telegram"),
						} satisfies Connection,
					],
				},
			);
			openGroups();
			expect(screen.queryByRole("group", { name: "电报私聊" })).toBeNull();
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
			renderCard(draftWith({ isOnByDefault: false, replyForm: "nativeShare" }));
			openGroups();
			const a = row("群 A");
			expect(a.getByRole("button", { name: "跟默认 · 关" }).getAttribute("aria-pressed")).toBe(
				"true",
			);
			expect(
				a.getByRole("button", { name: "跟默认 · 小程序卡" }).getAttribute("aria-pressed"),
			).toBe("true");
		});

		it("解析格点「关」→ 草稿只收到这个群的 isOn=false", () => {
			const onPatch = renderCard(draftWith());
			openGroups();
			fireEvent.click(row("群 A").getByRole("button", { name: "关" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkPreview: { byTarget: { [T_A]: { isOn: false } } },
			});
		});

		it("形式格点「小程序卡」→ 草稿只收到这个群的 replyForm=nativeShare", () => {
			const onPatch = renderCard(draftWith());
			openGroups();
			fireEvent.click(row("群 A").getByRole("button", { name: "小程序卡" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkPreview: { byTarget: { [T_A]: { replyForm: "nativeShare" } } },
			});
		});

		it("有例外的格点「跟默认」→ 发删除哨兵,不是把默认值抄进例外", () => {
			const onPatch = renderCard(
				draftWith({ byTarget: { [T_A]: { isOn: false, replyForm: "nativeShare" } } }),
			);
			openGroups();
			const a = row("群 A");
			expect(a.getByRole("button", { name: "关" }).getAttribute("aria-pressed")).toBe("true");
			fireEvent.click(a.getByRole("button", { name: "跟默认 · 开" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkPreview: { byTarget: { [T_A]: { isOn: null } } },
			});
			fireEvent.click(a.getByRole("button", { name: "跟默认 · 图片卡" }));
			expect(onPatch).toHaveBeenCalledWith({
				linkPreview: { byTarget: { [T_A]: { replyForm: null } } },
			});
		});

		it("停用的目标照列,标「已停用」;连接停用的也算(运行时一样不解析)", () => {
			renderCard(draftWith(), vi.fn(), [target(T_A, "群 A", { enabled: false })]);
			openGroups();
			expect(row("群 A").getByText("已停用")).toBeTruthy();
			cleanup();

			renderCard(draftWith(), vi.fn(), [target(T_A, "群 A")], {
				connections: [{ ...ADAPTERS[0], enabled: false } as Connection, ...ADAPTERS.slice(1)],
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

		describe("列不列这个群:读连接的 inbound 能力", () => {
			const groupOn = (connectionId: string) => [target(T_A, "某群", { connectionId } as never)];
			const withCaps = (
				inbound: ConnectionCapabilitiesMap[string]["inbound"],
				connection: Connection,
			) =>
				renderCard(draftWith(), vi.fn(), groupOn(connection.id), {
					connections: [connection],
					capabilities: {
						[connection.id]: { atAll: UNKNOWN, inbound, nativeShare: UNKNOWN },
					},
				});

			it("支持 → 列", () => {
				withCaps(SUPPORTED, ADAPTERS[0] as Connection);
				openGroups();
				expect(screen.getByRole("group", { name: "某群" })).toBeTruthy();
			});

			it("不支持 → 不列(webhook 直连的会话目标也一样,不看平台名)", () => {
				withCaps(
					{ state: "unsupported", reason: "没有回程", checkedAt: 1 },
					ADAPTERS[3] as Connection,
				);
				expect(screen.getByText(/还没有群类推送目标/)).toBeTruthy();
			});

			it("还不知道 → 照列", () => {
				withCaps({ state: "unknown", reason: "桥没报这一项" }, ADAPTERS[0] as Connection);
				openGroups();
				expect(screen.getByRole("group", { name: "某群" })).toBeTruthy();
			});

			it("能力表里没有这条连接(引擎没起来 / 表还没回来)→ 照「还不知道」列", () => {
				renderCard(draftWith(), vi.fn(), groupOn(A_HOOK), { capabilities: {} });
				openGroups();
				expect(screen.getByRole("group", { name: "某群" })).toBeTruthy();
			});

			it("目标挂的连接不在了 → 不知道它是谁,不列", () => {
				renderCard(draftWith(), vi.fn(), groupOn("99999999-9999-4999-8999-999999999999"));
				expect(screen.getByText(/还没有群类推送目标/)).toBeTruthy();
			});
		});

		it("没有群类推送目标 → 空态 + 去推送目标页的链接", () => {
			renderCard(draftWith(), vi.fn(), [TARGETS[2] as PushTarget]);
			expect(screen.getByText(/还没有群类推送目标/)).toBeTruthy();
			expect(screen.getByRole("link", { name: /推送目标/ }).getAttribute("href")).toBe("/targets");
		});
	});
	describe("连接支持情况", () => {
		it("只列 OneBot 连接,三态各有说法:支持 / 不支持带原因 / 未探测", () => {
			renderCard(draftWith(), vi.fn(), TARGETS, {
				capabilities: { ...CAPS, [A_OB2]: CAPS[A_OB2] as never },
			});
			const panel = within(screen.getByRole("region", { name: "连接支持情况" }));
			expect(panel.getByText("NapCat 主号")).toBeTruthy();
			expect(panel.getByText("支持小程序卡")).toBeTruthy();
			expect(panel.getByText("Lagrange 备用")).toBeTruthy();
			expect(panel.getByText("不支持,回落图片卡")).toBeTruthy();
			expect(panel.getByText(/没有 get_mini_app_ark/)).toBeTruthy();
			expect(panel.queryByText("官机")).toBeNull();
		});

		it("表里没有的 OneBot 连接(引擎还没探)显示「未探测」", () => {
			renderCard(draftWith(), vi.fn(), TARGETS, { capabilities: {} });
			const panel = within(screen.getByRole("region", { name: "连接支持情况" }));
			expect(panel.getAllByText("未探测")).toHaveLength(2);
		});

		it("官机与 webhook 用一句话说明不支持;没有 OneBot 连接时只剩这句", () => {
			renderCard(draftWith(), vi.fn(), TARGETS, { connections: [ADAPTERS[2] as Connection] });
			const panel = within(screen.getByRole("region", { name: "连接支持情况" }));
			expect(panel.getByText(/QQ 官方机器人与 webhook 不支持小程序卡/)).toBeTruthy();
			expect(panel.getByText(/还没有 OneBot 连接/)).toBeTruthy();
		});

		it("群所在的连接不支持 → 那一行形式格旁提示会回落图片卡;支持的不提示", () => {
			renderCard(draftWith(), vi.fn(), [
				target(T_A, "群 A", { connectionId: A_OB2 } as never),
				target(T_B, "群 B", { connectionId: A_OB } as never),
			]);
			openGroups();
			expect(row("群 A").getByText(/会回落图片卡/)).toBeTruthy();
			expect(row("群 B").queryByText(/回落图片卡/)).toBeNull();
		});
	});
});
