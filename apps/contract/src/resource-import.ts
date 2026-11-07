import type { Result } from "@bilibili-notify/internal";

/** 只读导入检查的共同摘要。各类格式仍由各自模块校验；确认时重新检查原文件。 */
export type ResourceImportPreviewResponse = Result<{
	name: string;
	warnings: string[];
	/** 已有同名项；确认会另存新身份，绝不覆盖。 */
	conflict: boolean;
}>;
