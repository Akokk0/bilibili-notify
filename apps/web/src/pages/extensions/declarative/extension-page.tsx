import type { ExtensionDTO, ExtensionScalarField } from "@bilibili-notify/contract";
import { ErrorNote, HintNote, Icon, StatusDot, WarnNote } from "@bilibili-notify/ui";
import { reasonOf } from "../shared";
import { Blocks, TONE_DOT } from "./blocks";
import { RichText } from "./rich-text";
import { SettingsForm } from "./settings-form";
import { useExtensionView } from "./view-query";

/**
 * v2 拓展那一页里「照声明画」的三块(ADR-0019 决策 19 / 25):头卡正文(页级积木)、「配置」
 * 页签(设置表单)、拓展列表上那一行(`summary`)。三块读的是**同一个**状态查询 —— 键相同,
 * react-query 只问一次,WS 那条失效也一次刷新三处。
 *
 * **只在「开着且跑着」时问状态**:关着的问了也是 404;没跑起来的(加载失败 / 自动停用 / 版本
 * 不合)同理,而那两件事拓展表里的 `state` 已经说清楚了,用不着再拿一次 404 去猜。
 */
function isRunning(ext: ExtensionDTO): boolean {
	return ext.enabled && ext.state === "running";
}

/** 这一发失败是不是 404 —— 面板的 `ApiError` 带着状态码。 */
function isNotFound(err: unknown): boolean {
	return (err as { status?: unknown } | null)?.status === 404;
}

/** 清单里声明的设置项(没在跑的也有,决策 17)。 */
export function settingsFieldsOf(ext: ExtensionDTO) {
	return ext.settings?.fields ?? [];
}

/**
 * 头卡正文里的页级积木(决策 25)。
 *
 * 跑着却 404 = **还没交过视图**(只有设置项的拓展一辈子都这样),不是出错,什么都不画;别的
 * 失败(断网 / 500)把原话摆出来 —— 那一块本来该有东西,空着不说等于说「一切正常」。
 */
export function DeclarativeHead({ ext }: { ext: ExtensionDTO }) {
	const running = isRunning(ext);
	const view = useExtensionView(ext.id, running);
	if (!running) return null;
	if (view.isError) {
		if (isNotFound(view.error)) return null;
		return <ErrorNote size="sm">读不到它现在的状态:{reasonOf(view.error)}</ErrorNote>;
	}
	const page = view.data?.page;
	if (!Array.isArray(page) || page.length === 0) return null;
	// 页级积木没有「列表头」可挂图例,有三态列的表自己挂一次(决策 27)。
	return <Blocks blocks={page} extensionId={ext.id} legend />;
}

/**
 * 「配置」页签的正文:一条说明拓展现在处境的提示 + 设置表单。
 *
 * 🔴 **关着也画表单、也能存**(决策 32):设置只是存着的数据,关着时改了什么都不会发生,
 * 打开时拓展才读 —— 「装好 → 填 → 启用」这个顺序靠它才走得通。今天桥「关着就压暗、不给
 * 按钮」那一档随之退役。
 */
export function DeclarativeConfig({ ext }: { ext: ExtensionDTO }) {
	const fields = settingsFieldsOf(ext);
	const scalar = fields.filter((field): field is ExtensionScalarField => field.type !== "list");
	return (
		<>
			<RunStateNote ext={ext} />
			{scalar.length > 0 ? <SettingsForm extensionId={ext.id} fields={scalar} /> : null}
			{/*
			 * 列表设置项(`type: "list"`:每项一张卡、新建弹窗、删除 / 重新生成的确认、项上的视图与
			 * 「停用 / 启用」,决策 21 / 26 / 29)接在这里 —— 施工第二步。它们不进上面那张表单:
			 * 表单是「改完按保存」,列表是「每一下都当场写回」。
			 */}
		</>
	);
}

/**
 * 关着与没跑起来**分开说**:两者都没有状态,但要主人做的事正相反 —— 前者是他自己刚拨的开关,
 * 后者要去查日志。
 */
function RunStateNote({ ext }: { ext: ExtensionDTO }) {
	if (!ext.enabled) {
		return (
			<WarnNote size="sm" className="flex gap-[9px] leading-[1.7]">
				<Icon.warning size={15} className="mt-px shrink-0" />
				<div>
					<strong className="font-bold">拓展关着,它现在什么都不做。</strong>
					下面的设置照样能改,打开拓展之后生效;连接状态要等它跑起来才看得到。
				</div>
			</WarnNote>
		);
	}
	if (ext.state !== "running") {
		return (
			<HintNote className="leading-[1.65]">
				这个拓展现在没跑起来,底下只有设置、没有状态 —— 去日志里看它为什么没起来。
			</HintNote>
		);
	}
	return null;
}

/**
 * 拓展列表那张卡上的一行(决策 25):今天那句「N 个 bot 在线」是面板专为桥写的,v2 由视图的
 * `summary` 交。数不出来(关着 / 没跑 / 没交)就不说 —— 一个假装是 0 的数字比没有更糟。
 *
 * `divider`:它跟在「N 条连接」后面时要一根竖线隔开;`standalone`:没有那一行(订阅源)时
 * 自己撑起一行。
 */
export function ExtensionSummary({
	ext,
	divider = false,
	standalone = false,
}: {
	ext: ExtensionDTO;
	divider?: boolean;
	standalone?: boolean;
}) {
	const running = isRunning(ext);
	const view = useExtensionView(ext.id, running);
	const summary = running ? view.data?.summary : undefined;
	if (!summary) return null;
	const line = (
		<>
			{divider ? <span className="h-4 w-px bg-bn-border-subtle" /> : null}
			<div className="flex items-center gap-1.5">
				{summary.tone ? <StatusDot kind={TONE_DOT[summary.tone]} /> : null}
				<span className="text-bn-xs text-bn-text-secondary">
					<RichText text={summary.text} extensionId={ext.id} />
				</span>
			</div>
		</>
	);
	return standalone ? <div className="flex items-center gap-3.5 pt-0.5">{line}</div> : line;
}
