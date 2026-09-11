/**
 * 压缩包里那些**不算内容**的条目:目录项本身、macOS 打包时塞进来的 `__MACOSX/`、
 * 以及 Finder 在每个目录里留的 `.DS_Store`。
 *
 * 皮肤包与拓展包的白名单、上限、落盘各不相同,但「什么不算一个文件」是同一件事。
 * 两处分头写的话,哪天多认一种垃圾只会改到一边 —— 而另一边会把它当成**夹带文件**
 * 整包拒掉,症状只在某一类用户的机器上出现。
 */
export function isJunkZipEntry(name: string): boolean {
	return (
		name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store"
	);
}
