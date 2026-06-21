import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useBackendReachable } from "../hooks/useBackendReachable";
import { api } from "../services/api";
import { submitLogout } from "../services/session";
import { useAuthStore } from "../store/auth";
import { useSessionStore } from "../store/session";
import { type ThemePreference, useThemeStore } from "../store/theme";
import { BiliLoginStatus } from "../types/auth";
import type { PushTarget, Subscription } from "../types/domain";
import { Btn } from "./atoms";
import { Icon } from "./icons";

interface UserCardData {
	card?: {
		mid?: string;
		name?: string;
		face?: string;
	};
}

const NAV: ReadonlyArray<{
	to: string;
	label: string;
	countKey?: "subs" | "targets";
}> = [
	{ to: "/", label: "概览" },
	{ to: "/subs", label: "订阅 UP 主", countKey: "subs" },
	{ to: "/targets", label: "推送目标", countKey: "targets" },
	{ to: "/history", label: "推送历史" },
	{ to: "/rules", label: "高级规则" },
	{ to: "/cards", label: "卡片渲染 · 样式" },
	{ to: "/ai", label: "智能女仆" },
	{ to: "/system", label: "系统" },
	{ to: "/logs", label: "日志" },
	{ to: "/about", label: "关于" },
];

function AccountChip() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const loggedIn = snapshot?.status === BiliLoginStatus.LOGGED_IN;
	const card = loggedIn ? (snapshot?.data as UserCardData | undefined)?.card : undefined;
	const name = card?.name;
	const face = card?.face;
	if (loggedIn && name) {
		return (
			<span>
				当前账号 <span className="font-bold text-bn-pink">{name}</span> 已登录
				{face ? (
					<img
						alt={name}
						src={face}
						referrerPolicy="no-referrer"
						className="ml-2 inline-block h-5 w-5 rounded-full"
					/>
				) : null}
			</span>
		);
	}
	return (
		<span>
			女仆为您打理一切～(*´∀`)~♡{" "}
			<span className="text-bn-text-secondary">{snapshot?.msg ?? "登录态加载中"}</span>
		</span>
	);
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
	{ value: "system", label: "跟随系统", hint: "自动跟随系统外观" },
	{ value: "light", label: "浅色", hint: "固定使用亮色主题" },
	{ value: "dark", label: "深色", hint: "固定使用暗色主题" },
];

function themeLabel(value: ThemePreference): string {
	return THEME_OPTIONS.find((o) => o.value === value)?.label ?? "跟随系统";
}

function ThemeSwitcher() {
	const preference = useThemeStore((s) => s.preference);
	const resolved = useThemeStore((s) => s.resolved);
	const setPreference = useThemeStore((s) => s.setPreference);
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const current = themeLabel(preference);

	// 点击下拉外部时关闭(与 Rules/draft-island 的下拉一致),仅在展开时挂监听。
	useEffect(() => {
		if (!open) return;
		function handleDocClick(e: MouseEvent) {
			if (!containerRef.current) return;
			if (!containerRef.current.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", handleDocClick);
		return () => document.removeEventListener("mousedown", handleDocClick);
	}, [open]);

	return (
		<div className="relative" ref={containerRef}>
			<Btn
				variant="outline"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				ariaHasPopup
				ariaExpanded={open}
				title={`当前外观:${current}${preference === "system" ? `(${resolved === "dark" ? "深色" : "浅色"})` : ""}`}
			>
				主题：{current}
			</Btn>
			{open ? (
				<div className="absolute right-0 top-full z-20 mt-2 w-42 rounded-lg border border-bn-border bg-bn-surface-strong p-1.5 shadow-bn-elev">
					{THEME_OPTIONS.map((o) => {
						const active = o.value === preference;
						return (
							<button
								type="button"
								key={o.value}
								aria-label={o.label}
								onClick={() => {
									setPreference(o.value);
									setOpen(false);
								}}
								className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition ${
									active
										? "bg-bn-pink/12 font-bold text-bn-pink"
										: "text-bn-text-primary hover:bg-bn-hover-muted"
								}`}
							>
								<span className="block">{o.label}</span>
								<span className="block text-[10.5px] font-normal text-bn-text-secondary">
									{o.hint}
								</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/**
 * Dashboard logout (Q6). Icon-only, rightmost in the header cluster, rendered
 * only when auth is configured AND the session is authed. Lightweight 2-step
 * inline confirm (click → "确认登出?" ~3s → second click executes) — guards a
 * fat-finger from dropping unsaved edits, no modal infra.
 */
function LogoutButton() {
	const qc = useQueryClient();
	const authRequired = useSessionStore((s) => s.authRequired);
	const authed = useSessionStore((s) => s.authed);
	const markLoggedOut = useSessionStore((s) => s.markLoggedOut);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (revertTimer.current) clearTimeout(revertTimer.current);
		};
	}, []);

	if (!authRequired || !authed) return null;

	function armOrConfirm(): void {
		if (busy) return;
		if (!confirming) {
			setConfirming(true);
			if (revertTimer.current) clearTimeout(revertTimer.current);
			revertTimer.current = setTimeout(() => setConfirming(false), 3000);
			return;
		}
		if (revertTimer.current) clearTimeout(revertTimer.current);
		setBusy(true);
		void submitLogout().finally(() => {
			// authed=false → AuthGate effect tears the WS down + shows the
			// (cold) login card; drop cached server data so a re-login starts
			// from a clean slate.
			markLoggedOut();
			qc.clear();
		});
	}

	return (
		<>
			<span className="mx-1 h-5 w-px bg-bn-border" aria-hidden="true" />
			<Btn
				variant="outline"
				size="sm"
				icon={<Icon.logout size={14} />}
				onClick={armOrConfirm}
				disabled={busy}
				title="登出 Dashboard"
			>
				{confirming ? "确认登出?" : ""}
			</Btn>
		</>
	);
}

