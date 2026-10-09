// @vitest-environment jsdom

/**
 * 系统页「主人账号」卡的下拉(ADR-0021 决策 57,3a-18):主人目标只许指向私聊目标。
 *
 * - 下拉只列私聊目标(群、频道、webhook 托管端点都不列);
 * - 当前存着的值不在可选项里(指向群,或目标没了)→ 多一行不可选的「已失效」,
 *   下面的状态行说明并请主人重选;
 * - 选一个私聊目标 → 照常 patch。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { MasterSection } from "../System";

vi.mock("../../hooks/useDirtyDraft", () => ({ useDirtyDraft: () => {} }));
const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});
vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: { get: vi.fn(async () => []), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("../../store/auth", () => {
	const useAuthStore = (select: (s: unknown) => unknown) =>
		select({ snapshot: null, cookiesRefreshedAt: null });
	useAuthStore.getState = () => ({ clear: () => {} });
	return { useAuthStore };
});

function target(id: string, name: string, scope: "group" | "private" | "channel"): PushTarget {
	return {
		id,
		name,
		connectionId: "c1",
		kind: "session",
		platform: "onebot",
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
	const draft = { master: { targetId } } as unknown as GlobalConfig;
	render(<MasterSection draft={draft} targets={TARGETS} onPatch={onPatch} />);
	return onPatch;
}

const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("MasterSection 的下拉", () => {
	afterEach(cleanup);

	it("只列私聊目标:群与频道不在可选项里", () => {
		renderCard(undefined);
		expect(optionLabels()).toEqual(["未配置", "主人私聊", "副号私聊"]);
	});

	it("存着的是私聊目标:选中它,状态行写它的名字,没有「已失效」行", () => {
		renderCard("t-priv");
		expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("t-priv");
		expect(optionLabels()).not.toContain("已失效");
		expect(screen.getByText("→ 主人私聊")).toBeTruthy();
	});

	it("存着的指向群:多一行不可选的「已失效」并停在它上面,状态行请主人换私聊目标", () => {
		renderCard("t-group");
		expect(optionLabels()).toEqual(["未配置", "已失效", "主人私聊", "副号私聊"]);
		const stale = screen.getByRole("option", { name: "已失效" }) as HTMLOptionElement;
		expect(stale.disabled).toBe(true);
		expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("t-group");
		expect(
			screen.getByText("这个目标不是私聊，女仆没法悄悄告诉主人。请换一个私聊目标"),
		).toBeTruthy();
	});

	it("存着的目标已经不在了:同样多一行「已失效」,状态行说原来的目标不在了", () => {
		renderCard("t-gone");
		expect(optionLabels()).toEqual(["未配置", "已失效", "主人私聊", "副号私聊"]);
		expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("t-gone");
		expect(screen.getByText("原来的目标已经不在了，请重新选一个私聊目标")).toBeTruthy();
	});

	it("没配主人:没有「已失效」行,状态行照旧", () => {
		renderCard(undefined);
		expect(optionLabels()).not.toContain("已失效");
		expect(screen.getByText("未配置 · 出错时不会私聊提醒")).toBeTruthy();
	});

	it("选一个私聊目标 → patch 它的 id", () => {
		const onPatch = renderCard("t-group");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "t-priv2" } });
		expect(onPatch).toHaveBeenCalledWith({ master: { targetId: "t-priv2" } });
	});
});
