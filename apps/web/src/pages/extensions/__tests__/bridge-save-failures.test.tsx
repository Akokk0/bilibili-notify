// @vitest-environment jsdom
/**
 * 桥接入这一节里「事情没成」的那几屏。
 *
 * 🔴 这一节的每一次写都落在同一发 `PATCH /api/globals` 上,而它此前**没有 onError**:
 * 停用失败 → 开关自己弹回去、一个字不说;删除失败 → 确认框留在原地、按第二下还是没反应;
 * 新建失败 → 弹窗不关、也不说为什么。三种症状主人看到的都是「点了没用」,而真正的原因
 * (盘满了 / 配置被别处锁了 / 401)就在那条响应里躺着。
 *
 * 🔴 名单是**整份写回**的:一发还在路上时再点一下,后一发拿的是渲染时那份旧名单,
 * 于是前一发的改动被按回去 —— 两下都成功、结果只剩后一下,而且没有任何地方会报错。
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { LINK as HOME, renderPanel } from "./bridge-harness";

const OFFICE = { ...HOME, id: "c2", name: "机房那台" };

/** `links` 传 `null` = 那一口读不到(401 / 服务端炸了 / 断网)。 */
function renderLinks(links: unknown[] | null = [HOME]) {
	return renderPanel({ links });
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("写不进去的时候", () => {
	it("停用失败:把服务端那句话摆出来,不让开关自己弹回去就完事", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		renderLinks();
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		expect(await screen.findByText(/配置文件是只读的/)).toBeTruthy();
	});

	it("删除失败:原因就摆在确认框里 —— 框不关、不说话等于让人对着黑盒按第二下", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		renderLinks();
		await userEvent.click(await screen.findByRole("button", { name: "删除 家里那台" }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
		expect(await within(dialog).findByText(/配置文件是只读的/)).toBeTruthy();
	});

	it("新建失败:弹窗里说清为什么,别只是「创建」按下去毫无反应", async () => {
		vi.mocked(api.patch).mockRejectedValue(new Error("配置文件是只读的"));
		renderLinks([]);
		await userEvent.click(await screen.findByRole("button", { name: /新建第一条接入/ }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.type(within(dialog).getByLabelText("接入名字"), "新的那台");
		await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
		expect(await within(dialog).findByText(/配置文件是只读的/)).toBeTruthy();
	});
});

describe("一发还在路上", () => {
	/**
	 * 🔴 名单整份写回,基线是**渲染那一刻**算出来的。前一发还没回来时点第二下,第二发
	 * 带的名单里第一条还是旧值 —— 两发都成功,而第一下的改动被静默抹掉。
	 */
	it("那排钮在写回完成前点不动 —— 后一发会把前一发按回去", async () => {
		vi.mocked(api.patch).mockReturnValue(new Promise(() => {}));
		renderLinks([HOME, OFFICE]);
		await userEvent.click(await screen.findByRole("button", { name: "停用 家里那台" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));

		const other = screen.getByRole("button", { name: "停用 机房那台" }) as HTMLButtonElement;
		expect(other.disabled).toBe(true);
		await userEvent.click(other);
		expect(api.patch).toHaveBeenCalledTimes(1);
	});
});

describe("接入名单读不到", () => {
	/**
	 * 🔴 「读不到」被画成「没有」是一句假话,而且它还请人去建东西 —— 主人照着建一条,
	 * 建完发现原来那几条又回来了(或者压根存不进去)。
	 */
	it("说的是读不到与那句原因,不是「还没有桥接入」", async () => {
		renderLinks(null);
		expect(await screen.findByText(/配置读不出来/)).toBeTruthy();
		expect(screen.queryByText(/还没有桥接入/)).toBeNull();
		expect(screen.queryByRole("button", { name: /新建第一条接入/ })).toBeNull();
	});
});
