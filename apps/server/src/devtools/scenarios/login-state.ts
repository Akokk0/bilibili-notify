import { BiliLoginStatus } from "@bilibili-notify/api";
import type { LoginSnapshot, MessageBus } from "@bilibili-notify/internal";
import { fakeQrDataUrl } from "../fake-qr.js";
import type { DevScenarioDef } from "../registry.js";

/**
 * B2:扫码登录六态。面板从两处读登录快照:`GET /api/auth/status`(`authSystem.status()`)
 * 与 WS auth 频道的 `login-status-report`(总线上那条事件)。注入 = 两处一起换:`status()`
 * 盖掉,再往总线上发一条同样的快照;收摊 = 摘掉,把真快照再发一遍让面板对回去。
 *
 * 只换面板看到的:登录流程本身(轮询 / 健康检查)一行不动,也不会因此发 auth-lost。
 */
/** 只要 `status()` 能盖能摘;写成最窄的形状,登录系统整个类型的 Proxy 才塞得进来。 */
export interface OverridableStatus {
	api: { status(): LoginSnapshot };
	override(method: "status", impl: (real: () => LoginSnapshot) => LoginSnapshot): void;
	clear(method: "status"): void;
}

export interface LoginStateDeps {
	auth: OverridableStatus;
	bus: MessageBus;
}

type Key = "not-login" | "loading" | "qr" | "logging" | "logged-in" | "failed";

const STATUSES: ReadonlyArray<{ value: Key; label: string }> = [
	{ value: "not-login", label: "未登录" },
	{ value: "loading", label: "正在加载登录信息" },
	{ value: "qr", label: "等待扫码" },
	{ value: "logging", label: "正在登录(已扫码待确认)" },
	{ value: "logged-in", label: "已登录" },
	{ value: "failed", label: "登录失败" },
];

const DEFAULT_FAIL = "devtools:二维码已过期,请重新获取";
const FAKE_FACE = "https://i0.hdslb.com/bfs/face/member/noface.jpg";

async function build(key: Key, uname: string, message: string): Promise<LoginSnapshot> {
	switch (key) {
		case "not-login":
			return { status: BiliLoginStatus.NOT_LOGIN, msg: "未登录" };
		case "loading":
			return { status: BiliLoginStatus.LOADING_LOGIN_INFO, msg: "正在加载登录信息" };
		case "qr":
			return { status: BiliLoginStatus.LOGIN_QR, msg: "", data: await fakeQrDataUrl() };
		case "logging":
			// 与真流程一致:扫了码等确认时二维码图还留着。
			return {
				status: BiliLoginStatus.LOGGING_QR,
				msg: "已扫码,请在手机上确认",
				data: await fakeQrDataUrl(),
			};
		case "logged-in":
			return {
				status: BiliLoginStatus.LOGGED_IN,
				msg: "",
				data: {
					card: {
						mid: "900000001",
						name: uname,
						face: FAKE_FACE,
						level_info: { current_level: 6 },
					},
					space: {},
					like_num: 0,
				},
			};
		case "failed":
			return { status: BiliLoginStatus.LOGIN_FAILED, msg: message };
	}
}

export function loginStateScenario(deps: LoginStateDeps): DevScenarioDef {
	let fake: { key: Key; snapshot: LoginSnapshot } | null = null;

	return {
		id: "auth.login-state",
		group: "state",
		title: "登录状态",
		icon: "user",
		desc: "换掉面板看到的 B 站登录状态(顶栏账号、系统页登录卡、扫码弹窗)。只换面板看到的,登录流程本身不动;收摊即回真。",
		params: [
			{ key: "status", label: "状态", kind: "enum", options: STATUSES, default: "qr" },
			{ key: "uname", label: "账号名(已登录时)", kind: "text", default: "devtools 假账号" },
			{ key: "message", label: "失败原因(失败时)", kind: "text", default: DEFAULT_FAIL },
		],
		async run(params) {
			const key = String(params.status ?? "qr") as Key;
			const uname =
				typeof params.uname === "string" && params.uname !== "" ? params.uname : "devtools 假账号";
			const message =
				typeof params.message === "string" && params.message !== "" ? params.message : DEFAULT_FAIL;
			const snapshot = await build(key, uname, message);
			fake = { key, snapshot };
			deps.auth.override("status", () => snapshot);
			deps.bus.emit("login-status-report", snapshot);
			return {};
		},
		active() {
			if (!fake) return null;
			const label = STATUSES.find((s) => s.value === fake?.key)?.label ?? fake.key;
			return { scenarioId: "auth.login-state", label: `登录状态 → ${label}` };
		},
		reset() {
			if (!fake) return;
			fake = null;
			deps.auth.clear("status");
			deps.bus.emit("login-status-report", deps.auth.api.status());
		},
	};
}
