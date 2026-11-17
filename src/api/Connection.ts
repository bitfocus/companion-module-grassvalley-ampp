import { InstanceStatus, type LogLevel } from '@companion-module/base'
import { coalesce } from '../util/coalesce.js'
import { errorMessage } from '../util/errorMessage.js'
import { AmppClient, classifyFailure, normalisePlatformUrl } from './AmppClient.js'
import { ClusterStateApi } from './ClusterStateApi.js'
import { MatrixApi } from './MatrixApi.js'
import {
	CLUSTER_TOPICS,
	createNotificationHub,
	MATRIX_TOPICS,
	NotificationListener,
	type PlatformNotification,
} from './Notifications.js'
import type { AmppFabric } from './types.js'

const RECONNECT_MIN_MS = 5_000
const RECONNECT_MAX_MS = 60_000
// The hub publishes nothing when a fabric is added, removed or renamed, so the fabric list is checked instead
const FABRIC_POLL_MS = 60_000

/** The APIs of a connected session */
export interface Apis {
	matrix: MatrixApi
	cluster: ClusterStateApi
}

/** One connection to AMPP, from logging in until it's ended or drops */
export interface Session {
	readonly apis: Apis
	/** Aborted when the session ends, which cancels its requests; anything still running for it should stop */
	readonly signal: AbortSignal
	/** Reload the lists in the background; a burst of calls gets one (or two) reloads rather than one each */
	reload(): Promise<void>
}

export interface ConnectionHandlers {
	log(level: LogLevel, message: string): void
	updateStatus(status: InstanceStatus, message: string | null): void
	/** Load the lists for a session, throwing if they can't be loaded */
	load(session: Session): Promise<void>
	/** Whether these fabrics differ from the ones last loaded */
	fabricsChanged(fabrics: readonly AmppFabric[]): boolean
	onNotifications(notifications: readonly PlatformNotification[], session: Session): void
}

/**
 * Logs in, subscribes to notifications and loads the lists, reconnecting with backoff when the connection fails.
 * Each attempt has its own AbortController: ending it cancels the attempt's requests and route polling, and closing
 * its listener silences the hub's callbacks, so nothing from an ended session acts afterwards.
 */
export class Connection {
	readonly #handlers: ConnectionHandlers

	#attempt: AbortController | null = null
	#listener: NotificationListener | null = null
	#session: Session | null = null
	#reconnectTimer: NodeJS.Timeout | null = null
	#fabricPollTimer: NodeJS.Timeout | null = null
	#reconnectDelay = RECONNECT_MIN_MS

	constructor(handlers: ConnectionHandlers) {
		this.#handlers = handlers
	}

	requireSession(): Session {
		if (!this.#session) throw new Error('Not connected to AMPP')
		return this.#session
	}

	/** End any current connection and connect with these settings */
	start(platformUrlSetting: string, apiKeySetting: string): void {
		void this.stop()
		this.#reconnectDelay = RECONNECT_MIN_MS

		const platformUrl = normalisePlatformUrl(platformUrlSetting)
		const apiKey = apiKeySetting.trim()
		if (!platformUrl) {
			this.#handlers.updateStatus(InstanceStatus.BadConfig, 'Platform URL is missing or invalid')
			return
		}
		if (!apiKey) {
			this.#handlers.updateStatus(InstanceStatus.BadConfig, 'API key is missing')
			return
		}

		const client: AmppClient = new AmppClient(platformUrl, apiKey, (e) => {
			// A failure while connecting reaches #connect, which handles it
			if (this.#session) this.#handleConnectError(e, client)
		})
		void this.#connect(client)
	}

	/** End the connection entirely; resolves once the notification hub has disconnected */
	async stop(): Promise<void> {
		const closing = this.#endSession()
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer)
			this.#reconnectTimer = null
		}
		await closing
	}

	/** End the current session or connect attempt; a reconnect, if any, is scheduled separately */
	async #endSession(): Promise<void> {
		this.#attempt?.abort(new Error('The connection to AMPP ended'))
		this.#attempt = null
		this.#session = null
		if (this.#fabricPollTimer) {
			clearTimeout(this.#fabricPollTimer)
			this.#fabricPollTimer = null
		}
		const listener = this.#listener
		this.#listener = null
		await listener?.close()
	}

