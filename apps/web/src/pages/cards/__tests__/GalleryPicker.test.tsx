// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { GalleryPicker } from "../GalleryPicker";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
afterEach(() => {
	cleanup();
	i18n.set({ voice: "maid" });
});

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

function Location() {
	const location = useLocation();
	return (
		<output aria-label="当前位置">
			{location.pathname}
			{location.search}
		</output>
	);
}

function renderWithQuery(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<Location />
			<QueryClientProvider client={qc}>{node}</QueryClientProvider>
		</MemoryRouter>,
	);
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
	it.each([
		[
			"ja",
			"ご主人様、2枚の画像を通知ごとに順番に切り替えますね。",
			"2 枚 · 通知ごとに順番に切り替え",
			"無効な画像の参照を削除",
		],
		[
			"zh-TW",
			"主人，這 2 張圖片會在每次推播時依序輪換喔。",
			"2 張 · 每次推播依序輪換",
			"移除失效引用",
		],
	] as const)(
		"%s maid rotation hint retains image order and the missing reference until removal",
		async (locale, maid, plain, remove) => {
			const onChange = vi.fn();
			renderWithQuery(<GalleryPicker value={[GHOST, REAL]} onChange={onChange} />);
			const ghost = await screen.findByTestId("gallery-ghost");
			for (const [voice, expected] of [
				["maid", maid],
				["plain", plain],
			] as const) {
				act(() => i18n.set({ locale, voice }));
				expect(screen.getByText(expected)).toBeTruthy();
				expect(screen.getByTestId("gallery-ghost")).toBe(ghost);
				expect(ghost.textContent).toContain("1");
				expect(onChange).not.toHaveBeenCalled();
				expect(deleteMock).not.toHaveBeenCalled();
			}
			fireEvent.click(screen.getByRole("button", { name: remove }));
			expect(onChange).toHaveBeenCalledExactlyOnceWith([REAL]);
			expect(deleteMock).not.toHaveBeenCalled();
		},
	);

	it("管理资源在当前页进入图片分类，不提交未确认选择", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const onChange = vi.fn();
		try {
			renderWithQuery(<GalleryPicker value={[]} onChange={onChange} />);
			fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
			fireEvent.click(await screen.findByRole("button", { name: "选择图片 1" }));
			fireEvent.click(screen.getByRole("button", { name: "管理资源" }));
			expect(screen.getByLabelText("当前位置").textContent).toBe("/library?category=images");
			expect(open).not.toHaveBeenCalled();
			expect(screen.getByText("已选择 1 张")).toBeTruthy();
			expect(onChange).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
		}
	});

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

	it("选择窗不提供删除文件，取消不清字段或通知删盘", async () => {
		const onChange = vi.fn(),
			onAssetDeleted = vi.fn();
		renderWithQuery(
			<GalleryPicker value={[REAL]} onChange={onChange} onAssetDeleted={onAssetDeleted} />,
		);
		fireEvent.click(await screen.findByRole("button", { name: "选择图片" }));
		await screen.findByRole("button", { name: "选择图片 1" });
		expect(screen.queryByRole("button", { name: /删除图片|从图廊删除/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(onAssetDeleted).not.toHaveBeenCalled();
		expect(deleteMock).not.toHaveBeenCalled();
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

describe("素材库图片端点接线", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});
	it("上传到素材库，刷新图片列表并选入上传结果，缩略图也从素材库读", async () => {
		getMock.mockReset();
		blobMock.mockReset();
		uploadMock.mockReset();
		getMock
			.mockResolvedValueOnce({ ok: true, ids: [] })
			.mockResolvedValue({ ok: true, ids: [REAL] });
		blobMock.mockRejectedValue(new Error("no blob in test"));
		uploadMock.mockResolvedValue({ ok: true, id: REAL });
		const onChange = vi.fn();
		renderWithQuery(<GalleryPicker value={[]} onChange={onChange} />);
		fireEvent.click(await screen.findByRole("button", { name: "选择图片" }));
		await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/library/images"));
		const file = new File(["image"], "image.png", { type: "image/png" });
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error("missing upload input");
		fireEvent.change(input, {
			target: { files: [file] },
		});
		await screen.findByRole("button", { name: "选择图片 1" });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "使用所选" }));
		await waitFor(() => expect(onChange).toHaveBeenCalledWith([REAL]));
		expect(uploadMock.mock.calls[0][0]).toBe("/api/library/images");
		expect((uploadMock.mock.calls[0][1] as FormData).get("file")).toBe(file);
		await waitFor(() => expect(blobMock).toHaveBeenCalledWith(`/api/library/images/${REAL}`));
	});
});

