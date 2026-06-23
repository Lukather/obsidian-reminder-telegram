import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				project: ['./tsconfig.eslint.json'],
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	// Test files + auto-mock: relax strict-typed rules that fire because
	// the obsidian auto-mock doesn't expose types to the TS service.
	// Must come AFTER obsidianmd configs to win on conflicting rules.
	{
		files: [
			'src/**/*.test.ts',
			'src/__fixtures__/**/*.ts',
			'src/__integration__/**/*.ts',
			'__mocks__/**/*.ts',
		],
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'no-undef': 'off',
			'import/no-nodejs-modules': 'off',
		},
	},
	// vitest.config.ts runs in Node, allow node builtins
	{
		files: ['vitest.config.ts', 'esbuild.config.mjs', 'version-bump.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'import/no-nodejs-modules': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
