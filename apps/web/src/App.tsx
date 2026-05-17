import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { AlertShell } from "./components/alert-shell";
import { FloatingAiBar } from "./components/floating-ai-bar";
import { GlassHeader } from "./components/header";
import { ShellError, ShellLoading } from "./components/shell-states";
import { ToastShell } from "./components/toast-shell";
import { useAlertChannel } from "./hooks/useAlertChannel";
import { useAuthChannel } from "./hooks/useAuthChannel";
import { useAuthHydrate } from "./hooks/useAuthHydrate";
import { HEALTH_QUERY_KEY, HEALTH_QUERY_OPTIONS } from "./hooks/useBackendReachable";
import { usePushEventsChannel } from "./hooks/usePushEventsChannel";
import { useStateChannel } from "./hooks/useStateChannel";
import Ai from "./pages/Ai";
import Cards from "./pages/Cards";
import Dashboard from "./pages/Dashboard";
import History from "./pages/History";
import Rules from "./pages/Rules";
import Subs from "./pages/Subs";
import System from "./pages/System";
import Targets from "./pages/Targets";
import { api } from "./services/api";

interface HealthSnapshot {
	status: string;
	uptime: number;
}

export default function App() {
	useAuthHydrate();
	useAuthChannel();
	useStateChannel();
	usePushEventsChannel();
	useAlertChannel();

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
						<Route path="/rules" element={<Rules />} />
						<Route path="/cards" element={<Cards />} />
						<Route path="/ai" element={<Ai />} />
						<Route path="/system" element={<System />} />
					</Routes>
				</main>
			)}
			<FloatingAiBar />
			<ToastShell />
			<AlertShell />
		</div>
	);
}
