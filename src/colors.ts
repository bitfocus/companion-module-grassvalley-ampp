import { combineRgb } from '@companion-module/base'

// Button colours for presets and feedbacks. Every button uses white text, so each background is dark enough for it

export const WHITE = combineRgb(255, 255, 255)
export const BLACK = combineRgb(0, 0, 0)
/** Selected */
export const BLUE = combineRgb(0, 102, 204)
/** Routed, Running, something to Take */
export const GREEN = combineRgb(0, 153, 0)
/** Starting or stopping */
export const AMBER = combineRgb(204, 102, 0)
/** Offline, locked, in error */
export const RED = combineRgb(204, 0, 0)
/** On air, as tally lights are */
export const TALLY_RED = combineRgb(255, 0, 0)
