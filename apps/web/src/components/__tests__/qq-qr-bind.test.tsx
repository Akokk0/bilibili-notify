// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { pollDelayMs, QQQrBindButton } from "../qq-qr-bind";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("../../services/api", () => ({
	api: { post: postMock },
	ApiError: class ApiError extends Error {
		constructor(public readonly status: number) {
			super(`http ${status}`);
		}
	},
}));

/**
 * server 当前恒回 2 秒。测试里用最小合法值 1 秒(0 会被护栏抬回下限,见
 * pollDelayMs),所以下面等结果的 waitFor 一律要给足于一轮的时间。
 */
const START_OK = { taskId: "T1", qr: "data:image/png;base64,QR", interval: 1 };
/** 一轮轮询是 1 秒,默认 1000ms 的 waitFor 卡在边界上,统一放宽。 */
const POLLED = { timeout: 4000 };

describe("QQQrBindButton", () => {
	beforeEach(() => postMock.mockReset());
	afterEach(() => cleanup());

	it("初始只有入口按钮 + 实验性徽章,不见弹窗", () => {
		render(<QQQrBindButton onCredentials={() => {}} />);
		expect(screen.getByRole("button", { name: /扫码连接/ })).toBeTruthy();
		expect(screen.getByText("实验性")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("点击 → 调 /bind/start,弹层展示二维码与能力注意(OpenClaw 说明已砍)", async () => {
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "pending" };
		});
		render(<QQQrBindButton onCredentials={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码连接/ }));
		await waitFor(() => {
			const img = screen.getByAltText("QQ 机器人绑定二维码") as HTMLImageElement;
			expect(img.src).toBe(START_OK.qr);
		});
		// OpenClaw/通道失效那段说明已砍(话太多),只留能力注意
		expect(screen.queryByText(/OpenClaw/)).toBeNull();
		// lite bot 的使用面预告:别让用户建完 bot 去配群 target 撞静默失败。
		expect(screen.getByText(/创建者当群主的群/)).toBeTruthy();
		expect(postMock).toHaveBeenCalledWith("/api/qq/bind/start", expect.anything());
	});

	it("轮询到 created → 回调凭据并收起弹层", async () => {
		const got = vi.fn();
		postMock.mockImplementation(async (path: string) => {
			if (path === "/api/qq/bind/start") return START_OK;
			return { status: "created", appId: "102000001", appSecret: "S3cret" };
		});
		render(<QQQrBindButton onCredentials={got} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码连接/ }));
		await waitFor(
			() => expect(got).toHaveBeenCalledWith({ appId: "102000001", appSecret: "S3cret" }),
			POLLED,
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
		fireEvent.click(screen.getByRole("button", { name: /扫码连接/ }));
		await waitFor(() => expect(screen.getByText(/二维码已过期/)).toBeTruthy(), POLLED);

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
		fireEvent.click(screen.getByRole("button", { name: /扫码连接/ }));
		await waitFor(() => expect(screen.getByText(/未返回完整机器人凭据/)).toBeTruthy(), POLLED);
		expect(screen.getAllByText(/手动填写/).length).toBeGreaterThan(0);
		const polls = postMock.mock.calls.filter(([p]) => p === "/api/qq/bind/poll").length;
		// 等**足一整轮**再数。这里曾写死 20ms:`interval` 从 0 改成 1 的那次,
		// 一轮变成 1000ms,于是就算 error 分支忘了 return,20ms 内也不可能有下一发 ——
		// 断言从此永远成立(2026-08-31 审查)。间隔从 pollDelayMs 现算,以后再怎么
		// 调 interval 都不会重新变成空跑。
		await new Promise((r) => setTimeout(r, pollDelayMs(START_OK.interval) + 300));
		expect(postMock.mock.calls.filter(([p]) => p === "/api/qq/bind/poll").length).toBe(polls);
	});

	it("start 失败 → 报错并可重试", async () => {
		postMock.mockRejectedValueOnce(new Error("bind_start_failed"));
		render(<QQQrBindButton onCredentials={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /扫码连接/ }));
		await waitFor(() => expect(screen.getByText(/创建绑定任务失败/)).toBeTruthy());
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});
});

/**
 * 轮询间隔直接吃 server 回来的数字,不夹会出事:`interval: 0`(server 的测试里
 * 就用着这个值)或字段缺失(`undefined * 1000 = NaN`,setTimeout 当 0 处理)都会
 * 让浏览器以网络极限速度重发 `POST /api/qq/bind/poll`,而每一发服务端都会转成
 * 一次对腾讯的请求,一直持续到任务 10 分钟 TTL 到期。
 */
describe("pollDelayMs", () => {
	it("正常值原样换算成毫秒", () => {
		expect(pollDelayMs(2)).toBe(2000);
	});

	it("0 / 负数 / NaN / 缺失一律抬到下限,绝不退化成紧循环", () => {
		expect(pollDelayMs(0)).toBe(1000);
		expect(pollDelayMs(-5)).toBe(1000);
		expect(pollDelayMs(undefined)).toBe(2000);
		expect(pollDelayMs(Number.NaN)).toBe(2000);
	});

	it("离谱的大值也夹住 —— 上游写错一个零不该让弹窗看起来死掉", () => {
		expect(pollDelayMs(86_400)).toBe(60_000);
	});
});
