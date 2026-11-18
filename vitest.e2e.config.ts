import { defineConfig } from 'vitest/config'

/** The end-to-end suite, against the live AMPP system in `.env`; run with `yarn test:e2e` */
export default defineConfig({
	test: {
		include: ['e2e/**/*.e2e.ts'],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		// One live system, so one test at a time
		fileParallelism: false,
	},
})
