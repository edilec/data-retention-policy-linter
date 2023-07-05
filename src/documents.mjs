/**
 * The four input documents, compiled from parsed JSON into the shapes the
 * evaluator works on.
 *
 * Everything here is shape and vocabulary: is this an object, does it declare a
 * version this build understands, is every key one of the documented ones, is
 * every id a name rather than something that would merely print as one. Nothing
 * here knows whether a class is held, covered or over-retained -- those are
 * questions about the four documents together and they are answered in
 * `evaluate.mjs`.
 *
 * The supported dialect is deliberately small and it is declared rather than
 * approximated. A construct this build does not implement -- a duration written
 * as a string, a legal-hold status outside the two it knows -- is reported as
 * unsupported and makes the run incomplete. It is never quietly treated as the
 * permissive case, which for a tool that recommends deletion is the difference
 * between a cautious answer and a destructive one.
 */

import { compileDuration } from './duration.mjs'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  byCodeUnit,
  describeValue,
  excerpt,
  isIdentifier,
  isLabel,
  isPlainObject,
} from './text.mjs'

/** The only document version this build reads. Anything else is unsupported, not ignored. */
export const DOCUMENT_SCHEMA_VERSION = '1'

export const CLASS_DOCUMENT_KEYS = Object.freeze(['classes', 'schemaVersion'])
export const POLICY_DOCUMENT_KEYS = Object.freeze(['policies', 'schemaVersion'])
export const HOLD_DOCUMENT_KEYS = Object.freeze(['holds', 'schemaVersion'])
export const JOB_DOCUMENT_KEYS = Object.freeze(['jobs', 'schemaVersion'])

export const CLASS_KEYS = Object.freeze(['description', 'id', 'owner', 'regulation', 'regulatoryMinimum'])
export const POLICY_KEYS = Object.freeze(['class', 'description', 'environment', 'retention'])
export const HOLD_KEYS = Object.freeze(['classes', 'description', 'id', 'status'])
export const JOB_KEYS = Object.freeze(['classes', 'description', 'id'])

/**
 * The legal-hold states this build implements.
 *
 * There are exactly two, and a third word is not guessed at. `"lifted"`,
 * `"pending release"` and `"expired"` are all states a real matter-management
 * export can carry, and every one of them would have to be mapped onto `active`
 * or `released` by somebody who knows what the exporter meant. Reading an
 * unrecognised status as released is the single most dangerous default this
 * tool could have, so it does not have it: the hold is refused, the run is
 * incomplete, and while hold evidence is incomplete no class is recommended for
 * deletion at all.
 */
export const HOLD_STATUSES = Object.freeze(['active', 'released'])

/** Rules used for a duration that did not compile, one per distinct reason. */
const DURATION_RULES = Object.freeze({
  'bare-number': 'duration-not-structured',
  shape: 'duration-invalid',
  string: 'duration-not-structured',
  'stray-keys': 'duration-invalid',
  'unit-shape': 'duration-invalid',
  'unit-unsupported': 'duration-unit-unsupported',
  'value-range': 'duration-out-of-range',
  'value-shape': 'duration-invalid',
})

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}

function quoteKeys(keys) {
  return keys.map((key) => `"${excerpt(key, 60)}"`).join(', ')
}

/**
 * Open a document: an object, known keys only, a known version, a list of the
 * right name, and no more entries than the limit allows.
 *
 * Returns the list or `null`. `null` means nothing at all was compiled from the
 * document -- deliberately, rather than a prefix being read and reported as the
 * whole, because "the first 500 classes have owners" is not a question anybody
 * asked.
 */
