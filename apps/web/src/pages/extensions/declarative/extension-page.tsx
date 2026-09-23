import type {
	ExtensionDTO,
	ExtensionField,
	ExtensionListField,
	ExtensionScalarField,
} from "@bilibili-notify/contract";
import { ErrorNote, HintNote, Icon, StatusDot, WarnNote } from "@bilibili-notify/ui";
import { reasonOf } from "../shared";
import { Blocks, TONE_DOT } from "./blocks";
import { ListSection } from "./list-section";
import { RichText } from "./rich-text";
import { SettingsForm } from "./settings-form";
import { isNotFound, isRunning, liveViewOf, useExtensionView } from "./view-query";

/**
 * v2 拓展那一页里「照声明画」的几块(ADR-0019 决策 19 / 25):头卡正文(页级积木)、「配置」
 * 页签(设置表单 + 列表)、拓展列表上那一行(`summary`)。它们读的是**同一个**状态查询 ——
 * 键相同,react-query 只问一次,WS 那条失效也一次刷新各处。什么时候问、404 算什么,见
 * `view-query.ts`。
 */

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
	const page = liveViewOf(running, view)?.page;
	if (!Array.isArray(page) || page.length === 0) return null;
	// 页级积木没有「列表头」可挂图例,有三态列的表自己挂一次(决策 27)。
	return <Blocks blocks={page} extensionId={ext.id} legend />;
}

/**
 * 「配置」页签的正文:一条说明拓展现在处境的提示 + 设置表单与列表。
 *
 * 🔴 **关着也画表单与列表、也能存**(决策 32):设置只是存着的数据,关着时改了什么都不会
 * 发生,打开时拓展才读 —— 「装好 → 填 → 启用」这个顺序靠它才走得通。今天桥「关着就压暗成
 * 一行一条、不给按钮」那一档随之退役。
 */
export function DeclarativeConfig({ ext }: { ext: ExtensionDTO }) {
	return (
		<>
			<RunStateNote ext={ext} />
			{configGroupsOf(settingsFieldsOf(ext)).map((group) =>
				group.kind === "list" ? (
					<ListSection key={`list:${group.field.key}`} ext={ext} field={group.field} />
				) : (
					<SettingsForm
						key={`form:${group.fields[0]?.key}`}
						extensionId={ext.id}
						fields={group.fields}
					/>
				),
			)}
		</>
	);
}

/**
 * 「配置」页签照声明的**顺序**摆:挨着的单值格并进一张设置卡,每格列表自成一节。
 *
 * 列表不进那张表单:表单是「改完按保存」,列表是「每一下都当场写回」(新建 / 删除 / 停用各是
 * 一发)—— 塞进同一张卡,主人分不清哪些改动还等着「保存」。顺序照清单,不把列表统一挪到最后:
 * 拓展把哪一格写在前面,是它在说「先填这个」。
 */
type ConfigGroup =
	| { kind: "form"; fields: ExtensionScalarField[] }
	| { kind: "list"; field: ExtensionListField };

function configGroupsOf(fields: readonly ExtensionField[]): ConfigGroup[] {
	const groups: ConfigGroup[] = [];
	for (const field of fields) {
		if (field.type === "list") {
			groups.push({ kind: "list", field });
			continue;
		}
		const last = groups[groups.length - 1];
		if (last?.kind === "form") last.fields.push(field);
		else groups.push({ kind: "form", fields: [field] });
	}
	return groups;
}

/**
 * 关着与没跑起来**分开说**:两者都没有状态,但要主人做的事正相反 —— 前者是他自己刚拨的开关,
 * 后者要去查日志。
 */
function RunStateNote({ ext }: { ext: ExtensionDTO }) {
	if (!ext.enabled) {
		return (
			<WarnNote size="sm" icon={<Icon.warning size={15} />} className="leading-[1.7]">
				<strong className="font-bold">拓展关着,它现在什么都不做。</strong>
				下面的设置照样能改,打开拓展之后生效;连接状态要等它跑起来才看得到。
			</WarnNote>
		);
	}
	/*
	 * 新版等着换上(ADR-0012 决策 47):同样没有状态,但原因不在日志里 —— 是这个进程换不上盘上
	 * 那份代码,怎么换就在头卡里。说「去日志里看」等于把人支走。
	 */
	if (ext.state === "staged") {
		return (
			<HintNote className="leading-[1.65]">
				新版装好了还没换上,底下只有设置、没有状态 —— 怎么换在上面那张卡里。
			</HintNote>
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
	// 状态那一口出错(404 也算)时,缓存里那句是出错之前的数 —— 与头卡、列表那一节同一把尺子。
	const summary = liveViewOf(running, view)?.summary;
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
