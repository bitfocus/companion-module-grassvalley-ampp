import fs from 'node:fs'
import path from 'node:path'
import { InstanceStatus } from '@companion-module/base'
import ModuleInstance from '../src/main.js'

/** What the suite runs against, from the repo's gitignored `.env` (or the environment, which wins) */
export interface E2eConfig {
	url: string
	apiKey: string
	/** A destination the suite may route, lock and rename; it restores each afterwards */
	destination: string | null
	/** A source on the destination's fabric to route to it for a moment */
	source: string | null
	/** An app the suite may stop, start and restart */
	app: string | null
}

export function loadConfig(): E2eConfig | null {
	const file = path.resolve(import.meta.dirname, '../.env')
	const fromFile = fs.existsSync(file)
		? Object.fromEntries(
				fs
					.readFileSync(file, 'utf8')
					.split('\n')
					.filter((line) => line.includes('=') && !line.trim().startsWith('#'))
					.map((line) => {
						const i = line.indexOf('=')
						return [
							line.slice(0, i).trim(),
							line
								.slice(i + 1)
								.trim()
								.replace(/^["']|["']$/g, ''),
						]
					}),
			)
		: {}
	const get = (key: string): string | null => process.env[key] || fromFile[key] || null
	const url = get('URL')
	const apiKey = get('API_KEY')
	if (!url || !apiKey) return null
	return {
		url,
		apiKey,
		destination: get('AMPP_E2E_DESTINATION'),
		source: get('AMPP_E2E_SOURCE'),
		app: get('AMPP_E2E_APP'),
	}
}

// Definitions and events are typed by the module's schema; the suite reads them generically
type Definitions = Record<string, any>

/**
 * Runs the real module outside Companion, standing in for the host: it records what the module defines, publishes and
 * logs, and runs its actions and feedbacks as Companion would.
 */
export class ModuleHarness {
	readonly module: ModuleInstance
	readonly variables = new Map<string, unknown>()
	readonly statuses: Array<{ status: InstanceStatus; message: string | null }> = []
	readonly logs: Array<{ level: string; message: string }> = []
	readonly checkedFeedbacks: string[] = []
	actions: Definitions = {}
	feedbacks: Definitions = {}
	variableDefinitions: Definitions = {}
	presets: { structure: Definitions[]; presets: Definitions } = { structure: [], presets: {} }

	constructor() {
		;(globalThis as { COMPANION_LOGGER?: unknown }).COMPANION_LOGGER = (
			_source: string,
			level: string,
			message: string,
		) => this.logs.push({ level, message })

		const context = {
			_isInstanceContext: true,
			id: 'e2e',
			label: 'ampp',
			upgradeScripts: [],
			sharedUdpSocketHandlers: new Map(),
			saveConfig: () => {},
			updateStatus: (status: InstanceStatus, message: string | null) => this.statuses.push({ status, message }),
			setActionDefinitions: (actions: Definitions) => (this.actions = actions),
			setFeedbackDefinitions: (feedbacks: Definitions) => (this.feedbacks = feedbacks),
			setPresetDefinitions: (structure: Definitions[], presets: Definitions) => (this.presets = { structure, presets }),
			setVariableDefinitions: (definitions: Definitions) => (this.variableDefinitions = definitions),
			setVariableValues: (values: Record<string, unknown>) => {
				for (const [id, value] of Object.entries(values)) this.variables.set(id, value)
			},
			getVariableValue: (id: string) => this.variables.get(id),
			checkFeedbacks: (ids: string[]) => this.checkedFeedbacks.push(...ids),
			checkAllFeedbacks: () => this.checkedFeedbacks.push('*'),
			checkFeedbacksById: () => {},
			subscribeActions: () => {},
			unsubscribeActions: () => {},
			unsubscribeFeedbacks: () => {},
			recordAction: () => {},
			oscSend: () => {},
			setCompositeElementDefinitions: () => {},
			sharedUdpSocketJoin: async () => '',
			sharedUdpSocketLeave: async () => {},
			sharedUdpSocketSend: async () => {},
		}
		this.module = new ModuleInstance(context)
	}

	get status(): InstanceStatus | undefined {
		return this.statuses.at(-1)?.status
	}

	/** Start the module as Companion would, and wait for it to connect and load the lists */
	async start(config: E2eConfig): Promise<void> {
		await this.module.init({ platformUrl: config.url }, true, { apiKey: config.apiKey })
		await this.waitFor(() => this.status === InstanceStatus.Ok, 30_000, 'the module to connect')
	}

	async stop(): Promise<void> {
		await this.module.destroy()
	}

	/** Run an action's callback with these options, as a button press would */
	async runAction(actionId: string, options: Record<string, unknown>): Promise<void> {
		const action = this.actions[actionId]
		if (!action) throw new Error(`No action ${actionId}`)
		await action.callback({ id: 'e2e', actionId, controlId: 'e2e', options, surfaceId: undefined }, { type: 'action' })
	}

	/** Evaluate a feedback with these options, as Companion does when it's checked */
	feedback(feedbackId: string, options: Record<string, unknown>): unknown {
		const feedback = this.feedbacks[feedbackId]
		if (!feedback) throw new Error(`No feedback ${feedbackId}`)
		return feedback.callback({ id: 'e2e', feedbackId, controlId: 'e2e', options, type: 'boolean' }, {})
	}

	/** Wait until the module reaches a condition, through its own notifications and timers */
	async waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`)
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
	}
}
