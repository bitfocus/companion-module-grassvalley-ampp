import { InstanceStatus } from '@companion-module/base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DISCONNECT_SOURCE } from '../src/options.js'
import { appVariablePrefix, destinationVariablePrefix, nodeVariablePrefix } from '../src/variables.js'
import { loadConfig, ModuleHarness } from './harness.js'

const config = loadConfig()

/**
 * The real module against a live AMPP system. Reading runs whenever `.env` has `URL` and `API_KEY`; changing a
 * destination or an app only runs against the targets `.env` names, and each is put back afterwards.
 */
describe.skipIf(!config)('module against live AMPP', () => {
	const harness = new ModuleHarness()
	const state = () => harness.module.state
	const variable = (id: string) => harness.variables.get(id)

	beforeAll(async () => {
		await harness.start(config!)
	})

	afterAll(async () => {
		await harness.stop()
	})

	describe('connecting', () => {
		it('connects and loads the lists', () => {
			expect(harness.status).toBe(InstanceStatus.Ok)
			expect(state().fabrics.length).toBeGreaterThan(0)
			expect(state().destinations.length).toBeGreaterThan(0)
			expect(state().sources.length).toBeGreaterThan(0)
			expect(state().apps.length).toBeGreaterThan(0)
			expect(state().nodes.length).toBeGreaterThan(0)
			expect(harness.logs.filter((l) => l.level === 'error')).toEqual([])
		})
	})

	describe('definitions', () => {
		it('defines every action, feedback and preset section', () => {
			expect(Object.keys(harness.actions).sort()).toEqual(
				[
					'route',
					'lock',
					'rename_source',
					'rename_destination',
					'select_destination',
					'select_source',
					'take',
					'clear_selected_source',
					'start_app',
					'stop_app',
					'restart_app',
				].sort(),
			)
			expect(Object.keys(harness.feedbacks).sort()).toEqual(
				[
					'routed',
					'locked',
					'tally',
					'source_tally',
					'endpoint_enabled',
					'endpoint_running',
					'node_online',
					'destination_selected',
					'routed_to_selected',
					'source_selected',
					'selected_source',
					'app_state',
					'any_app_state',
					'app_error',
				].sort(),
			)
			expect(harness.presets.structure.map((s) => s.id)).toEqual(['routing', 'apps', 'nodes'])
		})

		it('defines every variable it sets', () => {
			const undefinedIds = [...harness.variables.keys()].filter((id) => !(id in harness.variableDefinitions))
			expect(undefinedIds).toEqual([])
		})

		it('offers a destination and source button for each endpoint, and a status button for each app', () => {
			const groups = harness.presets.structure.flatMap((s) => s.definitions)
			const templateValues = (presetId: string) =>
				groups.filter((g) => g.presetId === presetId).flatMap((g) => g.templateValues.map((v: any) => v.value))
			expect(templateValues('routing_destination').sort()).toEqual(
				state()
					.destinations.map((d) => d.id)
					.sort(),
			)
			expect(templateValues('routing_source').sort()).toEqual(
				state()
					.sources.map((s) => s.id)
					.sort(),
			)
			expect(templateValues('app_status').sort()).toEqual(
				state()
					.apps.map((a) => a.id)
					.sort(),
			)
		})
	})

	describe('state', () => {
		it("publishes each destination's routed source", () => {
			for (const destination of state().destinations) {
				const prefix = destinationVariablePrefix(destination.id)
				expect(variable(`${prefix}_source_id`)).toBe(destination.routedProducerId ?? '')
				expect(variable(`${prefix}_name`)).toBe(destination.shortLabel)
			}
		})

		it('shows each route, lock state and app state through the feedbacks', () => {
			for (const destination of state().destinations) {
				expect(harness.feedback('locked', { destination: destination.id })).toBe(destination.locked)
				if (destination.routedProducerId) {
					expect(
						harness.feedback('routed', { source: destination.routedProducerId, destination: destination.id }),
					).toBe(true)
				}
			}
			for (const app of state().apps) {
				expect(harness.feedback('app_state', { app: app.id, state: app.state ?? '' })).toBe(!!app.state)
				expect(harness.feedback('app_error', { app: app.id })).toBe(state().appHasError(app))
				expect(variable(`${appVariablePrefix(app.id)}_state`)).toBe(app.state ?? '')
			}
			expect(variable('apps_total')).toBe(state().apps.length)
		})

		it('shows each node online, with its metrics arriving as notifications', async () => {
			for (const node of state().nodes) expect(harness.feedback('node_online', { node: node.id })).toBe(node.online)
			// Nodes send performance metrics every few seconds
			const online = state().nodes.find((n) => n.online)!
			await harness.waitFor(
				() => typeof variable(`${nodeVariablePrefix(online.id)}_cpu`) === 'number',
				30_000,
				`metrics from ${online.name}`,
			)
		})
	})

	const destinationTarget = config?.destination && config.source ? config : null

	describe.skipIf(!destinationTarget)('changing the test destination', () => {
		const destination = () => state().findDestination(destinationTarget!.destination!)!
		const source = () => state().findSource(destinationTarget!.source!)!
		const prefix = () => destinationVariablePrefix(destination().id)
		let original: { sourceId: string | null; locked: boolean; alias: string | null }

		beforeAll(() => {
			expect(destination(), `destination ${destinationTarget!.destination} on AMPP`).toBeDefined()
			expect(source(), `source ${destinationTarget!.source} on AMPP`).toBeDefined()
			expect(source().fabricId).toBe(destination().fabricId)
			original = { sourceId: destination().routedProducerId, locked: destination().locked, alias: destination().alias }
		})

		afterAll(async () => {
			// Put it back however the tests ended: every step, so one failing doesn't leave the rest changed
			const failures: string[] = []
			const step = async (what: string, run: () => Promise<void>) => {
				try {
					await run()
				} catch (e) {
					failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
				}
			}
			const id = destination().id
			if (destination().alias !== original.alias) {
				// An empty label resets the alias to the name, which is what an alias equal to the name reads as
				const label = original.alias && original.alias !== destination().name ? original.alias : ''
				await step('restore the alias', async () => harness.runAction('rename_destination', { destination: id, label }))
			}
			if (destination().locked) {
				await step('unlock', async () => harness.runAction('lock', { destination: id, lock_state: 'U' }))
			}
			if (destination().routedProducerId !== original.sourceId) {
				const source = original.sourceId ?? DISCONNECT_SOURCE
				await step('restore the route', async () => harness.runAction('route', { source, destination: id }))
			}
			if (original.locked) {
				await step('lock again', async () => harness.runAction('lock', { destination: id, lock_state: 'L' }))
			}
			expect(failures, 'restoring the test destination').toEqual([])
		})

		/**
		 * A real source to route that isn't routed already: the test source, else the original one. Disconnect only
		 * as a last resort, as it only completes when the app receiving the route acknowledges the clear, which not
		 * every AMPP app does.
		 */
		const nextSource = (): string => {
			if (destination().routedProducerId !== source().id) return source().id
			return original.sourceId && original.sourceId !== source().id ? original.sourceId : DISCONNECT_SOURCE
		}

		it('routes a source to it', async () => {
			const target = nextSource()
			await harness.runAction('route', { source: target, destination: destination().id })

			expect(variable(`${prefix()}_source_id`)).toBe(target === DISCONNECT_SOURCE ? '' : target)
			expect(variable('last_route_status')).toMatch(/Routed|Cleared|Removed/)
			if (target !== DISCONNECT_SOURCE) {
				expect(harness.feedback('routed', { source: target, destination: destination().id })).toBe(true)
			}
		})

		it('routes by selecting the destination, then a source, then Take', async () => {
			const target = nextSource()
			await harness.runAction('select_destination', { destination: destination().id })
			expect(variable('selected_destination_id')).toBe(destination().id)
			expect(harness.feedback('destination_selected', { destination: destination().id })).toBe(true)

			await harness.runAction('select_source', { source: target, wait_for_take: true })
			expect(variable('selected_source_id')).toBe(target)
			expect(harness.feedback('selected_source', {})).toBe(true)
			expect(harness.feedback('source_selected', { source: target })).toBe(true)

			await harness.runAction('take', {})
			expect(variable('selected_source_id')).toBe('')
			expect(harness.feedback('routed_to_selected', { source: target })).toBe(true)

			await harness.runAction('select_source', { source: target, wait_for_take: true })
			await harness.runAction('clear_selected_source', {})
			expect(harness.feedback('selected_source', {})).toBe(false)
		})

		it('locks and unlocks it', async () => {
			await harness.runAction('lock', { destination: destination().id, lock_state: 'L' })
			expect(variable(`${prefix()}_locked`)).toBe(true)
			expect(harness.feedback('locked', { destination: destination().id })).toBe(true)

			await harness.runAction('lock', { destination: destination().id, lock_state: 'U' })
			expect(variable(`${prefix()}_locked`)).toBe(false)
		})

		it('renames it, seeing the new name come back as a notification', async () => {
			const label = `E2E ${Date.now()}`
			await harness.runAction('rename_destination', { destination: destination().id, label })
			await harness.waitFor(() => destination().alias === label, 15_000, 'the rename to come back')
			expect(variable(`${prefix()}_label`)).toBe(label)
			expect(state().findDestination(label)?.id).toBe(destination().id)
		})
	})

	describe.skipIf(!config?.app)('controlling the test app', () => {
		const app = () => state().findApp(config!.app!)!
		const appState = () => variable(`${appVariablePrefix(app().id)}_state`)

		beforeAll(async () => {
			expect(app(), `app ${config!.app} on AMPP`).toBeDefined()
			// Start from Running, so each test sees a whole cycle
			if (app().state !== 'Running') {
				await harness.runAction('start_app', { app: app().id })
				await harness.waitFor(() => appState() === 'Running', 90_000, `${config!.app} to be Running`)
			}
		})

		afterAll(async () => {
			if (app().state === 'Ready') await harness.runAction('start_app', { app: app().id })
		})

		it('stops it, then starts it again', async () => {
			await harness.runAction('stop_app', { app: app().id })
			await harness.waitFor(() => appState() === 'Ready', 60_000, `${config!.app} to stop`)
			expect(harness.feedback('app_state', { app: app().id, state: 'Ready' })).toBe(true)
			expect(harness.checkedFeedbacks).toContain('app_state')

			await harness.runAction('start_app', { app: app().id })
			await harness.waitFor(() => appState() === 'Running', 90_000, `${config!.app} to start`)
			expect(harness.feedback('app_state', { app: app().id, state: 'Running' })).toBe(true)
		})

		it('restarts it, seeing it stop and come back', async () => {
			const seen = new Set<unknown>()
			const watching = harness.waitFor(
				() => {
					seen.add(appState())
					return seen.has('Stopping') && appState() === 'Running'
				},
				90_000,
				`${config!.app} to restart`,
			)
			await harness.runAction('restart_app', { app: app().id })
			await watching
			expect(harness.feedback('app_error', { app: app().id })).toBe(false)
		})
	})

	describe('first load', () => {
		/** A router must never see the route action without its destinations while the lists count as loaded */
		const emptyWhileComplete = (from: number) =>
			harness.actionPublishes.slice(from).filter((p) => p.destinations === 0 && p.firstLoadComplete !== false)

		it('reports first_load_complete once the lists are published, and not before', () => {
			expect(variable('first_load_complete')).toBe(true)
			expect(harness.actionPublishes[0]?.firstLoadComplete).toBe(false)
			expect(emptyWhileComplete(0)).toEqual([])
			expect(harness.loadCompletions).toEqual([state().destinations.length])
		})

		it('reports the lists incomplete while reconnecting with new settings, until they have loaded again', async () => {
			const from = harness.actionPublishes.length
			await harness.module.configUpdated({ platformUrl: config!.url }, { apiKey: config!.apiKey })
			expect(variable('first_load_complete')).toBe(false)

			await harness.waitFor(() => variable('first_load_complete') === true, 30_000, 'the lists to load again')
			await harness.waitFor(() => harness.status === InstanceStatus.Ok, 30_000, 'the module to connect again')
			expect(emptyWhileComplete(from)).toEqual([])
			expect(harness.loadCompletions.at(-1)).toBe(state().destinations.length)
			expect(state().destinations.length).toBeGreaterThan(0)
		})
	})
})
