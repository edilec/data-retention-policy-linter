/**
 * data-retention-policy-linter -- read four exported documents about data
 * retention and report what contradicts what.
 *
 * ## What this tool does not do
 *
 * It deletes nothing. It schedules nothing, triggers nothing, calls nothing and
 * opens no socket. It has no clock, so it cannot and does not say that any
 * particular record is now old enough to remove. Its entire output is a report:
 * four documents came in, and a set of findings and one row per data class went
 * out. `README.md` says the same thing at more length and
 * `docs/retention-rules.md` says what each rule means.
 *
 * ## The one rule everything else is arranged around
 *
 * An **active legal hold outranks every retention rule**. A class under an
 * active hold is never recommended for deletion, whatever its retention period
 * says; a deletion job that covers a held class is reported as a conflict to be
 * suspended, not as evidence the hold does not matter. And hold evidence that
 * could not be read blocks every recommendation in the run, because the hold
 * nobody could read is exactly the hold that would have stopped a deletion.
 *
 * ## Two properties pinned by behaviour rather than by declaration
 *
 * - **Order is by code unit.** Class ids and environment names carry upper
 *   case, `-`, `_`, `.` and `/`, all of which collate differently from their
 *   code points, so a locale-aware comparison would name a different
 *   environment in a conflict on a different machine.
 * - **Severity comes from one frozen table.** Severity decides pass from fail,
 *   and `test/severity-exit.test.mjs` pins it by exit code and error count
 *   rather than by comparing the table against a copy of itself.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { compileClasses, compileHolds, compileJobs, compilePolicies } from './documents.mjs'
import { downgradeRecommendations, evaluate } from './evaluate.mjs'
import { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject } from './text.mjs'

export const TOOL_ID = 'data-retention-policy-linter'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_CLASSES_NAME = 'classes.json'
export const DEFAULT_POLICIES_NAME = 'policies.json'
export const DEFAULT_HOLDS_NAME = 'holds.json'
export const DEFAULT_JOBS_NAME = 'jobs.json'

/** The four documents, in the fixed order every loop over them uses. */
const KINDS = Object.freeze(['classes', 'holds', 'jobs', 'policies'])

/**
 * Limits, each enforced and each reported by name when it is reached.
 *
 * Exceeding one is never a silent truncation: it produces a finding that names
 * the limit and marks the run `incomplete`, because a partial walk is not
 * evidence that the part nobody walked was fine. There is no recursion limit
 * because there is no recursive structure in the input: the deepest shape this
 * tool reads is an array of objects holding an array of strings, and every one
 * of those is bounded by name below.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxClassRefs: 200,
  maxClasses: 500,
  maxDurationValue: 100000,
  maxEnvironments: 32,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxHolds: 500,
  maxJobs: 500,
  maxPolicies: 2000,
  maxRuntimeMs: 10000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxClassRefs: 2000,
  maxClasses: 5000,
  maxDurationValue: 1000000,
  maxEnvironments: 256,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxHolds: 5000,
  maxJobs: 5000,
  maxPolicies: 20000,
  maxRuntimeMs: 600000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and demoting one of the error rules below -- say `hold-conflicts-with-job` --
 * turns "a deletion job is pointed at data under legal hold" into a green
 * build. Every finding takes its severity from here and an unknown rule id
 * throws.
 *
 * `test/severity-table.test.mjs` asserts this table against the documented
 * catalog in both directions. That is worth having and it is not the test: a
 * table, a catalog and a test's expected map are three declarations, and one
 * edit that changes all three leaves every assertion comparing them satisfied.
 * `test/severity-exit.test.mjs` drives a real input through the real binary for
 * every rule here and pins the process exit code and the error count with
 * literals instead. An exit code cannot be edited.
 *
 * Only three rules are below `error`, and each is a legitimate state rather
 * than a defect: an active hold (`hold-active`, `info`) is the system working,
 * and a hold or job that names no class, or a class present in some
 * environments and not others (`warning`), is worth a reader's attention
 * without being a contradiction.
 */
