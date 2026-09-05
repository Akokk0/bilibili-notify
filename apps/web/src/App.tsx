import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/AuthGate";
import { AiChatDock, CHAT_PATH } from "./components/ai-chat";
import { AlertShell } from "./components/alert-shell";
import { DraftIsland } from "./components/draft-island";
import { GlassHeader } from "./components/header";
import { TourCompanion } from "./components/onboarding/tour-companion";
import { ShellError, ShellLoading } from "./components/shell-states";
import { SkinPreviewBar } from "./components/skin-preview-bar";
import { ToastShell } from "./components/toast-shell";
import { useAlertChannel } from "./hooks/useAlertChannel";
import { useAuthChannel } from "./hooks/useAuthChannel";
import { useAuthHydrate } from "./hooks/useAuthHydrate";
import { HEALTH_QUERY_KEY, HEALTH_QUERY_OPTIONS } from "./hooks/useBackendReachable";
import { usePushEventsChannel } from "./hooks/usePushEventsChannel";
import { useStateChannel } from "./hooks/useStateChannel";
import { useUpdateCheckOnOpen } from "./hooks/useUpdateCheckOnOpen";
import { useUpdateTransitionNotice } from "./hooks/useUpdateTransitionNotice";
import About from "./pages/About";
import Ai from "./pages/Ai";
import Cards from "./pages/Cards";
import Chat from "./pages/Chat";
import Dashboard from "./pages/Dashboard";
import History from "./pages/History";
import Logs from "./pages/Logs";
import Rules from "./pages/Rules";
import Stats from "./pages/Stats";
import Subs from "./pages/Subs";
import System from "./pages/System";
import Targets from "./pages/Targets";
import { api } from "./services/api";

interface HealthSnapshot {
	status: string;
	uptime: number;
}

export default function App() {
	return (
		<AuthGate>
			<AuthedApp />
		</AuthGate>
	);
}

/**
 * The authenticated dashboard. Rendered by `<AuthGate>` only once the session
 * is established (or auth is disabled). Keeping the channel hooks here — rather
 * than at the App root — is what gates WS: a cold, unauthenticated load never
 * mounts this subtree, so the WS singleton is never created before login.
 */
function AuthedApp() {
	useAuthHydrate();
	useAuthChannel();
	useStateChannel();
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
	const health = useQuery({
		queryKey: HEALTH_QUERY_KEY,
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		...HEALTH_QUERY_OPTIONS,
	});

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
					<Routes>
						<Route path="/" element={<Dashboard />} />
						<Route path="/subs" element={<Subs />} />
						<Route path="/targets" element={<Targets />} />
						<Route path="/history" element={<History />} />
						<Route path="/stats" element={<Stats />} />
						<Route path="/rules" element={<Rules />} />
						<Route path="/cards" element={<Cards />} />
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
				</main>
			)}
			<AiChatDock />
			<DraftIsland />
			<SkinPreviewBar />
			<ToastShell />
			<AlertShell />
			{/* 「带我做」导览伴随窗:左下角(右下 toast/右上告警/底部灵动岛都有主了) */}
			<TourCompanion />
		</div>
	);
}
