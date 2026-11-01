import { dirname, resolve } from "node:path";
import { ts } from "./source-scan.mjs";

/** Binding/value analysis local to the platform-decision guard; never trusts type names. */
export function descriptorFlow(sources, rootPath) {
	const files = new Map(sources.map((source) => [resolve(source.path), source.ast]));
	const host = {
		fileExists: (path) => files.has(resolve(path)),
		readFile: (path) => files.get(resolve(path))?.text,
		getSourceFile: (path) => files.get(resolve(path)),
		getDefaultLibFileName: () => "",
		writeFile() {},
		getCurrentDirectory: () => process.cwd(),
		getDirectories: () => [],
		getCanonicalFileName: (path) => path,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		resolveModuleNames: (names, containing) =>
			names.map((name) => {
				if (!name.startsWith(".")) return undefined;
				const base = resolve(dirname(containing), name);
				const path = [
					base,
					`${base}.ts`,
					`${base}.tsx`,
					`${base}.mjs`,
					resolve(base, "index.ts"),
					resolve(base, "index.tsx"),
				].find((candidate) => files.has(candidate));
				return path
					? {
							resolvedFileName: path,
							extension: path.endsWith(".tsx") ? ts.Extension.Tsx : ts.Extension.Ts,
						}
					: undefined;
			}),
	};
	const program = ts.createProgram(
		[...files.keys()],
		{ noLib: true, allowJs: true, target: ts.ScriptTarget.Latest },
		host,
	);
	const checker = program.getTypeChecker();
	const unwrapped = (node) => {
		while (
			node &&
			(ts.isParenthesizedExpression(node) ||
				ts.isAsExpression(node) ||
				ts.isNonNullExpression(node) ||
				ts.isSatisfiesExpression(node) ||
				ts.isTypeAssertionExpression(node))
		)
			node = node.expression;
		return node;
	};
	const symbolOf = (node) => {
		let symbol = checker.getSymbolAtLocation(node);
		const seen = new Set();
		while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
			seen.add(symbol);
			symbol = checker.getAliasedSymbol(symbol);
		}
		return symbol;
	};
	const callable = (node) => {
		const target = unwrapped(node);
		if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target;
		const declaration = symbolOf(target)?.valueDeclaration;
		if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
		if (
			declaration &&
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer &&
			declaration.parent.flags & ts.NodeFlags.Const
		) {
			const init = unwrapped(declaration.initializer);
			if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
		}
		return undefined;
	};
	const calls = new Map();
	const props = new Map();
	const writes = new Set();
	const aliases = new Map();
	const functions = [];
	const recordWrite = (node) => {
		let written = unwrapped(node);
		while (ts.isPropertyAccessExpression(written) || ts.isElementAccessExpression(written))
			written = unwrapped(written.expression);
		const symbol = symbolOf(written);
		if (symbol) writes.add(symbol);
	};
	const visit = (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.parent.flags & ts.NodeFlags.Const &&
			node.initializer &&
			ts.isIdentifier(unwrapped(node.initializer))
		) {
			const symbol = symbolOf(node.name);
			const original = symbolOf(unwrapped(node.initializer));
			if (symbol && original) {
				aliases.set(symbol, new Set([...(aliases.get(symbol) ?? []), original]));
				aliases.set(original, new Set([...(aliases.get(original) ?? []), symbol]));
			}
		}
		if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
			functions.push(node);
		if (ts.isCallExpression(node)) {
			const fn = callable(node.expression);
			if (fn) calls.set(fn, [...(calls.get(fn) ?? []), node]);
		}
		if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
			const fn = callable(node.tagName);
			if (fn) props.set(fn, [...(props.get(fn) ?? []), node.attributes]);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		)
			recordWrite(node.left);
		if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
			if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
				recordWrite(node.operand);
		}
		if (ts.isDeleteExpression(node)) recordWrite(node.expression);
		ts.forEachChild(node, visit);
	};
	for (const source of files.values()) visit(source);
	// A write through any immutable alias invalidates the shared object in both directions.
	const pendingWrites = [...writes];
	for (const symbol of pendingWrites) {
		for (const alias of aliases.get(symbol) ?? []) {
			if (writes.has(alias)) continue;
			writes.add(alias);
			pendingWrites.push(alias);
		}
	}
	const trustedParameters = new Set();
	const trustedCallbacks = new Set();
	const trustedFunctions = new Set();
	const isAbsent = (node) =>
		node &&
		(node.kind === ts.SyntaxKind.NullKeyword ||
			(ts.isIdentifier(node) && node.text === "undefined"));
	const root = resolve(rootPath);
	const isRoot = (fn) =>
		fn &&
		ts.isFunctionDeclaration(fn) &&
		fn.name?.text === "subscriptionPlatformOf" &&
		resolve(fn.getSourceFile().fileName) === root;
	const safeFallback = (node) => {
		const target = unwrapped(node);
		return (
			isAbsent(target) ||
			(ts.isObjectLiteralExpression(target) &&
				target.properties.length === 1 &&
				target.properties.every(
					(property) =>
						ts.isPropertyAssignment(property) &&
						property.name.text === "label" &&
						isIdentitySourceKey(property.initializer),
				))
		);
	};
	const isStaticIdentity = (node) => {
		const target = unwrapped(node);
		return (
			(ts.isIdentifier(target) && target.text === "identity") ||
			(ts.isPropertyAccessExpression(target) &&
				target.name.text === "identity" &&
				ts.isIdentifier(unwrapped(target.expression)))
		);
	};
	const isIdentitySourceKey = (node) => {
		const target = unwrapped(node);
		return (
			ts.isPropertyAccessExpression(target) &&
			target.name.text === "sourceKey" &&
			isStaticIdentity(target.expression)
		);
	};
	function isDescriptor(node, seen = new Set()) {
		const target = unwrapped(node);
		if (!target || seen.has(target)) return false;
		seen = new Set(seen).add(target);
		if (ts.isCallExpression(target)) {
			if (writes.has(symbolOf(unwrapped(target.expression)))) return false;
			const fn = callable(target.expression);
			return (
				isRoot(fn) ||
				trustedFunctions.has(fn) ||
				trustedCallbacks.has(symbolOf(unwrapped(target.expression)))
			);
		}
		if (ts.isConditionalExpression(target)) {
			return (
				(isDescriptor(target.whenTrue, seen) &&
					(isDescriptor(target.whenFalse, seen) || isAbsent(target.whenFalse))) ||
				(isAbsent(target.whenTrue) && isDescriptor(target.whenFalse, seen))
			);
		}
		if (
			ts.isBinaryExpression(target) &&
			[ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
				target.operatorToken.kind,
			)
		) {
			return (
				isDescriptor(target.left, seen) &&
				(isDescriptor(target.right, seen) || safeFallback(target.right))
			);
		}
		if (!ts.isIdentifier(target)) return false;
		const symbol = symbolOf(target);
		if (!symbol || writes.has(symbol)) return false;
		if (trustedParameters.has(symbol)) return true;
		const declaration = symbol.valueDeclaration;
		return (
			declaration &&
			ts.isVariableDeclaration(declaration) &&
			declaration.parent.flags & ts.NodeFlags.Const &&
			declaration.initializer &&
			isDescriptor(declaration.initializer, seen)
		);
	}
	const returnedExpressions = (fn) => {
		if (!fn.body) return [];
		if (!ts.isBlock(fn.body)) return [fn.body];
		const expressions = [];
		const walk = (node) => {
			if (node !== fn.body && ts.isFunctionLike(node)) return;
			if (ts.isReturnStatement(node)) {
				if (node.expression) expressions.push(node.expression);
				return;
			}
			ts.forEachChild(node, walk);
		};
		walk(fn.body);
		return expressions;
	};
	// Positive fixed point: an unproved/cyclic input never seeds trust.
	let changed = true;
	while (changed) {
		changed = false;
		for (const fn of functions) {
			const returns = returnedExpressions(fn);
			if (
				!trustedFunctions.has(fn) &&
				returns.length &&
				returns.every((value) => isDescriptor(value))
			) {
				trustedFunctions.add(fn);
				changed = true;
			}
			fn.parameters.forEach((parameter, index) => {
				const incoming = calls.get(fn) ?? [];
				if (
					ts.isIdentifier(parameter.name) &&
					incoming.length &&
					incoming.every((call) => call.arguments[index] && isDescriptor(call.arguments[index]))
				) {
					const symbol = symbolOf(parameter.name);
					if (symbol && !trustedParameters.has(symbol)) {
						trustedParameters.add(symbol);
						changed = true;
					}
				}
				if (index !== 0 || !ts.isObjectBindingPattern(parameter.name)) return;
				for (const binding of parameter.name.elements) {
					if (!ts.isIdentifier(binding.name)) continue;
					const key = binding.propertyName?.text ?? binding.name.text;
					const components = props.get(fn) ?? [];
					if (
						!components.length ||
						incoming.length ||
						components.some((attributes) => attributes.properties.some(ts.isJsxSpreadAttribute))
					)
						continue;
					const values = components
						.map(
							(attributes) =>
								attributes.properties.find(
									(attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === key,
								)?.initializer,
						)
						.map((init) => (init && ts.isJsxExpression(init) ? init.expression : undefined));
					const symbol = symbolOf(binding.name);
					if (
						symbol &&
						!trustedParameters.has(symbol) &&
						values.every((value) => value && isDescriptor(value))
					) {
						trustedParameters.add(symbol);
						changed = true;
					}
					if (
						symbol &&
						!trustedCallbacks.has(symbol) &&
						values.every((value) => {
							if (!value) return false;
							const callback = callable(value);
							return callback && trustedFunctions.has(callback);
						})
					) {
						trustedCallbacks.add(symbol);
						changed = true;
					}
				}
			});
		}
	}
	return { isDescriptor };
}
