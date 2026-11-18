import type ModuleInstance from './main.js'
import { appOption, destinationOption, DISCONNECT_CHOICE, sourceOption } from './options.js'

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
	select_destination: {
		options: {
			destination: string
		}
	}
	select_source: {
		options: {
			source: string
			wait_for_take: boolean
		}
	}
	take: {
		options: Record<string, never>
	}
	clear_selected_source: {
		options: Record<string, never>
	}
	start_app: {
		options: { app: string }
	}
	stop_app: {
		options: { app: string }
	}
	restart_app: {
		options: { app: string }
	}
}

export function UpdateActions(self: ModuleInstance): void {
	const sourceChoices = self.state.sourceChoices()
	const app = appOption(self.state.appChoices())
	const sourceOrDisconnect = sourceOption([DISCONNECT_CHOICE, ...sourceChoices])
	const destination = destinationOption(self.state.destinationChoices())
	const label = {
		id: 'label',
		type: 'textinput',
		label: 'New Label',
		description: 'Sets the AMPP alias; leave empty to reset it to the name',
		default: '',
	} as const

	self.setActionDefinitions({
		route: {
			name: 'Route Source',
			description: 'Choose (Disconnect) as the source to clear the destination',
			options: [sourceOrDisconnect, destination],
			callback: async (event) => {
				await self.route(event.options.source, event.options.destination)
			},
		},
		lock: {
			name: 'Lock Destination',
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
			name: 'Rename Source',
			options: [sourceOption(sourceChoices), label],
			callback: async (event) => {
				await self.rename('source', event.options.source, event.options.label)
			},
		},
		rename_destination: {
			name: 'Rename Destination',
			options: [destination, label],
			callback: async (event) => {
				await self.rename('destination', event.options.destination, event.options.label)
			},
		},
		select_destination: {
			name: 'Select Destination',
			description: 'Choose the destination that Select Source routes to',
			options: [destination],
			callback: (event) => self.selectDestination(event.options.destination),
		},
		select_source: {
			name: 'Select Source',
			description:
				'Route a source to the selected destination, or select it to route on Take. Choose (Disconnect) to clear the destination',
			options: [
				sourceOrDisconnect,
				{
					id: 'wait_for_take',
					type: 'checkbox',
					label: 'Wait For Take',
					description: 'Select the source to route when a Take button is pressed, rather than routing it straight away',
					default: false,
				},
			],
			callback: async (event) => self.selectSource(event.options.source, event.options.wait_for_take),
		},
		take: {
			name: 'Take',
			description: 'Route the source waiting for Take to the selected destination',
			options: [],
			callback: async () => self.take(),
		},
		clear_selected_source: {
			name: 'Clear Selected Source',
			options: [],
			callback: () => self.clearSelectedSource(),
		},
		start_app: {
			name: 'Start App',
			options: [app],
			callback: async (event) => self.controlApp('start', event.options.app),
		},
		stop_app: {
			name: 'Stop App',
			options: [app],
			callback: async (event) => self.controlApp('stop', event.options.app),
		},
		restart_app: {
			name: 'Restart App',
			options: [app],
			callback: async (event) => self.controlApp('restart', event.options.app),
		},
	})
}
