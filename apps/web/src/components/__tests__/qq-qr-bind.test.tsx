// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { QQQrBindButton } from "../qq-qr-bind";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("../../services/api", () => ({
	api: { post: postMock },
	ApiError: class ApiError extends Error {
		constructor(public readonly status: number) {
			super(`http ${status}`);
		}
	},
}));

/** interval 0 → 组件用 0ms 轮询,waitFor 就能等到结果,不用摆弄假时钟。 */
const START_OK = { taskId: "T1", qr: "data:image/png;base64,QR", interval: 0 };

describe("QQQrBindButton", () => {
	beforeEach(() => postMock.mockReset());
	afterEach(() => cleanup());

	it("初始只有入口按钮 + 实验性徽章,不见弹窗", () => {
		render(<QQQrBindButton onCredentials={() => {}} />);
		expect(screen.getByRole("button", { name: /扫码一键创建/ })).toBeTruthy();
		expect(screen.getByText("实验性")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("点击 → 调 /bind/start,弹层展示二维码与 OpenClaw 提示", async () => {
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "pending" };
		});
		render(<QQQrBindButton onCredentials={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码一键创建/ }));
		await waitFor(() => {
			const img = screen.getByAltText("QQ 机器人绑定二维码") as HTMLImageElement;
			expect(img.src).toBe(START_OK.qr);
		});
		expect(screen.getByText(/OpenClaw/)).toBeTruthy();
		expect(postMock).toHaveBeenCalledWith("/api/qq/bind/start", expect.anything());
	});

	it("轮询到 created → 回调凭据并收起弹层", async () => {
		const got = vi.fn();
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "created", appId: "102000001", appSecret: "S3cret" };
		});
		render(<QQQrBindButton onCredentials={got} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码一键创建/ }));
		await waitFor(() =>
			expect(got).toHaveBeenCalledWith({ appId: "102000001", appSecret: "S3cret" }),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(got).toHaveBeenCalledTimes(1);
	});

	it("轮询到 expired → 提示过期并给「重新生成」;点击再走一遍 start", async () => {
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "expired" };
		});
		render(<QQQrBindButton onCredentials={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码一键创建/ }));
		await waitFor(() => expect(screen.getByText(/二维码已过期/)).toBeTruthy());

		postMock.mockClear();
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "pending" };
		});
		fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/qq/bind/start", expect.anything()),
		);
	});

	it("轮询到业务 error → 展示报错与手填提示,停止轮询", async () => {
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "error", message: "扫码成功但腾讯未返回完整机器人凭据" };
		});
		render(<QQQrBindButton onCredentials={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码一键创建/ }));
		await waitFor(() => expect(screen.getByText(/未返回完整机器人凭据/)).toBeTruthy());
		expect(screen.getByText(/手动填写/)).toBeTruthy();
		const polls = postMock.mock.calls.filter(([p]) => p === "/api/qq/bind/poll").length;
		await new Promise((r) => setTimeout(r, 20));
		expect(postMock.mock.calls.filter(([p]) => p === "/api/qq/bind/poll").length).toBe(polls);
	});

	it("start 失败 → 报错并可重试", async () => {
		postMock.mockRejectedValueOnce(new Error("bind_start_failed"));
		render(<QQQrBindButton onCredentials={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码一键创建/ }));
		await waitFor(() => expect(screen.getByText(/创建绑定任务失败/)).toBeTruthy());
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});
});
