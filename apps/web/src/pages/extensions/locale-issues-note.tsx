import type { ExtensionDTO } from "@bilibili-notify/contract";
import { Icon, WarnNote } from "@bilibili-notify/ui";
import { useT } from "../../i18n";

/**
 * 拓展详情页的「译文问题」注(ADR-0037 决策 14):拓展自带的译文里没收下的条目。每条是一句话,
 * **服务端已经按当前语言取好**(`ext.localeIssues`),这里原样列出、不再翻;只有标题是面板自己的字。
 * **有问题才出现**:没有这一格(老服务端)或是空数组都不画。
 */
export function LocaleIssuesNote({ ext }: { ext: ExtensionDTO }) {
	const t = useT();
	const issues = ext.localeIssues ?? [];
	if (issues.length === 0) return null;
	return (
		<WarnNote icon={<Icon.warning size={15} />}>
			<div className="text-bn-base font-bold tracking-tight">
				{t("extension.detail.localeIssuesTitle")}
			</div>
			<ul className="mt-1 list-disc pl-4">
				{issues.map((issue) => (
					<li key={issue}>{issue}</li>
				))}
			</ul>
		</WarnNote>
	);
}
