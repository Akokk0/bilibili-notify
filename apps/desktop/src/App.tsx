/**
 * 桌面启动页(launcher)。
 *
 * 前身是零构建的原生 HTML(git 历史里的 src/index.html),React 化后消费
 * @bilibili-notify/ui 与 web 端同一套 tokens/组件。行为契约钉在 __tests__/App.test.tsx:
 * 1s 轮询 get_launcher_state、ready 自动跳 Dashboard、七个按钮的 invoke 语义、
 * degraded(非 Tauri 环境)提示 —— 一条都不许丢。
 *
 * detail 区沿用原版语义:轮询每次用 state.detail 覆盖,命令错误也写进同一个区
 * (所以会被下一秒的轮询盖掉,原版就是这样)。
 */

import { Btn, Pill, Spinner, StatusDot, type StatusDotKind } from "@bilibili-notify/ui";
import { useCallback, useEffect, useRef, useState } from "react";

export interface LauncherState {
	status: string;
	statusLabel: string;
	message: string;
	detail?: string | null;
	panelUrl?: string | null;
	dockToggleAvailable: boolean;
	dockHidden: boolean;
}

export type Invoke = (cmd: string) => Promise<unknown>;

declare global {
	interface Window {
		__TAURI__?: { core?: { invoke?: Invoke } };
	}
}

export interface AppProps {
	/** Tauri 的 invoke;默认取全局注入,测试与 degraded 场景传 undefined。 */
	invoke?: Invoke;
	/** ready 后的整页跳转;默认 location.replace,jsdom 里注入 mock。 */
	navigate?: (url: string) => void;
	pollMs?: number;
}

const DOT_KIND: Record<string, StatusDotKind> = {
	starting: "pending",
	ready: "ok",
	error: "err",
};

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function App({
	invoke = typeof window === "undefined" ? undefined : window.__TAURI__?.core?.invoke,
	navigate,
	pollMs = 1000,
}: AppProps) {
	const [st, setSt] = useState<LauncherState | null>(null);
	const [detail, setDetail] = useState(invoke ? "" : "window.__TAURI__.core.invoke 不存在");
	const [retrying, setRetrying] = useState(false);

	// navigate 的默认值每次渲染都是新引用,进 useCallback 依赖会让轮询 effect
	// 每帧重建 —— 走 ref 拿最新值,effect 只随 invoke/pollMs 变。
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;

	const refresh = useCallback(async () => {
		if (!invoke) return;
		try {
			const state = (await invoke("get_launcher_state")) as LauncherState;
			setSt(state);
			setDetail(state.detail ?? "");
			if (state.status === "ready" && state.panelUrl) {
				const nav = navigateRef.current ?? ((url: string) => window.location.replace(url));
				nav(state.panelUrl);
			}
		} catch (err) {
			setDetail(errText(err));
		}
	}, [invoke]);

	useEffect(() => {
		if (!invoke) return;
		void refresh();
		const timer = setInterval(() => void refresh(), pollMs);
		return () => clearInterval(timer);
	}, [invoke, refresh, pollMs]);

	async function fire(cmd: string): Promise<void> {
		try {
			await invoke?.(cmd);
		} catch (err) {
			setDetail(errText(err));
		}
	}

	async function retry(): Promise<void> {
		setRetrying(true);
		try {
			await invoke?.("retry_service");
		} finally {
			setRetrying(false);
			await refresh();
		}
	}

	async function toggleDock(): Promise<void> {
		try {
			await invoke?.("toggle_dock_icon");
			await refresh();
		} catch (err) {
			await refresh();
			setDetail(errText(err));
		}
	}

	const degraded = !invoke;
	const statusLabel = degraded ? "Tauri API 不可用" : (st?.statusLabel ?? "正在启动后端服务");
	const message = degraded
		? "请在 Tauri 桌面壳中打开此页面。"
		: (st?.message ?? "正在启动本机后端。服务就绪后会自动打开 Dashboard。");
	const busy = retrying || (st ? st.status === "starting" : !degraded);
	const dotKind: StatusDotKind = degraded ? "warn" : (DOT_KIND[st?.status ?? ""] ?? "pending");

	return (
		<main className="flex min-h-screen items-center justify-center px-6 py-12">
			<section className="bn-glass w-[min(720px,100%)] rounded-bn-card p-8 shadow-bn-elev">
				<div className="mb-6 flex items-center gap-2.5">
					<Pill color="#FB7299" subtle>
						<StatusDot kind={dotKind} />
						{statusLabel}
					</Pill>
					{busy ? <Spinner size={16} /> : null}
				</div>

				<h1 className="mb-3 text-[28px] font-extrabold tracking-tight text-bn-text-primary">
					Bilibili Notify 桌面版
				</h1>
				<p className="text-[13.5px] leading-relaxed text-bn-text-secondary">{message}</p>

				<div className="mt-7 flex flex-wrap gap-2">
					<Btn variant="primary" disabled={busy} onClick={() => void retry()}>
						重试启动
					</Btn>
					<Btn
						variant="outline"
						disabled={busy || !st?.panelUrl}
						onClick={() => void fire("open_panel_in_browser")}
					>
						打开 Dashboard
					</Btn>
					<Btn variant="outline" onClick={() => void fire("open_server_log_dir")}>
						打开后端日志
					</Btn>
					<Btn variant="outline" onClick={() => void fire("open_launcher_log_dir")}>
						打开启动器日志
					</Btn>
					<Btn variant="outline" onClick={() => void fire("open_data_dir")}>
						打开数据目录
					</Btn>
					<Btn
						variant="outline"
						disabled={!st?.dockToggleAvailable}
						title={st?.dockToggleAvailable ? undefined : "当前平台或菜单栏图标不可用"}
						onClick={() => void toggleDock()}
					>
						{st?.dockHidden ? "显示 Dock 图标" : "隐藏 Dock 图标"}
					</Btn>
					<Btn variant="danger" onClick={() => void fire("quit_app")}>
						退出应用
					</Btn>
				</div>

				{detail ? (
					<pre className="mt-5 whitespace-pre-wrap rounded-lg bg-bn-code-bg p-4 font-mono text-[12.5px] leading-relaxed text-bn-text-secondary">
						{detail}
					</pre>
				) : null}
			</section>
		</main>
	);
}
