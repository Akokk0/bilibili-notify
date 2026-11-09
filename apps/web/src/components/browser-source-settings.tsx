import type { EnableRenderingResponse, RenderSourceResponse } from "@bilibili-notify/contract";
import { Btn, GlassBox } from "@bilibili-notify/ui";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { api } from "../services/api";
import { Field, TInput } from "./forms";

type Busy = null | "detect" | "path" | "endpoint";

/**
 * System 页「卡片渲染 · 浏览器」区 —— 展示当前渲染浏览器来源,并支持**热切换**:
 * 改本地 Chrome 路径(带自动探测)或远程端点,应用即调 POST
 * /api/cards/renderer(后端先探测新浏览器连通,通了才换、才写回 yaml;
 * 失败保持现状并回显错误)。Cards 页 `not_configured` 提示区只管「从无到有」的首次启用,
 * 启用之后的查看与切换都在这里。
 */
export function BrowserSourceSettings() {
	const tx = useT();

	const [status, setStatus] = useState<RenderSourceResponse | null>(null);
	const [path, setPath] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [busy, setBusy] = useState<Busy>(null);
	const [err, setErr] = useState<string | null>(null);
	const [okMsg, setOkMsg] = useState<"unchanged" | "applied" | null>(null);
	const [detectMiss, setDetectMiss] = useState(false);

	async function load() {
		const res = await api.get<RenderSourceResponse>("/api/cards/renderer");
		setStatus(res);
	}

	// 首载:effect 内直接调 api(不引用外层 load,躲开 exhaustive-deps 的重建陷阱)。
	useEffect(() => {
		api
			.get<RenderSourceResponse>("/api/cards/renderer")
			.then(setStatus)
			.catch((e) => setErr((e as Error).message));
	}, []);

	async function detect() {
		setBusy("detect");
		setErr(null);
		setDetectMiss(false);
		try {
			const res = await api.get<{ path: string | null }>("/api/cards/chrome");
			if (res.path) setPath(res.path);
			else setDetectMiss(true);
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function apply(kind: "path" | "endpoint") {
		const body =
			kind === "path" ? { chromePath: path.trim() } : { chromeEndpoint: endpoint.trim() };
		setBusy(kind);
		setErr(null);
		setOkMsg(null);
		try {
			// 切换不成一律是非 2xx(`api` 抛 `ApiError`,`message` 是服务端的原话),走到下一行就是成了。
			const res = await api.post<EnableRenderingResponse>("/api/cards/renderer", body);
			setOkMsg(res.alreadyEnabled ? "unchanged" : "applied");
			await load();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(null);
		}
	}

	const source = status?.source;
	const current = !status ? (
		<span className="text-bn-text-secondary">
			{tx("panelUi.components.browser-source-settings.3")}
		</span>
	) : status.enabled && source?.chromeEndpoint ? (
		<span>
			{tx("panelUi.components.browser-source-settings.4")}{" "}
			<code className="rounded-sm bg-bn-code-bg px-1.5 py-0.5 font-mono">
				{source.chromeEndpoint}
			</code>
		</span>
	) : status.enabled && source?.chromePath ? (
		<span>
			{tx("panelUi.components.browser-source-settings.5")}{" "}
			<code className="rounded-sm bg-bn-code-bg px-1.5 py-0.5 font-mono">{source.chromePath}</code>
		</span>
	) : (
		<span className="text-bn-text-secondary">
			{tx("panelUi.components.browser-source-settings.6")}
		</span>
	);

	return (
		<GlassBox
			className="@container"
			title={tx("panelUi.components.browser-source-settings.7")}
			subtitle={tx("panelUi.components.browser-source-settings.8")}
			accent={status?.enabled ? "var(--color-bn-success)" : "var(--color-bn-inactive)"}
			badge={
				status
					? status.enabled
						? tx("panelUi.components.browser-source-settings.9")
						: tx("panelUi.components.browser-source-settings.10")
					: undefined
			}
		>
			<div data-testid="browser-source-current" className="py-2.5 text-bn-sm text-bn-text-primary">
				{current}
			</div>
			{status && !status.persistable ? (
				<div className="pb-2 text-bn-xs text-bn-warning-text">
					{tx("panelUi.components.browser-source-settings.11")}
				</div>
			) : null}
			<Field
				code="chromePath"
				responsive
				label={tx("panelUi.components.browser-source-settings.12")}
				hint={tx("panelUi.components.browser-source-settings.13")}
			>
				<div className="flex w-full flex-wrap items-center gap-2">
					<TInput
						value={path}
						onChange={setPath}
						mono
						placeholder={tx("panelUi.components.browser-source-settings.14")}
						full={false}
					/>
					<Btn size="sm" variant="ghost" onClick={detect} disabled={busy === "detect"}>
						{busy === "detect"
							? tx("panelUi.components.browser-source-settings.15")
							: tx("panelUi.components.browser-source-settings.16")}
					</Btn>
					<Btn size="sm" onClick={() => apply("path")} disabled={busy === "path" || !path.trim()}>
						{busy === "path"
							? tx("panelUi.components.browser-source-settings.17")
							: tx("panelUi.components.browser-source-settings.18")}
					</Btn>
				</div>
			</Field>
			<Field
				code="chromeEndpoint"
				responsive
				label={tx("panelUi.components.browser-source-settings.19")}
				hint={tx("panelUi.components.browser-source-settings.20")}
			>
				<div className="flex w-full flex-wrap items-center gap-2">
					<TInput
						value={endpoint}
						onChange={setEndpoint}
						mono
						placeholder={tx("panelUi.components.browser-source-settings.21")}
						full={false}
					/>
					<Btn
						size="sm"
						onClick={() => apply("endpoint")}
						disabled={busy === "endpoint" || !endpoint.trim()}
					>
						{busy === "endpoint"
							? tx("panelUi.components.browser-source-settings.22")
							: tx("panelUi.components.browser-source-settings.23")}
					</Btn>
				</div>
			</Field>
			{detectMiss ? (
				<div className="pt-1.5 text-bn-xs text-bn-warning-text">
					{tx("panelUi.components.browser-source-settings.24")}
				</div>
			) : null}
			{okMsg ? (
				<div className="pt-1.5 text-bn-xs text-bn-success-text">
					✓{" "}
					{okMsg === "unchanged"
						? tx("panelUi.components.browser-source-settings.1")
						: tx("panelUi.components.browser-source-settings.2")}
				</div>
			) : null}
			{err ? <div className="pt-1.5 text-bn-xs text-bn-danger-text">{err}</div> : null}
		</GlassBox>
	);
}
