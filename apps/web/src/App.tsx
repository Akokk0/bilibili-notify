import { Btn, ErrorNote, UiTextProvider, WarnNote } from "@bilibili-notify/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/AuthGate";
import { AiChatDock, CHAT_PATH } from "./components/ai-chat";
import { AlertShell } from "./components/alert-shell";
import { DraftIsland } from "./components/draft-island";
import { PageErrorBoundary } from "./components/error-boundary";
import { GlassHeader } from "./components/header";
import { TourCompanion } from "./components/onboarding/tour-companion";
import { PlatformMetaRoot } from "./components/platform-meta";
import { ShellError, ShellLoading } from "./components/shell-states";
import { SkinPreviewBar } from "./components/skin-preview-bar";
import { SkinRoot } from "./components/skin-root";
import { StartupScreen } from "./components/startup-screen";
import { SystemNoticesHost } from "./components/system-notices";
import { ToastShell } from "./components/toast-shell";
import { browser, useRestartStore } from "./components/update/restart";
import { useAlertChannel } from "./hooks/useAlertChannel";
import { useAuthChannel } from "./hooks/useAuthChannel";
import { HEALTH_QUERY_OPTIONS } from "./hooks/useBackendReachable";
import { HEALTH_DETAILS_QUERY_OPTIONS } from "./hooks/useHealthDetails";
import { usePushEventsChannel } from "./hooks/usePushEventsChannel";
import { useStateChannel } from "./hooks/useStateChannel";
import { useUpdateCheckOnOpen } from "./hooks/useUpdateCheckOnOpen";
import { useUpdateTransitionNotice } from "./hooks/useUpdateTransitionNotice";
import { useT, useTextOptions } from "./i18n";
import { useTextSettings } from "./i18n/use-text-settings";
import About from "./pages/About";
import Ai from "./pages/Ai";
import CardSkinEditor from "./pages/CardSkinEditor";
import Cards from "./pages/Cards";
import Chat from "./pages/Chat";
import ExtensionDetail from "./pages/ExtensionDetail";
import Extensions from "./pages/Extensions";
import History from "./pages/History";
import Library from "./pages/Library";
import Logs from "./pages/Logs";
import Overview from "./pages/Overview";
import Rules from "./pages/Rules";
import Stats from "./pages/Stats";
import Subscriptions from "./pages/Subscriptions";
import System from "./pages/System";
import Targets from "./pages/Targets";
import { setWsBackendReady } from "./services/wsSingleton";
import { useSessionStore } from "./store/session";

/**
 * devtools 只在开发期存在:`import.meta.env.DEV` 是编译期常量,生产构建里这一句折成 `null`,
 * 动态 import 随死枝一起被摇掉 —— dist 里连 devtools 这个 chunk 都没有(2026-09-06 对着
 * 构建产物 grep 过,带对照项)。让这句话继续成立的是
 * `src/__tests__/devtools-isolation.test.ts`:它钉住「除了这一处没人提 devtools」和
 * 「这一处包在 DEV 三元里」。服务端那半另有自己的门,两边各自挡。
 */
const DevDock = import.meta.env.DEV
	? lazy(() => import("./devtools/dock").then((m) => ({ default: m.DevDock })))
	: null;

export default function App() {
	const { locale } = useTextOptions();
	useLayoutEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return (
		<AuthGate>
			<StartupApp />
		</AuthGate>
	);
}

/** Auth is established before probing protected startup details; business readers mount only after running. */
function StartupApp() {
	const t = useT();
	const qc = useQueryClient();
	const health = useQuery({ ...HEALTH_QUERY_OPTIONS, refetchOnMount: "always" });
	const process = health.isFetchedAfterMount ? (health.data?.startedAt ?? null) : null;
	const [probedProcess, setProbedProcess] = useState<string | null>(null);
	const [releasedProcess, setReleasedProcess] = useState<string | null>(null);
	const details = useQuery({
		...HEALTH_DETAILS_QUERY_OPTIONS,
		enabled: process !== null && probedProcess === process,
	});
	// A cached running result may belong to another process or data generation. Never release from it.
	useEffect(() => {
		let alive = true;
		setReleasedProcess(null);
		if (process !== null)
			void qc
				.resetQueries({ queryKey: HEALTH_DETAILS_QUERY_OPTIONS.queryKey, exact: true })
				.then(() => {
					if (alive) setProbedProcess(process);
				});
		return () => {
			alive = false;
		};
	}, [process, qc]);
	const state = probedProcess === process ? details.data : undefined;
	const running = state?.phase === "running";
	useEffect(() => {
		if (!running) {
			setReleasedProcess(null);
			return;
		}
		if (process === null || health.isError || releasedProcess === process) return;
		let alive = true;
		const business = {
			predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "health",
		};
		void qc.cancelQueries(business).then(() => {
			if (!alive) return;
			qc.removeQueries(business);
			setReleasedProcess(process);
		});
		return () => {
			alive = false;
		};
	}, [running, process, health.isError, releasedProcess, qc]);
	const restartView = useRestartStore((s) => s.view);
	const generationRestart = restartView?.intent.purpose === "generation" ? restartView : null;
	const ready =
		process !== null && releasedProcess === process && running && generationRestart === null;
	const allowed = useSessionStore((s) => !s.authRequired || s.authed);
	useLayoutEffect(() => {
		setWsBackendReady(ready && allowed);
		return () => setWsBackendReady(false);
	}, [ready, allowed]);
	return (
		<UiTextProvider t={t}>
			{ready ? (
				<PlatformMetaRoot>
					<SkinRoot>
						<AuthedApp processId={process ?? ""} />
					</SkinRoot>
				</PlatformMetaRoot>
			) : (
				<StartupScreen
					details={generationRestart ? undefined : state}
					restarting={generationRestart !== null}
					failed={!generationRestart && (health.isError || details.isError)}
					onRetry={() => {
						void health.refetch();
						void details.refetch();
					}}
				>
					{generationRestart?.kind === "timed-out" ? (
						<ErrorNote size="sm" className="mt-4">
							{t("lifecycle.restartTimedOut")}
							<div className="mt-2">
								<Btn size="sm" variant="outline" onClick={() => useRestartStore.getState().retry()}>
									{t("lifecycle.keepWaiting")}
								</Btn>
							</div>
						</ErrorNote>
					) : generationRestart?.kind === "fell-back" ? (
						<WarnNote size="sm" className="mt-4">
							{t("lifecycle.restartFellBack", { version: generationRestart.version })}
							<div className="mt-2">
								<Btn size="sm" variant="outline" onClick={() => browser.reload()}>
									{t("lifecycle.reloadCurrent")}
								</Btn>
							</div>
						</WarnNote>
					) : null}
				</StartupScreen>
			)}
		</UiTextProvider>
	);
}

