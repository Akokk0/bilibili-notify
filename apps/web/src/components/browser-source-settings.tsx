import type { RenderSourceResponse } from "@bilibili-notify/contract";
import { useEffect, useState } from "react";
import { api } from "../services/api";
import { Btn } from "./atoms";
import { Field, TInput } from "./forms";
import { GlassBox } from "./glass-box";

type Busy = null | "detect" | "path" | "endpoint";

/**
 * System 页「卡片渲染 · 浏览器」区 —— 展示当前渲染浏览器来源,并支持**热切换**:
 * 改本地 Chrome 路径(带自动探测)或远程端点,应用即调 POST
 * /api/cards/enable-rendering(后端先探测新浏览器连通,通了才换、才写回 yaml;
 * 失败保持现状并回显错误)。Cards 页 503 提示区只管「从无到有」的首次启用,
 * 启用之后的查看与切换都在这里。
 */
export function BrowserSourceSettings() {
	const [status, setStatus] = useState<RenderSourceResponse | null>(null);
	const [path, setPath] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [busy, setBusy] = useState<Busy>(null);
	const [err, setErr] = useState<string | null>(null);
	const [okMsg, setOkMsg] = useState<string | null>(null);
	const [detectMiss, setDetectMiss] = useState(false);

	async function load() {
		const res = await api.get<RenderSourceResponse>("/api/cards/render-source");
		setStatus(res);
	}

	// 首载:effect 内直接调 api(不引用外层 load,躲开 exhaustive-deps 的重建陷阱)。
	useEffect(() => {
		api
			.get<RenderSourceResponse>("/api/cards/render-source")
			.then(setStatus)
			.catch((e) => setErr((e as Error).message));
	}, []);

	async function detect() {
		setBusy("detect");
		setErr(null);
		setDetectMiss(false);
		try {
			const res = await api.get<{ path: string | null }>("/api/cards/detect-chrome");
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
			const res = await api.post<{ ok: boolean; alreadyEnabled?: boolean; err?: string }>(
				"/api/cards/enable-rendering",
				body,
			);
			if (!res.ok) throw new Error(res.err ?? "切换失败");
			setOkMsg(res.alreadyEnabled ? "已是当前配置,无需切换" : "已生效");
			await load();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(null);
		}
	}

	const source = status?.source;
	const current = !status ? (
		<span className="text-bn-text-secondary">加载中…</span>
	) : status.enabled && source?.chromeEndpoint ? (
		<span>
			远程浏览器{" "}
			<code className="rounded bg-bn-code-bg px-1.5 py-0.5 font-mono">{source.chromeEndpoint}</code>
		</span>
	) : status.enabled && source?.chromePath ? (
		<span>
			本地浏览器{" "}
			<code className="rounded bg-bn-code-bg px-1.5 py-0.5 font-mono">{source.chromePath}</code>
		</span>
	) : (
		<span className="text-bn-text-secondary">未启用 —— 卡片渲染当前退化为文字推送</span>
	);

	return (
		<GlassBox
			title="卡片渲染 · 浏览器"
			subtitle="chromePath / chromeEndpoint · 应用即热切换,先探测连通再生效"
			accent={status?.enabled ? "#22c55e" : "#94a3b8"}
			badge={status ? (status.enabled ? "已启用" : "未启用") : undefined}
		>
			<div
				data-testid="browser-source-current"
				className="py-2.5 text-[12.5px] text-bn-text-primary"
			>
				{current}
			</div>
			{status && !status.persistable ? (
				<div className="pb-2 text-[11px] text-bn-warning-text">
					当前部署没有可写的配置文件:切换即时生效,但重启后不保留(请改用环境变量 / yaml)。
				</div>
			) : null}
			<Field code="chromePath" label="本地浏览器路径" hint="Chrome / Chromium 可执行文件绝对路径">
				<div className="flex w-full flex-wrap items-center gap-2">
					<TInput
						value={path}
						onChange={setPath}
						mono
						placeholder="/usr/bin/chromium 等 Chrome 路径"
						full={false}
					/>
					<Btn size="sm" variant="ghost" onClick={detect} disabled={busy === "detect"}>
						{busy === "detect" ? "探测中…" : "自动探测"}
					</Btn>
					<Btn size="sm" onClick={() => apply("path")} disabled={busy === "path" || !path.trim()}>
						{busy === "path" ? "应用中…" : "应用本地路径"}
					</Btn>
				</div>
			</Field>
			<Field
				code="chromeEndpoint"
				label="远程浏览器端点"
				hint="ws:// 直连 browserless 等;http:// 为 chromium remote-debugging 端点。slim 镜像用这个"
			>
				<div className="flex w-full flex-wrap items-center gap-2">
					<TInput
						value={endpoint}
						onChange={setEndpoint}
						mono
						placeholder="ws://browser:3000?token=… 或 http://host:9222"
						full={false}
					/>
					<Btn
						size="sm"
						onClick={() => apply("endpoint")}
						disabled={busy === "endpoint" || !endpoint.trim()}
					>
						{busy === "endpoint" ? "应用中…" : "应用远程端点"}
					</Btn>
				</div>
			</Field>
			{detectMiss ? (
				<div className="pt-1.5 text-[11px] text-bn-warning-text">
					未在常见位置找到 Chrome / Chromium,请手动填写路径。
				</div>
			) : null}
			{okMsg ? <div className="pt-1.5 text-[11px] text-bn-success-text">✓ {okMsg}</div> : null}
			{err ? <div className="pt-1.5 text-[11px] text-bn-danger-text">{err}</div> : null}
		</GlassBox>
	);
}