export const RULE_SEVERITY = Object.freeze({
  'class-duplicate': 'error',
  'class-invalid': 'error',
  'class-owner-missing': 'error',
  'class-reference-duplicate': 'error',
  'class-uncovered-by-job': 'error',
  'class-unpolicied': 'error',
  'document-invalid': 'error',
  'duration-invalid': 'error',
  'duration-not-structured': 'error',
  'duration-out-of-range': 'error',
  'duration-unit-unsupported': 'error',
  'environment-coverage-partial': 'warning',
  'environment-duration-ambiguous': 'error',
  'environment-duration-conflict': 'error',
  'hold-active': 'info',
  'hold-class-unknown': 'error',
  'hold-conflicts-with-job': 'error',
  'hold-coverage-unknown': 'error',
  'hold-covers-nothing': 'warning',
  'hold-duplicate': 'error',
  'hold-invalid': 'error',
  'hold-status-unsupported': 'error',
  'identifier-invalid': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'job-class-unknown': 'error',
  'job-class-unpolicied': 'error',
  'job-coverage-unknown': 'error',
  'job-covers-nothing': 'warning',
  'job-duplicate': 'error',
  'job-invalid': 'error',
  'minimum-comparison-ambiguous': 'error',
  'no-classes-evaluated': 'error',
  'path-escapes-root': 'error',
  'policy-class-unknown': 'error',
  'policy-coverage-unknown': 'error',
  'policy-duplicate': 'error',
  'policy-invalid': 'error',
  'retention-below-minimum': 'error',
  'schema-version-unsupported': 'error',
  'time-budget-exceeded': 'error',
  'too-many-class-references': 'error',
  'too-many-classes': 'error',
  'too-many-environments': 'error',
  'too-many-findings': 'error',
  'too-many-holds': 'error',
  'too-many-jobs': 'error',
  'too-many-policies': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['classes', 'clock', 'holds', 'jobs', 'limits', 'policies', 'root'])

/** Raised when the run passes its time budget; turned into a finding by the caller. */
class TimeBudgetExceeded extends Error {}

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit that a
 * typo silently disables is a limit that is not enforced, and the CLI turns
 * this throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(`Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`)
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against a path
 * that has not been resolved refuses legitimate files whenever the root is
 * reached through a symbolic link -- a `/var` that is really `/private/var` is
 * enough -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered, because naming a file outside the declared root is a usage error
 * rather than a fact about the subject. This is emphatically *not* the
 * confinement: a symbolic link planted inside the root passes every check in
 * this function, and `resolveInput` is what catches it by resolving the real
 * path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  const parts = normalize(name).split(/[\\/]/)
  if (parts.includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised evidence carefully and left identifiers raw, so a record id holding
 * a newline forged an extra line in the human report.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/retention-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * The message is part of the key because a handful of rules anchor more than
 * one finding at the same pointer on purpose -- a class with two environments
 * below the same regulatory minimum, for one. No two findings share all four
 * components, and `sort` is stable, so even a tie would preserve emission
 * order, which is itself fixed by the documents.
 */
export function compareFindings(left, right) {
  return (
    byCodeUnit(left.location.file, right.location.file) ||
    byCodeUnit(left.location.pointer, right.location.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message)
  )
}

function buildReport(sink, state, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: state.files.classes,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the inputs.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.rows.length,
      errors,
      warnings,
      classes: state.classes,
      policies: state.policies,
      holds: state.holds,
      activeHolds: state.activeHolds,
      jobs: state.jobs,
      environments: state.environments.length,
      deletionRecommended: state.counts.deletionRecommended,
      blockedByHold: state.counts.blockedByHold,
      blocked: state.counts.blocked,
      undecided: state.counts.undecided,
    },
    environments: state.environments,
    classes: state.rows,
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an unresolved
 * target refuses legitimate files, so the root is resolved too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may still exist as a link that resolves nowhere. Confine the
    // nearest existing ancestor first, so a symlinked parent directory cannot
    // decide where a "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text) }
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${error.message}`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
}

const COMPILERS = Object.freeze({
  classes: compileClasses,
  holds: compileHolds,
  jobs: compileJobs,
  policies: compilePolicies,
})

function emptyState(files) {
  return {
    files,
    rows: [],
    environments: [],
    counts: { deletionRecommended: 0, blockedByHold: 0, blocked: 0, undecided: 0 },
    classes: 0,
    policies: 0,
    holds: 0,
    activeHolds: 0,
    jobs: 0,
    incomplete: false,
  }
}

/**
 * Lint a set of exported retention documents.
 *
 * @param {object} options
 * @param {string} options.root Directory holding the four documents.
 * @param {string} [options.classes] Data-class catalog, relative to the root.
 * @param {string} [options.policies] Retention policies, relative to the root.
 * @param {string} [options.holds] Legal holds, relative to the root.
 * @param {string} [options.jobs] Deletion jobs, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @param {Function} [options.clock] Monotonic millisecond source for the time
 *   budget. Injected so a test can drive the budget without waiting, and so
 *   that nothing in this package reads a wall clock.
 * @returns {Promise<object>} the report.
 */
export async function lintRetentionPolicies(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new TypeError('clock must be a function returning milliseconds')

  const names = {
    classes: validateName(options.classes ?? DEFAULT_CLASSES_NAME, '--classes'),
    holds: validateName(options.holds ?? DEFAULT_HOLDS_NAME, '--holds'),
    jobs: validateName(options.jobs ?? DEFAULT_JOBS_NAME, '--jobs'),
    policies: validateName(options.policies ?? DEFAULT_POLICIES_NAME, '--policies'),
  }

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const clock = options.clock ?? (() => performance.now())
  const started = clock()
  const budget = {
    check() {
      if (clock() - started > limits.maxRuntimeMs) throw new TimeBudgetExceeded()
    },
  }

  const sink = new FindingSink()
  const state = emptyState(names)

  const parsed = {}
  for (const kind of KINDS) {
    const name = names[kind]
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      // (1) An input that could not be reached is missing evidence, not a
      // verdict about it.
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep all four documents inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      parsed[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    // (2) Unreadable, undecodable or unparseable bytes are missing evidence too.
    if (loaded === null) state.incomplete = true
    parsed[kind] = loaded
  }

  const compiled = {}
  for (const kind of KINDS) {
    if (parsed[kind] === null) {
      compiled[kind] = null
      continue
    }
    const document = COMPILERS[kind](sink, names[kind], parsed[kind].value, limits)
    // (3) A document whose shape, version or size this build cannot take is a
    // document nothing was learned from.
    if (document === null) state.incomplete = true
    compiled[kind] = document
  }

  for (const kind of KINDS) {
    const document = compiled[kind]
    if (document === null) continue
    // (4) An entry that did not compile was not compared against anything.
    // Reporting `fail` here would claim the whole document was read when part
    // of it was refused.
    if (document.entries.length !== document.declared) state.incomplete = true
    // (5) A class name inside an otherwise well formed hold or job that is not
    // a name leaves that hold's or job's reach partly unknown, which is not the
    // same as knowing what it reaches.
    if ((document.refusedReferences ?? 0) > 0) state.incomplete = true
  }

  if (compiled.classes !== null) state.classes = compiled.classes.entries.length
  if (compiled.policies !== null) state.policies = compiled.policies.entries.length
  if (compiled.holds !== null) {
    state.holds = compiled.holds.entries.length
    state.activeHolds = compiled.holds.entries.filter((hold) => hold.status === 'active').length
  }
  if (compiled.jobs !== null) state.jobs = compiled.jobs.entries.length

  if (KINDS.every((kind) => compiled[kind] !== null)) {
    let result = null
    let timedOut = false
    try {
      result = evaluate(sink, names, compiled, limits, budget)
      /**
       * The re-check after the loop, and the reason this tool has one.
       *
       * A budget that can be exhausted *inside* a loop cannot be trusted to
       * have fired: a tool in this catalog ran out of steps mid-loop, broke,
       * fell through to the success branch and wrote "equivalence confirmed"
       * about a group that did not hold. So the budget is asked again here,
       * after the evaluation has returned, and if it has been passed every
       * conclusion that evaluation reached is downgraded below.
       */
      budget.check()
    } catch (error) {
      if (!(error instanceof TimeBudgetExceeded)) throw error
      timedOut = true
    }

    if (timedOut) {
      // (6) A run that stopped early compared less than it was asked to, and
      // anything it did conclude was concluded on a partial reading.
      state.incomplete = true
      sink.add({
        file: names.classes,
        ruleId: 'time-budget-exceeded',
        message: `The evaluation passed the maxRuntimeMs budget of ${limits.maxRuntimeMs} and stopped; every recommendation it had reached has been downgraded to undecided rather than reported as if the run had finished.`,
        suggestion: 'Raise --max-runtime-ms, or lint fewer classes at a time.',
      })
      if (result !== null) downgradeRecommendations(result, 'time-budget-exceeded')
    }

    if (result === null) {
      // (7) An evaluation that never ran -- today, one refused for naming more
      // environments than the limit allows -- learned nothing about any class.
      state.incomplete = true
    } else {
      state.rows = result.rows
      state.environments = result.environments
      state.counts = result.counts

      // (8) A class whose recommendation is undecided is a class this run could
      // not finish deciding about: a duration comparison with two answers, a
      // policy that would not read, hold evidence that is not complete. Any of
      // those is missing evidence, and missing evidence is never a pass.
      if (result.counts.undecided > 0) state.incomplete = true

      /**
       * (9) The vacuous pass, refused explicitly.
       *
       * Four documents that all compile, with no class left to evaluate, would
       * otherwise report `pass` with `checked: 0` -- green on no evidence at
       * all. This is the only thing standing between that input and a green
       * build, so it is an error, it marks the run incomplete, and
       * `test/incomplete.test.mjs` fails if either half is removed.
       *
       * It is confined to runs that reached the evaluation: a run whose
       * documents could not be read has already said so under its own rule, and
       * repeating it here would backstop those flags so that removing one would
       * change nothing observable.
       */
      if (result.rows.length === 0) {
        state.incomplete = true
        sink.add({
          file: names.classes,
          pointer: '/classes',
          ruleId: 'no-classes-evaluated',
          message: `The run evaluated 0 of ${compiled.classes.declared} declared data class(es), so it has no evidence to be green on.`,
          suggestion: 'Declare the data classes this policy set is meant to cover, and fix whatever stopped the ones that are there from compiling.',
        })
      }
    }
  }

  return buildReport(sink, state, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${summary.checked} of ${summary.classes} data class(es) evaluated across ${summary.environments} environment(s);`
    + ` ${summary.policies} policy(ies), ${summary.holds} hold(s) of which ${summary.activeHolds} active, ${summary.jobs} deletion job(s).`,
    `deletion recommended for ${summary.deletionRecommended}; ${summary.blockedByHold} blocked by an active legal hold,`
    + ` ${summary.blocked} blocked by a conflict, ${summary.undecided} undecided. status ${report.status}.`,
    'This tool deletes nothing and schedules nothing; every line above is a recommendation about a policy.',
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} `
      + `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { RECOMMENDATIONS, REASONS, downgradeRecommendations, evaluate } from './evaluate.mjs'
export {
  DURATION_KEYS, UNITS, UNIT_DAYS, compareDurations, compileDuration, formatDuration,
  isExact, relateDurations, sameExpression, satisfiesMinimum,
} from './duration.mjs'
export {
  CLASS_DOCUMENT_KEYS, CLASS_KEYS, DOCUMENT_SCHEMA_VERSION, HOLD_DOCUMENT_KEYS, HOLD_KEYS,
  HOLD_STATUSES, JOB_DOCUMENT_KEYS, JOB_KEYS, POLICY_DOCUMENT_KEYS, POLICY_KEYS,
  compileClasses, compileHolds, compileJobs, compilePolicies,
} from './documents.mjs'
export {
  EXCERPT_LIMIT, MAX_DESCRIPTION_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_LABEL_LENGTH, byCodeUnit,
  decodeUtf8, describeValue, excerpt, hasForbiddenCharacter, isIdentifier, isLabel, isPlainObject,
} from './text.mjs'