	async #connect(client: AmppClient): Promise<void> {
		const attempt = new AbortController()
		this.#attempt = attempt
		const { signal } = attempt
		const handlers = this.#handlers
		handlers.updateStatus(InstanceStatus.Connecting, null)

		try {
			await client.login()
			if (signal.aborted) return

			// Subscribe before loading the lists, so a change made in between isn't missed
			const hub = createNotificationHub(
				client.baseUrl,
				async () => client.getAccessToken(),
				(level, message) => handlers.log(level, `Notification hub: ${message}`),
			)
			const listener = new NotificationListener(hub, {
				topics: [...MATRIX_TOPICS, ...CLUSTER_TOPICS],
				onNotifications: (notifications) => handlers.onNotifications(notifications, session),
				onInterrupted: () => {
					handlers.updateStatus(InstanceStatus.UnknownWarning, 'Reconnecting to AMPP notifications')
				},
				onResumed: () => {
					handlers.updateStatus(InstanceStatus.Ok, null)
					// Changes made while the hub was down were missed, so reload to catch up
					void session.reload()
				},
				onError: (e) => {
					handlers.log('warn', `Lost AMPP notifications: ${errorMessage(e)}`)
					this.#handleConnectError(e, client)
				},
			})
			// From here #endSession closes it, which silences its callbacks
			this.#listener = listener
			const session: Session = {
				apis: { matrix: new MatrixApi(client, signal), cluster: new ClusterStateApi(client, signal) },
				signal,
				reload: coalesce(async () => this.#refresh(session, listener)),
			}

			await listener.open()
			await handlers.load(session)
			if (signal.aborted) return

			handlers.log('info', 'Connected to AMPP')
			this.#session = session
			listener.release()
			this.#scheduleFabricPoll(session)
			this.#reconnectDelay = RECONNECT_MIN_MS
			handlers.updateStatus(InstanceStatus.Ok, null)
		} catch (e) {
			if (signal.aborted) return
			this.#handleConnectError(e, client)
		}
	}

	/** End the session and, unless the problem needs the user to change the config, reconnect with backoff */
	#handleConnectError(e: unknown, client: AmppClient): void {
		void this.#endSession()

		const message = errorMessage(e)
		this.#handlers.log('error', `AMPP connection failed: ${message}`)

		switch (classifyFailure(e)) {
			// Credential and permission problems won't fix themselves, so wait for the user to change the config
			case 'auth':
				this.#handlers.updateStatus(InstanceStatus.AuthenticationFailure, message)
				return
			case 'permission':
				this.#handlers.updateStatus(InstanceStatus.InsufficientPermissions, `Permission denied: ${message}`)
				return
		}

		this.#handlers.updateStatus(InstanceStatus.ConnectionFailure, message)

		const delay = this.#reconnectDelay
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS)
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null
			void this.#connect(client)
		}, delay)
	}

	/** Reload the lists in the background, logging (rather than throwing) a failure */
	async #refresh(session: Session, listener: NotificationListener): Promise<void> {
		listener.hold()
		try {
			await this.#handlers.load(session)
		} catch (e) {
			// A failure beyond this request has already ended the session
			if (!session.signal.aborted) this.#handlers.log('warn', `Could not refresh the lists: ${errorMessage(e)}`)
		} finally {
			listener.release()
		}
	}

	#scheduleFabricPoll(session: Session): void {
		this.#fabricPollTimer = setTimeout(() => {
			this.#fabricPollTimer = null
			void this.#pollFabrics(session)
		}, FABRIC_POLL_MS)
	}

	/** Reload everything when a fabric was added, removed or renamed; its endpoints may have gone without an event */
	async #pollFabrics(session: Session): Promise<void> {
		try {
			const fabrics = await session.apis.matrix.listFabrics()
			if (this.#handlers.fabricsChanged(fabrics)) {
				this.#handlers.log('info', 'The AMPP fabrics changed, reloading the lists')
				await session.reload()
			}
		} catch (e) {
			if (!session.signal.aborted) this.#handlers.log('warn', `Could not check the AMPP fabrics: ${errorMessage(e)}`)
		}
		if (!session.signal.aborted) this.#scheduleFabricPoll(session)
	}
}
