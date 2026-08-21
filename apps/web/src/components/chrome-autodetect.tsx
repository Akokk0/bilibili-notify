import { useState } from "react";
import { api } from "../services/api";

type DetectState = "idle" | "detecting" | "enabling" | "connecting" | "enabled";

/**
 * 「启用卡片渲染」交互 —— 嵌在卡片预览 503(浏览器未配置)提示区,两条路:
 *
 * - **自动探测本机 Chrome**:探测常见安装位置 → 展示路径 → 一键热启用。
 * - **连接远程浏览器**:填 `ws://`(browserless 等)或 `http://`(chromium
 *   remote-debugging)端点 → 后端先真开一页探测连通,通了才启用 —— slim 镜像
 *   (无内置 chromium)靠这条路。
 *
 * 两条路都走 POST /api/cards/enable-rendering:后端运行时构造 puppeteer 并注入
 * live/dynamic 引擎 + 写回 bn.config.yaml,无需重启。
 */
/**
 * 提示条里的小药丸钮。三颗(自动探测 / 启用 / 连接远程)只差色调与文案,此前
 * 各写一遍,绿的那两颗逐字相同。挂 `data-bn="btn"` 让皮肤搬得动 —— 页面里手写
 * 的按钮不会自己带上挂点。
 */
const PILL_TONE = {
	pink: "border-bn-pink/40 bg-bn-pink/10 text-bn-pink",
	success: "border-bn-success/50 bg-bn-success-soft text-bn-success-text",
} as const;

function ActionPill({
	tone,
	onClick,
	disabled,
	children,
}: {
	tone: keyof typeof PILL_TONE;
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			data-bn="btn"
			className={`rounded-bn-pill border px-3 py-1 font-semibold disabled:opacity-60 ${PILL_TONE[tone]}`}
		>
			{children}
		</button>
	);
}

export function ChromeAutoDetect({ onEnabled }: { onEnabled: () => void }) {
	const [state, setState] = useState<DetectState>("idle");
	const [path, setPath] = useState<string | null>(null);
	const [endpoint, setEndpoint] = useState("");
	const [notFound, setNotFound] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function detect() {
		setState("detecting");
		setErr(null);
		setNotFound(false);
		setPath(null);
		try {
			const res = await api.get<{ path: string | null }>("/api/cards/detect-chrome");
			setPath(res.path);
			setNotFound(res.path === null);
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setState("idle");
		}
	}

	async function enable() {
		if (!path) return;
		setState("enabling");
		setErr(null);
		try {
			const res = await api.post<{ ok: boolean; err?: string }>("/api/cards/enable-rendering", {
				chromePath: path,
			});
			if (!res.ok) throw new Error(res.err ?? "启用失败");
			setState("enabled");
			onEnabled();
		} catch (e) {
			setErr((e as Error).message);
			setState("idle");
		}
	}

	async function connectRemote() {
		const trimmed = endpoint.trim();
		if (!trimmed) return;
		setState("connecting");
		setErr(null);
		try {
			const res = await api.post<{ ok: boolean; err?: string }>("/api/cards/enable-rendering", {
				chromeEndpoint: trimmed,
			});
			if (!res.ok) throw new Error(res.err ?? "连接失败");
			setState("enabled");
			onEnabled();
		} catch (e) {
			setErr((e as Error).message);
			setState("idle");
		}
	}

	if (state === "enabled") {
		return (
			<div className="mt-2 rounded-sm border border-bn-success-border bg-bn-success-soft p-2 text-[11px] font-semibold text-bn-success-text">
				✓ 卡片渲染已启用 · 已写回配置,重启仍生效
			</div>
		);
	}

	return (
		<div className="mt-2 rounded-sm border border-bn-warning-border bg-bn-warning-soft p-2 text-[11px] text-bn-warning-text">
			<div className="mb-1.5">
				设置 <code className="font-mono">BN_CHROME_PATH</code> 环境变量或 yaml{" "}
				<code className="font-mono">chromePath</code>,或一键自动探测本机浏览器:
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<ActionPill tone="pink" onClick={detect} disabled={state === "detecting"}>
					{state === "detecting" ? "探测中…" : "自动探测 Chrome"}
				</ActionPill>
				{path ? (
					<>
						<code className="rounded-sm bg-bn-code-bg px-1.5 py-0.5 font-mono text-bn-warning-text">
							{path}
						</code>
						<ActionPill tone="success" onClick={enable} disabled={state === "enabling"}>
							{state === "enabling" ? "启用中…" : "启用"}
						</ActionPill>
					</>
				) : null}
			</div>
			{notFound ? (
				<div className="mt-1.5 text-bn-warning-text">
					未在常见位置找到 Chrome / Chromium,请手动设置 chromePath 指向浏览器二进制。
				</div>
			) : null}
			<div className="mt-2 border-t border-bn-warning-border/50 pt-2">
				<div className="mb-1.5">
					或连接<strong>远程浏览器</strong>(slim 镜像 / 无本机浏览器时用,如 browserless 容器):
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<input
						type="text"
						value={endpoint}
						onChange={(e) => setEndpoint(e.target.value)}
						placeholder="ws://browser:3000?token=… 或 http://host:9222"
						data-bn="input"
						className="min-w-56 flex-1 rounded-sm border border-bn-warning-border bg-bn-code-bg px-2 py-1 font-mono text-bn-warning-text placeholder:opacity-50"
					/>
					<ActionPill
						tone="success"
						onClick={connectRemote}
						disabled={state === "connecting" || !endpoint.trim()}
					>
						{state === "connecting" ? "连接中…" : "连接远程浏览器"}
					</ActionPill>
				</div>
			</div>
			{err ? <div className="mt-1.5 text-bn-danger-text">{err}</div> : null}
		</div>
	);
}
