import { NavLink } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus } from "../types/auth";
import { ServiceStatusPill } from "./glass";

const NAV: ReadonlyArray<readonly [string, string]> = [
	["/", "概览"],
	["/subs", "订阅 UP 主"],
	["/targets", "推送目标"],
	["/rules", "高级规则"],
	["/cards", "卡片样式"],
	["/ai", "智能女仆"],
	["/auth", "账号"],
];

function LogoMark() {
	return (
		<div
			role="img"
			aria-label="Bilibili Notify"
			className="grid h-11 w-11 place-items-center rounded-xl text-xl text-white shadow-bn-card"
			style={{ background: "linear-gradient(135deg, #fb7299 0%, #00aeec 100%)" }}
		>
			🎀
		</div>
	);
}

export function GlassHeader() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const loggedIn = snapshot?.status === BiliLoginStatus.LOGGED_IN;
	const loginHint = snapshot
		? loggedIn
			? "账号已登录"
			: "账号未登录，前往「账号」页扫码"
		: "登录态加载中…";

	return (
		<header className="bn-glass-strong sticky top-0 z-10">
			<div className="flex items-center justify-between px-7 pb-0 pt-4">
				<div className="flex items-center gap-3">
					<LogoMark />
					<div>
						<div className="text-base font-bold tracking-tight text-bn-text-primary">
							女仆值班室 · Bilibili Notify
						</div>
						<div className="mt-0.5 text-xs text-bn-text-secondary">{loginHint}</div>
					</div>
				</div>
				<ServiceStatusPill online={loggedIn} label={loggedIn ? "推送服务运行中" : "等待登录"} />
			</div>
			<nav className="flex gap-0 px-5 pt-3">
				{NAV.map(([path, label]) => (
					<NavLink
						key={path}
						to={path}
						end
						className={({ isActive }) =>
							`relative px-4 py-2.5 text-sm transition ${
								isActive
									? "font-bold text-bn-pink"
									: "font-medium text-bn-text-tertiary hover:text-bn-text-primary"
							}`
						}
					>
						{({ isActive }) => (
							<>
								{label}
								<span
									className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition ${
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
