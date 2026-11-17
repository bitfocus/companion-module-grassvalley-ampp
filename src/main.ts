import { InstanceBase, type SomeCompanionConfigField } from '@companion-module/base'
import { Connection, type Session } from './api/Connection.js'
import type { PlatformNotification } from './api/Notifications.js'
import * as commands from './commands.js'
import { applyClusterEvents } from './state/clusterEvents.js'
import { applyLoadedState, loadState } from './state/loadState.js'
import { applyMatrixEvents } from './state/matrixEvents.js'
import { RouterState, type StateChanges } from './state/RouterState.js'
import { oncePerTurn } from './util/oncePerTurn.js'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import {
	destinationVariableValues,
	nodeVariableValues,
	sourceVariableValues,
	UpdateVariableDefinitions,
	type VariablesSchema,
} from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	secrets!: ModuleSecrets
	readonly state = new RouterState()
	#warnedNoFabrics = false
	// Notifications are applied as they arrive, then published together once the burst they arrived in is done
	readonly #publishSoon = oncePerTurn(() => this.publishChanges())

	readonly #connection = new Connection({
		log: (level, message) => this.log(level, message),
		updateStatus: (status, message) => this.updateStatus(status, message),
		load: async (session) => this.#load(session),
		fabricsChanged: (fabrics) => this.state.fabricsDiffer(fabrics),
		onNotifications: (notifications, session) => this.#handleNotifications(notifications, session),
	})

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()
		this.setVariableValues({ last_route: '', last_route_status: '', last_route_error: '' })

		this.#startConnection()
	}

	async destroy(): Promise<void> {
		this.#publishSoon.cancel()
		await this.#connection.stop()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets
		this.#startConnection()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	async route(sourceRef: string, destinationRef: string): Promise<void> {
		return commands.route(this, this.#connection.requireSession(), sourceRef, destinationRef)
	}

	async setLocked(destinationRef: string, locked: boolean): Promise<void> {
		return commands.setLocked(this, this.#connection.requireSession(), destinationRef, locked)
	}

	async rename(kind: 'source' | 'destination', ref: string, label: string): Promise<void> {
		return commands.rename(this, this.#connection.requireSession(), kind, ref, label)
	}

	/** Push what changed in the state out to variables and feedbacks */
	publishChanges(): void {
		this.#publish(this.state.takeChanges())
	}

	#startConnection(): void {
		this.#warnedNoFabrics = false
		this.#clearState()
		this.#connection.start(this.config.platformUrl ?? '', this.secrets?.apiKey ?? '')
	}

	#clearState(): void {
		if (this.state.sources.length || this.state.destinations.length || this.state.nodes.length) {
			this.state.clear()
			this.publishChanges()
		}
	}

	async #load(session: Session): Promise<void> {
		const loaded = await loadState(session.apis, (message) => this.log('warn', message))
		if (session.signal.aborted) return

		applyLoadedState(this.state, loaded)
		const changes = this.state.takeChanges()
		if (changes.lists) {
			this.log(
				'info',
				`Loaded ${this.state.sources.length} source(s) and ${this.state.destinations.length} destination(s) from ${this.state.fabrics.length} fabric(s), and ${this.state.nodes.length} node(s)`,
			)
		}
		// Once until fabrics appear, rather than on every reload
		if (this.state.fabrics.length) {
			this.#warnedNoFabrics = false
		} else if (!this.#warnedNoFabrics) {
			this.#warnedNoFabrics = true
			this.log('warn', 'This AMPP account has no fabrics, so there is nothing to route')
		}
		this.#publish(changes)
	}

	#publish(changes: StateChanges): void {
		if (changes.all || changes.lists) {
			this.#stateUpdated(changes.lists)
			return
		}
		if (changes.destinations.length) {
			this.setVariableValues(destinationVariableValues(this.state, changes.destinations))
			this.checkFeedbacks('routed', 'locked', 'tally', 'endpoint_enabled', 'endpoint_running')
		}
		if (changes.sources.length) {
			this.setVariableValues(sourceVariableValues(this.state, changes.sources))
			this.checkFeedbacks('source_tally', 'endpoint_enabled', 'endpoint_running')
		}
		const nodes = new Set([...changes.nodes, ...changes.nodeMetrics])
		if (nodes.size) this.setVariableValues(nodeVariableValues([...nodes]))
		if (changes.nodes.length) this.checkFeedbacks('node_online')
	}

	/** Push everything out; definitions only need regenerating when the endpoints, nodes or their labels changed */
	#stateUpdated(listsChanged: boolean): void {
		// Variables first: a router reading the new action choices expects each port's fabric and label to be set
		if (listsChanged) this.updateVariableDefinitions()
		this.setVariableValues({
			...destinationVariableValues(this.state, this.state.destinations),
			...sourceVariableValues(this.state, this.state.sources),
			...nodeVariableValues(this.state.nodes),
		})
		if (listsChanged) {
			this.updateActions()
			this.updateFeedbacks()
			// Presets reference the feedbacks, so they go after them
			this.updatePresets()
		}
		this.checkAllFeedbacks()
	}

	#handleNotifications(notifications: readonly PlatformNotification[], session: Session): void {
		const reload = applyMatrixEvents(this.state, notifications)
		applyClusterEvents(this.state, notifications)
		if (reload) void session.reload()
		this.#publishSoon.schedule()
	}
}
