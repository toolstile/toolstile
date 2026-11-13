import { defineConfig } from "vite-plus";

// Workspace lint and format settings for `vp lint` (Oxlint) and `vp fmt` (Oxfmt).
// The application's Vite config lives in apps/web/vite.config.ts.
export default defineConfig({
	lint: {
		plugins: [
			"eslint",
			"typescript",
			"unicorn",
			"react",
			"jsx-a11y",
			"oxc",
			"vitest",
			"jest",
		],
		// Local rules (lint/rules.mjs) for checks the built-in rules cannot express here.
		jsPlugins: ["./lint/rules.mjs"],
		categories: { correctness: "error" },
		ignorePatterns: [
			"**/routeTree.gen.ts",
			"**/migrations/**",
			"**/.output/**",
			"**/.tanstack/**",
			"**/dist/**",
			"**/coverage/**",
			"packages/ui/src/assets/agents/**",
			"packages/api/catalog/**",
		],
		// TypeScript reports use before initialization in .ts files; scripts need the rule.
		// With variables and functions off it reports only same-scope reads (the TDZ case).
		overrides: [
			{
				files: ["**/*.mjs", "**/*.js"],
				rules: {
					"eslint/no-use-before-define": [
						"error",
						{ functions: false, classes: true, variables: false },
					],
				},
			},
		],
		rules: {
			"react/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "error",
			"react/no-array-index-key": "error",
			"react/no-danger": "error",
			"typescript/no-explicit-any": "error",
			"unicorn/no-document-cookie": "error",
			"eslint/no-control-regex": "error",
			"eslint/eqeqeq": ["error", "always", { null: "ignore" }],
			"eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
			],
			"eslint/no-unused-expressions": [
				"error",
				{ allowTernary: true, allowShortCircuit: true },
			],
			"jsx-a11y/no-noninteractive-tabindex": "error",
			"jsx-a11y/label-has-associated-control": [
				"error",
				{ controlComponents: ["Checkbox"] },
			],
			"vitest/no-focused-tests": "error",
			"vitest/no-duplicate-hooks": "error",
			"jest/no-export": "error",
			"eslint/array-callback-return": "error",
			"eslint/no-fallthrough": "error",
			"eslint/no-self-compare": "error",
			"eslint/no-case-declarations": "error",
			"eslint/no-constructor-return": "error",
			"eslint/no-redeclare": "error",
			"toolstile/button-type": "error",
			"toolstile/svg-name": "error",
			"toolstile/semantic-elements": "error",
			"toolstile/string-case": "error",
			"oxc/misrefactored-assign-op": "error",
			"toolstile/builtin-new": "error",
			"toolstile/jsx-semicolon": "error",
			"toolstile/no-script-href": "error",
			"typescript/no-unsafe-function-type": "error",
			"typescript/no-empty-object-type": "error",
			"unicorn/prefer-number-properties": "error",
			"eslint/no-prototype-builtins": "error",
			"eslint/no-template-curly-in-string": "error",
			"toolstile/anchor-text": "error",
			"react/jsx-no-comment-textnodes": "error",
			"react/jsx-no-target-blank": "error",
			// Components decide where focus lands; only DOM elements are checked.
			"jsx-a11y/no-autofocus": ["error", { ignoreNonDOM: true }],
			// The automatic JSX runtime needs no React import.
			"react/react-in-jsx-scope": "off",
			// React Compiler rules; the app does not use the compiler.
			"react/set-state-in-effect": "off",
			"react/refs": "off",
			"react/immutability": "off",
			"react/preserve-manual-memoization": "off",
			"react/purity": "off",
			// Vitest accepts a message argument; assertions also live in test helpers.
			"vitest/valid-expect": "off",
			"vitest/expect-expect": "off",
			"vitest/no-standalone-expect": "off",
			"vitest/no-conditional-expect": "off",
			"vitest/require-to-throw-message": "off",
			"vitest/require-mock-type-parameters": "off",
			// The jest plugin supplies no-export; its copies of the Vitest rules above stay off,
			// and Vitest accepts describe(name, options, fn).
			"jest/valid-expect": "off",
			"jest/expect-expect": "off",
			"jest/no-standalone-expect": "off",
			"jest/no-conditional-expect": "off",
			"jest/require-to-throw-message": "off",
			"jest/valid-describe-callback": "off",
			// Buttons with spread props, live regions and img/dialog roles are handled by the
			// toolstile rules; these built-ins flag them without exception.
			"react/button-has-type": "off",
			"jsx-a11y/prefer-tag-over-role": "off",
			// Labelled forms handle focus for their fields; asset types use references.
			"jsx-a11y/no-noninteractive-element-interactions": "off",
			"typescript/triple-slash-reference": "off",
			"unicorn/no-useless-spread": "off",
			"unicorn/no-useless-fallback-in-spread": "off",
			"unicorn/no-new-array": "off",
		},
	},
	// The pre-commit hook (.vite-hooks/pre-commit) formats staged source in the format scope.
	staged: {
		"{packages,apps/web/src,apps/web/scripts,tests,scripts,lint}/**/*.{ts,tsx,js,mjs,css}":
			"vp fmt --no-error-on-unmatched-pattern",
	},
	fmt: {
		useTabs: true,
		printWidth: 80,
		ignorePatterns: [
			"**/routeTree.gen.ts",
			"**/migrations/**",
			"**/.output/**",
			"**/dist/**",
			"packages/ui/src/assets/agents/**",
			"packages/api/catalog/**",
		],
	},
});
