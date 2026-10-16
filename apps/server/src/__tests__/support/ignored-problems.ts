import type { ProblemTable } from "../../problems/problem-table.js";

/**
 * 不收任何问题的问题表写口:被测的零件必须接上问题表(接线靠类型钉住),而这条测试不关心问题时用。
 * 要看问题怎么进表的,用真的 `createProblemTable`。
 */
export const ignoredProblems: Pick<ProblemTable, "report" | "resolve" | "clearReporter"> = {
	report() {},
	resolve() {},
	clearReporter() {},
};
