import { describe, expect, it } from 'vitest'
import { tallyMatches } from '../feedbacks.js'

describe('tallyMatches', () => {
	it('matches the chosen level only', () => {
		expect(tallyMatches('High', 'High')).toBe(true)
		expect(tallyMatches('Low', 'High')).toBe(false)
		expect(tallyMatches('Low', 'Low')).toBe(true)
	})

	it('matches either level for any', () => {
		expect(tallyMatches('High', 'any')).toBe(true)
		expect(tallyMatches('Low', 'any')).toBe(true)
	})

	it('never matches off or unknown', () => {
		expect(tallyMatches('Off', 'any')).toBe(false)
		expect(tallyMatches(null, 'any')).toBe(false)
	})
})
