import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { HEALTH_QUERY_KEY, HEALTH_QUERY_OPTIONS } from "../../hooks/useBackendReachable";
import { api } from "../../services/api";
import { useAuthStore } from "../../store/auth";
import { BiliLoginStatus } from "../../types/auth";
import type { PushAdapter, PushTarget, Subscription } from "../../types/domain";
import { deriveOnboarding, type OnboardingView } from "./derive";

interface HealthSnapshot {
	status: string;
	uptime: number;
	modules?: { dynamic: boolean; live: boolean; image: boolean; ai: boolean };
}

/** 导览进行中的判据轮询间隔。 */
const POLL_MS = 3_000;

/**
 * 新手进度的数据装配 —— 左缘导览小卡与 /guide 页共用这一份。全部复用站内
 * 既有 queryKey(与对应页面共享缓存);health 行为选项走 HEALTH_QUERY_OPTIONS
 * 单一权威(三处 observer 选项不一致会让可达性探测抖动,见 useBackendReachable)。
 *
 * `poll: true`(导览小卡传)= **导览进行中**(未毕业,hook 内部判)每 3s
 * invalidate 全部判据 query + auth-status(useAuthHydrate 的 effect 把新快照
 * 写回 authStore)——「做完自动进下一步」不能指望每条更新链路都恰好有
 * invalidate / WS 推送:扫码登录走 WS、页面 mutation 走 invalidate、而「在 QQ
 * 里给 bot 发消息捞 openid」这类页面外动作根本没有前端事件,轮询是唯一兜得住
 * 全部环节的底。毕业后自动停,不给稳态页面加任何请求。
 *
 * `ready=false` = 基础数据还没齐:半份数据画出来的进度是错的,调用方先别渲染。
 */
export function useOnboardingState(opts?: { poll?: boolean }): {
	view: OnboardingView | null;
	ready: boolean;
} {
	const qc = useQueryClient();
	const snapshot = useAuthStore((s) => s.snapshot);
	const subsQ = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const adaptersQ = useQuery({
		queryKey: ["adapters"],
		queryFn: () => api.get<PushAdapter[]>("/api/adapters"),
	});
	const targetsQ = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const healthQ = useQuery({
		queryKey: HEALTH_QUERY_KEY,
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		...HEALTH_QUERY_OPTIONS,
	});

	const ready = Boolean(subsQ.data && adaptersQ.data && targetsQ.data);
	const view =
		subsQ.data && adaptersQ.data && targetsQ.data
			? deriveOnboarding({
					biliLoggedIn: snapshot?.status === BiliLoginStatus.LOGGED_IN,
					subsCount: subsQ.data.length,
					adapters: adaptersQ.data,
					targets: targetsQ.data,
					modules: healthQ.data?.modules,
				})
			: null;

	const pollActive = opts?.poll === true && ready && view?.allDone !== true;
	useEffect(() => {
		if (!pollActive) return;
		const timer = setInterval(() => {
			for (const key of ["auth-status", "subscriptions", "adapters", "targets"]) {
				void qc.invalidateQueries({ queryKey: [key] });
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [pollActive, qc]);

	return { view, ready };
}
