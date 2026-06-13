import { useCallback, useEffect, useMemo, useState } from "react";
import { dashboardApi, resolveApiBase, subscribeDashboardEvents } from "./api/client";
import type { DashboardBootstrap } from "./api/types";
import { Badge, Button, Card, ErrorBanner, useConfirm } from "./components/ui";
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
	const requestConfirmation = useConfirm();
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
		let disposed = false;
		let bridgeStopped = false;
		let bridgeCleanup: (() => void) | undefined;
		let pollingTimer: ReturnType<typeof setInterval> | undefined;
		const stopBridge = () => {
			if (bridgeStopped) return;
			bridgeStopped = true;
			bridgeCleanup?.();
		};
		const startPollingFallback = () => {
			if (disposed || pollingTimer) return;
			setSseState("fallback");
			stopBridge();
			void reload();
			pollingTimer = setInterval(() => void reload(), 10_000);
		};
		bridgeCleanup = subscribeDashboardEvents({
			onHydrate(next) {
				setData(next);
				setLoading(false);
				setError(null);
			},
			onRefresh: () => void reload(),
			onOpen: () => setSseState("open"),
			onError: startPollingFallback,
		});
		if (bridgeCleanup) {
			return () => {
				disposed = true;
				stopBridge();
				if (pollingTimer) clearInterval(pollingTimer);
			};
		}
		if (typeof EventSource === "undefined") {
			setSseState("fallback");
			const timer = setInterval(() => void reload(), 10_000);
			return () => {
				disposed = true;
				clearInterval(timer);
			};
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
			// Stream truncation is handled below the page layer; poll instead of reopening SSE here.
			source.close();
		};
		const timer = setInterval(() => {
			if (source.readyState === EventSource.CLOSED) void reload();
		}, 10_000);
		return () => {
			disposed = true;
			clearInterval(timer);
			source.close();
		};
	}, [reload]);

	useEffect(() => {
		const handler = (event: BeforeUnloadEvent) => {
			if (dirtyTabs.size === 0) return;
			// 现代浏览器仅需 preventDefault 即可弹出未保存提示;不再设置已弃用的 returnValue。
			event.preventDefault();
		};
		globalThis.addEventListener("beforeunload", handler);
		return () => globalThis.removeEventListener("beforeunload", handler);
	}, [dirtyTabs]);

	const setTabDirty = useCallback((tab: TabKey, dirty: boolean) => {
		setDirtyTabs((prev) => {
			// 幂等:dirty 状态未变则保持同一引用,避免子 Tab 用不稳定 onDirty 时触发渲染死循环。
			if (dirty === prev.has(tab)) return prev;
			const next = new Set(prev);
			if (dirty) next.add(tab);
			else next.delete(tab);
			return next;
		});
	}, []);

	// 稳定回调:避免每次渲染新建 onDirty 箭头,导致子 Tab 的 effect 反复重跑(配合幂等 setTabDirty 杜绝渲染循环)。
	const onSettingsDirty = useCallback(
		(dirty: boolean) => setTabDirty("settings", dirty),
		[setTabDirty],
	);
	const onRulesDirty = useCallback((dirty: boolean) => setTabDirty("rules", dirty), [setTabDirty]);

	const activeMeta = useMemo(
		() => TABS.find((tab) => tab.key === activeTab) ?? TABS[0],
		[activeTab],
	);
	const dirtyLabel = [...dirtyTabs]
		.map((tab) => TABS.find((item) => item.key === tab)?.label ?? tab)
		.join("、");

	const switchTab = async (tab: TabKey) => {
		if (tab === activeTab) return;
		if (dirtyTabs.size > 0) {
			const canSwitch = await requestConfirmation({
				message: `还有未保存草稿：${dirtyLabel}。确定切换 Tab 吗？`,
			});
			if (!canSwitch) return;
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
							通过 AstrBot Plugin Page 配置订阅、推送目标和高级规则。
						</p>
					</div>
					<div className="flex flex-col items-center gap-2">
						<Button onClick={() => void reload()} disabled={loading}>
							刷新
						</Button>
						{data ? <Badge>{data.snapshot.version}</Badge> : null}
					</div>
				</div>
			</header>

			<nav className="grid gap-2 md:grid-cols-4">
				{TABS.map((tab) => (
					<button
						key={tab.key}
						type="button"
						onClick={() => void switchTab(tab.key)}
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
						<SettingsTab data={data} onData={setData} onReload={reload} onDirty={onSettingsDirty} />
					) : null}
					{activeTab === "subscriptions" ? (
						<SubscriptionsTab data={data} onData={setData} onReload={reload} />
					) : null}
					{activeTab === "targets" ? (
						<TargetsTab data={data} onData={setData} onReload={reload} />
					) : null}
					{activeTab === "rules" ? (
						<RulesTab data={data} onData={setData} onDirty={onRulesDirty} />
					) : null}
				</main>
			) : null}
		</div>
	);
}
