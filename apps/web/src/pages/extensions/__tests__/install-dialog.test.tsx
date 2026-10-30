// @vitest-environment jsdom
/**
 * 「装一个拓展」弹窗。
 *
 * 🔴 末尾那段「开发版不用自己动手」说的是 devtools —— 正式版里根本没有 devtools,这段话
 * 对用户就是一句指向不存在的东西的谜语(2026-09-11 主人问「这是只有开发版才有吗」,那时
 * 它对所有人都显示)。`import.meta.env.DEV` 是编译期常量,生产构建里这一枝整个折掉。
 *
 * 🔴「自己放进去」那条印的是服务端报的装载根:1.0 起数据在 `<dataDir>/generations/<序号>/` 里,
 * 照老说法放进 `<dataDir>/extensions/` 的包永远不会被装上,而序号主人自己猜不出来。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class ApiError extends Error {},
}));
vi.mock("../../../utils/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { i18n } from "../../../i18n";
import { api } from "../../../services/api";
import { copyToClipboard } from "../../../utils/clipboard";
import { ExtensionInstallDialog } from "../install-dialog";

const ROOT = "/srv/bn/generations/3/extensions";

function listed(over: Partial<ExtensionsResponse> = {}): ExtensionsResponse {
	return {
		extensions: [],
		restart: { can: false, code: "unsupervised", message: "这个进程退了没人拉" },
		...over,
	};
}

function renderDialog() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ExtensionInstallDialog onClose={() => {}} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
	vi.mocked(api.get).mockResolvedValue(listed({ root: ROOT }));
});

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("装一个拓展", () => {
	it("开发版:末尾有「开发版不用自己动手」那段", () => {
		vi.stubEnv("DEV", true);
		renderDialog();
		expect(screen.getByText(/开发版不用自己动手/)).toBeTruthy();
	});

	it("正式版:那段整个不渲染 —— 正式版里没有 devtools,别让用户去找左下角", () => {
		vi.stubEnv("DEV", false);
		renderDialog();
		expect(screen.queryByText(/开发版不用自己动手/)).toBeNull();
	});

	it("传包的虚线框是圆角矩形,与 AddCard 同一档(rounded-xl),不是方的", () => {
		vi.stubEnv("DEV", true);
		renderDialog();
		// 弹窗经 portal 挂在 body 上,别从 render 的 container 里找。
		const slot = document.body.querySelector('[data-bn="add-slot"]');
		expect(slot).not.toBeNull();
		expect(slot?.className).toMatch(/\brounded-xl\b/);
	});

	it("「自己放进去」印的是服务端报的装载根,复制下去的就是那一串", async () => {
		renderDialog();

		expect(await screen.findByText(ROOT)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "复制拓展目录" }));
		expect(copyToClipboard).toHaveBeenCalledWith(ROOT);
	});

	it("服务端没报装载根(回退到老版本时)→ 照老说法写 <dataDir>/extensions/,不给复制", async () => {
		vi.mocked(api.get).mockResolvedValue(listed());
		renderDialog();

		expect(await screen.findByText("<dataDir>/extensions/<拓展 id>/")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "复制拓展目录" })).toBeNull();
	});
});
