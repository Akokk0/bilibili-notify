import { type Disposable, ok, type ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../../api/api.js";
import { watchLoginEdges } from "../../login-edges.js";
import { LoginFlow } from "../login-flow.js";

const RESTORED = "restored";
const LOST = "lost";

interface FakeTimer extends Disposable {
	fire(): void;
}

function makeServiceContext() {
	const timeouts: FakeTimer[] = [];
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const serviceCtx: ServiceContext = {
		logger,
		setInterval: () => ({ dispose() {} }),
		setTimeout(fn) {
			const timer: FakeTimer = { dispose: vi.fn(), fire: fn };
			timeouts.push(timer);
			return timer;
		},
		onDispose() {},
		signal: new AbortController().signal,
		track() {},
	};
	return { serviceCtx, timeouts };
}

function makeApi() {
	const api = {
		fetchMyselfInfo: vi.fn(),
		fetchUserCard: vi.fn(),
		fetchLoginQrCode: vi.fn(),
		fetchLoginStatus: vi.fn(),
		getCookiesJson: vi.fn(() => '[{"key":"SESSDATA","value":"x"}]'),
		commitScannedLogin: vi.fn(async () => ok()),
		holdLoginSaves: vi.fn(() => ({ dispose() {} })),
		loginGeneration: 0,
	};
	return api;
}

function harness() {
	const api = makeApi();
	const { serviceCtx, timeouts } = makeServiceContext();
	const flow = new LoginFlow({
		serviceCtx,
		api: api as unknown as Api,
		healthCheckMs: 0,
	});
	const watchEvents: string[] = [];
	const watch = watchLoginEdges(
		{
			state: () => flow.authState(),
			onChange: (fn) => flow.onChange(fn),
		},
		{
			onLost: () => void watchEvents.push(LOST),
			onRestored: () => void watchEvents.push(RESTORED),
		},
	);

	async function signIn(): Promise<void> {
		api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		api.fetchUserCard.mockResolvedValueOnce(
			ok({ data: { card: { mid: "42", name: "n", face: "" } } }),
		);
		await flow.reportAccountInfo();
	}

	async function openQr(): Promise<void> {
		api.fetchLoginQrCode.mockResolvedValueOnce(
			ok({ data: { url: "https://qr", qrcode_key: "key" } }),
		);
		await flow.beginLogin(async () => "data:image/png;base64,AA==");
	}

	return {
		api,
		flow,
		signIn,
		openQr,
		timeouts,
		watchEvents,
		dispose() {
			watch.dispose();
			flow.stop();
		},
	};
}

describe("watchLoginEdges 观察 LoginFlow 的登录边", () => {
	it("开机未登录，之后登上：restored 一次", async () => {
		const h = harness();
		h.flow.reportLoggedOut("notLogin");
		h.watchEvents.length = 0;

		await h.signIn();

		expect(h.watchEvents).toEqual([RESTORED]);
		h.dispose();
	});

	it("运行中掉线再重登：lost、restored 各一次", async () => {
		const h = harness();
		await h.signIn();
		h.watchEvents.length = 0;

		await h.flow.handleAuthLost();
		await h.signIn();

		expect(h.watchEvents).toEqual([LOST, RESTORED]);
		h.dispose();
	});

	it("手动退出登录：lost 一次，重复退出不多发", async () => {
		const h = harness();
		await h.signIn();
		h.watchEvents.length = 0;

		h.flow.reportLoggedOut("notLogin");
		h.flow.reportLoggedOut("notLogin");

		expect(h.watchEvents).toEqual([LOST]);
		h.dispose();
	});

	it("已登录时重扫、不扫等超时再心跳回来：没有登录边", async () => {
		const h = harness();
		await h.signIn();
		h.watchEvents.length = 0;

		await h.openQr();
		h.timeouts.at(-1)?.fire();
		await h.signIn();

		expect(h.watchEvents).toEqual([]);
		h.dispose();
	});

	it("重扫途中撞 -101 再登上：没有 lost、restored 一次", async () => {
		const h = harness();
		await h.signIn();
		h.watchEvents.length = 0;

		await h.openQr();
		await h.flow.handleAuthLost();
		await h.signIn();

		expect(h.watchEvents).toEqual([RESTORED]);
		h.dispose();
	});

	it("开机停在 confirming 后心跳成功：restored 一次", async () => {
		const h = harness();
		h.api.fetchMyselfInfo.mockRejectedValueOnce(new Error("network down"));
		await h.flow.reportAccountInfo();

		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce(
			ok({ data: { card: { mid: "42", name: "n", face: "" } } }),
		);
		await h.flow.healthCheckNow();

		expect(h.watchEvents).toEqual([RESTORED]);
		h.dispose();
	});
});
