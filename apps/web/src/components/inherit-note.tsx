import { useT } from "../i18n";
/**
 * 覆盖开关关闭时的那行「未启用 · …」说明 —— 与设计稿一致。
 * 收编前 Cards(InheritNote)与 rules/SubscriptionRulesEditor(InheritHint)各抄一份,
 * 逐字符只差 `py-6`/`py-5`;合并取多数派 py-5,「未启用 · 」前缀由组件出。
 */

import type { ReactNode } from "react";

export function InheritNote({ children }: { children: ReactNode }) {
	const tx = useT();

	return (
		<div className="py-5 text-center text-bn-sm text-bn-text-tertiary">
			{tx("panelUi.components.inherit-note.1")}
			{children}
		</div>
	);
}
