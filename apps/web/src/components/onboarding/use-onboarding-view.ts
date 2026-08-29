import { useQuery } from "@tanstack/react-query";
import { HEALTH_QUERY_KEY, HEALTH_QUERY_OPTIONS } from "../../hooks/useBackendReachable";
import { api } from "../../services/api";
import { useAuthStore } from "../../store/auth";
import { BiliLoginStatus } from "../../types/auth";
import type { PushAdapter, PushTarget, Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { deriveOnboarding, type OnboardingView } from "./derive";

interface HealthSnapshot {
	status: string;
	uptime: number;
	modules?: { dynamic: boolean; live: boolean; image: boolean; ai: boolean };
}

/**
 * 新手进度的数据装配 —— OnboardingCard(首页卡)与 /guide(引导页顶部进度)
 * 共用这一份。全部复用站内既有 queryKey(与对应页面共享缓存,不发独立轮询);
 * health 行为选项走 HEALTH_QUERY_OPTIONS 单一权威(三处 observer 选项不一致
 * 会让可达性探测抖动,见 useBackendReachable)。
 *
 * `ready=false` = 基础数据还没齐:半份数据画出来的进度是错的,调用方先别渲染。
 */
export function useOnboardingState(): {
	view: OnboardingView | null;
	dismissed: boolean;
	ready: boolean;
} {
	const snapshot = useAuthStore((s) => s.snapshot);
	const globalsQ = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
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

	if (!globalsQ.data || !subsQ.data || !adaptersQ.data || !targetsQ.data) {
		return { view: null, dismissed: false, ready: false };
	}
	return {
		view: deriveOnboarding({
			biliLoggedIn: snapshot?.status === BiliLoginStatus.LOGGED_IN,
			subsCount: subsQ.data.length,
			adapters: adaptersQ.data,
			targets: targetsQ.data,
			modules: healthQ.data?.modules,
		}),
		dismissed: globalsQ.data.onboardingDismissed === true,
		ready: true,
	};
}
