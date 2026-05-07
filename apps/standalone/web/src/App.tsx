import { Route, Routes } from "react-router-dom";
import { GlassHeader } from "./components/header";
import { useAuthChannel } from "./hooks/useAuthChannel";
import { useAuthHydrate } from "./hooks/useAuthHydrate";
import { useStateChannel } from "./hooks/useStateChannel";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import Subs from "./pages/Subs";
import Targets from "./pages/Targets";

function Placeholder({ name }: { name: string }) {
	return (
		<div className="bn-glass rounded-bn-card p-8 text-center text-sm text-bn-text-secondary shadow-bn-card">
			页面占位：{name}
		</div>
	);
}

export default function App() {
	useAuthHydrate();
	useAuthChannel();
	useStateChannel();
	return (
		<div className="flex min-h-screen flex-col">
			<GlassHeader />
			<main className="flex-1 px-7 py-6">
				<Routes>
					<Route path="/" element={<Dashboard />} />
					<Route path="/subs" element={<Subs />} />
					<Route path="/targets" element={<Targets />} />
					<Route path="/rules" element={<Placeholder name="高级规则" />} />
					<Route path="/cards" element={<Placeholder name="卡片样式" />} />
					<Route path="/ai" element={<Placeholder name="智能女仆" />} />
					<Route path="/auth" element={<Auth />} />
				</Routes>
			</main>
		</div>
	);
}
