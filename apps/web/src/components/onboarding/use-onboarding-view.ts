import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { SOURCE_AUTH_QUERY_PREFIX, useSourceAuth } from "../../hooks/use-source-auth";
import { HEALTH_DETAILS_QUERY_KEY, useHealthDetails } from "../../hooks/useHealthDetails";
import { api } from "../../services/api";
import type { Connection, PushTarget, Subscription } from "../../types/domain";
import { deriveOnboarding, type OnboardingView } from "./derive";
import { useOnboardingInputsOverride } from "./inputs-override";

/** 导览进行中的判据轮询间隔。 */
const POLL_MS = 3_000;

/**
 * 每轮要失效的 queryKey。**健康详情也在里面** —— 它带的 `modules` 快照喂着
 * 「锦上添花」两条尾巴(图片渲染 / AI),漏掉它,毕业卡上的尾巴在导览开着的
 * 全程都不会变绿。它自己确实带 `refetchInterval`,但那是 useHealthDetails
 * 的事:那边哪天改了选项,这边就静静地退回不刷新(2026-08-31 审查)。
 * key 用权威常量而不是照抄字面量,同理。
 */
const POLLED_KEYS: readonly (readonly unknown[])[] = [
	SOURCE_AUTH_QUERY_PREFIX,
	["subscriptions"],
	["connections"],
	["targets"],
	HEALTH_DETAILS_QUERY_KEY,
];

/**
 * 新手进度的数据装配 —— 左缘导览小卡与 /guide 页共用这一份。全部复用站内
 * 既有 queryKey(与对应页面共享缓存);健康详情与首页同走 useHealthDetails(几处
 * observer 选项不一致会让轮询节奏不确定,同 useBackendReachable 那条)。
 *
 * `poll`(导览小卡传「小卡正展开着」)= **导览进行中**,每 3s invalidate 全部
 * 判据 query(见 POLLED_KEYS,登录状态 `["source-auth"]` 也在里面,重取的结果直接
 * 写回查询缓存)——
 * 「做完自动进下一步」不能指望每条更新链路都恰好有 invalidate / WS 推送:扫码
 * 登录走 WS、页面 mutation 走 invalidate、而「在 QQ 里给 bot 发消息捞 openid」
 * 这类页面外动作根本没有前端事件,轮询是唯一兜得住全部环节的底。
 *
 * 停的条件有三道,一道都不能少 —— 这里是全站唯一一处**长期**定时请求,5 条
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
	const { state: authState } = useSourceAuth(BILIBILI_SOURCE_KEY);
	const enabled = opts?.active ?? true;
	const subsQ = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
		enabled,
	});
	const connectionsQ = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
		enabled,
	});
	const targetsQ = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
		enabled,
	});
	const detailsQ = useHealthDetails({ enabled });

	// 记住结果:react-query 的结构共享让空转 refetch 不换引用,所以这个 memo
	// 真的守得住。不记的话每次 render 都是新对象,下游那几个吃 view 的 memo /
	// effect(步位、完成庆祝)就跟着每 render 跑一遍,memo 形同虚设。
	const biliLoggedIn = authState?.status === "logged-in";
	const modules = detailsQ.data?.modules;
	// devtools 装的假输入优先:判据函数照跑,只是喂的不是真查询。
	const override = useOnboardingInputsOverride((s) => s.inputs);
	const view = useMemo(
		() =>
			override
				? deriveOnboarding(override)
				: subsQ.data && connectionsQ.data && targetsQ.data
					? deriveOnboarding({
							biliLoggedIn,
							subsCount: subsQ.data.length,
							connections: connectionsQ.data,
							targets: targetsQ.data,
							modules,
						})
					: null,
		[override, biliLoggedIn, subsQ.data, connectionsQ.data, targetsQ.data, modules],
	);

	const pollActive = opts?.poll === true && view !== null && !view.allDone;
	useEffect(() => {
		if (!pollActive) return;
		const timer = setInterval(() => {
			// 后台标签页不问:判据只在用户看得见的时候才需要跟手,而这个定时器
			// 一开就是整个标签页寿命 —— 挂着一天的后台页不该一直敲服务端。
			if (document.hidden) return;
			for (const queryKey of POLLED_KEYS) void qc.invalidateQueries({ queryKey });
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [pollActive, qc]);

	return { view };
}
