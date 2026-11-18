/**
 * 「装完那句话」—— 传包装与从市场装**共用**这一块(装完的回答是同一个形状)。
 *
 * 三种结局的出路完全不同:热装好了(什么都不用做)、盖掉了一份这个进程跑过的(新版等着换上,
 * 出口有两个 —— 重启 BN 或只重载这个拓展,ADR-0012 决策 47)、装失败(原因由调用方另行摆出来,
 * 不在这里)。
 *
 * ⛔ **那颗重启按钮只在确实需要它的这件事旁边出现**(ADR-0005 决策 22):面板上没有常驻的重启
 * 入口 —— 重启是**刚做完这件事**的后果,不是一个随时可按的动作。这台机器上按了回不来
 * (开发版 / 裸跑)就不给按钮,但要把原因写出来。那一整块与详情页头卡共用(`StagedCodeNote`)。
 */

import type { ExtensionInstallResponse } from "@bilibili-notify/contract";
import { Btn, HintNote, MonoChip, WarnNote } from "@bilibili-notify/ui";
import { useNavigate } from "react-router-dom";
import { DEFAULT_RESTART_WAIT, type RestartWait } from "../../components/update/restart";
import { useT } from "../../i18n";
import { StagedCodeNote } from "./staged-code-note";

function DocsButton({ done }: { done: ExtensionInstallResponse }) {
	const t = useT();
	const navigate = useNavigate();
	// 旧服务端可能省略 docs。文档是否存在以安装响应为准。
	const docs = done.docs;
	if (!docs || (!docs.readme && !docs.changelog)) return null;

	const tab = docs.readme && !(done.staged && docs.changelog) ? "readme" : "changelog";
	const label =
		tab === "readme"
			? t("panelUi.pages.extensions.install-outcome.2")
			: done.staged
				? t("panelUi.pages.extensions.install-outcome.1")
				: t("panelUi.pages.extensions.install-outcome.3");
	return (
		<span className="shrink-0 self-start">
			<Btn
				size="sm"
				variant="outline"
				onClick={() => navigate(`/extensions/${encodeURIComponent(done.id)}?tab=${tab}`)}
			>
				{label}
			</Btn>
		</span>
	);
}

export interface ExtensionInstallOutcomeProps {
	done: ExtensionInstallResponse | null;
	/** 等待参数,只有测试会给。 */
	wait?: RestartWait;
}

/**
 * 包里被跳过的语言文件(ADR-0037 决策 14):长得像语言码、BN 语言表里却没有的 `locales/*.json`,
 * 照装但没写进盘 —— 装的人得知道,否则他会以为那份译文在用。**有才出现**,三种结局都可能带。
 */
function SkippedLocalesNote({ done }: { done: ExtensionInstallResponse }) {
	const t = useT();
	// 🔴 契约里这一格是**可选**的(老服务端没有),缺了与空数组一样:不画。
	const files = done.skippedLocales ?? [];
	if (files.length === 0) return null;
	return (
		<WarnNote size="sm">
			<div>{t("extension.install.skippedLocales")}</div>
			<ul className="mt-1 flex flex-wrap gap-1.5">
				{files.map((file) => (
					<li key={file}>
						<MonoChip>{file}</MonoChip>
					</li>
				))}
			</ul>
		</WarnNote>
	);
}

export function ExtensionInstallOutcome(props: ExtensionInstallOutcomeProps) {
	if (!props.done) return null;
	return (
		<>
			<InstallOutcomeBody {...props} />
			<SkippedLocalesNote done={props.done} />
		</>
	);
}

function InstallOutcomeBody({ done, wait = DEFAULT_RESTART_WAIT }: ExtensionInstallOutcomeProps) {
	const tx = useT();

	if (!done) return null;
	/*
	 * 🔴 老服务端(应用内自更新那几秒)回的是 `needsRestart` 而没有 `staged` —— 缺了就落到
	 * 「装好了」那一句,不去读它没给的东西。少一块提示是小事,整块炸掉是大事。
	 */
	if (done.staged && !done.enabled) {
		/*
		 * 关着装进去的,而这个进程跑过它别的代码(决策 47):拨开也只会停在「新版等着换上」。
		 * 现在就说,但**不给**那两颗钮 —— 「只重载」只在开着时给(按下去等于替主人把开关拨开),
		 * 重启指去它那一页(那一行也带着 `staged`,头卡里有同一块)。
		 */
		return (
			<HintNote tone="neutral" className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span>
					<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
					{tx("panelUi.pages.extensions.install-outcome.4")}
				</span>
				<DocsButton done={done} />
			</HintNote>
		);
	}
	if (done.staged) {
		return (
			<StagedCodeNote
				id={done.id}
				name={done.name}
				stagedVersion={done.version}
				// 走到这儿的都开着(关着的上面那一支接走了)—— 只重载给。
				swappable
				restart={done.restart}
				wait={wait}
			>
				{/* 排在两条出路之后:先看见要做的那件事,再看见可以顺便读的那份。 */}
				<DocsButton done={done} />
			</StagedCodeNote>
		);
	}
	return (
		<HintNote
			tone={done.enabled ? "success" : "neutral"}
			className="flex flex-wrap items-center gap-x-2 gap-y-1"
		>
			<span>
				<strong className="text-bn-text-secondary">{done.name}</strong> {done.version}{" "}
				{done.enabled
					? tx("panelUi.pages.extensions.install-outcome.5")
					: tx("panelUi.pages.extensions.install-outcome.6")}
			</span>
			<DocsButton done={done} />
		</HintNote>
	);
}
