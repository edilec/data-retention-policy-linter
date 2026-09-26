/**
 * Retention durations, as explicit units.
 *
 * A retention period in an export is written one of two ways: as a structured
 * value with a unit, or as a string somebody intends the reader to parse --
 * `"30d"`, `"P7Y"`, `"6 months"`. This package reads the first and refuses the
 * second. Parsing a duration out of a string is where a linter starts guessing:
 * `"1m"` is a minute to one exporter and a month to another, and the cost of
 * guessing wrong here is a deletion recommendation against data that was
 * supposed to be kept. A string duration is reported as unsupported and the
 * policy carrying it is not evaluated.
 *
 * ## Why a duration is an interval and not a number
 *
 * A day is a day and a week is seven of them. A month is not a fixed number of
 * days and neither is a year. Converting `{"value": 1, "unit": "month"}` into
 * "30 days" invents a precision the input never had, and the invention is not
 * harmless: `30 days` against a regulatory minimum of `1 month` would be
 * reported as satisfied on a 30-day month and as a violation on a 31-day one.
 *
 * So every duration compiles to the closed interval of days it can possibly
 * span, and comparisons answer one of four things: definitely less, definitely
 * greater, definitely equal, or **ambiguous**. Ambiguous is not rounded away
 * and it is not quietly resolved in either direction: it is a finding, it makes
 * the run incomplete, and the class it concerns never receives a deletion
 * recommendation. A linter that cannot tell whether a policy meets its
 * regulatory minimum must say so.
 */

/** The units this build implements. A unit outside this list is refused, never approximated. */
export const UNITS = Object.freeze(['day', 'month', 'week', 'year'])

/**
 * The closed interval of days one of each unit can span.
 *
 * A month is 28 to 31 days; a year is 365 or 366. These are facts about the
 * Gregorian calendar, not a configuration, which is why they are frozen here
 * rather than exposed as an option: a caller who could widen `year` to 360
 * could make a violation disappear.
 */
export const UNIT_DAYS = Object.freeze({
  day: Object.freeze([1, 1]),
  week: Object.freeze([7, 7]),
  month: Object.freeze([28, 31]),
  year: Object.freeze([365, 366]),
})

/** The keys a duration object may carry. Anything else is refused rather than ignored. */
export const DURATION_KEYS = Object.freeze(['unit', 'value'])

/**
 * Compile one declared duration.
 *
 * Returns `{ ok: true, duration }` or `{ ok: false, reason, detail }`. The
 * reasons are distinct because they mean different things to a reader: a
 * string duration is a construct this build declines to guess at, an unknown
 * unit is a vocabulary this build does not implement, and a malformed object is
 * simply wrong.
 */
export function compileDuration(value, maxValue) {
  if (typeof value === 'string') {
    return { ok: false, reason: 'string', detail: value.length }
  }
  if (typeof value === 'number') {
    return { ok: false, reason: 'bare-number', detail: value }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'shape' }
  }
  const stray = Object.keys(value).filter((key) => !DURATION_KEYS.includes(key))
  if (stray.length > 0) return { ok: false, reason: 'stray-keys', detail: stray }
  if (typeof value.unit !== 'string') return { ok: false, reason: 'unit-shape' }
  if (!UNITS.includes(value.unit)) return { ok: false, reason: 'unit-unsupported', detail: value.unit }
  if (!Number.isInteger(value.value) || value.value < 0) return { ok: false, reason: 'value-shape' }
  if (value.value > maxValue) return { ok: false, reason: 'value-range', detail: value.value }

  const [low, high] = UNIT_DAYS[value.unit]
  return {
    ok: true,
    duration: Object.freeze({
      value: value.value,
      unit: value.unit,
      minDays: value.value * low,
      maxDays: value.value * high,
    }),
  }
}

/** `7 day`, `1 month`, `10 year` -- the spelling used in every message and every row. */
export function formatDuration(duration) {
  return `${duration.value} ${duration.unit}`
}

/** True when two durations are written identically. `7 day` and `7 day`, not `7 day` and `1 week`. */
export function sameExpression(left, right) {
  return left.value === right.value && left.unit === right.unit
}

/** A duration that can span only one number of days: everything in days or weeks. */
export function isExact(duration) {
  return duration.minDays === duration.maxDays
}

/**
 * Compare two durations.
 *
 * Returns `'less'`, `'greater'`, `'equal'` or `'ambiguous'`. The first three are
 * claims: they hold for every calendar the intervals allow. `'ambiguous'` says
 * the intervals overlap without coinciding, so the two orders are both
 * possible, and this package never picks one.
 *
 * `1 month` against `30 day` is the worked example: [28, 31] overlaps [30, 30],
 * so the month is shorter in a February and longer in a March, and no answer
 * about which is bigger is true all year.
 */
export function compareDurations(left, right) {
  if (sameExpression(left, right)) return 'equal'
  if (left.maxDays < right.minDays) return 'less'
  if (left.minDays > right.maxDays) return 'greater'
  if (isExact(left) && isExact(right) && left.minDays === right.minDays) return 'equal'
  return 'ambiguous'
}

/**
 * Does a retention period meet a regulatory minimum?
 *
 * `'satisfied'`, `'below'` or `'ambiguous'`. `'satisfied'` requires the
 * retention to be at least the minimum for every calendar both intervals allow;
 * `'below'` requires it to fall short for every one of them. Anything between
 * is ambiguous, which is an answer this tool is willing to give and a state a
 * reader has to resolve -- by restating one of the two durations in the other's
 * unit -- before the class can be recommended for deletion.
 */
export function satisfiesMinimum(retention, minimum) {
  const comparison = compareDurations(retention, minimum)
  if (comparison === 'less') return 'below'
  if (comparison === 'greater' || comparison === 'equal') return 'satisfied'
  return 'ambiguous'
}

/**
 * How two environments' retention periods for one class relate.
 *
 * `'equal'`, `'differs'` or `'ambiguous'`. Two environments that keep a class
 * for provably different lengths of time are a conflict a human has to settle;
 * two whose durations merely *might* differ are not a conflict, and calling
 * them one would be a false report. The middle case is named rather than
 * rounded into either neighbour.
 */
export function relateDurations(left, right) {
  const comparison = compareDurations(left, right)
  if (comparison === 'equal') return 'equal'
  if (comparison === 'ambiguous') return 'ambiguous'
  return 'differs'
}
