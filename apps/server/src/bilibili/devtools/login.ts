import { ok, type SourceAuth } from "@bilibili-notify/internal";
import type { DevScenarioDef } from "../../devtools/registry.js";
import { BILI_SHELLS_NOT_READY_SUMMARY } from "./shells.js";

export function loginScenarios(deps: {
	auth: () => Pick<Required<SourceAuth>, "state"> | undefined;
	login: () =>
		| {
				handleAuthLost(): Promise<void>;
				reportAccountInfo(): Promise<void>;
		  }
		| undefined;
}): DevScenarioDef[] {
	const lost: DevScenarioDef = {
		id: "auth.lost",
		group: "state",
		title: "登录失效",
		icon: "logout",
		desc: "这是真改登录状态 —— 会把当前登录判失效：动态检测会停、直播监听会拆；会进问题表，主人会收到私聊，恢复时会补一句「已恢复」；cookie 罐不动，所以「重新确认登录」能把它拉回来；看完记得按「重新确认登录」。",
		params: [],
		async run() {
			const login = deps.login();
			const auth = deps.auth();
			if (!login || !auth) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			if (auth.state().status !== "logged-in") {
				return ok({ summary: "现在没登录着，没有可判失效的会话" });
			}
			await login.handleAuthLost();
			return ok({
				summary:
					"当前登录已判失效；动态检测会停、直播监听会拆。cookie 罐没动，看完记得按「重新确认登录」。",
			});
		},
	};

	const recheck: DevScenarioDef = {
		id: "auth.recheck",
		group: "state",
		title: "重新确认登录",
		icon: "check",
		desc: "这是真改登录状态 —— 拿 cookie 罐里现成的登录再向 B 站确认一次：还有效就回到已登录，动态检测重新起来、直播监听按当前订阅重建，问题表里的登录失效清掉，主人会收到一句「已恢复」；已经失效的话就判成登录失效，动态检测停、直播监听拆，进问题表，主人会收到私聊。cookie 罐不动。",
		params: [],
		async run() {
			const login = deps.login();
			const auth = deps.auth();
			if (!login || !auth) return ok({ summary: BILI_SHELLS_NOT_READY_SUMMARY });
			await login.reportAccountInfo();
			const status = auth.state().status;
			const label =
				status === "logged-in"
					? "已登录"
					: status === "logged-out"
						? "未登录"
						: status === "expired"
							? "登录已失效"
							: status === "confirming"
								? "正在确认"
								: status === "awaiting-scan"
									? "等待扫码"
									: "登录失败";
			return ok({ summary: `重新确认登录：${label}。` });
		},
	};

	return [lost, recheck];
}
