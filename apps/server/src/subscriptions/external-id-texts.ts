/**
 * 外部 id 格式不对时回给面板的话,集中在这里,逻辑里不写整句(之后改字只动这一个文件)。
 *
 * 点名用来源描述符的 `label`:核心不知道哪个平台的 id 叫什么、长什么样,只说「这个来源认的写法」。
 */
export const EXTERNAL_ID_TEXTS = {
	/** 整条失败的话(`Failure.message`)。 */
	mismatch: (label: string): string => `${label}的外部 id 格式不对，没法新建订阅`,
	/** 指到 `identity.externalId` 的那一条细节。 */
	mismatchIssue: (label: string): string => `这个 id 不是${label}认的写法`,
};
