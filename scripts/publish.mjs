import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packagesDir = "packages";

for (const dir of readdirSync(packagesDir)) {
	const pkgPath = join(packagesDir, dir, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

	if (pkg.private) continue;

	const { name, version } = pkg;

	try {
		execSync(`npm info ${name}@${version} version`, { stdio: "pipe" });
		console.log(`Skipping ${name}@${version} (already published)`);
		continue;
	} catch {
		// not published yet
	}

	console.log(`Publishing ${name}@${version}`);
	execSync(`yarn workspace ${name} npm publish --access public`, {
		stdio: "inherit",
		env: { ...process.env, YARN_NPM_AUTH_TOKEN: process.env.NPM_TOKEN },
	});
}
