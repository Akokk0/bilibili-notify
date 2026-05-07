import { useQuery } from "@tanstack/react-query";
import { NavLink, Route, Routes } from "react-router-dom";
import { api } from "./services/api";

interface HealthSnapshot {
	status: string;
	version: string;
	uptime: number;
	startedAt: string;
}

function HealthCard() {
	const { data, isLoading, error } = useQuery({
		queryKey: ["health"],
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		refetchInterval: 5_000,
	});
	if (isLoading) return <div className="text-sm text-gray-500">加载中…</div>;
	if (error)
		return <div className="text-sm text-red-600">健康检查失败：{String((error as Error).message)}</div>;
	return (
		<pre className="rounded bg-gray-50 p-3 text-xs leading-relaxed">{JSON.stringify(data, null, 2)}</pre>
	);
}

function Placeholder({ name }: { name: string }) {
	return <div className="p-6 text-gray-700">页面占位：{name}</div>;
}

const NAV: ReadonlyArray<readonly [string, string]> = [
	["/", "概览"],
	["/subs", "订阅"],
	["/targets", "推送目标"],
	["/rules", "高级规则"],
	["/cards", "卡片样式"],
	["/ai", "AI"],
	["/auth", "登录"],
];

export default function App() {
	return (
		<div className="min-h-screen bg-white text-gray-900">
			<header className="border-b border-gray-200 px-6 py-3">
				<h1 className="text-lg font-semibold">Bilibili-Notify Dashboard</h1>
			</header>
			<nav className="flex gap-4 border-b border-gray-200 px-6 py-2 text-sm">
				{NAV.map(([path, label]) => (
					<NavLink
						key={path}
						to={path}
						end
						className={({ isActive }) =>
							isActive ? "font-medium text-blue-600" : "text-gray-600 hover:text-gray-900"
						}
					>
						{label}
					</NavLink>
				))}
			</nav>
			<main className="p-6">
				<Routes>
					<Route
						path="/"
						element={
							<div className="space-y-4">
								<h2 className="text-base font-medium">服务器健康</h2>
								<HealthCard />
							</div>
						}
					/>
					<Route path="/subs" element={<Placeholder name="订阅 UP 主" />} />
					<Route path="/targets" element={<Placeholder name="推送目标" />} />
					<Route path="/rules" element={<Placeholder name="高级规则" />} />
					<Route path="/cards" element={<Placeholder name="卡片样式" />} />
					<Route path="/ai" element={<Placeholder name="智能女仆" />} />
					<Route path="/auth" element={<Placeholder name="登录" />} />
				</Routes>
			</main>
		</div>
	);
}
