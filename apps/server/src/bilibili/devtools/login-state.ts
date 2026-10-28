import { type AuthState, type Disposable, ok, type SourceAuth } from "@bilibili-notify/internal";
import { type OverridableApi, overridableApi } from "../../devtools/api-overrides.js";
import type { DevScenarioDef } from "../../devtools/registry.js";
import { fakeQrDataUrl } from "./fake-qr.js";
import { BILI_SHELLS_NOT_READY_SUMMARY } from "./shells.js";

/**
 * B2:登录状态的假货。面板从两处读登录态:`GET /api/sources/:sourceKey/auth`(来源的 `auth.state()` /
 * `auth.account()`)与 WS auth 频道的 `subscription-auth-changed`。后者是宿主订了登录口的变更通知、来了读一遍
 * `state()` 发到总线上的;场景拿不到总线(ADR-0031 决策 2「核心的句柄不交出去」),所以注入 = `state()` /
 * `account()` 盖掉,再替登录口喊一声「变了」(`notifyChanged`),宿主照常转发;收摊 = 摘掉,再喊一声。
 *
 * 宿主订着这条通知的不止总线:登录问题表也订着,所以假「失效」会进问题表并私聊主人(截流开着就拦下),
 * 收摊即恢复。登录流程本身(轮询 / 健康检查)一行不动。
 * 选项就是 `AuthState` 的六种取值,其中 `confirming` 有两种情况(已扫等手机确认 / 开机没确认),各给一项。
 */
export interface LoginStateDeps {
	/** 来源登录口的开发壳;来源造好之前取不到。 */
	auth: () => AuthShell | undefined;
}

/** 登录口的开发壳:`state` / `account` 能盖能摘;经它订的变更通知都记着,盖完能替登录口喊一声。 */
export interface AuthShell {
	/** 交给 B 站来源当 `Source.auth` 的那一份;宿主经它订变更。 */
	api: Required<SourceAuth>;
	override: OverridableApi<Required<SourceAuth>>["override"];
	clear(method: "state" | "account"): void;
	/** 经壳订了变更的回调挨个叫一遍 —— 宿主那头(总线上的登录事件、登录问题表)跟真的变了一样。 */
	notifyChanged(): void;
}

export function createAuthShell(real: Required<SourceAuth>): AuthShell {
	const shell = overridableApi(real);
	const listeners = new Set<() => void>();
	// 订阅照样订到真登录口上(真的变了照常通知),另在这里记一份;撤的时候两边一起撤。
	shell.override("onChange", (subscribe, fn): Disposable => {
		listeners.add(fn);
		const subscription = subscribe(fn);
		return {
			dispose() {
				listeners.delete(fn);
				subscription.dispose();
			},
		};
	});
	return {
		api: shell.api,
		override: shell.override,
		clear: (method) => shell.clear(method),
		notifyChanged() {
			for (const fn of [...listeners]) fn();
		},
	};
}

type Key =
	| "logged-out"
	| "awaiting-scan"
	| "confirming-scan"
	| "confirming-check"
	| "logged-in"
	| "expired"
	| "error";

const STATUSES: ReadonlyArray<{ value: Key; label: string }> = [
	{ value: "logged-out", label: "未登录" },
	{ value: "awaiting-scan", label: "等待扫码" },
	{ value: "confirming-scan", label: "正在确认(已扫码,等手机上点确认)" },
	{ value: "confirming-check", label: "正在确认(开机还没向 B 站确认)" },
	{ value: "logged-in", label: "已登录" },
	{ value: "expired", label: "登录失效" },
	{ value: "error", label: "登录失败" },
];

const DEFAULT_FAIL = "devtools:二维码已过期,请重新获取";
const DEFAULT_UNAME = "devtools 假账号";

interface Fake {
	state: AuthState;
	account: { name: string } | null;
}

async function build(key: Key, uname: string, message: string): Promise<Fake> {
	switch (key) {
		case "logged-out":
			return { state: { status: "logged-out" }, account: null };
		case "awaiting-scan":
			return {
				state: {
					status: "awaiting-scan",
					qr: {
						dataUrl: await fakeQrDataUrl(),
						expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
					},
				},
				account: null,
			};
		case "confirming-scan":
			return {
				state: { status: "confirming", message: "已扫码，请在手机上确认" },
				account: null,
			};
		case "confirming-check":
			return {
				state: {
					status: "confirming",
					message: "正在向 B 站确认登录状态，暂时连不上的话会自动重试",
				},
				account: null,
			};
		case "logged-in":
			return {
				state: { status: "logged-in", loggedInAt: new Date().toISOString() },
				account: { name: uname },
			};
		case "expired":
			return { state: { status: "expired", message }, account: null };
		case "error":
			return { state: { status: "error", message }, account: null };
	}
}

export function loginStateScenario(deps: LoginStateDeps): DevScenarioDef {
	let fake: { key: Key; auth: AuthShell } | null = null;

	return {
		id: "auth.login-state",
		group: "state",
		title: "登录状态",
		icon: "user",
		desc: "换掉 B 站登录口报给宿主的登录状态:顶栏账号、系统页登录卡、扫码弹窗跟着变,登录问题表也跟着反应 —— 假「失效」会进问题表并私聊主人(截流开着就拦下)。登录流程本身不动;收摊即回真。",
		params: [
			{ key: "status", label: "状态", kind: "enum", options: STATUSES, default: "awaiting-scan" },
			{ key: "uname", label: "账号名(已登录时)", kind: "text", default: DEFAULT_UNAME },
			{ key: "message", label: "失败原因(失败 / 失效时)", kind: "text", default: DEFAULT_FAIL },
		],
		async run(params) {
			const auth = deps.auth();
			if (!auth) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			const key = String(params.status ?? "awaiting-scan") as Key;
			const uname =
				typeof params.uname === "string" && params.uname !== "" ? params.uname : DEFAULT_UNAME;
			const message =
				typeof params.message === "string" && params.message !== "" ? params.message : DEFAULT_FAIL;
			const built = await build(key, uname, message);
			fake = { key, auth };
			auth.override("state", () => built.state);
			auth.override("account", () => built.account);
			auth.notifyChanged();
			return ok();
		},
		active() {
			if (!fake) return null;
			const label = STATUSES.find((s) => s.value === fake?.key)?.label ?? fake.key;
			return { scenarioId: "auth.login-state", label: `登录状态 → ${label}` };
		},
		reset() {
			if (!fake) return;
			const { auth } = fake;
			fake = null;
			auth.clear("state");
			auth.clear("account");
			auth.notifyChanged();
		},
	};
}
