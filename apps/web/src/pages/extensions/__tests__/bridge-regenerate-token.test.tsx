// @vitest-environment jsdom
/**
 * 换钥匙之前先问一句。
 *
 * 🔴 「重新生成」是**立刻生效且撤不回**的一下:服务端现读,下一次连接就按新的判,正连着
 * 的那条当场掉线;手一抖换掉了对面正用着的钥匙,就得有人去那一头的插件设置里把新的填一遍
 * 才连得回来。这颗钮与「删除」挨在同一张卡上,而删除早就有确认框 —— 代价同档的两件事
 * 只有一件会拦一下,那一件就是这一排钮里最容易按错的。
 *
 * 空 token 那一颗**刻意不问**:没有连着的桥可踢、也没有旧钥匙可作废(脱敏备份恢复回来的
 * 常态就是空的),问一句只是挡在路上 —— 而它偏偏是最该顺手按下去的那一颗。
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { LINK, renderPanel, savedLinks, TOKEN } from "./bridge-harness";

/** 那一发整份写回里,第一条接入的 token。 */
function patchedToken(): string | undefined {
	return savedLinks()[0]?.token;
}

/** 按下接入卡上那颗「重新生成」。 */
async function clickRegenerate(links: unknown[] = [LINK]) {
	renderPanel({ links });
	await userEvent.click(await screen.findByRole("button", { name: /重新生成/ }));
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("重新生成 token 之前先问一句", () => {
	it("非空 token:先弹确认框,这一下一个字都不写", async () => {
		await clickRegenerate();
		const dialog = await screen.findByRole("dialog");
		// 框里得指名道姓 —— 一屏好几条接入时,「哪一条」就是这一下的全部风险
		expect(within(dialog).getByText(/家里那台/)).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("取消:token 原样不动", async () => {
		await clickRegenerate();
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("确认才真的换 —— 写回的是一把新的 32 位钥匙", async () => {
		await clickRegenerate();
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "重新生成" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(patchedToken()).toMatch(/^[0-9a-f]{32}$/);
		expect(patchedToken()).not.toBe(TOKEN);
	});

	it("空 token 那一颗不问,当场就生成 —— 没东西可踢,也没有旧钥匙可作废", async () => {
		await clickRegenerate([{ ...LINK, token: "" }]);
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(patchedToken()).toMatch(/^[0-9a-f]{32}$/);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
