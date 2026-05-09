import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { FloatingAiBar } from "./components/floating-ai-bar";
import { GlassHeader } from "./components/header";
import { ShellError, ShellLoading } from "./components/shell-states";
import { useAuthChannel } from "./hooks/useAuthChannel";
import { useAuthHydrate } from "./hooks/useAuthHydrate";
import { useStateChannel } from "./hooks/useStateChannel";
import Ai from "./pages/Ai";
import Auth from "./pages/Auth";
import Cards from "./pages/Cards";
import Dashboard from "./pages/Dashboard";
import History from "./pages/History";
import Rules from "./pages/Rules";
import Subs from "./pages/Subs";
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

	// Detect when the backend is genuinely unreachable so the shell can show
	// the design's error state instead of letting individual pages render
	// scattered "fetch failed" lines. We probe /api/health a few times before
	// declaring it down — single-flight network blips shouldn't trigger the
	// full-screen banner.
	const health = useQuery({
		queryKey: ["health"],
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		retry: 2,
		refetchInterval: 5_000,
	});

	const showLoading = health.isLoading && !health.data;
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
						<Route path="/auth" element={<Auth />} />
					</Routes>
				</main>
			)}
			<FloatingAiBar />
		</div>
	);
}
