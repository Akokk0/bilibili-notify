// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError } from "../../services/api";
import { pollDelayMs, QQQrBindButton } from "../qq-qr-bind";

const { postMock, getMock } = vi.hoisted(() => ({ postMock: vi.fn(), getMock: vi.fn() }));

vi.mock("../../services/api", () => ({
	api: { post: postMock, get: getMock },
	// 与真 ApiError 同一个构造签名 `(status, body, message)`:`code` 从解析好的体里来。
	ApiError: class ApiError extends Error {
		readonly code?: string;
		constructor(
			public readonly status: number,
			body?: { code?: string },
			message = `http ${status}`,
		) {
			super(message);
			this.code = body?.code;
		}
	},
}));

const BEGIN = "/api/adapters/qq-official/auth";
const STATE = "/api/adapters/qq-official/auth/T1";
const DRAFT = "/api/adapters/qq-official/auth/T1/draft";

/**
 * server 当前恒回 2 秒。测试里用最小合法值 1 秒(0 会被护栏抬回下限,见
 * pollDelayMs),所以下面等结果的 waitFor 一律要给足于一轮的时间。
 */
const BEGIN_OK = {
	taskId: "T1",
	state: {
		status: "awaiting-scan",
		qr: { dataUrl: "data:image/png;base64,QR", expiresAt: "2026-10-11T00:10:00.000Z" },
	},
	pollIntervalSeconds: 1,
};
const DRAFT_OK = { settings: { appId: "102000001", appSecret: "S3cret" } };
/** 一轮轮询是 1 秒,默认 1000ms 的 waitFor 卡在边界上,统一放宽。 */
const POLLED = { timeout: 4000 };

/** 发起、取草稿各按完整路径给值(不用一个兜底值糊所有 POST,否则取草稿与发起分不开)。 */
function postRoutes(overrides: Partial<Record<string, () => unknown>> = {}) {
	postMock.mockImplementation(async (path: string) => {
		const handler = overrides[path];
		if (handler) return handler();
		if (path === BEGIN) return BEGIN_OK;
		throw new Error(`unexpected POST ${path}`);
	});
}
const loggedIn = () => ({ state: { status: "logged-in", loggedInAt: "2026-10-11T00:01:00.000Z" } });
const callsOf = (mock: typeof postMock, path: string) =>
	mock.mock.calls.filter(([p]) => p === path).length;
const openDialog = () => fireEvent.click(screen.getByRole("button", { name: /扫码连接/ }));

