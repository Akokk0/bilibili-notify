import { useEffect, useState } from "react";
import { dashboardApi } from "../api/client";
import type {
	AstrBotPushTarget,
	DashboardBootstrap,
	DeliveryResult,
	PairingCodeResult,
} from "../api/types";
import {
	Badge,
	Button,
	Card,
	ConfirmButton,
	EmptyState,
	ErrorBanner,
	Field,
	Input,
	TextArea,
} from "../components/ui";

interface TargetsTabProps {
	readonly data: DashboardBootstrap;
	readonly onData: (data: DashboardBootstrap) => void;
	readonly onReload: () => Promise<void>;
}

export function TargetsTab({ data, onData, onReload }: TargetsTabProps) {
	const [pairing, setPairing] = useState<PairingCodeResult | null>(null);
	const [names, setNames] = useState<Record<string, string>>({});
	const [testText, setTestText] = useState("来自 Bilibili Notify AstrBot Dashboard 的测试推送");
	const [lastResult, setLastResult] = useState<Record<string, DeliveryResult>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	useEffect(() => {
		setNames(Object.fromEntries(data.targets.map((target) => [target.id, target.name])));
	}, [data.targets]);

	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err);
		} finally {
			setBusy(false);
		}
	};

	const createPairingCode = () =>
		run(async () => {
			setPairing(await dashboardApi.createPairingCode());
		});

	const patchTarget = (target: AstrBotPushTarget, patch: Record<string, unknown>) =>
		run(async () => {
			const nextTarget = await dashboardApi.patchTarget(target.id, patch);
			onData({
				...data,
				targets: data.targets.map((item) => (item.id === nextTarget.id ? nextTarget : item)),
			});
			await onReload();
		});

	const deleteTarget = (target: AstrBotPushTarget) =>
		run(async () => {
			await dashboardApi.deleteTarget(target.id);
			onData({ ...data, targets: data.targets.filter((item) => item.id !== target.id) });
			await onReload();
		});

	const testPush = (target: AstrBotPushTarget) =>
		run(async () => {
			const result = await dashboardApi.pushTest(target.id, testText.trim() || "测试推送");
			setLastResult((current) => ({ ...current, [target.id]: result }));
			await onReload();
		});

	return (
		<div className="grid gap-5">
			<ErrorBanner error={error} />
			<Card
				title="配对码绑定"
				description="在 Dashboard 生成一次性配对码，然后到目标群聊/私聊执行绑定命令。"
			>
				<div className="grid gap-4 lg:grid-cols-[1fr_auto]">
					<div className="rounded-2xl bg-white/65 p-4">
						{pairing ? (
							<div>
								<div className="text-bn-text-secondary text-sm">配对码</div>
								<div className="mt-2 select-all font-bold font-mono text-3xl text-bn-pink tracking-widest">
									{pairing.code}
								</div>
								<div className="mt-2 text-bn-text-tertiary text-sm">
									过期时间：{new Date(pairing.expiresAt).toLocaleString()}
								</div>
								<pre className="mt-3 rounded-2xl bg-white/80 p-3 text-bn-text-tertiary text-sm">
									/bilibili-notify bind {pairing.code}
									{"\n"}/bn bind {pairing.code}
								</pre>
							</div>
						) : (
							<p className="text-bn-text-secondary text-sm">
								配对码只用于当前 AstrBot 会话绑定；Dashboard 不创建会话目标，也不接触 sidecar
								token。
							</p>
						)}
					</div>
					<Button tone="primary" onClick={createPairingCode} disabled={busy}>
						生成配对码
					</Button>
				</div>
			</Card>

			<Card
				title="测试推送"
				description="Dashboard 只发送 pure text 测试消息；富消息仍由真实业务链路 best-effort 投递。"
			>
				<Field label="测试文本">
					<TextArea value={testText} onChange={(event) => setTestText(event.target.value)} />
				</Field>
			</Card>

			<Card title="推送目标" description="维护 AstrBot 会话目标；目标禁用后不会出现在路由投递中。">
				{data.targets.length === 0 ? (
					<EmptyState>还没有推送目标。生成配对码并在目标会话中执行绑定命令。</EmptyState>
				) : null}
				<div className="grid gap-4">
					{data.targets.map((target) => (
						<article key={target.id} className="rounded-3xl bg-white/65 p-4 ring-1 ring-black/5">
							<header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
								<div>
									<div className="flex flex-wrap items-center gap-2">
										<h3 className="font-semibold text-lg">{target.name}</h3>
										<Badge tone={target.enabled ? "success" : "neutral"}>
											{target.enabled ? "启用" : "停用"}
										</Badge>
										<Badge>{target.scope}</Badge>
									</div>
									<div className="mt-1 text-bn-text-secondary text-sm">
										{target.session.sessionName ||
											target.session.sessionId ||
											target.session.unified_msg_origin}
									</div>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => patchTarget(target, { enabled: !target.enabled })}
										disabled={busy}
									>
										{target.enabled ? "停用" : "启用"}
									</Button>
									<Button
										tone="primary"
										onClick={() => testPush(target)}
										disabled={busy || !target.enabled}
									>
										测试推送
									</Button>
									<ConfirmButton
										tone="danger"
										confirmText={`确定删除目标 ${target.name}？`}
										onConfirm={() => deleteTarget(target)}
										disabled={busy}
									>
										删除
									</ConfirmButton>
								</div>
							</header>
							<div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
								<Field label="目标名称">
									<Input
										value={names[target.id] ?? target.name}
										onChange={(event) =>
											setNames((current) => ({ ...current, [target.id]: event.target.value }))
										}
									/>
								</Field>
								<Button
									onClick={() =>
										patchTarget(target, {
											name: (names[target.id] ?? target.name).trim() || target.name,
										})
									}
									disabled={busy || (names[target.id] ?? target.name) === target.name}
								>
									保存名称
								</Button>
							</div>
							<dl className="mt-4 grid gap-2 text-sm md:grid-cols-3">
								<Info label="platform" value={target.session.platform ?? "未上报"} />
								<Info label="message type" value={target.session.messageType ?? "未上报"} />
								<Info label="session id" value={target.session.sessionId ?? "未上报"} />
							</dl>
							{lastResult[target.id] ? (
								<div className="mt-3 rounded-2xl bg-white/70 p-3 text-sm">
									<Badge tone={lastResult[target.id]?.ok ? "success" : "danger"}>
										{lastResult[target.id]?.ok ? "测试成功" : "测试失败"}
									</Badge>
									<span className="ml-2 text-bn-text-secondary">
										{lastResult[target.id]?.err ?? `latency ${lastResult[target.id]?.latencyMs}ms`}
									</span>
								</div>
							) : null}
						</article>
					))}
				</div>
			</Card>
		</div>
	);
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
	return (
		<div className="rounded-2xl bg-white/60 p-3">
			<dt className="text-bn-text-secondary text-xs">{label}</dt>
			<dd className="mt-1 break-all font-medium text-bn-text-primary">{value}</dd>
		</div>
	);
}
