import type ModuleInstance from './main.js'
import { destinationOption, DISCONNECT_CHOICE, sourceOption } from './options.js'

export type ActionsSchema = {
	route: {
		options: {
			source: string
			destination: string
		}
	}
	lock: {
		options: {
			destination: string
			lock_state: 'L' | 'U'
		}
	}
	rename_source: {
		options: {
			source: string
			label: string
		}
	}
	rename_destination: {
		options: {
			destination: string
			label: string
		}
	}
}

export function UpdateActions(self: ModuleInstance): void {
	const sourceChoices = self.state.sourceChoices()
	const destination = destinationOption(self.state.destinationChoices())
	const label = {
		id: 'label',
		type: 'textinput',
		label: 'New label',
		description: 'Sets the AMPP alias; leave empty to reset it to the name',
		default: '',
	} as const

	self.setActionDefinitions({
		route: {
			name: 'Route source to destination',
			description: 'Choose (Disconnect) as the source to clear the destination',
			options: [sourceOption([DISCONNECT_CHOICE, ...sourceChoices]), destination],
			callback: async (event) => {
				await self.route(event.options.source, event.options.destination)
			},
		},
		lock: {
			name: 'Lock or unlock destination',
			options: [
				destination,
				{
					id: 'lock_state',
					type: 'dropdown',
					label: 'State',
					choices: [
						{ id: 'L', label: 'Lock' },
						{ id: 'U', label: 'Unlock' },
					],
					default: 'L',
				},
			],
			callback: async (event) => {
				await self.setLocked(event.options.destination, event.options.lock_state === 'L')
			},
		},
		rename_source: {
			name: 'Rename source',
			options: [sourceOption(sourceChoices), label],
			callback: async (event) => {
				await self.rename('source', event.options.source, event.options.label)
			},
		},
		rename_destination: {
			name: 'Rename destination',
			options: [destination, label],
			callback: async (event) => {
				await self.rename('destination', event.options.destination, event.options.label)
			},
		},
	})
}
