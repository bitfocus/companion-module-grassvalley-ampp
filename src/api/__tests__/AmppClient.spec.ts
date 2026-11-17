import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	AmppAuthError,
	AmppClient,
	AmppConnectionError,
	AmppHttpError,
	classifyFailure,
	getJwtExpiry,
	normalisePlatformUrl,
	parseErrorDetail,
} from '../AmppClient.js'

const BASE = 'https://region.cloud.grassvalley.com'
const SIGNAL = new AbortController().signal

function makeJwt(expSeconds: number): string {
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
	return `header.${payload}.sig`
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), { status })
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
	return input instanceof Request ? input.url : input.toString()
}

function tokenResponse(token: string): Response {
	return jsonResponse(200, { access_token: token })
}

describe('normalisePlatformUrl', () => {
	it('adds https and strips trailing slashes', () => {
		expect(normalisePlatformUrl(' region.cloud.grassvalley.com/ ')).toBe(BASE)
		expect(normalisePlatformUrl(`${BASE}///`)).toBe(BASE)
	})

	it('keeps an explicit scheme and path', () => {
		expect(normalisePlatformUrl('http://10.0.0.1:8080/ampp/')).toBe('http://10.0.0.1:8080/ampp')
	})

	it('rejects empty or unparseable input', () => {
		expect(normalisePlatformUrl('')).toBeNull()
		expect(normalisePlatformUrl('   ')).toBeNull()
		expect(normalisePlatformUrl('https://exa mple.com')).toBeNull()
	})
})

describe('getJwtExpiry', () => {
	it('reads the exp claim as milliseconds', () => {
		expect(getJwtExpiry(makeJwt(1_700_000_000))).toBe(1_700_000_000_000)
	})

	it('returns null for malformed tokens', () => {
		expect(getJwtExpiry('not-a-jwt')).toBeNull()
		expect(getJwtExpiry('a.!!!.c')).toBeNull()
		expect(getJwtExpiry(`a.${Buffer.from('{}').toString('base64url')}.c`)).toBeNull()
	})
})

describe('classifyFailure', () => {
	it('treats rejected credentials as auth failures', () => {
		expect(classifyFailure(new AmppAuthError('bad key'))).toBe('auth')
		expect(classifyFailure(new AmppHttpError(401, null, 'still 401'))).toBe('auth')
	})

	it('treats 403 as a permission problem', () => {
		expect(classifyFailure(new AmppHttpError(403, null, 'forbidden'))).toBe('permission')
	})

	it('treats other HTTP errors as specific to the request', () => {
		expect(classifyFailure(new AmppHttpError(404, null, 'gone'))).toBe('request')
		expect(classifyFailure(new AmppHttpError(503, null, 'down'))).toBe('request')
	})

	it('treats an unreachable platform as a lost connection', () => {
		expect(classifyFailure(new AmppConnectionError('fetch failed'))).toBe('connection')
	})

	it('treats anything else as specific to the request', () => {
		expect(classifyFailure(new SyntaxError('Unexpected token < in JSON'))).toBe('request')
		expect(classifyFailure(new Error('returned more than 100 pages'))).toBe('request')
	})
})

describe('parseErrorDetail', () => {
	it('reads the matrix ErrorModel message', () => {
		expect(parseErrorDetail('{"message":"Destination is locked","retry":false}')).toBe('Destination is locked')
	})

	it('prefers the OAuth error description over the error code', () => {
		expect(parseErrorDetail('{"error":"invalid_client","error_description":"Bad key"}')).toBe('Bad key')
		expect(parseErrorDetail('{"error":"invalid_client"}')).toBe('invalid_client')
	})

	it('falls back to truncated text for other bodies', () => {
		expect(parseErrorDetail('  Service Unavailable ')).toBe('Service Unavailable')
		expect(parseErrorDetail('{"other":1}')).toBe('{"other":1}')
		expect(parseErrorDetail('x'.repeat(300))).toHaveLength(200)
		expect(parseErrorDetail('null')).toBe('null')
	})

	it('returns null for an empty body', () => {
		expect(parseErrorDetail('  ')).toBeNull()
	})
})

