// Local Oxlint rules for checks the built-in rules do not express the way this code needs.
import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const attribute = (node, name) =>
	node.attributes.find(
		(item) => item.type === "JSXAttribute" && item.name.name === name,
	);
const spreads = (node) =>
	node.attributes.some((item) => item.type === "JSXSpreadAttribute");
// Marks a value only known at runtime, as opposed to a literal null.
const unknown = Symbol("unknown");
// The static value of an expression: the constant for literals (including null),
// expression-free template literals and the undefined identifier; otherwise unknown.
const constant = (node) => {
	if (node?.type === "Literal") return node.value;
	if (node?.type === "TemplateLiteral" && !node.expressions.length)
		return node.quasis[0].value.cooked;
	if (node?.type === "Identifier" && node.name === "undefined") return undefined;
	return unknown;
};
// React renders nothing for these values and omits attributes set to them.
const blank = (value) =>
	value === null ||
	value === undefined ||
	typeof value === "boolean" ||
	(typeof value === "string" && !value.trim());
// An attribute's static value: undefined when absent, true when it has no value.
const literal = (item) => {
	if (!item) return undefined;
	if (!item.value) return true;
	return constant(item.value.type === "JSXExpressionContainer" ? item.value.expression : item.value);
};
// Statically empty text: only whitespace text and constant empty expressions.
const empty = (children) =>
	children.every((child) => {
		if (child.type === "JSXText") return !child.value.trim();
		if (child.type !== "JSXExpressionContainer") return false;
		if (child.expression.type === "JSXEmptyExpression") return true;
		const value = constant(child.expression);
		return value !== unknown && blank(value);
	});
const tag = (node) => (node.name.type === "JSXIdentifier" ? node.name.name : "");

/** A button needs an explicit type unless spread props may supply one. */
const buttonType = defineRule({
	meta: {
		messages: {
			missing: "Give this button an explicit type (button, submit or reset).",
			invalid: "A button type must be button, submit or reset.",
		},
	},
	create(context) {
		return {
			JSXOpeningElement(node) {
				if (tag(node) !== "button" || spreads(node)) return;
				const type = attribute(node, "type");
				if (!type) return context.report({ node, messageId: "missing" });
				const value = literal(type);
				if (value !== unknown && !["button", "submit", "reset"].includes(value))
					context.report({ node: type, messageId: "invalid" });
			},
		};
	},
});

/** An svg needs an accessible name or must be hidden from assistive technology. */
const svgName = defineRule({
	meta: {
		messages: {
			missing:
				"Give this svg a <title>, aria-label or aria-labelledby, or hide it with aria-hidden.",
		},
	},
	create(context) {
		return {
			JSXElement(element) {
				const node = element.openingElement;
				if (tag(node) !== "svg") return;
				const hidden = literal(attribute(node, "aria-hidden"));
				if (hidden === true || hidden === "true" || hidden === unknown) return;
				const role = literal(attribute(node, "role"));
				if (role === "presentation" || role === "none") return;
				// A label counts unless it is absent or statically empty, null or false.
				for (const name of ["aria-label", "aria-labelledby"]) {
					const label = literal(attribute(node, name));
					if (label === unknown || (typeof label === "string" && label.trim())) return;
				}
				const titled = element.children.some(
					(child) =>
						child.type === "JSXElement" &&
						tag(child.openingElement) === "title" &&
						!empty(child.children),
				);
				if (!titled) context.report({ node, messageId: "missing" });
			},
		};
	},
});

// Roles with a native element that carries the same semantics and keyboard behaviour.
// Live regions (status, alert), img and dialog are not included: their native
// equivalents (<output>, <img>, <dialog>) change meaning or rendering.
const semantic = {
	button: "<button>",
	checkbox: '<input type="checkbox">',
	radio: '<input type="radio">',
	link: "<a href>",
	heading: "<h1>-<h6>",
	list: "<ul> or <ol>",
	listitem: "<li>",
	navigation: "<nav>",
	banner: "<header>",
	contentinfo: "<footer>",
	main: "<main>",
	complementary: "<aside>",
	article: "<article>",
	form: "<form>",
	table: "<table>",
	row: "<tr>",
	cell: "<td>",
	columnheader: "<th>",
	rowheader: "<th>",
	separator: "<hr>",
	textbox: "<input> or <textarea>",
	searchbox: '<input type="search">',
};

/** Prefer the native element over an ARIA role that recreates it. */
const semanticElements = defineRule({
	meta: { messages: { native: "Use {{element}} instead of role=\"{{role}}\"." } },
	create(context) {
		return {
			JSXOpeningElement(node) {
				const name = tag(node);
				if (!name || name[0] !== name[0].toLowerCase()) return;
				const role = literal(attribute(node, "role"));
				if (typeof role !== "string" || !(role in semantic)) return;
				context.report({
					node,
					messageId: "native",
					data: { element: semantic[role], role },
				});
			},
		};
	},
});

