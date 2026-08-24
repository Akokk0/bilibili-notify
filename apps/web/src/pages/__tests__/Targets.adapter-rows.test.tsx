// @vitest-environment jsdom

/**
 * 推送目标弹窗里那列「选一个适配器」的行。
 *
 * 它挂着 `option` / `option-active`,但选中态此前**只买到一半**:染色的底与边写
 * 在 `style` 里(平台 tint),inline 压过一切 author 样式、清洗层又会摘掉皮肤写的
 * `!important` —— 皮肤改得到圆角与阴影,唯独改不动选中那一行的底。**未选中态更
 * 亏**:那一档的 `bg-bn-surface` / `border-bn-border` 本来是静态 token,却也一起
 * 写在了 inline 上,于是连「整列换个底色」这种最普通的换装都做不到。
 *
 * 修法与服务商候选卡同一套:平台色进 `--bn-tint` 这个自定义属性(inline 里只剩
 * 一个值,不再是一条 `background` 声明),涂法进 `@utility`。工具类落在
 * `@layer utilities`,而皮肤 CSS 是**无层**的 —— 无层恒压过任何分层。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushAdapter } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

/** 两个**不同平台**的适配器 —— tint 逐平台不同,才验得出「没被抹成一个通用色」。 */
const ADAPTERS = [
	{
		id: "11111111-1111-4111-8111-111111111111",
		name: "家里那台 OneBot",
		enabled: true,
		platform: "onebot",
		config: { transport: "http", baseUrl: "http://127.0.0.1:5700", accessToken: "" },
	},
	{
		id: "22222222-2222-4222-8222-222222222222",
		name: "QQ 官方那个",
		enabled: true,
		platform: "qq-official",
		config: { appId: "1145141", appSecret: "x", sandbox: false, botType: "public" },
	},
] as unknown as PushAdapter[];

function renderPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Targets />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return ADAPTERS;
		if (url === "/api/targets") return [];
		return [];
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** 打开「新建推送目标」弹窗 —— 那列适配器行就在里面。 */
async function openTargetEditor(): Promise<void> {
	renderPage();
	// 页面上不止一处入口(空态一个、每张适配器卡上各一个)—— 点头一个就行。
	const [add] = await screen.findAllByRole("button", { name: /新建推送目标/ });
	fireEvent.click(add as HTMLElement);
	await waitFor(() => screen.getByRole("dialog"));
}

function rowOf(name: string): HTMLElement {
	const dialog = screen.getByRole("dialog");
	const row = [...dialog.querySelectorAll<HTMLElement>('[data-bn~="option"]')].find((el) =>
		(el.textContent ?? "").includes(name),
	);
	if (!row) throw new Error(`没找到适配器行:${name}`);
	return row;
}

describe("适配器候选行的两态都够得到皮肤", () => {
	it("选中那行的底与边不在 inline 上 —— 皮肤才盖得动", async () => {
		await openTargetEditor();
		const row = rowOf("家里那台 OneBot");
		expect(row.getAttribute("data-bn")).toContain("option-active");
		expect(row.style.background).toBe("");
		expect(row.style.borderColor).toBe("");
	});

	it("未选中那行也不在 inline 上 —— 它那两个值本来就是静态 token", async () => {
		await openTargetEditor();
		const row = rowOf("QQ 官方那个");
		expect(row.getAttribute("data-bn")).not.toContain("option-active");
		expect(row.style.background).toBe("");
		expect(row.style.borderColor).toBe("");
		expect(row.className).toContain("bg-bn-surface");
	});

	it("平台色改走 --bn-tint,而且逐平台不同", async () => {
		await openTargetEditor();
		const onebot = rowOf("家里那台 OneBot").style.getPropertyValue("--bn-tint");
		const qq = rowOf("QQ 官方那个").style.getPropertyValue("--bn-tint");
		expect(onebot).not.toBe("");
		expect(qq).not.toBe("");
		expect(onebot).not.toBe(qq);
	});

	it("涂法走工具类,只落在选中那一行上", async () => {
		await openTargetEditor();
		expect(rowOf("家里那台 OneBot").className).toContain("bn-tint-row");
		expect(rowOf("QQ 官方那个").className).not.toContain("bn-tint-row");
	});
});
