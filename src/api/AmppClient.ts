import { errorMessage } from '../util/errorMessage.js'

const TOKEN_SCOPES = ['platform', 'platform.readonly', 'cluster', 'cluster.readonly']
const TOKEN_REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

/** The platform rejected our credentials (bad API key, or a key without the required scopes) */
export class AmppAuthError extends Error {}

export class AmppHttpError extends Error {
	constructor(
		readonly status: number,
		/** The server's own explanation, if it gave one */
		readonly detail: string | null,
		message: string,
	) {
		super(message)
	}
}

/** The platform couldn't be reached: a network error or timeout before it answered */
export class AmppConnectionError extends Error {}

/**
 * How a failure should be handled once connected:
 * - `auth`: credentials rejected (the token couldn't be refreshed, or a fresh one is still refused)
 * - `permission`: the key lacks a scope or access for that request
 * - `request`: this one request failed (refused, or an answer that couldn't be used), the connection is fine
 * - `connection`: the platform couldn't be reached (network error, timeout)
 */
export type FailureKind = 'auth' | 'permission' | 'request' | 'connection'

export function classifyFailure(e: unknown): FailureKind {
	if (e instanceof AmppAuthError) return 'auth'
	if (e instanceof AmppConnectionError) return 'connection'
	if (e instanceof AmppHttpError) {
		// #request has already retried a 401 with a fresh token
		if (e.status === 401) return 'auth'
		if (e.status === 403) return 'permission'
	}
	return 'request'
}

/**
 * fetch, rejecting with AmppConnectionError when the platform can't be reached, or with the signal's reason when it's
 * aborted first
 */
async function fetchPlatform(url: string | URL, init: RequestInit, signal: AbortSignal | null): Promise<Response> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	try {
		return await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
	} catch (e) {
		if (signal?.aborted) throw signal.reason
		throw new AmppConnectionError(errorMessage(e), { cause: e })
	}
}

interface CachedToken {
	accessToken: string
	expiresAt: number
}

export type QueryParams = Record<string, string>

/**
 * Normalise a user-entered platform URL to `https://host[/path]` without a trailing slash.
 * Returns null if it can't be parsed.
 */