describe("QQQrBindButton", () => {
	// 花括号不能省:箭头函数直接返回 mockReset() 的结果,vitest 会把返回的函数当清理钩子,
	// 收摊时多调一发 postMock(undefined)。
	beforeEach(() => {
		postMock.mockReset();
		getMock.mockReset();
	});
	afterEach(() => cleanup());

	it("初始只有入口按钮 + 实验性徽章,不见弹窗", () => {
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		expect(screen.getByRole("button", { name: /扫码连接/ })).toBeTruthy();
		expect(screen.getByText("实验性")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("点击 → POST 发起,弹层展示取自 state.qr.dataUrl 的二维码与能力注意(OpenClaw 说明已砍)", async () => {
		postRoutes();
		getMock.mockResolvedValue({ state: BEGIN_OK.state });
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => {
			const img = screen.getByAltText("QQ 机器人绑定二维码") as HTMLImageElement;
			expect(img.src).toBe(BEGIN_OK.state.qr.dataUrl);
		});
		// OpenClaw/通道失效那段说明已砍(话太多),只留能力注意
		expect(screen.queryByText(/OpenClaw/)).toBeNull();
		// lite bot 的使用面预告:别让用户建完 bot 去配群 target 撞静默失败。
		expect(screen.getByText(/创建者当群主的群/)).toBeTruthy();
		expect(postMock).toHaveBeenCalledWith(BEGIN, expect.anything());
	});

	it("适配器键进路径时做了转义", async () => {
		postRoutes({ "/api/adapters/a%2Fb/auth": () => BEGIN_OK });
		getMock.mockResolvedValue({ state: BEGIN_OK.state });
		render(<QQQrBindButton adapterKey="a/b" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/adapters/a%2Fb/auth", {}));
	});

	it("问到 logged-in → 另发 POST 取草稿 → 回调两格凭据一次并收起弹层", async () => {
		const got = vi.fn();
		postRoutes({ [DRAFT]: () => DRAFT_OK });
		getMock.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(
			() => expect(got).toHaveBeenCalledWith({ appId: "102000001", appSecret: "S3cret" }),
			POLLED,
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(got).toHaveBeenCalledTimes(1);
		expect(getMock).toHaveBeenCalledWith(STATE);
		expect(callsOf(postMock, DRAFT)).toBe(1);
		expect(callsOf(postMock, BEGIN)).toBe(1);
	});

	it("取草稿是异步的也不会被问询的 effect 清掉(必现的坑:回来的凭据被丢)", async () => {
		const got = vi.fn();
		// 取走即清:和真服务端一样,第二次取是「找不到」—— 不然 effect 被清掉后重跑、再取一次也能蒙混过关。
		let drafts = 0;
		postRoutes({
			[DRAFT]: () => {
				drafts += 1;
				if (drafts > 1) {
					throw new ApiError(
						404,
						{ code: "not_found", message: "绑定任务不存在或已过期" },
						"绑定任务不存在或已过期",
					);
				}
				return new Promise((resolve) => setTimeout(() => resolve(DRAFT_OK), 150));
			},
		});
		getMock.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/正在取回凭据/)).toBeTruthy(), POLLED);
		await waitFor(() => expect(got).toHaveBeenCalledTimes(1), POLLED);
		expect(drafts).toBe(1);
	});

	it("confirming 接着问;logged-out 按过期处理", async () => {
		const got = vi.fn();
		postRoutes({ [DRAFT]: () => DRAFT_OK });
		getMock
			.mockResolvedValueOnce({ state: { status: "confirming" } })
			.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(() => expect(got).toHaveBeenCalledTimes(1), { timeout: 6000 });
		expect(getMock.mock.calls.length).toBe(2);
		cleanup();

		postRoutes();
		getMock.mockReset();
		getMock.mockResolvedValue({ state: { status: "logged-out" } });
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/二维码已过期/)).toBeTruthy(), POLLED);
	});

	it("码过期(服务端报 error)→ 红色提示盒里是服务端的话,并给「重新生成」;点击再走一遍发起", async () => {
		postRoutes();
		getMock.mockResolvedValue({
			state: { status: "error", message: "二维码已过期，请重新生成" },
		});
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		// 断言服务端那句话真的显示出来(把话改空它不能绿)。
		await waitFor(() => expect(screen.getByText("二维码已过期，请重新生成")).toBeTruthy(), POLLED);

		postMock.mockClear();
		fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
		await waitFor(() => expect(postMock).toHaveBeenCalledWith(BEGIN, expect.anything()));
	});

	it("问到业务 error → 展示服务端的话与手填提示,停止问询", async () => {
		postRoutes();
		getMock.mockResolvedValue({
			state: { status: "error", message: "扫码成功但腾讯未返回完整机器人凭据" },
		});
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/未返回完整机器人凭据/)).toBeTruthy(), POLLED);
		expect(screen.getAllByText(/手动填写/).length).toBeGreaterThan(0);
		const polls = getMock.mock.calls.length;
		// 等**足一整轮**再数。这里曾写死 20ms:`interval` 从 0 改成 1 的那次,
		// 一轮变成 1000ms,于是就算 error 分支忘了 return,20ms 内也不可能有下一发 ——
		// 断言从此永远成立(2026-08-31 审查)。间隔从 pollDelayMs 现算,以后再怎么
		// 调间隔都不会重新变成空跑。
		await new Promise((r) => setTimeout(r, pollDelayMs(BEGIN_OK.pollIntervalSeconds) + 300));
		expect(getMock.mock.calls.length).toBe(polls);
	});

	/**
	 * 任务不在了(server 重启 / 10 分钟 TTL 清了)服务端回 `not_found`:当过期处理,请用户重开。
	 * 面板按**错误码**判、不看状态码 —— 这里状态码故意给个不相干的 409,码才是判据。
	 */
	it("问询遇到 not_found(任务已不在)→ 当过期处理,给「重新生成」", async () => {
		postRoutes();
		getMock.mockRejectedValue(
			new ApiError(
				409,
				{ code: "not_found", message: "绑定任务不存在或已过期" },
				"绑定任务不存在或已过期",
			),
		);
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/二维码已过期/)).toBeTruthy(), POLLED);
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});

	it("问询遇到瞬时故障(unavailable)→ 服务端保留了任务,下一轮接着问", async () => {
		const got = vi.fn();
		postRoutes({ [DRAFT]: () => DRAFT_OK });
		// 状态码故意给 404:只有错误码是 unavailable,不能被当成「任务不在了」。
		getMock
			.mockRejectedValueOnce(
				new ApiError(404, { code: "unavailable", message: "查询绑定结果失败" }, "查询绑定结果失败"),
			)
			.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(
			() => expect(got).toHaveBeenCalledWith({ appId: "102000001", appSecret: "S3cret" }),
			{ timeout: 6000 },
		);
		expect(screen.queryByText(/二维码已过期/)).toBeNull();
	});

	it("取草稿遇暂时失败 → 只重试取草稿这一步:不重新发起、不再回头问状态,最后回调一次", async () => {
		const got = vi.fn();
		let drafts = 0;
		postRoutes({
			[DRAFT]: () => {
				drafts += 1;
				if (drafts === 1) {
					throw new ApiError(503, { code: "unavailable", message: "网络抖" }, "网络抖");
				}
				return DRAFT_OK;
			},
		});
		getMock.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(() => expect(got).toHaveBeenCalledTimes(1), { timeout: 6000 });
		expect(drafts).toBe(2);
		expect(callsOf(postMock, BEGIN)).toBe(1);
		expect(getMock.mock.calls.length).toBe(1);
	});

	it("取草稿回 not_found → 「绑定结果已经不在了」并给「重新生成」,不回调", async () => {
		const got = vi.fn();
		postRoutes({
			[DRAFT]: () => {
				throw new ApiError(
					404,
					{ code: "not_found", message: "绑定任务不存在或已过期" },
					"绑定任务不存在或已过期",
				);
			},
		});
		getMock.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/绑定结果已经不在了/)).toBeTruthy(), POLLED);
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
		expect(got).not.toHaveBeenCalled();
	});

	it("取草稿回 conflict → 显示服务端的话与「重新生成」", async () => {
		postRoutes({
			[DRAFT]: () => {
				throw new ApiError(
					409,
					{ code: "conflict", message: "这次扫码没有成功，没有可取的结果" },
					"这次扫码没有成功，没有可取的结果",
				);
			},
		});
		getMock.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/这次扫码没有成功/)).toBeTruthy(), POLLED);
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});

	it("取回来的 settings 缺 appSecret → 不回调,提示凭据不完整", async () => {
		const got = vi.fn();
		postRoutes({ [DRAFT]: () => ({ settings: { appId: "102000001" } }) });
		getMock.mockResolvedValue(loggedIn());
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={got} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/凭据不完整/)).toBeTruthy(), POLLED);
		expect(got).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});

	it("发起失败 → 报错并可重试", async () => {
		postMock.mockRejectedValueOnce(new Error("发起绑定失败：系统繁忙"));
		render(<QQQrBindButton adapterKey="qq-official" onCredentials={() => {}} />);
		openDialog();
		await waitFor(() => expect(screen.getByText(/创建绑定任务失败/)).toBeTruthy());
		expect(screen.getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});
});

/**
 * 问询间隔直接吃 server 回来的数字,不夹会出事:`0` 或字段缺失(`undefined * 1000 = NaN`,
 * setTimeout 当 0 处理)都会让浏览器以网络极限速度重发 `GET /api/adapters/:adapterKey/auth/:taskId`,
 * 而每一发服务端都会转成一次对腾讯的请求,一直持续到任务 10 分钟 TTL 到期。
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