function openDocument(sink, file, value, spec, limits) {
  if (!isPlainObject(value)) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} must hold a JSON object with "schemaVersion" and "${spec.listKey}"; it holds ${describeValue(value)}.`,
    })
    return null
  }

  const stray = unknownKeys(value, spec.documentKeys)
  if (stray.length > 0) {
    sink.add({
      file,
      pointer: '',
      ruleId: 'document-invalid',
      message: `${file} declares unknown key(s) ${quoteKeys(stray)}; known keys are ${spec.documentKeys.join(', ')}. An unknown key is refused rather than ignored, so a typo cannot disable a check.`,
    })
    return null
  }

  if (value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    sink.add({
      file,
      pointer: '/schemaVersion',
      ruleId: 'schema-version-unsupported',
      message: `${file} declares schemaVersion ${describeValue(value.schemaVersion)}; this build implements version "${DOCUMENT_SCHEMA_VERSION}" only and does not guess at another one.`,
      suggestion: `Re-export the document as schemaVersion "${DOCUMENT_SCHEMA_VERSION}".`,
    })
    return null
  }

  const list = value[spec.listKey]
  if (!Array.isArray(list)) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: 'document-invalid',
      message: `"${spec.listKey}" must be an array; it is ${describeValue(list)}.`,
    })
    return null
  }

  if (list.length > limits[spec.limitKey]) {
    sink.add({
      file,
      pointer: `/${spec.listKey}`,
      ruleId: spec.limitRule,
      message: `${file} declares ${list.length} ${spec.noun}(s), above the ${spec.limitKey} limit of ${limits[spec.limitKey]}; nothing was compiled from it rather than a prefix being read and reported as the whole.`,
      suggestion: `Raise ${spec.limitFlag}, or split the document.`,
    })
    return null
  }

  return list
}

/** The shared entry gate: an object, known keys only, a usable id, a bounded description. */
function openEntry(sink, file, pointer, raw, spec, byId) {
  if (!isPlainObject(raw)) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `A ${spec.noun} entry must be an object; this is ${describeValue(raw)}.`,
    })
    return null
  }

  const stray = unknownKeys(raw, spec.entryKeys)
  if (stray.length > 0) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `This ${spec.noun} declares unknown key(s) ${quoteKeys(stray)}; known keys are ${spec.entryKeys.join(', ')}. Nothing outside that list is read, which is why no record, payload or credential field can reach this tool by accident.`,
    })
    return null
  }

  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION_LENGTH)) {
    sink.add({
      file,
      pointer: `${pointer}/description`,
      ruleId: spec.invalidRule,
      message: `"description" must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters; it is ${describeValue(raw.description)}.`,
    })
    return null
  }

  if (spec.hasId) {
    if (!isIdentifier(raw.id)) {
      sink.add({
        file,
        pointer: `${pointer}/id`,
        ruleId: 'identifier-invalid',
        message: `This ${spec.noun} has no usable id; it is ${describeValue(raw.id)}.`,
        suggestion: 'An id is 1-120 characters from [A-Za-z0-9._:/+-], starting with a letter or digit.',
      })
      return null
    }
    if (byId.has(raw.id)) {
      sink.add({
        file,
        pointer: `${pointer}/id`,
        ruleId: spec.duplicateRule,
        message: `${spec.noun} id "${excerpt(raw.id, 120)}" is declared twice, at ${byId.get(raw.id).pointer} and here; neither copy is authoritative, so this one was refused.`,
      })
      return null
    }
  }

  return raw
}

/**
 * Report a duration that did not compile, and say which rule refused it.
 *
 * The refused value is described, never reproduced: a retention field is a
 * place an exporter can put anything at all, and the pointer already says
 * exactly where to look.
 */
function reportDuration(sink, file, pointer, label, result, limits) {
  const ruleId = DURATION_RULES[result.reason]
  // Built one at a time rather than as a table of every message: `detail` holds
  // a different shape for each reason, so an eager table computes seven strings
  // out of values six of them were never meant to see.
  let message
  if (result.reason === 'bare-number') {
    message = `${label} is a bare number with no unit; a duration is compared as an explicit value and unit, so this one was not read.`
  } else if (result.reason === 'shape') {
    message = `${label} must be an object with "value" and "unit".`
  } else if (result.reason === 'string') {
    message = `${label} is written as a string of ${result.detail} character(s); this build compares explicit units and never parses a duration out of text, because "1m" is a minute to one exporter and a month to another.`
  } else if (result.reason === 'stray-keys') {
    message = `${label} declares unknown key(s) ${quoteKeys(result.detail)}; a duration carries "value" and "unit" and nothing else.`
  } else if (result.reason === 'unit-shape') {
    message = `${label} declares no unit; a duration is compared as an explicit value and unit.`
  } else if (result.reason === 'unit-unsupported') {
    message = `${label} uses the unit "${excerpt(String(result.detail), 40)}", which this build does not implement; supported units are day, week, month and year. It was refused rather than converted into a guess.`
  } else if (result.reason === 'value-range') {
    message = `${label} declares the value ${result.detail}, above the maxDurationValue limit of ${limits.maxDurationValue}; it was refused rather than clamped.`
  } else {
    message = `${label} must declare an integer value of zero or more.`
  }
  sink.add({ file, pointer, ruleId, message })
  return ruleId
}

/** Compile a duration in place, reporting and refusing it if it does not read. */
function readDuration(sink, file, pointer, label, raw, limits) {
  const result = compileDuration(raw, limits.maxDurationValue)
  if (result.ok) return result.duration
  reportDuration(sink, file, pointer, label, result, limits)
  return null
}

const CLASS_SPEC = {
  listKey: 'classes',
  documentKeys: CLASS_DOCUMENT_KEYS,
  entryKeys: CLASS_KEYS,
  invalidRule: 'class-invalid',
  duplicateRule: 'class-duplicate',
  limitRule: 'too-many-classes',
  limitKey: 'maxClasses',
  noun: 'class',
  limitFlag: '--max-classes',
  hasId: true,
}

/**
 * The data-class catalog.
 *
 * A class with no usable owner still compiles. Ownership is a policy question
 * -- "every class needs an owner" is one of the things this tool exists to
 * check -- so it is reported under its own rule against a class that is
 * otherwise evaluated normally, rather than being folded into the shape gate
 * where it would silently remove the class from every other check.
 */
export function compileClasses(sink, file, value, limits) {
  const list = openDocument(sink, file, value, CLASS_SPEC, limits)
  if (list === null) return null

  const entries = []
  const byId = new Map()

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/classes/${index}`
    const raw = openEntry(sink, file, pointer, list[index], CLASS_SPEC, byId)
    if (raw === null) continue

    let ownerRefused = false
    let owner = null
    if (raw.owner === undefined) {
      ownerRefused = true
      sink.add({
        file,
        pointer: `${pointer}/owner`,
        ruleId: 'class-owner-missing',
        message: `Data class "${excerpt(raw.id, 120)}" declares no owner; a retention decision with nobody accountable for it is a decision nobody can approve.`,
        suggestion: 'Name the team or role accountable for this class in "owner".',
      })
    } else if (!isLabel(raw.owner)) {
      ownerRefused = true
      sink.add({
        file,
        pointer: `${pointer}/owner`,
        ruleId: 'class-owner-missing',
        message: `Data class "${excerpt(raw.id, 120)}" has no usable owner; it is ${describeValue(raw.owner)}. An owner is 1-${MAX_LABEL_LENGTH} printable characters.`,
        suggestion: 'Name the team or role accountable for this class in "owner".',
      })
    } else {
      owner = raw.owner
    }

    let regulation = null
    if (raw.regulation !== undefined) {
      if (!isLabel(raw.regulation)) {
        sink.add({
          file,
          pointer: `${pointer}/regulation`,
          ruleId: 'class-invalid',
          message: `"regulation" must be a citation of 1-${MAX_LABEL_LENGTH} printable characters; it is ${describeValue(raw.regulation)}.`,
        })
        continue
      }
      regulation = raw.regulation
    }

    let regulatoryMinimum = null
    let minimumRefused = false
    if (raw.regulatoryMinimum !== undefined) {
      regulatoryMinimum = readDuration(
        sink,
        file,
        `${pointer}/regulatoryMinimum`,
        `The regulatory minimum for "${excerpt(raw.id, 60)}"`,
        raw.regulatoryMinimum,
        limits,
      )
      minimumRefused = regulatoryMinimum === null
    }

    const entry = {
      index,
      pointer,
      id: raw.id,
      owner,
      ownerRefused,
      regulation,
      regulatoryMinimum,
      minimumRefused,
      description: raw.description === undefined ? '' : raw.description,
    }
    byId.set(entry.id, entry)
    entries.push(entry)
  }

  return { declared: list.length, entries, byId }
}

