import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
	ignores: ['vitest.config.ts', 'vitest.e2e.config.ts'],
})

export default [
	...baseConfig,
	{
		files: ['**/__tests__/**/*', 'e2e/**/*'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]
