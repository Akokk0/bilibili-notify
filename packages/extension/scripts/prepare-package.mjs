import { copyFile, readFile, writeFile } from "node:fs/promises";

// workspace保留源码实际使用的私有依赖；npm发行目录只声明公开的消费依赖。
// 版本、公开入口和依赖范围均从同一份源清单生成，不维护第二份清单。
const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const {
	private: _private,
	scripts: _scripts,
	devDependencies: _devDependencies,
	publishConfig: _publishConfig,
	...manifest
} = source;
const dependencies = { ...source.dependencies };
delete dependencies["@bilibili-notify/internal"];
const target = (path) => path.replace(/^\.\/lib\//, "./");

await writeFile(
	new URL("../lib/package.json", import.meta.url),
	`${JSON.stringify(
		{
			...manifest,
			private: false,
			files: ["**/*.mjs", "**/*.d.mts", "README.md", "DEVELOPMENT.md", "LICENSE"],
			types: target(source.types),
			exports: Object.fromEntries(
				Object.entries(source.exports).map(([key, value]) => [key, target(value)]),
			),
			dependencies,
			publishConfig: { access: "public" },
		},
		null,
		"\t",
	)}\n`,
);
await copyFile(
	new URL("../README.md", import.meta.url),
	new URL("../lib/README.md", import.meta.url),
);
await copyFile(
	new URL("../DEVELOPMENT.md", import.meta.url),
	new URL("../lib/DEVELOPMENT.md", import.meta.url),
);
await copyFile(
	new URL("../../../LICENSE", import.meta.url),
	new URL("../lib/LICENSE", import.meta.url),
);
