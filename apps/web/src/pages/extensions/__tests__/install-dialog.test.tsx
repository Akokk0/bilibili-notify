// @vitest-environment jsdom
/**
 * 「装一个拓展」弹窗。
 *
 * 🔴 末尾那段「开发版不用自己动手」说的是 devtools —— 正式版里根本没有 devtools,这段话
 * 对用户就是一句指向不存在的东西的谜语(2026-09-11 主人问「这是只有开发版才有吗」,那时
 * 它对所有人都显示)。`import.meta.env.DEV` 是编译期常量,生产构建里这一枝整个折掉。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class ApiError extends Error {},
}));

import { ExtensionInstallDialog } from "../install-dialog";

function renderDialog() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ExtensionInstallDialog onClose={() => {}} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
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
});
