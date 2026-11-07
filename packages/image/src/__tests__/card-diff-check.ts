/**
 * 守卫 10 的「批准的像素差清单」(ADR-0028 决策 2)的形状与判官。清单本身在
 * `approved-card-diffs.ts`,接线在 `card-baseline.test.ts`。
 *
 * 文件快照(`toMatchFileSnapshot`)给人看**哪里变了**,但 `-u` 一跑就悄悄换了标尺。清单
 * 钉的是**哪份字节是批准过的**:每个样例从起点出发,往后每次出图变化都得在清单末尾记一条
 * 「样例、变化、类别、依据」并带上新字节的 hash —— 光 `-u` 不补清单,这里照样红。
 */

import { createHash } from "node:crypto";
import type { Issue } from "@bilibili-notify/internal";

/**
 * 预批的三类(ADR-0028 决策 2):平台叫法中立化、内联 SVG 换成图库图的残差、B 站纯装饰去掉。
 * 三类之外的变化要主人点过头,记成 `master-approved` 并写明在哪定的、哪天定的。
 */
type PreApprovedCategory =
	| "platform-neutral-naming"
	| "library-image-residue"
	| "bili-decoration-removed";

interface ApprovedCardDiffBase {
	/** 样例名,即夹具的 `name`(快照文件 `__snapshots__/card-baseline/<sample>.html`)。 */
	readonly sample: string;
	/** 卡上看得出的变化,一句话。 */
	readonly change: string;
	/** 为什么允许:哪份 ADR / 文档、哪一片。 */
	readonly basis: string;
	/** 变化之后整份 HTML 的 {@link cardHtmlHash}。 */
	readonly hash: string;
}

type ApprovedCardDiffEntry =
	| (ApprovedCardDiffBase & { readonly category: PreApprovedCategory })
	| (ApprovedCardDiffBase & { readonly category: "master-approved"; readonly approvedOn: string });

export interface CardDiffList {
	/** 起点:清单开张那天每个样例的 hash。新加的夹具也在这里补一行。 */
	readonly baseline: Readonly<Record<string, string>>;
	/** 起点之后批准的变化,只往末尾追加;同一样例认最后一条。 */
	readonly approvals: readonly ApprovedCardDiffEntry[];
}

/** 一份出图 HTML 的指纹:sha256 取前 16 位十六进制,够分辨、在清单里也读得下去。 */
export function cardHtmlHash(html: string): string {
	return createHash("sha256").update(html).digest("hex").slice(0, 16);
}

function approvedHashOf(sample: string, list: CardDiffList): string | undefined {
	for (let i = list.approvals.length - 1; i >= 0; i--) {
		const entry = list.approvals[i];
		if (entry?.sample === sample) return entry.hash;
	}
	return list.baseline[sample];
}

/** 这个样例此刻画出来的字节,是不是清单批准的那一份。 */
export function cardDiffIssues(sample: string, hash: string, list: CardDiffList): Issue[] {
	const approved = approvedHashOf(sample, list);
	if (approved === undefined) {
		return [
			{
				path: [sample],
				message:
					`样例「${sample}」不在清单里(现在画出来是 ${hash})。新加的夹具:在 approved-card-diffs.ts ` +
					`的 baseline 里补一行 "${sample}": "${hash}"。`,
			},
		];
	}
	if (approved === hash) return [];
	return [
		{
			path: [sample],
			message:
				`样例「${sample}」的出图字节变了:现在是 ${hash},清单最后批准的是 ${approved}。先看快照的 diff ` +
				"确认变化是想要的;是的话在 approved-card-diffs.ts 的 approvals 末尾加一条 " +
				`{ sample: "${sample}", category, change, basis, hash: "${hash}" }` +
				"(三类预批之外的写 master-approved 加 approvedOn)。",
		},
	];
}

/** 清单里点名、夹具里却已经没有的样例 —— 改名、删夹具、打错字都会留下这种死条目。 */
export function orphanedCardDiffIssues(samples: readonly string[], list: CardDiffList): Issue[] {
	const known = new Set(samples);
	const issues: Issue[] = [];
	for (const sample of Object.keys(list.baseline)) {
		if (!known.has(sample)) {
			issues.push({
				path: ["baseline", sample],
				message: `起点里的样例「${sample}」已经没有对应的夹具`,
			});
		}
	}
	list.approvals.forEach((entry, i) => {
		if (!known.has(entry.sample)) {
			issues.push({
				path: ["approvals", i],
				message: `第 ${i} 条批准的样例「${entry.sample}」已经没有对应的夹具`,
			});
		}
	});
	return issues;
}
