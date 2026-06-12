import { useEffect, useState } from "react";
import { dashboardApi, errorDetails } from "../api/client";
import type { DashboardBootstrap, GlobalConfig, LoginSnapshot } from "../api/types";
import { FEATURE_KEYS, FEATURE_LABELS } from "../api/types";
import {
	Badge,
	Button,
	Card,
	ConfirmButton,
	ErrorBanner,
	Field,
	Input,
	SectionGrid,
	Select,
	TextArea,
	Toggle,
} from "../components/ui";
import {
	buildGlobalsPatch,
	cloneConfig,
	isDirty,
	linesToList,
	listToLines,
	parseNumberInput,
} from "../lib/config";
import { loginQrImageSrc, loginResponseSummary } from "../lib/login";

interface SettingsTabProps {
	readonly data: DashboardBootstrap;
	readonly onData: (data: DashboardBootstrap) => void;
	readonly onReload: () => Promise<void>;
	readonly onDirty: (dirty: boolean) => void;
}

export function SettingsTab({ data, onData, onReload, onDirty }: SettingsTabProps) {
	const [draft, setDraft] = useState(() => cloneConfig(data.globals));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [login, setLogin] = useState<LoginSnapshot | undefined>(data.snapshot.business?.login);

	useEffect(() => {
		setDraft(cloneConfig(data.globals));
		setLogin(data.snapshot.business?.login);
	}, [data.globals, data.snapshot.business?.login]);

	const dirty = isDirty(data.globals, draft);
	const qrImageSrc = loginQrImageSrc(login?.data);
	const loginSummary = loginResponseSummary(login?.data);
	useEffect(() => onDirty(dirty), [dirty, onDirty]);

	const updateDraft = (mutator: (next: GlobalConfig) => void) => {
		setDraft((current) => {
			const next = cloneConfig(current);
			mutator(next);
			return next;
		});
	};

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const globals = await dashboardApi.patchGlobals(buildGlobalsPatch(draft));
			onData({ ...data, globals });
			setDraft(cloneConfig(globals));
		} catch (err) {
			setError(err);
		} finally {
			setSaving(false);
		}
	};

	const runLoginAction = async (action: () => Promise<LoginSnapshot>) => {
		setError(null);
		try {
			const next = await action();
			setLogin(next);
			await onReload();
		} catch (err) {
			setError(err);
		}
	};

	const danger = async (action: () => Promise<unknown>) => {
		setSaving(true);
		setError(null);
		try {
			await action();
			await onReload();
		} catch (err) {
			setError(err);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="grid gap-5">
			<ErrorBanner error={error} />
			<Card
				title="草稿"
				description="设置页采用 draft/save/reset；保存前不会写入 sidecar 配置。"
				action={
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => setDraft(cloneConfig(data.globals))} disabled={!dirty || saving}>
							重置草稿
						</Button>
						<Button tone="primary" onClick={() => void save()} disabled={!dirty || saving}>
							{saving ? "保存中..." : "保存设置"}
						</Button>
					</div>
				}
			>
				<div className="flex flex-wrap gap-2">
					<Badge tone={dirty ? "warn" : "success"}>{dirty ? "有未保存修改" : "已同步"}</Badge>
					<Badge>dataDir: {data.snapshot.dataDir ?? "未上报"}</Badge>
					<Badge>host: {data.snapshot.host}</Badge>
					<Badge>port: {data.snapshot.port}</Badge>
				</div>
			</Card>

			<Card
				title="Bilibili 登录"
				description="登录态由 sidecar 管理，页面只通过 Python proxy 调用登录 API。"
			>
				<div className="grid gap-4 lg:grid-cols-[1fr_auto]">
					<div className="rounded-2xl bg-white/60 p-4">
						<div className="flex flex-wrap items-center gap-2">
							<Badge tone={login?.status === 0 ? "success" : "warn"}>
								status: {login?.status ?? "unknown"}
							</Badge>
							<span className="text-bn-text-tertiary text-sm">
								{login?.msg ?? "尚未获取登录状态"}
							</span>
						</div>
						{qrImageSrc ? (
							<div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
								<img
									alt="Bilibili 登录二维码"
									className="h-44 w-44 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-black/5"
									src={qrImageSrc}
								/>
								<div className="text-bn-text-secondary text-sm">
									<div className="font-medium text-bn-text-primary">
										使用 Bilibili 手机客户端扫码登录
									</div>
									<div className="mt-1">扫码后等待页面自动刷新登录状态。</div>
								</div>
							</div>
						) : null}
						{loginSummary ? (
							<details className="mt-3 text-bn-text-secondary text-xs">
								<summary className="cursor-pointer">查看登录响应摘要</summary>
								<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-white/70 p-3 font-mono">
									{loginSummary}
								</pre>
							</details>
						) : null}
					</div>
					<div className="flex flex-wrap items-start gap-2 lg:flex-col">
						<Button onClick={() => void runLoginAction(dashboardApi.loginStatus)}>刷新状态</Button>
						<Button tone="primary" onClick={() => void runLoginAction(dashboardApi.beginLogin)}>
							开始二维码登录
						</Button>
						<Button tone="danger" onClick={() => void runLoginAction(dashboardApi.logout)}>
							退出登录
						</Button>
					</div>
				</div>
			</Card>

			<Card title="运行信息" description="启动级配置仍在 AstrBot 原生配置中维护，这里只读展示。">
				<dl className="grid gap-3 text-sm md:grid-cols-2 lg:grid-cols-4">
					<Info label="sidecar URL" value={data.snapshot.url} />
					<Info label="pid" value={String(data.snapshot.pid)} />
					<Info label="AI backend" value={data.snapshot.aiBackend} />
					<Info label="AI provider" value={data.snapshot.aiProviderId || "AstrBot 默认 Provider"} />
					<Info label="订阅文件" value={data.snapshot.business?.subscriptions.path ?? "未上报"} />
					<Info label="订阅数" value={String(data.subscriptions.length)} />
					<Info label="目标数" value={String(data.targets.length)} />
					<Info label="运行时长" value={`${Math.round(data.snapshot.uptimeMs / 1000)}s`} />
				</dl>
			</Card>

			<Card title="应用级设置">
				<SectionGrid>
					<Field label="日志等级">
						<Select
							value={draft.app.logLevel}
							onChange={(event) =>
								updateDraft((next) => {
									next.app.logLevel = event.target.value as GlobalConfig["app"]["logLevel"];
								})
							}
						>
							<option value="error">error</option>
							<option value="warn">warn</option>
							<option value="info">info</option>
							<option value="debug">debug</option>
						</Select>
					</Field>
					<Field label="动态轮询 cron">
						<Input
							value={draft.app.dynamicCron}
							onChange={(event) =>
								updateDraft((next) => {
									next.app.dynamicCron = event.target.value;
								})
							}
						/>
					</Field>
					<Field label="登录健康检查间隔（分钟）">
						<Input
							type="number"
							min={5}
							max={180}
							value={draft.app.healthCheckMinutes}
							onChange={(event) =>
								updateDraft((next) => {
									next.app.healthCheckMinutes = parseNumberInput(
										event.target.value,
										next.app.healthCheckMinutes,
									);
								})
							}
						/>
					</Field>
					<Field label="历史保留天数">
						<Input
							type="number"
							min={1}
							max={365}
							value={draft.app.historyRetentionDays}
							onChange={(event) =>
								updateDraft((next) => {
									next.app.historyRetentionDays = parseNumberInput(
										event.target.value,
										next.app.historyRetentionDays,
									);
								})
							}
						/>
					</Field>
					<Field label="日志归档保留天数">
						<Input
							type="number"
							min={1}
							max={365}
							value={draft.app.logRetentionDays}
							onChange={(event) =>
								updateDraft((next) => {
									next.app.logRetentionDays = parseNumberInput(
										event.target.value,
										next.app.logRetentionDays,
									);
								})
							}
						/>
					</Field>
					<Field label="User-Agent 覆盖" hint="留空表示使用内置默认 UA。">
						<Input
							value={draft.app.userAgent ?? ""}
							onChange={(event) =>
								updateDraft((next) => {
									next.app.userAgent = event.target.value || undefined;
								})
							}
						/>
					</Field>
					<Field label="错误私聊目标">
						<Select
							value={draft.master.targetId ?? ""}
							onChange={(event) =>
								updateDraft((next) => {
									next.master.targetId = event.target.value || undefined;
								})
							}
						>
							<option value="">不发送错误私聊</option>
							{data.targets.map((target) => (
								<option key={target.id} value={target.id}>
									{target.name}
								</option>
							))}
						</Select>
					</Field>
				</SectionGrid>
			</Card>

			<Card title="默认通知功能">
				<div className="grid gap-3 md:grid-cols-3">
					{FEATURE_KEYS.map((feature) => (
						<Toggle
							key={feature}
							label={FEATURE_LABELS[feature]}
							checked={draft.defaults.features[feature]}
							onChange={(checked) =>
								updateDraft((next) => {
									next.defaults.features[feature] = checked;
								})
							}
						/>
					))}
				</div>
			</Card>

			<Card title="过滤与推送计划">
				<SectionGrid>
					<Field label="屏蔽关键词" hint="每行或逗号分隔。">
						<TextArea
							value={listToLines(draft.defaults.filters.blockKeywords)}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.filters.blockKeywords = linesToList(event.target.value);
								})
							}
						/>
					</Field>
					<Field label="白名单关键词" hint="配置后只有命中的内容会推送。">
						<TextArea
							value={listToLines(draft.defaults.filters.whitelistKeywords)}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.filters.whitelistKeywords = linesToList(event.target.value);
								})
							}
						/>
					</Field>
					<Field label="屏蔽正则">
						<TextArea
							value={listToLines(draft.defaults.filters.blockRegex)}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.filters.blockRegex = linesToList(event.target.value);
								})
							}
						/>
					</Field>
					<Field label="白名单正则">
						<TextArea
							value={listToLines(draft.defaults.filters.whitelistRegex)}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.filters.whitelistRegex = linesToList(event.target.value);
								})
							}
						/>
					</Field>
					<Toggle
						label="过滤转发动态"
						checked={draft.defaults.filters.blockForward}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.filters.blockForward = checked;
							})
						}
					/>
					<Toggle
						label="过滤专栏动态"
						checked={draft.defaults.filters.blockArticle}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.filters.blockArticle = checked;
							})
						}
					/>
					<Toggle
						label="过滤抽奖动态"
						checked={draft.defaults.filters.blockDraw}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.filters.blockDraw = checked;
							})
						}
					/>
					<Toggle
						label="过滤 AV 号动态"
						checked={draft.defaults.filters.blockAv}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.filters.blockAv = checked;
							})
						}
					/>
					<Field label="最低 SC 价格">
						<Input
							type="number"
							min={0}
							value={draft.defaults.filters.minScPrice}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.filters.minScPrice = parseNumberInput(
										event.target.value,
										next.defaults.filters.minScPrice,
									);
								})
							}
						/>
					</Field>
					<Field label="舰长最低等级（1 总督 / 2 提督 / 3 舰长）">
						<Input
							type="number"
							min={1}
							max={3}
							value={draft.defaults.filters.minGuardLevel}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.filters.minGuardLevel = parseNumberInput(
										event.target.value,
										next.defaults.filters.minGuardLevel,
									) as 1 | 2 | 3;
								})
							}
						/>
					</Field>
					<Field label="复推间隔（小时，0 关闭）">
						<Input
							type="number"
							min={0}
							max={24}
							value={draft.defaults.schedule.pushTime}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.schedule.pushTime = parseNumberInput(
										event.target.value,
										next.defaults.schedule.pushTime,
									);
								})
							}
						/>
					</Field>
					<Toggle
						label="sidecar 重启后补推"
						checked={draft.defaults.schedule.restartPush}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.schedule.restartPush = checked;
							})
						}
					/>
				</SectionGrid>
			</Card>

			<Card title="通知内容模板">
				<SectionGrid>
					<TemplateField
						label="开播模板"
						value={draft.defaults.templates.liveStart}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.liveStart = value;
							})
						}
					/>
					<TemplateField
						label="直播中复推模板"
						value={draft.defaults.templates.liveOngoing}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.liveOngoing = value;
							})
						}
					/>
					<TemplateField
						label="下播模板"
						value={draft.defaults.templates.liveEnd}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.liveEnd = value;
							})
						}
					/>
					<TemplateField
						label="弹幕总结模板"
						value={draft.defaults.templates.liveSummary}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.liveSummary = value;
							})
						}
					/>
					<TemplateField
						label="动态模板"
						value={draft.defaults.templates.dynamic}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.dynamic = value;
							})
						}
					/>
					<TemplateField
						label="视频模板"
						value={draft.defaults.templates.dynamicVideo}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.dynamicVideo = value;
							})
						}
					/>
					<TemplateField
						label="特别弹幕模板"
						value={draft.defaults.templates.specialDanmaku}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.specialDanmaku = value;
							})
						}
					/>
					<TemplateField
						label="特别进房模板"
						value={draft.defaults.templates.specialUserEnter}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.specialUserEnter = value;
							})
						}
					/>
					<Toggle
						label="启用自定义上舰文案/图片"
						checked={draft.defaults.templates.guardBuy.enable}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.templates.guardBuy.enable = checked;
							})
						}
					/>
					<TemplateField
						label="舰长模板"
						value={draft.defaults.templates.guardBuy.captain.template}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.guardBuy.captain.template = value;
							})
						}
					/>
					<Field label="舰长图片 URL">
						<Input
							value={draft.defaults.templates.guardBuy.captain.imageUrl}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.templates.guardBuy.captain.imageUrl = event.target.value;
								})
							}
						/>
					</Field>
					<TemplateField
						label="提督模板"
						value={draft.defaults.templates.guardBuy.commander.template}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.guardBuy.commander.template = value;
							})
						}
					/>
					<Field label="提督图片 URL">
						<Input
							value={draft.defaults.templates.guardBuy.commander.imageUrl}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.templates.guardBuy.commander.imageUrl = event.target.value;
								})
							}
						/>
					</Field>
					<TemplateField
						label="总督模板"
						value={draft.defaults.templates.guardBuy.governor.template}
						onChange={(value) =>
							updateDraft((next) => {
								next.defaults.templates.guardBuy.governor.template = value;
							})
						}
					/>
					<Field label="总督图片 URL">
						<Input
							value={draft.defaults.templates.guardBuy.governor.imageUrl}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.templates.guardBuy.governor.imageUrl = event.target.value;
								})
							}
						/>
					</Field>
				</SectionGrid>
			</Card>

			<Card
				title="AI 点评"
				description="AI 默认关闭；启用后调用 AstrBot Provider 生成总结。模型由 AstrBot Provider 决定，人格（声线）由 AstrBot 人格系统提供——在插件配置里选 Provider 与默认人格即可，可在「订阅规则」为单个 UP 主单独指定人格。"
			>
				<SectionGrid>
					<Toggle
						label="启用 AI 点评"
						checked={draft.defaults.ai.enabled}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.ai.enabled = checked;
							})
						}
					/>
				</SectionGrid>
			</Card>

			<Card title="卡片与图集">
				<SectionGrid>
					<Toggle
						label="启用图片卡片"
						checked={draft.defaults.cardStyle.enabled}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.cardStyle.enabled = checked;
							})
						}
					/>
					<Toggle
						label="隐藏直播简介"
						checked={draft.defaults.cardStyle.hideDesc}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.cardStyle.hideDesc = checked;
							})
						}
					/>
					<Toggle
						label="隐藏粉丝/观看数"
						checked={draft.defaults.cardStyle.hideFollower}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.cardStyle.hideFollower = checked;
							})
						}
					/>
					<Field label="起始颜色">
						<Input
							value={draft.defaults.cardStyle.cardColorStart}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.cardStyle.cardColorStart = event.target.value;
								})
							}
						/>
					</Field>
					<Field label="结束颜色">
						<Input
							value={draft.defaults.cardStyle.cardColorEnd}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.cardStyle.cardColorEnd = event.target.value;
								})
							}
						/>
					</Field>
					<Field label="字体">
						<Input
							value={draft.defaults.cardStyle.font}
							onChange={(event) =>
								updateDraft((next) => {
									next.defaults.cardStyle.font = event.target.value;
								})
							}
						/>
					</Field>
					<Toggle
						label="动态图集附加原图"
						checked={draft.defaults.imageGroup.enable}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.imageGroup.enable = checked;
							})
						}
					/>
					<Toggle
						label="图集使用合并转发"
						checked={draft.defaults.imageGroup.forward}
						onChange={(checked) =>
							updateDraft((next) => {
								next.defaults.imageGroup.forward = checked;
							})
						}
					/>
				</SectionGrid>
			</Card>

			<Card title="危险操作" description="执行前会二次确认；这些操作直接写 sidecar 配置。">
				<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
					<ConfirmButton
						tone="danger"
						confirmText="确定恢复全局默认设置？"
						onConfirm={() => danger(dashboardApi.resetGlobals)}
						disabled={saving}
					>
						重置全局设置
					</ConfirmButton>
					<ConfirmButton
						tone="danger"
						confirmText="确定清空全部订阅？"
						onConfirm={() => danger(dashboardApi.clearSubscriptions)}
						disabled={saving}
					>
						清空订阅
					</ConfirmButton>
					<ConfirmButton
						tone="danger"
						confirmText="确定清空全部推送目标？"
						onConfirm={() => danger(dashboardApi.clearTargets)}
						disabled={saving}
					>
						清空目标
					</ConfirmButton>
					<ConfirmButton
						tone="danger"
						confirmText="确定清空所有 UP 的高级覆盖规则？"
						onConfirm={() => danger(dashboardApi.clearOverrides)}
						disabled={saving}
					>
						清空覆盖规则
					</ConfirmButton>
				</div>
				{error ? <p className="mt-3 text-red-600 text-sm">{errorDetails(error).summary}</p> : null}
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

function TemplateField({
	label,
	value,
	onChange,
}: {
	readonly label: string;
	readonly value: string;
	readonly onChange: (value: string) => void;
}) {
	return (
		<Field label={label}>
			<TextArea value={value} onChange={(event) => onChange(event.target.value)} />
		</Field>
	);
}