/**
 * The authenticated dashboard. Rendered by `<AuthGate>` only once the session
 * is established (or auth is disabled). Keeping the channel hooks here — rather
 * than at the App root — is what gates WS: a cold, unauthenticated load never
 * mounts this subtree, so the WS singleton is never created before login.
 */
function AuthedApp({ processId }: { processId: string }) {
	const [noticesBlocking, setNoticesBlocking] = useState(true);
	useAuthChannel();
	useStateChannel();
	// 语言与口吻跟服务端设置走(登录后才读得到设置,所以挂在这里而不是根上)。
	useTextSettings();
	usePushEventsChannel();
	useAlertChannel();
	// 打开面板就查一次更新(不定时)。放在这里同样是被登录门挡着的:没会话不查。
	useUpdateCheckOnOpen();
	// 后台下载收尾时把那张「正在下载」换成「已就绪 / 下载失败」。挂在壳层,人在哪一页都订阅着。
	useUpdateTransitionNotice();

	// Detect when the backend is genuinely unreachable so the shell can show
	// the design's error state instead of letting individual pages render
	// scattered "fetch failed" lines. retry=0 — health probes should fail
	// fast (TCP ECONNREFUSED resolves in <100 ms); retrying with exponential
	// backoff just keeps the UI in "loading" for several seconds before
	// committing to the error banner.
	const health = useQuery(HEALTH_QUERY_OPTIONS);

	// Show ShellLoading only on the very first attempt (no data and no error
	// yet). After ANY error, stay on ShellError until a successful refetch
	// lands — even when the user clicks "重试", the error banner stays put
	// while the new request is in flight (the inflight flicker is what made
	// the screen bounce loading ↔ error every few seconds before).
	const showLoading = !health.data && !health.error;
	const showError = !health.data && !!health.error;

	return (
		<div className="flex min-h-screen flex-col">
			<GlassHeader />
			<SystemNoticesHost processId={processId} onBlockingChange={setNoticesBlocking} />
			{showLoading ? (
				<ShellLoading />
			) : showError ? (
				<ShellError
					message={String((health.error as Error | null)?.message ?? "unknown")}
					onRetry={() => {
						void health.refetch();
					}}
				/>
			) : (
				<main className="flex-1 px-7 pb-24 pt-6">
					{/* 一页渲染炸了只丢这一页:边界在 main 里面,顶栏与角落里那几块在它外面(见组件注释)。 */}
					<PageErrorBoundary>
						<Routes>
							<Route path="/" element={<Overview />} />
							<Route path="/subs" element={<Subscriptions />} />
							<Route path="/targets" element={<Targets />} />
							<Route path="/extensions" element={<Extensions />} />
							<Route path="/extensions/:id" element={<ExtensionDetail />} />
							<Route path="/history" element={<History />} />
							<Route path="/stats" element={<Stats />} />
							<Route path="/rules" element={<Rules />} />
							<Route path="/cards" element={<Cards />} />
							<Route path="/library" element={<Library />} />
							{/* 皮肤编辑器自铺 fixed inset-0(同聊天页):三栏并排要整个视口宽,
							    挤在站内顶栏与两侧内边距里会两边都不够(ADR-0014 决策 20)。 */}
							<Route path="/cards/skins/:id" element={<CardSkinEditor />} />
							<Route path="/ai" element={<Ai />} />
							{/* 聊天页自带 fixed inset-0 的整页底,视觉上盖过 header 与 main 的
							    留白 —— 放在健康门里是刻意的:后端断了就该看到统一的错误壳,
							    而不是一个每问必挂的聊天。 */}
							<Route path={CHAT_PATH} element={<Chat />} />
							<Route path="/system" element={<System />} />
							<Route path="/logs" element={<Logs />} />
							{/* 新手指引并进关于页(五轮定稿):/about/guide/:chapter? 深链直达教程章节 */}
							<Route path="/about/:section?/:chapter?" element={<About />} />
						</Routes>
					</PageErrorBoundary>
				</main>
			)}
			<AiChatDock />
			<DraftIsland />
			<SkinPreviewBar />
			<ToastShell />
			<AlertShell />
			{/* 「带我做」导览伴随窗:左下角(右下 toast/右上告警/底部灵动岛都有主了) */}
			{noticesBlocking ? null : <TourCompanion />}
			{DevDock ? (
				<Suspense fallback={null}>
					<DevDock />
				</Suspense>
			) : null}
		</div>
	);
}
