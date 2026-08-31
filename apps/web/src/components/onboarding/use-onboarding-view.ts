import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
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
 * `poll`(导览小卡传「小卡正展开着」)= **导览进行中**,每 3s invalidate 全部
 * 判据 query + auth-status(useAuthHydrate 的 effect 把新快照写回 authStore)——
 * 「做完自动进下一步」不能指望每条更新链路都恰好有 invalidate / WS 推送:扫码
 * 登录走 WS、页面 mutation 走 invalidate、而「在 QQ 里给 bot 发消息捞 openid」
 * 这类页面外动作根本没有前端事件,轮询是唯一兜得住全部环节的底。
 *
 * 停的条件有三道,一道都不能少 —— 这里是全站唯一一处**长期**定时请求,4 条
 * query × 20 次/分钟会一直跑到标签页关掉:毕业即停(hook 内部判)、小卡收起
 * 即停(调用方传 false;跳过指引的人第一时间落进这档)、标签页切到后台即停。
 *
 * `active`(不传 = 一直要)= **这份判据现在有人看**。导览小卡是在 App 里无条件
 * 挂载的,而它对已经关掉导览的人整棵树 render null —— 四条 query 却开在任何
 * choice 判断之前,每开一个页面都白发一遍(在 /logs、/cards 上连订阅全表都拉)。
 * 调用方拿它把开关交出去(2026-08-31 审查)。
 *
 * `view=null` = 基础数据还没齐:半份数据画出来的进度是错的,调用方先别渲染。
 */
export function useOnboardingState(opts?: { poll?: boolean; active?: boolean }): {
	view: OnboardingView | null;
} {
	const qc = useQueryClient();
	const snapshot = useAuthStore((s) => s.snapshot);
	const enabled = opts?.active ?? true;
	const subsQ = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
		enabled,
	});
	const adaptersQ = useQuery({
		queryKey: ["adapters"],
		queryFn: () => api.get<PushAdapter[]>("/api/adapters"),
		enabled,
	});
	const targetsQ = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
		enabled,
	});
	const healthQ = useQuery({
		queryKey: HEALTH_QUERY_KEY,
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		...HEALTH_QUERY_OPTIONS,
		enabled,
	});

	// 记住结果:react-query 的结构共享让空转 refetch 不换引用,所以这个 memo
	// 真的守得住。不记的话每次 render 都是新对象,下游那几个吃 view 的 memo /
	// effect(步位、完成庆祝)就跟着每 render 跑一遍,memo 形同虚设。
	const biliLoggedIn = snapshot?.status === BiliLoginStatus.LOGGED_IN;
	const modules = healthQ.data?.modules;
	const view = useMemo(
		() =>
			subsQ.data && adaptersQ.data && targetsQ.data
				? deriveOnboarding({
						biliLoggedIn,
						subsCount: subsQ.data.length,
						adapters: adaptersQ.data,
						targets: targetsQ.data,
						modules,
					})
				: null,
		[biliLoggedIn, subsQ.data, adaptersQ.data, targetsQ.data, modules],
	);

	const pollActive = opts?.poll === true && view !== null && !view.allDone;
	useEffect(() => {
		if (!pollActive) return;
		const timer = setInterval(() => {
			// 后台标签页不问:判据只在用户看得见的时候才需要跟手,而这个定时器
			// 一开就是整个标签页寿命 —— 挂着一天的后台页不该一直敲服务端。
			if (document.hidden) return;
			for (const key of ["auth-status", "subscriptions", "adapters", "targets"]) {
				void qc.invalidateQueries({ queryKey: [key] });
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [pollActive, qc]);

	return { view };
}