const POLICY_SPEC = {
  listKey: 'policies',
  documentKeys: POLICY_DOCUMENT_KEYS,
  entryKeys: POLICY_KEYS,
  invalidRule: 'policy-invalid',
  duplicateRule: 'policy-duplicate',
  limitRule: 'too-many-policies',
  limitKey: 'maxPolicies',
  noun: 'policy',
  limitFlag: '--max-policies',
  hasId: false,
}

/**
 * The retention policies, one per data class per environment.
 *
 * A refused policy is attributed to its class whenever the entry at least names
 * one readably, so that only that class becomes undecided. When even the class
 * name is unusable the refusal cannot be attributed to anybody, and the caller
 * is told: an unattributed refusal means some class somewhere has a retention
 * rule this run never read, and no class is recommended for deletion on that
 * evidence.
 */
export function compilePolicies(sink, file, value, limits) {
  const list = openDocument(sink, file, value, POLICY_SPEC, limits)
  if (list === null) return null

  const entries = []
  const byClass = new Map()
  const byKey = new Map()
  const refusedByClass = new Map()
  let unattributedRefusals = 0

  const refuse = (raw) => {
    if (isPlainObject(raw) && isIdentifier(raw.class)) {
      refusedByClass.set(raw.class, (refusedByClass.get(raw.class) ?? 0) + 1)
    } else {
      unattributedRefusals += 1
    }
  }

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/policies/${index}`
    const raw = openEntry(sink, file, pointer, list[index], POLICY_SPEC, byKey)
    if (raw === null) {
      refuse(list[index])
      continue
    }

    if (!isIdentifier(raw.class)) {
      sink.add({
        file,
        pointer: `${pointer}/class`,
        ruleId: 'identifier-invalid',
        message: `This policy names no usable data class; "class" is ${describeValue(raw.class)}.`,
        suggestion: 'A class id is 1-120 characters from [A-Za-z0-9._:/+-], starting with a letter or digit.',
      })
      refuse(raw)
      continue
    }

    if (!isIdentifier(raw.environment)) {
      sink.add({
        file,
        pointer: `${pointer}/environment`,
        ruleId: 'identifier-invalid',
        message: `This policy names no usable environment; "environment" is ${describeValue(raw.environment)}.`,
        suggestion: 'An environment name is 1-120 characters from [A-Za-z0-9._:/+-], starting with a letter or digit.',
      })
      refuse(raw)
      continue
    }

    // "|" cannot occur in a class id or an environment name, so no pair of
    // legitimate values can collide on this key by spelling one another.
    const key = `${raw.class}|${raw.environment}`
    const earlier = byKey.get(key)
    if (earlier !== undefined) {
      sink.add({
        file,
        pointer,
        ruleId: 'policy-duplicate',
        message: `Data class "${excerpt(raw.class, 80)}" already has a retention policy for environment "${excerpt(raw.environment, 60)}" at ${earlier.pointer}; neither copy is authoritative, so this one was refused.`,
        suggestion: 'Keep one policy per class per environment.',
      })
      refuse(raw)
      continue
    }

    const retention = readDuration(
      sink,
      file,
      `${pointer}/retention`,
      `The retention period for "${excerpt(raw.class, 60)}" in "${excerpt(raw.environment, 40)}"`,
      raw.retention,
      limits,
    )
    if (retention === null) {
      refuse(raw)
      continue
    }

    const entry = {
      index,
      pointer,
      classId: raw.class,
      environment: raw.environment,
      retention,
      description: raw.description === undefined ? '' : raw.description,
    }
    byKey.set(key, entry)
    if (!byClass.has(entry.classId)) byClass.set(entry.classId, [])
    byClass.get(entry.classId).push(entry)
    entries.push(entry)
  }

  return { declared: list.length, entries, byClass, byKey, refusedByClass, unattributedRefusals }
}

/**
 * A list of class names on a hold or a job.
 *
 * Returns `null` when the list itself is unusable, which refuses the whole
 * entry. Returning a shorter list instead would record a legal hold as covering
 * fewer classes than it names -- and a class wrongly believed to be unheld is
 * exactly the class this tool must never recommend for deletion.
 */
function compileClassList(sink, file, pointer, raw, spec, limits) {
  if (raw === undefined) {
    sink.add({
      file,
      pointer,
      ruleId: spec.invalidRule,
      message: `The ${spec.noun} declares no "classes" list, so there is nothing to compare; declare it, using [] for a ${spec.noun} that deliberately covers no class.`,
    })
    return null
  }
  if (!Array.isArray(raw)) {
    sink.add({
      file,
      pointer: `${pointer}/classes`,
      ruleId: spec.invalidRule,
      message: `"classes" must be an array of data-class names; it is ${describeValue(raw)}.`,
    })
    return null
  }
  if (raw.length > limits.maxClassRefs) {
    sink.add({
      file,
      pointer: `${pointer}/classes`,
      ruleId: 'too-many-class-references',
      message: `"classes" holds ${raw.length} entries, above the maxClassRefs limit of ${limits.maxClassRefs}; the ${spec.noun} was refused rather than read in part.`,
      suggestion: 'Raise --max-class-refs, or split the entry.',
    })
    return null
  }

  const refs = []
  const pointers = new Map()
  const seen = new Set()
  let refused = 0

  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index]
    const refPointer = `${pointer}/classes/${index}`

    if (!isIdentifier(candidate)) {
      refused += 1
      sink.add({
        file,
        pointer: refPointer,
        ruleId: 'identifier-invalid',
        message: `This "classes" entry is not a usable data-class name; it is ${describeValue(candidate)}.`,
        suggestion: 'A class id is 1-120 characters from [A-Za-z0-9._:/+-], starting with a letter or digit.',
      })
      continue
    }

    if (seen.has(candidate)) {
      sink.add({
        file,
        pointer: refPointer,
        ruleId: 'class-reference-duplicate',
        message: `Data class "${excerpt(candidate, 100)}" is listed more than once by this ${spec.noun}; the repeat adds nothing and was counted once.`,
      })
      continue
    }

    seen.add(candidate)
    pointers.set(candidate, refPointer)
    refs.push(candidate)
  }

  return { refs, pointers, refused }
}

const HOLD_SPEC = {
  listKey: 'holds',
  documentKeys: HOLD_DOCUMENT_KEYS,
  entryKeys: HOLD_KEYS,
  invalidRule: 'hold-invalid',
  duplicateRule: 'hold-duplicate',
  limitRule: 'too-many-holds',
  limitKey: 'maxHolds',
  noun: 'hold',
  limitFlag: '--max-holds',
  hasId: true,
}

/**
 * The legal holds.
 *
 * `refused` counts every hold this run could not read completely -- a malformed
 * entry, an unreadable status, a class name that is not a name. The caller
 * treats any non-zero count as "the set of held classes is not fully known",
 * and while that is true no class is recommended for deletion, including
 * classes no surviving hold mentions. A hold nobody could read is precisely the
 * hold that would have stopped a deletion.
 */
export function compileHolds(sink, file, value, limits) {
  const list = openDocument(sink, file, value, HOLD_SPEC, limits)
  if (list === null) return null

  const entries = []
  const byId = new Map()
  let refused = 0
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/holds/${index}`
    const raw = openEntry(sink, file, pointer, list[index], HOLD_SPEC, byId)
    if (raw === null) {
      refused += 1
      continue
    }

    if (typeof raw.status !== 'string' || !HOLD_STATUSES.includes(raw.status)) {
      refused += 1
      sink.add({
        file,
        pointer: `${pointer}/status`,
        ruleId: 'hold-status-unsupported',
        message: `Legal hold "${excerpt(raw.id, 80)}" declares the status ${describeValue(raw.status)}; this build implements ${HOLD_STATUSES.join(' and ')} only. An unrecognised status is never read as released, so the hold was refused and this run reports incomplete hold evidence.`,
        suggestion: `Re-export the hold with status ${HOLD_STATUSES.map((status) => `"${status}"`).join(' or ')}.`,
      })
      continue
    }

    const classes = compileClassList(sink, file, pointer, raw.classes, HOLD_SPEC, limits)
    if (classes === null) {
      refused += 1
      continue
    }
    if (classes.refused > 0) {
      refused += 1
      refusedReferences += classes.refused
    }

    const entry = {
      index,
      pointer,
      id: raw.id,
      status: raw.status,
      classes: classes.refs,
      classPointers: classes.pointers,
      description: raw.description === undefined ? '' : raw.description,
    }
    byId.set(entry.id, entry)
    entries.push(entry)
  }

  return { declared: list.length, entries, byId, refused, refusedReferences }
}

