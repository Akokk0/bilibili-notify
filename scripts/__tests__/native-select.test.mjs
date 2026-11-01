import { describe, expect, it } from "vite-plus/test";
import { findNodes, listSources, parseSource, ts } from "../source-scan.mjs";

function nativeSelects(source) {
	const namespaces = new Set(),
		factories = new Set();
	for (const statement of source.ast.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			statement.moduleSpecifier.text !== "react" ||
			statement.importClause?.isTypeOnly
		)
			continue;
		const clause = statement.importClause;
		if (clause?.name) namespaces.add(clause.name.text);
		const bindings = clause?.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
		else if (bindings)
			for (const entry of bindings.elements)
				if (!entry.isTypeOnly && (entry.propertyName ?? entry.name).text === "createElement")
					factories.add(entry.name.text);
	}
	const shadowed = (node, name) => {
		for (let scope = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
			if (!ts.isBlock(scope) && !ts.isFunctionLike(scope)) continue;
			let found = false;
			const binding = (n) => {
				if (ts.isIdentifier(n)) found ||= n.text === name;
				else if (ts.isBindingPattern(n))
					for (const e of n.elements) if (ts.isBindingElement(e)) binding(e.name);
			};
			const visit = (n) => {
				if (n !== scope && (ts.isFunctionLike(n) || ts.isClassDeclaration(n))) {
					if (n.name) binding(n.name);
					return;
				}
				if (n !== scope && ts.isBlock(n)) return;
				if (ts.isVariableDeclaration(n) || ts.isParameter(n)) binding(n.name);
				ts.forEachChild(n, visit);
			};
			visit(scope);
			if (found) return true;
		}
		return false;
	};
	return findNodes(source, (node) => {
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
			return ts.isIdentifier(node.tagName) && node.tagName.text === "select";
		if (
			!ts.isCallExpression(node) ||
			!node.arguments[0] ||
			!ts.isStringLiteralLike(node.arguments[0]) ||
			node.arguments[0].text !== "select"
		)
			return false;
		const callee = node.expression;
		if (ts.isIdentifier(callee)) return factories.has(callee.text) && !shadowed(node, callee.text);
		if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
			const member = ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: ts.isStringLiteral(callee.argumentExpression)
					? callee.argumentExpression.text
					: undefined;
			return (
				member === "createElement" &&
				ts.isIdentifier(callee.expression) &&
				namespaces.has(callee.expression.text) &&
				!shadowed(node, callee.expression.text)
			);
		}
		return false;
	}).map(({ line, text }) => ({ line, text }));
}
const sample = (text) => nativeSelects(parseSource("sample.tsx", text));
describe("native select construction", () => {
	it("finds both JSX forms and genuine React constructors", () => {
		expect(
			sample(
				'import React, {createElement as h} from "react"; const a=<select />; const b=<select></select>; h("select"); React.createElement("select");',
			),
		).toHaveLength(4);
	});
	it("ignores text, comments, custom components and unrelated or shadowed factories", () => {
		expect(
			sample(
				'import React, {createElement as h} from "react"; const s="<select />"; /* <select /> */ const a=<Select />; other.createElement("select"); function f(h){h("select")}',
			),
		).toEqual([]);
	});
	it("scans the real dashboard and UI package with no allowlist", () => {
		const hits = listSources(["apps/web/src", "packages/ui/src"]).flatMap((file) =>
			nativeSelects(parseSource(file)).map((hit) => ({ file, ...hit })),
		);
		expect(hits).toEqual([]);
	});
});