export function normalisePlatformUrl(raw: string): string | null {
	let value = raw.trim()
	if (!value) return null
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`

	try {
		const url = new URL(value)
		return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
	} catch {
		return null
	}
}

/** Reads the `exp` claim (seconds since epoch) from a JWT, returning it as milliseconds */
export function getJwtExpiry(token: string): number | null {
	const payload = token.split('.')[1]
	if (!payload) return null

	try {
		const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
		return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null
	} catch {
		return null
	}
}

export class AmppClient {
	readonly #baseUrl: string
	readonly #apiKey: string
	readonly #onFailure: (e: unknown) => void
	#token: CachedToken | null = null
	#pendingToken: Promise<CachedToken> | null = null

	/**
	 * `onFailure` hears about every request that fails for a reason beyond that request (rejected credentials, missing
	 * permission, or the platform unreachable), before the error is thrown to the caller. Aborted requests aren't
	 * reported.
	 */
	constructor(baseUrl: string, apiKey: string, onFailure: (e: unknown) => void) {
		this.#baseUrl = baseUrl
		this.#apiKey = apiKey
		this.#onFailure = onFailure
	}

	/** Fetch a fresh token, throwing AmppAuthError if the credentials are rejected */
	async login(): Promise<void> {
		this.#token = null
		await this.#getToken()
	}

	async get<T>(path: string, query: QueryParams | null, signal: AbortSignal): Promise<T> {
		return this.#request<T>('GET', path, query, undefined, null, signal)
	}

	async post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
		return this.#request<T>('POST', path, null, body, null, signal)
	}

	async put<T>(path: string, body: unknown, headers: Record<string, string> | null, signal: AbortSignal): Promise<T> {
		return this.#request<T>('PUT', path, null, body, headers, signal)
	}

	get baseUrl(): string {
		return this.#baseUrl
	}

	/** A current bearer token, refreshing it if needed; for connections the client doesn't make itself */
	async getAccessToken(): Promise<string> {
		return (await this.#getToken()).accessToken
	}

	async #getToken(): Promise<CachedToken> {
		if (this.#token && this.#token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return this.#token

		// De-duplicate concurrent refreshes so a burst of requests only hits the identity service once
		this.#pendingToken ??= this.#fetchToken().finally(() => {
			this.#pendingToken = null
		})
		this.#token = await this.#pendingToken
		return this.#token
	}

	async #fetchToken(): Promise<CachedToken> {
		const body = new URLSearchParams({ grant_type: 'client_credentials', scope: TOKEN_SCOPES.join(' ') })
		// Shared by every request waiting on it, so it isn't cancelled with any one of them
		const res = await fetchPlatform(
			`${this.#baseUrl}/identity/connect/token`,
			{
				method: 'POST',
				headers: {
					Authorization: `Basic ${this.#apiKey}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: body.toString(),
			},
			null,
		)

		if (!res.ok) {
			const detail = await readErrorDetail(res)
			const suffix = detail ? `: ${detail}` : ''
			// The identity service answers bad client credentials or scopes with 400 (invalid_client / invalid_scope)
			if (res.status === 400 || res.status === 401 || res.status === 403) {
				throw new AmppAuthError(`Authentication failed (${res.status})${suffix}`)
			}
			throw new AmppHttpError(res.status, detail, `Token request failed (${res.status})${suffix}`)
		}

		const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
		if (typeof data.access_token !== 'string' || !data.access_token) {
			throw new AmppAuthError('Token response did not contain an access token')
		}

		const expiresAt =
			getJwtExpiry(data.access_token) ??
			(typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : Date.now() + 5 * 60_000)

		return { accessToken: data.access_token, expiresAt }
	}

	async #request<T>(
		method: string,
		path: string,
		query: QueryParams | null,
		body: unknown,
		headers: Record<string, string> | null,
		signal: AbortSignal,
	): Promise<T> {
		const url = new URL(`${this.#baseUrl}/${path.replace(/^\/+/, '')}`)
		if (query) {
			for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
		}

		try {
			let res = await this.#send(method, url, body, headers, signal)
			if (res.status === 401) {
				// The token may have been revoked or expired early; retry once with a fresh one
				this.#token = null
				res = await this.#send(method, url, body, headers, signal)
			}

			if (!res.ok) {
				const detail = await readErrorDetail(res)
				throw new AmppHttpError(
					res.status,
					detail,
					`${method} ${url.pathname} failed (${res.status})${detail ? `: ${detail}` : ''}`,
				)
			}

			const text = await res.text()
			return (text ? JSON.parse(text) : undefined) as T
		} catch (e) {
			if (signal.aborted) throw signal.reason
			if (classifyFailure(e) !== 'request') this.#onFailure(e)
			throw e
		}
	}

	async #send(
		method: string,
		url: URL,
		body: unknown,
		extraHeaders: Record<string, string> | null,
		signal: AbortSignal,
	): Promise<Response> {
		const token = await this.#getToken()
		signal.throwIfAborted()
		const headers: Record<string, string> = { Authorization: `Bearer ${token.accessToken}`, ...extraHeaders }
		if (body !== undefined) headers['Content-Type'] = 'application/json'

		return fetchPlatform(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, signal)
	}
}

/**
 * Pull a readable message out of an error body: the matrix/fabric services send `{ message, retry }`, the identity
 * service sends OAuth's `{ error, error_description }`. Anything else is returned as (truncated) text.
 */
export function parseErrorDetail(text: string): string | null {
	const trimmed = text.trim()
	if (!trimmed) return null

	try {
		const body = JSON.parse(trimmed) as Record<string, unknown> | null
		for (const key of ['message', 'error_description', 'error']) {
			const value = body?.[key]
			if (typeof value === 'string' && value.trim()) return value.trim()
		}
	} catch {
		// Not JSON
	}
	return trimmed.slice(0, 200)
}

async function readErrorDetail(res: Response): Promise<string | null> {
	try {
		return parseErrorDetail(await res.text())
	} catch {
		return null
	}
}
