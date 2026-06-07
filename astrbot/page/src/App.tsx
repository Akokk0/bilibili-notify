import { useCallback, useEffect, useMemo, useState } from "react";
import { dashboardApi, resolveApiBase } from "./api/client";
import type { DashboardBootstrap } from "./api/types";
import { Badge, Button, Card, ErrorBanner } from "./components/ui";
import { RulesTab } from "./tabs/RulesTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { SubscriptionsTab } from "./tabs/SubscriptionsTab";
import { TargetsTab } from "./tabs/TargetsTab";

type TabKey = "settings" | "subscriptions" | "targets" | "rules";

const TABS: Array<{ key: TabKey; label: string; description: string }> = [
	{ key: "settings", label: "设置", description: "登录、全局默认值与危险操作" },
	{ key: "subscriptions", label: "订阅", description: "查找 UP、管理订阅与路由" },
	{ key: "targets", label: "推送目标", description: "配对会话、测试推送与目标维护" },
	{ key: "rules", label: "高级规则", description: "按 UP 覆盖继承的默认配置" },
];

export function App() {
	const [activeTab, setActiveTab] = useState<TabKey>("settings");
	const [data, setData] = useState<DashboardBootstrap | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [dirtyTabs, setDirtyTabs] = useState<ReadonlySet<TabKey>>(new Set());
	const [sseState, setSseState] = useState<"connecting" | "open" | "fallback">("connecting");

	const reload = useCallback(async () => {
		try {
			setError(null);
			const next = await dashboardApi.bootstrap();
			setData(next);
		} catch (err) {
			setError(err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	useEffect(() => {
		if (typeof EventSource === "undefined") {
			setSseState("fallback");
			const timer = setInterval(() => void reload(), 10_000);
			return () => clearInterval(timer);
		}
		const source = new EventSource(`${resolveApiBase()}/events/stream`);
		const hydrate = (event: MessageEvent<string>) => {
			try {
				setData(JSON.parse(event.data) as DashboardBootstrap);
				setLoading(false);
				setError(null);
			} catch {
				void reload();
			}
		};
		const refresh = () => void reload();
		source.addEventListener("hydrate", hydrate);
		source.addEventListener("auth-lost", refresh);
		source.addEventListener("auth-restored", refresh);
		source.addEventListener("delivery", refresh);
		source.addEventListener("engine-error", refresh);
		source.onopen = () => setSseState("open");
		source.onerror = () => {
			setSseState("fallback");
			source.close();
		};
		const timer = setInterval(() => {
			if (source.readyState === EventSource.CLOSED) void reload();
		}, 10_000);
		return () => {
			clearInterval(timer);
			source.close();
		};
	}, [reload]);

	useEffect(() => {
		const handler = (event: BeforeUnloadEvent) => {
			if (dirtyTabs.size === 0) return;
			event.preventDefault();
			event.returnValue = "";
		};
		globalThis.addEventListener("beforeunload", handler);
		return () => globalThis.removeEventListener("beforeunload", handler);
	}, [dirtyTabs]);

	const setTabDirty = useCallback((tab: TabKey, dirty: boolean) => {
		setDirtyTabs((prev) => {
			const next = new Set(prev);
			if (dirty) next.add(tab);
			else next.delete(tab);
			return next;
		});
	}, []);

	const activeMeta = useMemo(
		() => TABS.find((tab) => tab.key === activeTab) ?? TABS[0],
		[activeTab],
	);
	const dirtyLabel = [...dirtyTabs]
		.map((tab) => TABS.find((item) => item.key === tab)?.label ?? tab)
		.join("、");

	const switchTab = (tab: TabKey) => {
		if (tab === activeTab) return;
		if (
			dirtyTabs.size > 0 &&
			!globalThis.confirm(`还有未保存草稿：${dirtyLabel}。确定切换 Tab 吗？`)
		) {
			return;
		}
		setActiveTab(tab);
	};

	return (
		<div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
			<header className="bn-glass rounded-[28px] p-5 shadow-bn-elev">
				<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
					<div>
						<div className="mb-2 flex flex-wrap items-center gap-2">
							<Badge tone={data?.snapshot.status === "ready" ? "success" : "warn"}>
								{data?.snapshot.status ?? "loading"}
							</Badge>
							<Badge tone={sseState === "open" ? "info" : "neutral"}>
								{sseState === "open" ? "SSE 已连接" : "轮询兜底"}
							</Badge>
							{dirtyTabs.size > 0 ? <Badge tone="warn">未保存：{dirtyLabel}</Badge> : null}
						</div>
						<h1 className="font-bold text-2xl text-bn-text-primary sm:text-3xl">
							Bilibili Notify · AstrBot
						</h1>
						<p className="mt-2 max-w-2xl text-bn-text-tertiary text-sm leading-relaxed">
							通过 AstrBot Plugin Page 配置订阅、推送目标和高级规则。页面只访问 Python 白名单
							proxy，不接触 sidecar token。
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => void reload()} disabled={loading}>
							刷新
						</Button>
						<Badge>Page {__ASTRBOT_PAGE_VERSION__}</Badge>
						{data ? <Badge>Sidecar {data.snapshot.version}</Badge> : null}
					</div>
				</div>
			</header>

			<nav className="grid gap-2 md:grid-cols-4">
				{TABS.map((tab) => (
					<button
						key={tab.key}
						type="button"
						onClick={() => switchTab(tab.key)}
						className={`rounded-2xl p-4 text-left shadow-bn-card transition ${
							activeTab === tab.key ? "bg-bn-pink text-white" : "bn-glass hover:bg-white/90"
						}`}
					>
						<div className="font-semibold">{tab.label}</div>
						<div
							className={`mt-1 text-xs ${activeTab === tab.key ? "text-white/85" : "text-bn-text-secondary"}`}
						>
							{tab.description}
						</div>
					</button>
				))}
			</nav>

			{error ? <ErrorBanner error={error} /> : null}

			{loading && !data ? (
				<Card>
					<div className="py-10 text-center text-bn-text-secondary">
						正在连接 AstrBot sidecar...
					</div>
				</Card>
			) : null}

			{data ? (
				<main className="bn-anim-fade-in">
					<h2 className="sr-only">{activeMeta.label}</h2>
					{activeTab === "settings" ? (
						<SettingsTab
							data={data}
							onData={setData}
							onReload={reload}
							onDirty={(dirty) => setTabDirty("settings", dirty)}
						/>
					) : null}
					{activeTab === "subscriptions" ? (
						<SubscriptionsTab data={data} onData={setData} onReload={reload} />
					) : null}
					{activeTab === "targets" ? (
						<TargetsTab data={data} onData={setData} onReload={reload} />
					) : null}
					{activeTab === "rules" ? (
						<RulesTab
							data={data}
							onData={setData}
							onDirty={(dirty) => setTabDirty("rules", dirty)}
						/>
					) : null}
				</main>
			) : null}
		</div>
	);
}