export function GlassHeader() {
	const qc = useQueryClient();
	const reachable = useBackendReachable();
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const counts = {
		subs: subs.data?.length ?? 0,
		targets: targets.data?.length ?? 0,
	};

	function refreshAll(): void {
		qc.invalidateQueries({ queryKey: ["health"] });
		qc.invalidateQueries({ queryKey: ["auth-status"] });
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		qc.invalidateQueries({ queryKey: ["targets"] });
	}

	// 把 header 实测高度发布到 `--bn-header-h`,供页面内的 SectionNav 竖栏/横向条精确锚定
	// 吸顶位置(= header 高 + 间隔 = 元素自然起点)→ 滚动时零「往下带」,且账号名换行 / 窄视口
	// 按钮换行导致 header 变高时自动跟随。useLayoutEffect 在首帧 paint 前写入,避免回流闪烁。
	const headerRef = useRef<HTMLElement>(null);
	useLayoutEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const apply = () => {
			document.documentElement.style.setProperty("--bn-header-h", `${el.offsetHeight}px`);
		};
		apply();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", apply);
			return () => window.removeEventListener("resize", apply);
		}
		const ro = new ResizeObserver(apply);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	return (
		<header ref={headerRef} className="bn-glass-strong sticky top-0 z-10">
			<div className="flex items-center justify-between gap-4 px-7 pt-4">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex h-13 items-center px-1">
						<img alt="Bilibili Notify" src="/logo.png" className="h-13 w-auto object-contain" />
					</div>
					<div className="min-w-0">
						<div className="text-[17px] font-bold tracking-tight text-bn-text-primary">
							Bilibili Notify · 女仆值班室
						</div>
						<div className="mt-0.5 truncate text-[11.5px] text-bn-text-secondary">
							<AccountChip />
						</div>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{reachable ? (
						<span className="inline-flex items-center gap-1.5 rounded-full bg-bn-success-soft px-2.5 py-1 text-[11.5px] font-semibold text-bn-success-text">
							<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
							推送服务运行中
						</span>
					) : (
						<span className="inline-flex items-center gap-1.5 rounded-full bg-bn-danger-soft px-2.5 py-1 text-[11.5px] font-semibold text-bn-danger-text">
							<span className="h-1.5 w-1.5 rounded-full bg-red-500" />
							后端失联
						</span>
					)}
					<ThemeSwitcher />
					<Btn variant="outline" size="sm" icon={<Icon.refresh size={14} />} onClick={refreshAll}>
						刷新
					</Btn>
					<NavLink to="/subs">
						<Btn variant="primary" size="sm" icon={<Icon.plus size={14} />}>
							添加 UP 主
						</Btn>
					</NavLink>
					<LogoutButton />
				</div>
			</div>
			<nav className="flex gap-0 px-5 pt-3">
				{NAV.map((t) => (
					<NavLink
						key={t.to}
						to={t.to}
						end
						className={({ isActive }) =>
							`relative flex items-center gap-1.5 px-4 py-2.5 text-[13px] transition ${
								isActive
									? "font-bold text-bn-pink"
									: "font-medium text-bn-text-tertiary hover:text-bn-text-primary"
							}`
						}
					>
						{({ isActive }) => (
							<>
								{t.label}
								{t.countKey ? (
									<span
										className={`rounded-lg px-1.5 py-px text-[10px] font-bold ${
											isActive
												? "bg-bn-pink/15 text-bn-pink"
												: "bg-bn-code-bg text-bn-text-secondary"
										}`}
									>
										{counts[t.countKey]}
									</span>
								) : null}
								<span
									className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition ${
										isActive ? "bg-bn-pink" : "bg-transparent"
									}`}
								/>
							</>
						)}
					</NavLink>
				))}
			</nav>
		</header>
	);
}
