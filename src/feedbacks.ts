import type { DropdownChoice } from '@companion-module/base'
import { WORKLOAD_STATES, type TallyState, type WorkloadState } from './api/types.js'
import { BLUE, GREEN, RED, TALLY_RED, WHITE } from './colors.js'
import type ModuleInstance from './main.js'
import {
	appOption,
	destinationOption,
	DISCONNECT_CHOICE,
	nodeOption,
	sourceOption,
	sourceOrDestinationOption,
} from './options.js'

export type TallyLevel = Exclude<TallyState, 'Off'> | 'any'

export type FeedbacksSchema = {
	routed: {
		type: 'boolean'
		options: {
			source: string
			destination: string
		}
	}
	locked: {
		type: 'boolean'
		options: {
			destination: string
		}
	}
	tally: {
		type: 'boolean'
		options: {
			destination: string
			level: TallyLevel
		}
	}
	source_tally: {
		type: 'boolean'
		options: {
			source: string
			level: TallyLevel
		}
	}
	endpoint_enabled: {
		type: 'boolean'
		options: {
			endpoint: string
		}
	}
	endpoint_running: {
		type: 'boolean'
		options: {
			endpoint: string
		}
	}
	node_online: {
		type: 'boolean'
		options: {
			node: string
		}
	}
	destination_selected: {
		type: 'boolean'
		options: {
			destination: string
		}
	}
	routed_to_selected: {
		type: 'boolean'
		options: {
			source: string
		}
	}
	source_selected: {
		type: 'boolean'
		options: {
			source: string
		}
	}
	selected_source: {
		type: 'boolean'
		options: Record<string, never>
	}
	app_state: {
		type: 'boolean'
		options: {
			app: string
			state: WorkloadState
		}
	}
	any_app_state: {
		type: 'boolean'
		options: {
			state: WorkloadState
		}
	}
	app_error: {
		type: 'boolean'
		options: {
			app: string
		}
	}
}

/** The feedbacks re-checked whenever an app's state changes */
export const APP_FEEDBACKS = ['app_state', 'any_app_state', 'app_error'] as const

/** The feedbacks re-checked whenever the selected destination or selected source changes */
export const SELECTION_FEEDBACKS = [
	'destination_selected',
	'routed_to_selected',
	'source_selected',
	'selected_source',
] as const

/** Whether an endpoint's tally state counts as on for the chosen level */
export function tallyMatches(state: TallyState | null, level: TallyLevel): boolean {
	if (!state || state === 'Off') return false
	return level === 'any' || state === level
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const source = sourceOption(self.state.sourceChoices())
	const app = appOption(self.state.appChoices())
	const appState = {
		id: 'state',
		type: 'dropdown',
		label: 'State',
		choices: WORKLOAD_STATES.map((state) => ({ id: state, label: state })),
		default: 'Running',
	} as const
	const sourceOrDisconnect = sourceOption([DISCONNECT_CHOICE, ...self.state.sourceChoices()])
	const destination = destinationOption(self.state.destinationChoices())
	const endpoint = sourceOrDestinationOption(self.state.endpointChoices())

	const levelOption = {
		id: 'level',
		type: 'dropdown',
		label: 'Tally',
		choices: [
			{ id: 'High', label: 'High (on air)' },
			{ id: 'Low', label: 'Low (preview)' },
			{ id: 'any', label: 'High or low' },
		] as DropdownChoice<TallyLevel>[],
		default: 'High',
	} as const

	self.setFeedbackDefinitions({
		routed: {
			type: 'boolean',
			name: 'Source Routed',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [source, destination],
			callback: (feedback) => {
				const destination = self.state.findDestination(feedback.options.destination)
				const source = self.state.findSource(feedback.options.source)
				return !!destination && !!source && destination.routedProducerId === source.id
			},
		},
		locked: {
			type: 'boolean',
			name: 'Destination Locked',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [destination],
			callback: (feedback) => !!self.state.findDestination(feedback.options.destination)?.locked,
		},
		tally: {
			type: 'boolean',
			name: 'Destination Tally',
			defaultStyle: { bgcolor: TALLY_RED, color: WHITE },
			options: [destination, levelOption],
			callback: (feedback) =>
				tallyMatches(
					self.state.findDestination(feedback.options.destination)?.tallyState ?? null,
					feedback.options.level,
				),
		},
		source_tally: {
			type: 'boolean',
			name: 'Source Tally',
			defaultStyle: { bgcolor: TALLY_RED, color: WHITE },
			options: [source, levelOption],
			callback: (feedback) =>
				tallyMatches(self.state.findSource(feedback.options.source)?.tallyState ?? null, feedback.options.level),
		},
		endpoint_enabled: {
			type: 'boolean',
			name: 'Endpoint Enabled',
			description: 'Whether a source or destination is enabled',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [endpoint],
			callback: (feedback) => !!self.state.findAnyEndpoint(feedback.options.endpoint)?.enabled,
		},
		endpoint_running: {
			type: 'boolean',
			name: 'Endpoint Running',
			description: 'Whether the AMPP app behind a source or destination is in the Running state',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [endpoint],
			callback: (feedback) => {
				const endpoint = self.state.findAnyEndpoint(feedback.options.endpoint)
				return !!endpoint && self.state.workloadState(endpoint) === 'Running'
			},
		},
		node_online: {
			type: 'boolean',
			name: 'Node Online',
			description: 'Whether an AMPP node is online',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [nodeOption(self.state.nodeChoices())],
			callback: (feedback) => !!self.state.findNodeByRef(feedback.options.node)?.online,
		},
		destination_selected: {
			type: 'boolean',
			name: 'Destination Selected',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [destination],
			callback: (feedback) => {
				const selected = self.selection.destination
				return !!selected && self.state.findDestination(feedback.options.destination) === selected
			},
		},
		routed_to_selected: {
			type: 'boolean',
			name: 'Routed To Selected Destination',
			description: '(Disconnect) matches a selected destination with nothing routed to it',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [sourceOrDisconnect],
			callback: (feedback) => self.selection.isRoutedToSelected(feedback.options.source),
		},
		source_selected: {
			type: 'boolean',
			name: 'Source Selected',
			description: 'Whether this source is selected, waiting for Take',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [sourceOrDisconnect],
			callback: (feedback) => self.selection.isSourceSelected(feedback.options.source),
		},
		selected_source: {
			type: 'boolean',
			name: 'Selected Source',
			description: 'Whether a source is selected, waiting for Take, e.g. to light a Take button',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => self.selection.sourceId !== null,
		},
		app_state: {
			type: 'boolean',
			name: 'App State',
			description: "Whether an app is in this state, as AMPP reports the app's own state (Ready is stopped)",
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [app, appState],
			callback: (feedback) => self.state.findApp(feedback.options.app)?.state === feedback.options.state,
		},
		any_app_state: {
			type: 'boolean',
			name: 'Any App State',
			description: 'Whether any app is in this state, e.g. Error for a system alarm button',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [appState],
			callback: (feedback) => self.state.apps.some((a) => a.state === feedback.options.state),
		},
		app_error: {
			type: 'boolean',
			name: 'App Error',
			description:
				'Whether an app or one of its engines is in Error or reports an error reason, e.g. Unplaced when no node can run it',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [app],
			callback: (feedback) => {
				const found = self.state.findApp(feedback.options.app)
				return !!found && self.state.appHasError(found)
			},
		},
	})
}
