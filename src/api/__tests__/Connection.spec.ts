import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmppAuthError, AmppConnectionError, AmppHttpError } from '../AmppClient.js'
import { Connection, type ConnectionHandlers, type Session } from '../Connection.js'
import type { NotificationListenerOptions, PlatformNotification } from '../Notifications.js'

const fakes = vi.hoisted(() => ({
	login: null as unknown as () => Promise<void>,
	/** What the latest client reports a failure to, as it would for a request that failed beyond itself */
	reportFailure: null as unknown as (e: unknown) => void,
	listeners: [] as {
		options: NotificationListenerOptions
		hold: ReturnType<typeof vi.fn>
		release: ReturnType<typeof vi.fn>
		close: () => Promise<void>
	}[],
}))

vi.mock('../AmppClient.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../AmppClient.js')>()
	class FakeClient {
		constructor(
			readonly baseUrl: string,
			_apiKey: string,
			onFailure: (e: unknown) => void,
		) {
			fakes.reportFailure = onFailure
		}
		login = async () => fakes.login()
		getAccessToken = async () => 'token'
	}
	return { ...actual, AmppClient: FakeClient }
})

vi.mock('../Notifications.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../Notifications.js')>()
	class FakeListener {
		hold = vi.fn()
		release = vi.fn()
		close = vi.fn(async () => {})
		constructor(
			_hub: unknown,
			readonly options: NotificationListenerOptions,
		) {
			fakes.listeners.push(this)
		}
		async open() {}
	}
	return { ...actual, createNotificationHub: () => ({}), NotificationListener: FakeListener }
})

function makeHandlers() {
	return {
		log: vi.fn(),
		updateStatus: vi.fn(),
		load: vi.fn(async (_session: Session) => {}),
		fabricsChanged: vi.fn(() => false),
		onNotifications: vi.fn(),
	} satisfies ConnectionHandlers
}

const lastStatus = (handlers: ReturnType<typeof makeHandlers>) => handlers.updateStatus.mock.calls.at(-1)
const flush = async () => vi.advanceTimersByTimeAsync(0)
const NOTIFICATIONS: PlatformNotification[] = [{ topic: 'gv.cluster.matrix.consumer.updated', content: '{}' }]

