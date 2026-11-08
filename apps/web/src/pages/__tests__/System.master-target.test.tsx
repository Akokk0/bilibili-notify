// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../__tests__/select-controls";

/**
 * 系统页「主人账号」卡的下拉(ADR-0021 决策 57,3a-18):主人目标只许指向私聊目标。
 *
 * - 下拉只列私聊目标(群、频道、webhook 托管端点都不列);
 * - 当前存着的值不在可选项里(指向群,或目标没了)→ 多一行不可选的「已失效」,
 *   下面的状态行说明并请主人重选;
 * - 选一个私聊目标 → 照常 patch。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import type { PushTarget } from "../../types/domain";
import type { GlobalSettings } from "../../types/globals";
import { MasterSection } from "../system/master-section";

vi.mock("../../hooks/useDirtyDraft", () => ({ useDirtyDraft: () => {} }));
const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});
vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: { get: vi.fn(async () => []), post: vi.fn(), patch: vi.fn() },
}));
// 登录状态：这条测试不关心账号卡，按「还没取到」处理（与从前的空快照同一语境）。
vi.mock("../../hooks/use-source-auth", () => ({
	useSourceAuth: () => ({
		state: undefined,
		account: undefined,
		raw: undefined,
		isLoading: true,
		isError: false,
		error: null,
		startLogin: { isPending: false, mutate: () => {} },
		logout: { isPending: false, mutate: () => {} },
	}),
}));

function target(id: string, name: string, scope: "group" | "private" | "channel"): PushTarget {
	return {
		id,
		name,
		connectionId: "c1",
		kind: "session",
		scope,
		address: "1",
		enabled: true,
	} as PushTarget;
}

const TARGETS = [
	target("t-priv", "主人私聊", "private"),
	target("t-priv2", "副号私聊", "private"),
	target("t-group", "通知群", "group"),
	target("t-chan", "频道", "channel"),
];

function renderCard(targetId: string | undefined, onPatch = vi.fn()) {
	const draft = { master: { targetId } } as unknown as GlobalSettings;
	render(<MasterSection draft={draft} targets={TARGETS} onPatch={onPatch} />);
	return onPatch;
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const optionLabels = () => selectOptionsOf(screen.getByRole("combobox")).map((o) => o.textContent);

describe("MasterSection 的下拉", () => {
	afterEach(cleanup);

	it("notification-account labels follow locale without rewriting targets or patching a stale selection", async () => {
		const onPatch = renderCard("t-group");
		for (const [locale, title, unset, invalid, hint] of [
			[
				"en",
				"Owner notifications",
				"Not configured",
				"Invalid target",
				"This target is not a private chat. Choose a private-chat target.",
			],
			[
				"ja",
				"管理者への通知",
				"未設定",
				"無効な送信先",
				"この送信先は個人チャットではありません。個人チャットの送信先を選んでください。",
			],
			["zh-TW", "管理員通知", "未設定", "已失效", "此目標不是私聊，請選擇私聊目標。"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(screen.getByText(title)).toBeTruthy();
			expect(optionLabels()).toEqual([unset, invalid, "主人私聊c1", "副号私聊c1"]);
			expect(screen.getByRole("combobox").textContent).toBe(invalid);
			expect(screen.getByText(hint)).toBeTruthy();
			expect(onPatch).not.toHaveBeenCalled();
		}
		chooseSelect(screen.getByRole("combobox"), "副号私聊 · c1");
		expect(onPatch).toHaveBeenCalledExactlyOnceWith({ master: { targetId: "t-priv2" } });
	});

	it("只列私聊目标:群与频道不在可选项里", () => {
		renderCard(undefined);
		expect(optionLabels()).toEqual(["未配置", "主人私聊c1", "副号私聊c1"]);
	});

	it("存着的是私聊目标:选中它,状态行写它的名字,没有「已失效」行", () => {
		renderCard("t-priv");
		expect(screen.getByRole("combobox").textContent).toBe("主人私聊c1");
		expect(optionLabels()).not.toContain("已失效");
		expect(screen.getByText("→ 主人私聊 · c1")).toBeTruthy();
	});

	it("存着的指向群:多一行不可选的「已失效」并停在它上面,状态行请主人换私聊目标", () => {
		renderCard("t-group");
		expect(optionLabels()).toEqual(["未配置", "已失效", "主人私聊c1", "副号私聊c1"]);
		const stale = screen.getByRole("option", { name: "已失效" }) as HTMLButtonElement;
		expect(stale.disabled).toBe(true);
		expect(screen.getByRole("combobox").textContent).toBe("已失效");
		expect(screen.getByText("该目标不是私聊，请选择私聊目标。")).toBeTruthy();
	});

	it("存着的目标已经不在了:同样多一行「已失效」,状态行说原来的目标不在了", () => {
		renderCard("t-gone");
		expect(optionLabels()).toEqual(["未配置", "已失效", "主人私聊c1", "副号私聊c1"]);
		expect(screen.getByRole("combobox").textContent).toBe("已失效");
		expect(screen.getByText("原来的目标已不存在，请重新选择私聊目标。")).toBeTruthy();
	});

	it("没配主人:没有「已失效」行,状态行照旧", () => {
		renderCard(undefined);
		expect(optionLabels()).not.toContain("已失效");
		expect(screen.getByText("未配置 · 出错时不会私聊提醒")).toBeTruthy();
	});

	it("选一个私聊目标 → patch 它的 id", () => {
		const onPatch = renderCard("t-group");
		chooseSelect(screen.getByRole("combobox"), "副号私聊 · c1");
		expect(onPatch).toHaveBeenCalledWith({ master: { targetId: "t-priv2" } });
	});
});

it("同名私聊仍能按连接选择，patch 保持目标 id", () => {
	const onPatch = vi.fn();
	render(
		<MasterSection
			draft={{ master: {} }}
			targets={[
				target("first", "Family", "private"),
				{ ...target("second", "Family", "private"), connectionId: "c2" },
			]}
			connections={
				[
					{ id: "c1", name: "Main", platform: "relay" },
					{ id: "c2", name: "Backup", platform: "relay" },
				] as import("../../types/domain").Connection[]
			}
			onPatch={onPatch}
		/>,
	);
	chooseSelect(screen.getByRole("combobox"), "Family · Backup");
	expect(onPatch).toHaveBeenCalledExactlyOnceWith({ master: { targetId: "second" } });
});
