import type { DropdownChoice } from '@companion-module/base'

/** The route action's source for clearing a destination; AMPP ids are GUIDs, so it can't clash with one */
export const DISCONNECT_SOURCE = 'disconnect'
export const DISCONNECT_LABEL = '(Disconnect)'
export const DISCONNECT_CHOICE: DropdownChoice<string> = { id: DISCONNECT_SOURCE, label: DISCONNECT_LABEL }

/** A picker that also takes a value typed as an expression, such as a name */
function pickerOption<Id extends string>(
	id: Id,
	label: string,
	choices: DropdownChoice<string>[],
	expressionDescription: string,
) {
	return {
		id,
		type: 'dropdown',
		label,
		expressionDescription,
		choices,
		default: choices[0]?.id ?? '',
		allowCustom: true,
	} as const
}

type PickerOption<Id extends string> = ReturnType<typeof pickerOption<Id>>

function endpointOption<Id extends string>(id: Id, label: string, choices: DropdownChoice<string>[]): PickerOption<Id> {
	return pickerOption(id, label, choices, `The ID, name or alias of the ${label.toLowerCase()}`)
}

export function sourceOption(choices: DropdownChoice<string>[]): PickerOption<'source'> {
	return endpointOption('source', 'Source', choices)
}

export function destinationOption(choices: DropdownChoice<string>[]): PickerOption<'destination'> {
	return endpointOption('destination', 'Destination', choices)
}

export function sourceOrDestinationOption(choices: DropdownChoice<string>[]): PickerOption<'endpoint'> {
	return endpointOption('endpoint', 'Source Or Destination', choices)
}

export function appOption(choices: DropdownChoice<string>[]): PickerOption<'app'> {
	return pickerOption('app', 'App', choices, 'The ID, name or alias of the app')
}

export function nodeOption(choices: DropdownChoice<string>[]): PickerOption<'node'> {
	return pickerOption('node', 'Node', choices, 'The ID or name of the node')
}
