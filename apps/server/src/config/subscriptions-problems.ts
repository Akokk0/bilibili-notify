import { t } from "../i18n/index.js";
import type { ProblemTable } from "../problems/problem-table.js";

/** Only a count crosses the raw subscription ledger boundary. */
export function syncSubscriptionsProblem(problems: ProblemTable, count: number): void {
	const key = { reporter: "core", code: "subscriptions_invalid" };
	if (count === 0) {
		problems.resolve(key, { notify: false });
		return;
	}
	problems.report({ ...key, message: () => t("config.subscriptions.invalid", { count }) });
}
