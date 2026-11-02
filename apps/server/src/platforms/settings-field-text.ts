/** 元数据在导出描述时取字,不会把启动时的语言冻结在规则里。 */
export function fieldText(
	read: () => { label: string; description?: string },
	extra: Record<string, unknown> = {},
) {
	return Object.defineProperties(
		{
			get label() {
				return read().label;
			},
			get description() {
				return read().description;
			},
		},
		Object.getOwnPropertyDescriptors(extra),
	);
}