// x.toLowerCase() compared with a string containing upper case (or the reverse) is
// always unequal, which TypeScript does not report.
const caseOf = (node) => {
	if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
	const name = node.callee.property.name;
	if (name === "toLowerCase" || name === "toLocaleLowerCase") return "lower";
	if (name === "toUpperCase" || name === "toLocaleUpperCase") return "upper";
};
const mismatched = (kind, value) =>
	typeof value === "string" &&
	(kind === "lower" ? value !== value.toLowerCase() : value !== value.toUpperCase());
const stringCase = defineRule({
	meta: {
		messages: {
			mismatch: "This string can never equal a {{kind}}-cased value.",
		},
	},
	create(context) {
		return {
			BinaryExpression(node) {
				if (!["===", "!==", "==", "!="].includes(node.operator)) return;
				for (const [call, other] of [
					[node.left, node.right],
					[node.right, node.left],
				]) {
					const kind = caseOf(call);
					if (kind && mismatched(kind, constant(other)))
						context.report({ node: other, messageId: "mismatch", data: { kind } });
				}
			},
			SwitchStatement(node) {
				const kind = caseOf(node.discriminant);
				if (!kind) return;
				for (const item of node.cases)
					if (item.test && mismatched(kind, constant(item.test)))
						context.report({ node: item.test, messageId: "mismatch", data: { kind } });
			},
		};
	},
});