describe('AmppClient', () => {
	const fetchMock = vi.fn<typeof fetch>()

	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ['Date'] })
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
		fetchMock.mockReset()
	})

	const nowSeconds = () => Math.floor(Date.now() / 1000)

	it('requests a client-credentials token with the API key', async () => {
		fetchMock.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))

		await new AmppClient(BASE, 'KEY', vi.fn()).login()

		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe(`${BASE}/identity/connect/token`)
		expect(init?.method).toBe('POST')
		expect((init?.headers as Record<string, string>).Authorization).toBe('Basic KEY')
		const body = new URLSearchParams(init?.body as string)
		expect(body.get('grant_type')).toBe('client_credentials')
		expect(body.get('scope')).toBe('platform platform.readonly cluster cluster.readonly')
	})

	it('throws AmppAuthError when the credentials are rejected', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_client' }))

		await expect(new AmppClient(BASE, 'BAD', vi.fn()).login()).rejects.toBeInstanceOf(AmppAuthError)
	})

	it('throws AmppConnectionError when the platform cannot be reached', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

		const err = await new AmppClient(BASE, 'KEY', vi.fn()).login().catch((e: unknown) => e)
		expect(err).toBeInstanceOf(AmppConnectionError)
		expect((err as Error).message).toBe('fetch failed')
	})

	it('throws AmppHttpError for server errors from the identity service', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(503, undefined))

		const err = await new AmppClient(BASE, 'KEY', vi.fn()).login().catch((e: unknown) => e)
		expect(err).toBeInstanceOf(AmppHttpError)
		expect(err).not.toBeInstanceOf(AmppAuthError)
	})

	it('sends the bearer token and query parameters', async () => {
		const token = makeJwt(nowSeconds() + 3600)
		fetchMock.mockResolvedValueOnce(tokenResponse(token)).mockResolvedValueOnce(jsonResponse(200, { ok: true }))

		const result = await new AmppClient(BASE, 'KEY', vi.fn()).get('/cluster/thing', { fabricId: 'f 1' }, SIGNAL)

		expect(result).toEqual({ ok: true })
		const [url, init] = fetchMock.mock.calls[1]
		expect(urlOf(url)).toBe(`${BASE}/cluster/thing?fabricId=f+1`)
		expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`)
	})

	it('reuses a valid token and refreshes one close to expiry', async () => {
		fetchMock
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 120)))
			.mockResolvedValueOnce(jsonResponse(200, {}))
			.mockResolvedValueOnce(jsonResponse(200, {}))
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(200, {}))

		const client = new AmppClient(BASE, 'KEY', vi.fn())
		await client.get('/a', null, SIGNAL)
		await client.get('/b', null, SIGNAL)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		// Within the 60s refresh margin of the 120s token
		vi.setSystemTime(Date.now() + 61_000)
		await client.get('/c', null, SIGNAL)

		expect(urlOf(fetchMock.mock.calls[3][0])).toBe(`${BASE}/identity/connect/token`)
		expect(fetchMock).toHaveBeenCalledTimes(5)
	})

	it('only fetches one token for concurrent requests', async () => {
		fetchMock.mockImplementation(async (input) =>
			urlOf(input).endsWith('/identity/connect/token')
				? tokenResponse(makeJwt(nowSeconds() + 3600))
				: jsonResponse(200, {}),
		)

		const client = new AmppClient(BASE, 'KEY', vi.fn())
		await Promise.all([client.get('/a', null, SIGNAL), client.get('/b', null, SIGNAL), client.get('/c', null, SIGNAL)])

		const tokenCalls = fetchMock.mock.calls.filter(([url]) => urlOf(url).endsWith('/identity/connect/token'))
		expect(tokenCalls).toHaveLength(1)
	})

	it('retries once with a fresh token after a 401', async () => {
		fetchMock
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(401, undefined))
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(200, { retried: true }))

		await expect(new AmppClient(BASE, 'KEY', vi.fn()).get('/a', null, SIGNAL)).resolves.toEqual({ retried: true })
		expect(fetchMock).toHaveBeenCalledTimes(4)
	})

	it('throws AmppHttpError with the status for failed requests', async () => {
		fetchMock
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(403, { message: 'forbidden' }))

		const err = await new AmppClient(BASE, 'KEY', vi.fn()).get('/a', null, SIGNAL).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(AmppHttpError)
		expect((err as AmppHttpError).status).toBe(403)
		expect((err as AmppHttpError).detail).toBe('forbidden')
		expect((err as AmppHttpError).message).toBe('GET /a failed (403): forbidden')
	})

	it('posts JSON bodies', async () => {
		fetchMock
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(200, { requestId: 'r1' }))

		await new AmppClient(BASE, 'KEY', vi.fn()).post('/route', { sourceId: 's', destinationId: 'd' }, SIGNAL)

		const [, init] = fetchMock.mock.calls[1]
		expect(init?.method).toBe('POST')
		expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
		expect(JSON.parse(init?.body as string)).toEqual({ sourceId: 's', destinationId: 'd' })
	})

	it('puts JSON bodies with extra headers', async () => {
		fetchMock
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(200, { id: 'p1' }))

		await new AmppClient(BASE, 'KEY', vi.fn()).put('/producer/p1', { alias: 'Wide' }, { 'If-Match': '"*"' }, SIGNAL)

		const [, init] = fetchMock.mock.calls[1]
		const headers = init?.headers as Record<string, string>
		expect(init?.method).toBe('PUT')
		expect(headers['If-Match']).toBe('"*"')
		expect(headers['Content-Type']).toBe('application/json')
		expect(headers.Authorization).toMatch(/^Bearer /)
		expect(JSON.parse(init?.body as string)).toEqual({ alias: 'Wide' })
	})

	it('reports a failure beyond the request before throwing it, but not a refused request', async () => {
		const onFailure = vi.fn()
		const client = new AmppClient(BASE, 'KEY', onFailure)
		fetchMock
			.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600)))
			.mockResolvedValueOnce(jsonResponse(400, { message: 'The destination is locked' }))
			.mockRejectedValueOnce(new TypeError('fetch failed'))

		await expect(client.get('/a', null, SIGNAL)).rejects.toBeInstanceOf(AmppHttpError)
		expect(onFailure).not.toHaveBeenCalled()

		const err = await client.get('/b', null, SIGNAL).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(AmppConnectionError)
		expect(onFailure).toHaveBeenCalledWith(err)
	})

	it("rejects with the signal's reason when aborted, without reporting it", async () => {
		const onFailure = vi.fn()
		const client = new AmppClient(BASE, 'KEY', onFailure)
		const controller = new AbortController()
		const reason = new Error('The connection to AMPP ended')
		fetchMock.mockResolvedValueOnce(tokenResponse(makeJwt(nowSeconds() + 3600))).mockImplementationOnce(
			async (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
				}),
		)

		const request = client.get('/a', null, controller.signal)
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
		controller.abort(reason)

		await expect(request).rejects.toBe(reason)
		expect(onFailure).not.toHaveBeenCalled()
	})

	it('hands out the cached token for other connections', async () => {
		const token = makeJwt(nowSeconds() + 3600)
		fetchMock.mockResolvedValueOnce(tokenResponse(token))
		const client = new AmppClient(BASE, 'KEY', vi.fn())

		await expect(client.getAccessToken()).resolves.toBe(token)
		await expect(client.getAccessToken()).resolves.toBe(token)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(client.baseUrl).toBe(BASE)
	})
})
