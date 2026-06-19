import { useState } from "react";
import { api } from "../services/api";

type DetectState = "idle" | "detecting" | "enabling" | "enabled";

/**
 * 「自动探测 Chrome」交互 —— 嵌在卡片预览 503(chromePath 未配置)提示区。
 *
 * 探测本机常见安装位置的 Chrome / Chromium → 展示路径 → 一键热启用卡片渲染
 * (后端运行时构造 puppeteer 并注入 live/dynamic 引擎 + 写回 bn.config.yaml,
 * 无需重启)。探测不到则回落到手动配置提示。
 */
export function ChromeAutoDetect({ onEnabled }: { onEnabled: () => void }) {
	const [state, setState] = useState<DetectState>("idle");
	const [path, setPath] = useState<string | null>(null);
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

	if (state === "enabled") {
		return (
			<div className="mt-2 rounded border border-bn-success-border bg-bn-success-soft p-2 text-[11px] font-semibold text-bn-success-text">
				✓ 卡片渲染已启用 · 已写回配置,重启仍生效
			</div>
		);
	}

	return (
		<div className="mt-2 rounded border border-bn-warning-border bg-bn-warning-soft p-2 text-[11px] text-bn-warning-text">
			<div className="mb-1.5">
				设置 <code className="font-mono">BN_CHROME_PATH</code> 环境变量或 yaml{" "}
				<code className="font-mono">chromePath</code>,或一键自动探测本机浏览器:
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={detect}
					disabled={state === "detecting"}
					className="rounded-full border border-bn-pink/40 bg-bn-pink/10 px-3 py-1 font-semibold text-bn-pink disabled:opacity-60"
				>
					{state === "detecting" ? "探测中…" : "自动探测 Chrome"}
				</button>
				{path ? (
					<>
						<code className="rounded bg-bn-code-bg px-1.5 py-0.5 font-mono text-bn-warning-text">
							{path}
						</code>
						<button
							type="button"
							onClick={enable}
							disabled={state === "enabling"}
							className="rounded-full border border-emerald-400/50 bg-bn-success-soft px-3 py-1 font-semibold text-bn-success-text disabled:opacity-60"
						>
							{state === "enabling" ? "启用中…" : "启用"}
						</button>
					</>
				) : null}
			</div>
			{notFound ? (
				<div className="mt-1.5 text-bn-warning-text">
					未在常见位置找到 Chrome / Chromium,请手动设置 chromePath 指向浏览器二进制。
				</div>
			) : null}
			{err ? <div className="mt-1.5 text-bn-danger-text">{err}</div> : null}
		</div>
	);
}