// Constructors that throw when called without new. Error() and Array() are valid calls.
const constructors = new Set([
	"Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Promise",
	"Proxy", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
	"Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
	"Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);
/** Builtin constructors must be called with new, unless the name is declared locally. */
const builtinNew = defineRule({
	meta: { messages: { missing: "Call {{name}} with new; calling it directly throws." } },
	create(context) {
		const calls = [];
		// Lexical scopes: function scopes take var and parameters, block scopes take let,
		// const and class. Calls resolve through their own chain once the file is read, so
		// declarations later in a scope still shadow.
		let scope = { names: new Set(), parent: null, fn: true };
		const enter = (fn) => {
			scope = { names: new Set(), parent: scope, fn };
		};
		const leave = () => {
			scope = scope.parent;
		};
		const functionScope = () => {
			let current = scope;
			while (!current.fn) current = current.parent;
			return current;
		};
		// Every name a pattern binds, including destructured, default and rest bindings.
		const bind = (pattern, target = scope) => {
			if (!pattern) return;
			if (pattern.type === "Identifier") target.names.add(pattern.name);
			else if (pattern.type === "AssignmentPattern") bind(pattern.left, target);
			else if (pattern.type === "RestElement") bind(pattern.argument, target);
			else if (pattern.type === "ArrayPattern")
				for (const element of pattern.elements) bind(element, target);
			else if (pattern.type === "ObjectPattern")
				for (const property of pattern.properties)
					bind(property.type === "RestElement" ? property.argument : property.value, target);
			else if (pattern.type === "TSParameterProperty") bind(pattern.parameter, target);
		};
		const shadowed = (name, from) => {
			for (let current = from; current; current = current.parent)
				if (current.names.has(name)) return true;
			return false;
		};
		// Parameters live in their own scope; the body block is the separate var scope,
		// which parameter default values cannot see.
		const bodies = new Set();
		const enterFunction = (node) => {
			// A function expression's own name is visible only inside it.
			enter(false);
			if (node.type !== "FunctionDeclaration") bind(node.id);
			for (const param of node.params) bind(param);
			if (node.body?.type === "BlockStatement") bodies.add(node.body);
		};
		// The called builtin: Map(...) or globalThis.Map(...) / globalThis["Map"](...).
		const builtin = (callee) => {
			if (callee.type === "Identifier") return { name: callee.name, global: false };
			if (
				callee.type === "MemberExpression" &&
				callee.object.type === "Identifier" &&
				["globalThis", "window", "self", "global"].includes(callee.object.name)
			) {
				const name = callee.computed ? constant(callee.property) : callee.property.name;
				if (typeof name === "string") return { name, global: true };
			}
		};
		return {
			ImportSpecifier: (node) => bind(node.local),
			ImportDefaultSpecifier: (node) => bind(node.local),
			ImportNamespaceSpecifier: (node) => bind(node.local),
			VariableDeclaration(node) {
				const target = node.kind === "var" ? functionScope() : scope;
				for (const declarator of node.declarations) bind(declarator.id, target);
			},
			FunctionDeclaration(node) {
				bind(node.id);
				enterFunction(node);
			},
			"FunctionDeclaration:exit": leave,
			FunctionExpression: enterFunction,
			"FunctionExpression:exit": leave,
			ArrowFunctionExpression: enterFunction,
			"ArrowFunctionExpression:exit": leave,
			ClassDeclaration: (node) => bind(node.id),
			// A class expression's own name is visible only inside the class.
			ClassExpression(node) {
				enter(false);
				bind(node.id);
			},
			"ClassExpression:exit": leave,
			BlockStatement: (node) => enter(bodies.has(node)),
			"BlockStatement:exit": leave,
			// Loop heads, switch bodies and static blocks scope their let/const bindings.
			ForStatement: () => enter(false),
			"ForStatement:exit": leave,
			ForInStatement: () => enter(false),
			"ForInStatement:exit": leave,
			ForOfStatement: () => enter(false),
			"ForOfStatement:exit": leave,
			SwitchStatement: () => enter(false),
			"SwitchStatement:exit": leave,
			StaticBlock: () => enter(true),
			"StaticBlock:exit": leave,
			CatchClause(node) {
				enter(false);
				bind(node.param);
			},
			"CatchClause:exit": leave,
			CallExpression(node) {
				const called = builtin(node.callee);
				if (called && constructors.has(called.name)) calls.push({ node, scope, ...called });
			},
			"Program:exit"() {
				// A binding of the same name in scope is not the builtin; globalThis.X always is.
				for (const { node, name, global, scope: from } of calls)
					if (global || !shadowed(name, from))
						context.report({ node, messageId: "missing", data: { name } });
			},
		};
	},
});

/** A semicolon that starts JSX text after an element is a stray statement terminator. */
const jsxSemicolon = defineRule({
	meta: { messages: { stray: "This semicolon renders as text." } },
	create(context) {
		return {
			JSXText(node) {
				if (/^;[ \t]*\r?\n/.test(node.value)) context.report({ node, messageId: "stray" });
			},
		};
	},
});

// URLs that run script; whitespace and control characters are ignored as browsers do.
const scriptUrl = (value) =>
	typeof value === "string" &&
	value.replace(/[\u0000-\u0020]/g, "").toLowerCase().startsWith("javascript:");
/** No statically known javascript: URL in an href, on any element or component. */
const noScriptHref = defineRule({
	meta: { messages: { script: "Do not use a javascript: URL as an href." } },
	create(context) {
		return {
			JSXAttribute(node) {
				if (node.name.name === "href" && scriptUrl(literal(node)))
					context.report({ node, messageId: "script" });
			},
			CallExpression(node) {
				const callee = node.callee;
				const name =
					callee.type === "MemberExpression"
						? callee.computed
							? constant(callee.property)
							: callee.property.name
						: callee.name;
				const props = node.arguments[1];
				if (name !== "createElement" || props?.type !== "ObjectExpression") return;
				for (const property of props.properties)
					if (
						property.type === "Property" &&
						(property.key.name === "href" || property.key.value === "href") &&
						scriptUrl(constant(property.value))
					)
						context.report({ node: property, messageId: "script" });
			},
		};
	},
});

// Link text that says nothing about the destination when read out of context.
const vague = new Set(["click here", "here", "link", "a link", "learn more", "read more", "more", "click"]);
const text = (children) =>
	children
		.map((child) => {
			if (child.type === "JSXText") return child.value;
			if (child.type === "JSXExpressionContainer") {
				if (child.expression.type === "JSXEmptyExpression") return "";
				const value = constant(child.expression);
				if (value === unknown) return null;
				return typeof value === "string" || typeof value === "number" ? String(value) : "";
			}
			if (child.type === "JSXElement") return text(child.children);
			return null;
		})
		.reduce((all, part) => (all === null || part === null ? null : all + part), "");
/** Links need text that identifies the destination, not just "click here". */
const anchorText = defineRule({
	meta: { messages: { vague: "Describe the destination instead of \"{{words}}\"." } },
	create(context) {
		return {
			JSXElement(element) {
				const node = element.openingElement;
				if (tag(node) !== "a") return;
				// React omits a null, undefined or false label, leaving the text as the name.
				const label = literal(attribute(node, "aria-label"));
				const name =
					label === unknown
						? null
						: typeof label === "string" && label.trim()
							? label
							: text(element.children);
				if (typeof name !== "string") return;
				const words = name.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
				if (vague.has(words)) context.report({ node, messageId: "vague", data: { words } });
			},
		};
	},
});

export default definePlugin({
	meta: { name: "toolstile" },
	rules: {
		"button-type": buttonType,
		"svg-name": svgName,
		"semantic-elements": semanticElements,
		"string-case": stringCase,
		"builtin-new": builtinNew,
		"jsx-semicolon": jsxSemicolon,
		"no-script-href": noScriptHref,
		"anchor-text": anchorText,
	},
});