describe("图片选择器的平实与女仆口吻", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});
	it("切口吻后已挂载缩略图提示现换字，数据名仍平实", async () => {
		getMock.mockReset();
		getMock.mockResolvedValue({ ok: true, ids: [REAL] });
		blobMock.mockResolvedValue(new Blob(["x"], { type: "image/png" }));
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL() {
					return "blob:library-test";
				}
				static revokeObjectURL() {}
			},
		);
		renderWithQuery(<GalleryPicker value={[]} onChange={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "选择图片" }));
		const toggle = await screen.findByTitle("点击选用或取消");
		expect(toggle).toBeTruthy();
		expect(await screen.findByAltText("图片 1")).toBeTruthy();
		act(() => i18n.set({ voice: "maid" }));
		expect(toggle.title).toBe("主人，点一下选用，再点一下就取消啦。");
		expect(await screen.findByAltText("图片 1")).toBeTruthy();
	});
});

it("图片在共用弹窗里多选，取消不改字段，确认保留点击顺序", async () => {
	getMock.mockResolvedValue({ ok: true, ids: [REAL, GHOST] });
	const changed = vi.fn();
	renderWithQuery(<GalleryPicker value={[REAL]} onChange={changed} />);
	fireEvent.click(await screen.findByRole("button", { name: "选择图片" }));
	fireEvent.click(await screen.findByRole("button", { name: "选择图片 2" }));
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
	fireEvent.click(await screen.findByRole("button", { name: "选择图片 2" }));
	fireEvent.click(screen.getByRole("button", { name: "使用所选" }));
	expect(changed).toHaveBeenCalledWith([REAL, GHOST]);
});

it("取消选择不撤回已经上传的文件，也不改当前字段", async () => {
	let ids: string[] = [];
	getMock.mockImplementation(async () => ({ ok: true, ids }));
	uploadMock.mockImplementation(async () => {
		ids = [REAL];
		return { ok: true, id: REAL };
	});
	const changed = vi.fn();
	renderWithQuery(<GalleryPicker value={[]} onChange={changed} />);
	fireEvent.click(await screen.findByRole("button", { name: "选择图片" }));
	const input = document.querySelector<HTMLInputElement>("input[type=file]");
	if (!input) throw new Error("missing upload input");
	fireEvent.change(input, {
		target: { files: [new File(["x"], "image.png", { type: "image/png" })] },
	});
	await screen.findByRole("button", { name: "选择图片 1" });
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
	expect(
		(await screen.findByRole("button", { name: "选择图片 1" })).getAttribute("aria-pressed"),
	).toBe("false");
	expect(changed).not.toHaveBeenCalled();
	expect(deleteMock).not.toHaveBeenCalled();
});

it("image selection uses localized counts and keeps staged order across language changes", async () => {
	getMock.mockReset().mockResolvedValue({ ok: true, ids: [REAL, GHOST] });
	blobMock.mockReset().mockRejectedValue(new Error("no preview in test"));
	deleteMock.mockClear();
	uploadMock.mockClear();
	const changed = vi.fn();
	renderWithQuery(<GalleryPicker value={[REAL]} onChange={changed} />);
	fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
	await screen.findByRole("button", { name: "选择图片 2" });
	act(() => i18n.set({ locale: "en", voice: "plain" }));
	expect(screen.getByText("1 image selected")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Select image 2" }));
	for (const [locale, count] of [
		["en", "2 images selected"],
		["ja", "画像を 2 枚選択中"],
		["zh-TW", "已選取 2 張圖片"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByText(count)).toBeTruthy();
		expect(changed).not.toHaveBeenCalled();
		expect(deleteMock).not.toHaveBeenCalled();
		expect(uploadMock).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: "取消" }));
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "選擇圖片" }));
	expect(await screen.findByText("已選取 1 張圖片")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "選擇圖片 2" }));
	fireEvent.click(screen.getByRole("button", { name: "使用所選" }));
	expect(changed).toHaveBeenCalledExactlyOnceWith([REAL, GHOST]);
});
