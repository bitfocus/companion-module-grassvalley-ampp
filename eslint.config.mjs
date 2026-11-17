import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
	ignores: ['vitest.config.ts'],
})

export default [
	...baseConfig,
	{
		files: ['**/__tests__/**/*'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]