const JOB_SPEC = {
  listKey: 'jobs',
  documentKeys: JOB_DOCUMENT_KEYS,
  entryKeys: JOB_KEYS,
  invalidRule: 'job-invalid',
  duplicateRule: 'job-duplicate',
  limitRule: 'too-many-jobs',
  limitKey: 'maxJobs',
  noun: 'job',
  limitFlag: '--max-jobs',
  hasId: true,
}

/** The deletion jobs. `refused` has the same meaning here that it has for holds. */
export function compileJobs(sink, file, value, limits) {
  const list = openDocument(sink, file, value, JOB_SPEC, limits)
  if (list === null) return null

  const entries = []
  const byId = new Map()
  let refused = 0
  let refusedReferences = 0

  for (let index = 0; index < list.length; index += 1) {
    const pointer = `/jobs/${index}`
    const raw = openEntry(sink, file, pointer, list[index], JOB_SPEC, byId)
    if (raw === null) {
      refused += 1
      continue
    }

    const classes = compileClassList(sink, file, pointer, raw.classes, JOB_SPEC, limits)
    if (classes === null) {
      refused += 1
      continue
    }
    if (classes.refused > 0) {
      refused += 1
      refusedReferences += classes.refused
    }

    const entry = {
      index,
      pointer,
      id: raw.id,
      classes: classes.refs,
      classPointers: classes.pointers,
      description: raw.description === undefined ? '' : raw.description,
    }
    byId.set(entry.id, entry)
    entries.push(entry)
  }

  return { declared: list.length, entries, byId, refused, refusedReferences }
}
