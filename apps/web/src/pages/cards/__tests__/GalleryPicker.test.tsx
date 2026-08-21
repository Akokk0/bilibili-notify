// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { GalleryPicker } from "../GalleryPicker";

const { getMock, blobMock, deleteMock, uploadMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	blobMock: vi.fn(),
	deleteMock: vi.fn(),
	uploadMock: vi.fn(),
}));

vi.mock("../../../services/api", () => ({
	api: { get: getMock, blob: blobMock, delete: deleteMock, upload: uploadMock },
	ApiError: class extends Error {
		status = 0;
		body: unknown;
	},
}));

function renderWithQuery(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const REAL = `${"1".repeat(32)}.png`;
const GHOST = `${"9".repeat(32)}.png`;

describe("GalleryPicker", () => {
	beforeEach(() => {
		getMock.mockReset();
		getMock.mockResolvedValue({ ok: true, ids: [REAL] });
		blobMock.mockReset();
		blobMock.mockRejectedValue(new Error("no blob in test")); // 缩略图走占位分支
		deleteMock.mockReset();
	});
	afterEach(() => cleanup());

	it("选中但已不在图廊(文件被删)的 id → 渲染可见的「已失效」占位块,带轮换序号", async () => {
		renderWithQuery(<GalleryPicker value={[GHOST, REAL]} onChange={() => {}} />);
		const ghost = await screen.findByTestId("gallery-ghost");
		expect(ghost.textContent).toContain("已失效");
		expect(ghost.textContent).toContain("1"); // 幽灵占轮换第 1 位
	});

	it("两态角标只差底色 —— 失效那颗是红的,不能跟正常的串成一样", async () => {
		// 两个分支此前各写一遍同一串 90 字符类名。收成 OrderBadge 后,这条钉住
		// 「合并没把两态染成同一个色」——真串了的话页面上分不出哪张图已经失效。
		renderWithQuery(<GalleryPicker value={[GHOST, REAL]} onChange={() => {}} />);
		const ghost = await screen.findByTestId("gallery-ghost");
		const badge = ghost.querySelector("span.absolute") as HTMLElement;
		expect([
			badge.className.includes("bg-bn-danger-text"),
			badge.className.includes("bg-bn-pink"),
		]).toEqual([true, false]);
	});

	it("点失效占位块的移除按钮 → 从选择里剔除该 id", async () => {
		const onChange = vi.fn();
		renderWithQuery(<GalleryPicker value={[GHOST, REAL]} onChange={onChange} />);
		await screen.findByTestId("gallery-ghost");
		fireEvent.click(screen.getByLabelText("移除失效引用"));
		expect(onChange).toHaveBeenCalledWith([REAL]);
	});

	it("删盘成功 → 除 onChange 剔除自身选择外,还回调 onAssetDeleted 让页面清扫其他字段", async () => {
		deleteMock.mockResolvedValue({ ok: true });
		const onChange = vi.fn();
		const onAssetDeleted = vi.fn();
		renderWithQuery(
			<GalleryPicker value={[REAL]} onChange={onChange} onAssetDeleted={onAssetDeleted} />,
		);
		fireEvent.click(await screen.findByLabelText("从图廊删除"));
		await waitFor(() => expect(onChange).toHaveBeenCalledWith([]));
		expect(onAssetDeleted).toHaveBeenCalledWith(REAL);
	});

	it("空选/单张的底部文案可被调用方定制(封面上下文不再写「用渐变背景」)", async () => {
		const { unmount } = renderWithQuery(
			<GalleryPicker value={[]} onChange={() => {}} emptyHint="未选择(用 B 站直播间原始封面)" />,
		);
		expect(await screen.findByText("未选择(用 B 站直播间原始封面)")).toBeTruthy();
		unmount();

		renderWithQuery(<GalleryPicker value={[REAL]} onChange={() => {}} singleHint="单张固定封面" />);
		expect(await screen.findByText("单张固定封面")).toBeTruthy();
	});

	it("默认文案维持背景语义不变", async () => {
		renderWithQuery(<GalleryPicker value={[]} onChange={() => {}} />);
		expect(await screen.findByText("未选择(用渐变背景)")).toBeTruthy();
	});
});