describe('Connection', () => {
	let login: ReturnType<typeof vi.fn<() => Promise<void>>>

	beforeEach(() => {
		vi.useFakeTimers()
		login = vi.fn(async () => {})
		fakes.login = login
		fakes.listeners.length = 0
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('reports missing settings without connecting', () => {
		const handlers = makeHandlers()
		const connection = new Connection(handlers)

		connection.start('', 'key')
		expect(lastStatus(handlers)).toEqual([InstanceStatus.BadConfig, 'Platform URL is missing or invalid'])

		connection.start('ampp.example.com', '  ')
		expect(lastStatus(handlers)).toEqual([InstanceStatus.BadConfig, 'API key is missing'])
		expect(login).not.toHaveBeenCalled()
	})

	it('loads the lists, then starts listening and reports ok', async () => {
		const handlers = makeHandlers()
		const connection = new Connection(handlers)

		connection.start('ampp.example.com', 'key')
		expect(() => connection.requireSession()).toThrow('Not connected to AMPP')
		await flush()

		expect(handlers.load).toHaveBeenCalledOnce()
		expect(connection.requireSession()).toBe(handlers.load.mock.calls[0]?.[0])
		expect(fakes.listeners[0]?.release).toHaveBeenCalledOnce()
		expect(lastStatus(handlers)).toEqual([InstanceStatus.Ok, null])
	})

	it('reconnects with a growing delay while the platform is unreachable', async () => {
		login.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
		const handlers = makeHandlers()
		const connection = new Connection(handlers)

		connection.start('ampp.example.com', 'key')
		await flush()
		expect(lastStatus(handlers)).toEqual([InstanceStatus.ConnectionFailure, 'down'])

		await vi.advanceTimersByTimeAsync(4_999)
		expect(login).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(login).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(9_999)
		expect(login).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(login).toHaveBeenCalledTimes(3)
		expect(connection.requireSession()).toBeDefined()
	})

	it('waits for new settings when the credentials are rejected', async () => {
		login.mockRejectedValue(new AmppAuthError('Bad key'))
		const handlers = makeHandlers()
		const connection = new Connection(handlers)

		connection.start('ampp.example.com', 'key')
		await vi.advanceTimersByTimeAsync(120_000)

		expect(login).toHaveBeenCalledOnce()
		expect(lastStatus(handlers)).toEqual([InstanceStatus.AuthenticationFailure, 'Bad key'])
	})

	it('starts delivering notifications once the lists have loaded, until stopped', async () => {
		let finishLoad = () => {}
		const handlers = makeHandlers()
		handlers.load.mockImplementationOnce(async () => new Promise<void>((resolve) => (finishLoad = resolve)))
		const connection = new Connection(handlers)

		connection.start('ampp.example.com', 'key')
		await flush()
		const listener = fakes.listeners[0]
		expect(listener.release).not.toHaveBeenCalled()

		finishLoad()
		await flush()
		expect(listener.release).toHaveBeenCalledOnce()
		const session = connection.requireSession()
		listener.options.onNotifications(NOTIFICATIONS)
		expect(handlers.onNotifications).toHaveBeenCalledWith(NOTIFICATIONS, session)

		await connection.stop()
		expect(session.signal.aborted).toBe(true)
		expect(listener.close).toHaveBeenCalled()
	})

	it('drops and reconnects the session when the client finds the platform unreachable', async () => {
		const handlers = makeHandlers()
		const connection = new Connection(handlers)
		connection.start('ampp.example.com', 'key')
		await flush()
		const session = connection.requireSession()

		fakes.reportFailure(new AmppConnectionError('ECONNRESET'))
		expect(session.signal.aborted).toBe(true)
		expect(() => connection.requireSession()).toThrow('Not connected to AMPP')
		expect(lastStatus(handlers)).toEqual([InstanceStatus.ConnectionFailure, 'ECONNRESET'])

		await vi.advanceTimersByTimeAsync(5_000)
		expect(login).toHaveBeenCalledTimes(2)
		expect(connection.requireSession()).not.toBe(session)
	})

	it('leaves a failure while connecting to the connect attempt, handling it once', async () => {
		const handlers = makeHandlers()
		handlers.load.mockImplementationOnce(async () => {
			const e = new AmppConnectionError('ECONNRESET')
			fakes.reportFailure(e)
			throw e
		})
		const connection = new Connection(handlers)

		connection.start('ampp.example.com', 'key')
		await flush()

		expect(handlers.log.mock.calls.filter(([level]) => level === 'error')).toEqual([
			['error', 'AMPP connection failed: ECONNRESET'],
		])
		expect(lastStatus(handlers)).toEqual([InstanceStatus.ConnectionFailure, 'ECONNRESET'])
	})

	it('waits for new settings when the credentials stop working while connected', async () => {
		const handlers = makeHandlers()
		const connection = new Connection(handlers)
		connection.start('ampp.example.com', 'key')
		await flush()

		fakes.reportFailure(new AmppAuthError('Key revoked'))
		await vi.advanceTimersByTimeAsync(120_000)

		expect(lastStatus(handlers)).toEqual([InstanceStatus.AuthenticationFailure, 'Key revoked'])
		expect(login).toHaveBeenCalledOnce()
	})

	it('reloads when the fabrics change', async () => {
		const handlers = makeHandlers()
		handlers.fabricsChanged.mockReturnValue(true)
		const connection = new Connection(handlers)
		connection.start('ampp.example.com', 'key')
		await flush()
		const session = connection.requireSession()
		const listFabrics = vi.spyOn(session.apis.matrix, 'listFabrics').mockResolvedValue([])

		await vi.advanceTimersByTimeAsync(60_000)

		expect(listFabrics).toHaveBeenCalledOnce()
		expect(handlers.load).toHaveBeenCalledTimes(2)
	})

	it('holds notifications while a reload runs, even one that fails', async () => {
		const handlers = makeHandlers()
		const connection = new Connection(handlers)
		connection.start('ampp.example.com', 'key')
		await flush()
		const session = connection.requireSession()
		const listener = fakes.listeners[0]
		listener.release.mockClear()
		let failReload = (_e: Error) => {}
		handlers.load.mockImplementationOnce(async () => new Promise<void>((_, reject) => (failReload = reject)))

		const reloading = session.reload()
		await flush()
		expect(listener.hold).toHaveBeenCalledOnce()
		expect(listener.release).not.toHaveBeenCalled()

		failReload(new AmppHttpError(500, null, 'Server error'))
		await reloading
		expect(listener.release).toHaveBeenCalledOnce()
		expect(handlers.log).toHaveBeenCalledWith('warn', 'Could not refresh the lists: Server error')
	})

	it("doesn't open the notification hub when stopped while logging in", async () => {
		let finishLogin = () => {}
		login.mockImplementationOnce(async () => new Promise<void>((resolve) => (finishLogin = resolve)))
		const handlers = makeHandlers()
		const connection = new Connection(handlers)

		connection.start('ampp.example.com', 'key')
		await connection.stop()
		finishLogin()
		await flush()

		expect(fakes.listeners).toHaveLength(0)
		expect(handlers.load).not.toHaveBeenCalled()
	})
})
