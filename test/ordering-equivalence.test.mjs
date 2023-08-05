import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, REASONS, RULE_SEVERITY, byCodeUnit } from '../src/index.mjs'
import {
  apiReport,
  classDocument,
  clean,
  dataClass,
  duration,
  fixture,
  hold,
  holdDocument,
  job,
  jobDocument,
  policy,
  policyDocument,
} from './support.mjs'

/**
 * The ordering sites that cannot be pinned, proved equivalent instead of left
 * as gaps.
 *
 * `test/ordering.test.mjs` pins eleven of this package's sixteen ordering
 * sites by emitting a sequence a collator would emit differently. The remaining
 * five order values a collator cannot reorder at all: the reason vocabulary
 * (two sites), JSON Pointers, rule ids, and the message that breaks a tie no
 * two findings ever have. Substituting a collator at those five is an
 * *equivalent* mutation -- the output cannot change, so no test can catch it,
 * and saying so with an enumeration is more honest than either claiming
 * coverage or leaving a gap.
 *
 * Each case below enumerates every ordered pair of the real values and asserts
 * that the two comparisons agree in sign. The pointer case additionally checks
 * that the vocabulary it enumerates still covers everything the tool emits, so
 * that a new pointer shape fails this test rather than quietly widening the
 * alphabet the proof rests on. The limit-name case is here for the opposite
 * reason: those really do collate the other way round, which is what makes the
 * case in `test/ordering.test.mjs` a case at all.
 */

const collator = new Intl.Collator('en')

function disagreeingPairs(values) {
  const pairs = []
  for (const left of values) {
    for (const right of values) {
      if (Math.sign(byCodeUnit(left, right)) !== Math.sign(collator.compare(left, right))) pairs.push([left, right])
    }
  }
  return pairs
}

test('every ordered pair of reason codes collates exactly as it compares by code unit', () => {
  assert.equal(REASONS.length, 15)
  for (const reason of REASONS) assert.match(reason, /^[a-z][a-z-]*[a-z]$/, 'the alphabet this proof rests on')
  assert.deepEqual(disagreeingPairs(REASONS), [])
})

test('every ordered pair of rule ids collates exactly as it compares by code unit', () => {
  const ruleIds = Object.keys(RULE_SEVERITY)

  assert.equal(ruleIds.length > 40, true, 'the catalog must be the real one for this to prove anything')
  for (const ruleId of ruleIds) assert.match(ruleId, /^[a-z][a-z0-9-]*[a-z0-9]$/, 'the alphabet this proof rests on')
  assert.deepEqual(disagreeingPairs(ruleIds), [])
})

test('limit names are not in this file, because a collator really does reorder them', () => {
  // `maxClassRefs` precedes `maxClasses` by code unit, because `R` (U+0052)
  // precedes `e` (U+0065); an English collator compares letters without regard
  // to case at the primary level, puts `e` before `r`, and swaps the pair. That
  // site is therefore pinned by what the tool prints, in
  // `test/ordering.test.mjs`, rather than proved equivalent here.
  assert.deepEqual(
    disagreeingPairs(Object.keys(DEFAULT_LIMITS)),
    [['maxClassRefs', 'maxClasses'], ['maxClasses', 'maxClassRefs']],
  )
})

/**
 * The pointer vocabulary, written out as the shapes the tool can emit.
 *
 * Indices are sampled across the digit-length boundaries where a numeric
 * collator would disagree even though a plain one does not -- 9 before 10, 99
 * before 100 -- because those are the pairs a reviewer would worry about.
 */
const POINTER_SHAPES = Object.freeze([
  { name: 'document', build: () => [''] },
  { name: 'schemaVersion', build: () => ['/schemaVersion'] },
  { name: 'list', build: () => ['/classes', '/policies', '/holds', '/jobs'] },
  { name: 'entry', build: (n) => [`/classes/${n}`, `/policies/${n}`, `/holds/${n}`, `/jobs/${n}`] },
  { name: 'entry id', build: (n) => [`/classes/${n}/id`, `/holds/${n}/id`, `/jobs/${n}/id`] },
  { name: 'entry description', build: (n) => [`/classes/${n}/description`, `/policies/${n}/description`, `/holds/${n}/description`, `/jobs/${n}/description`] },
  { name: 'class field', build: (n) => [`/classes/${n}/owner`, `/classes/${n}/regulation`, `/classes/${n}/regulatoryMinimum`] },
  { name: 'policy field', build: (n) => [`/policies/${n}/class`, `/policies/${n}/environment`, `/policies/${n}/retention`] },
  { name: 'hold status', build: (n) => [`/holds/${n}/status`] },
  { name: 'reference list', build: (n) => [`/holds/${n}/classes`, `/jobs/${n}/classes`] },
  { name: 'reference', build: (n, m) => [`/holds/${n}/classes/${m}`, `/jobs/${n}/classes/${m}`] },
])

const INDEX_SAMPLE = Object.freeze([0, 1, 2, 9, 10, 11, 99, 100, 101])

function pointerVocabulary() {
  const pointers = new Set()
  for (const shape of POINTER_SHAPES) {
    for (const n of INDEX_SAMPLE) {
      for (const m of INDEX_SAMPLE) for (const pointer of shape.build(n, m)) pointers.add(pointer)
    }
  }
  return [...pointers]
}

const SHAPE_PATTERNS = Object.freeze({
  document: /^$/,
  schemaVersion: /^\/schemaVersion$/,
  list: /^\/(classes|policies|holds|jobs)$/,
  entry: /^\/(classes|policies|holds|jobs)\/\d+$/,
  'entry id': /^\/(classes|holds|jobs)\/\d+\/id$/,
  'entry description': /^\/(classes|policies|holds|jobs)\/\d+\/description$/,
  'class field': /^\/classes\/\d+\/(owner|regulation|regulatoryMinimum)$/,
  'policy field': /^\/policies\/\d+\/(class|environment|retention)$/,
  'hold status': /^\/holds\/\d+\/status$/,
  'reference list': /^\/(holds|jobs)\/\d+\/classes$/,
  reference: /^\/(holds|jobs)\/\d+\/classes\/\d+$/,
})

const long = 'd'.repeat(301)

/**
 * Inputs chosen to make the tool emit at least one finding of every pointer
 * shape and, between them, a spread of rule ids anchored at shared pointers.
 *
 * If a later change introduces a shape none of these produce, the completeness
 * assertion below fails -- which is the point. The proof is only as good as the
 * claim that these are all the pointers there are.
 */
const CORPUS = Object.freeze([
  () => apiReport(clean()),
  () => apiReport({ ...clean(), 'classes.json': [] }),
  () => apiReport({ ...clean(), 'policies.json': { schemaVersion: '9', policies: [] } }),
  () => apiReport({ ...clean(), 'holds.json': { schemaVersion: '1', holds: {} } }),
  () => apiReport(fixture([], [], [], [])),
  () => apiReport({ ...clean(), 'classes.json': classDocument([dataClass('billing.invoices', 'finance-platform'), 'not an object']) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance', description: long }]) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'billing.invoices' }]) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance', regulation: 7 }]) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([{ id: 'billing.invoices', owner: 'finance', regulatoryMinimum: '8y' }]) }),
  () => apiReport({ ...clean(), 'classes.json': classDocument([dataClass('billing.invoices', 'f'), dataClass('billing.invoices', 'g')]) }),
  () => apiReport({ ...clean(), 'policies.json': policyDocument([{ class: 4, environment: 'production', retention: duration(1, 'day') }]) }),
  () => apiReport({ ...clean(), 'policies.json': policyDocument([{ class: 'billing.invoices', environment: 4, retention: duration(1, 'day') }]) }),
  () => apiReport({ ...clean(), 'policies.json': policyDocument([policy('billing.invoices', 'production', '30d')]) }),
  () => apiReport({ ...clean(), 'policies.json': policyDocument([policy('billing.invoices', 'production', duration(1, 'day'), long)]) }),
  () => apiReport({
    ...clean(),
    'policies.json': policyDocument([
      policy('billing.invoices', 'production', duration(1, 'day')),
      policy('billing.invoices', 'production', duration(2, 'day')),
    ]),
  }),
  () => apiReport({ ...clean(), 'holds.json': holdDocument([{ id: 'm', status: 'lifted', classes: [] }]) }),
  () => apiReport({ ...clean(), 'holds.json': holdDocument([{ id: 'm', status: 'active', classes: 'billing.invoices' }]) }),
  () => apiReport({ ...clean(), 'holds.json': holdDocument([hold('m', 'active', [4])]) }),
  () => apiReport({ ...clean(), 'holds.json': holdDocument([hold('m', 'active', ['billing.invoices', 'billing.invoices'], long)]) }),
  () => apiReport({ ...clean(), 'holds.json': holdDocument([hold('m', 'active', ['billing.invoices']), hold('m', 'released', [])]) }),
  () => apiReport({ ...clean(), 'jobs.json': jobDocument([{ id: 'sweep' }]) }),
  () => apiReport({ ...clean(), 'jobs.json': jobDocument([job('sweep', ['legacy.clickstream'])]) }),
  () => apiReport({ ...clean(), 'jobs.json': jobDocument([job('sweep', ['billing.invoices'], long)]) }),
  () => apiReport({ ...clean(), 'jobs.json': jobDocument([job('sweep', []), job('sweep', [])]) }),
  () => apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform', { regulatoryMinimum: duration(8, 'year') })],
    [policy('billing.invoices', 'production', duration(3, 'year')), policy('billing.invoices', 'warm-standby', duration(1, 'month'))],
    [hold('m', 'active', ['billing.invoices'])],
    [job('sweep', ['billing.invoices'])],
  )),
  () => apiReport(fixture(
    [dataClass('billing.invoices', 'finance-platform', { regulatoryMinimum: duration(3, 'month') })],
    [policy('billing.invoices', 'production', duration(90, 'day')), policy('billing.invoices', 'warm-standby', duration(90, 'day'))],
    [],
    [job('sweep', [])],
  )),
  () => apiReport(clean(), { limits: { maxFindings: 1 } }),
  () => apiReport(clean(), { limits: { maxClasses: 1, maxPolicies: 1, maxHolds: 1, maxJobs: 1 } }),
  () => apiReport({ ...clean(), 'jobs.json': jobDocument([job('sweep', ['billing.invoices'])]) }, { limits: { maxClassRefs: 1 } }),
  () => apiReport(clean(), { limits: { maxEnvironments: 1, maxPolicies: 2 } }),
  () => apiReport(clean(), { limits: { maxDurationValue: 1 } }),
])

async function corpusReports() {
  const reports = []
  for (const build of CORPUS) reports.push(await build())
  return reports
}

test('the pointer vocabulary this proof enumerates still covers everything the tool emits', async () => {
  const emitted = new Set()
  for (const report of await corpusReports()) {
    for (const finding of report.findings) emitted.add(finding.location.pointer)
  }

  assert.equal(emitted.size > 20, true, 'the corpus must produce a real spread of pointers')

  const covered = new Set()
  for (const pointer of emitted) {
    const shape = Object.entries(SHAPE_PATTERNS).find(([, pattern]) => pattern.test(pointer))
    assert.notEqual(shape, undefined, `pointer "${pointer}" matches no declared shape`)
    covered.add(shape[0])
  }
  assert.deepEqual(
    [...covered].sort(byCodeUnit),
    Object.keys(SHAPE_PATTERNS).sort(byCodeUnit),
    'every declared shape is really emitted, and no other shape is',
  )
})

test('every ordered pair of real pointers collates exactly as it compares by code unit', () => {
  const pointers = pointerVocabulary()

  assert.equal(pointers.length > 300, true)
  assert.deepEqual(disagreeingPairs(pointers), [])
})

test('the rule-id comparison is reached at all, so the enumeration above is about something', async () => {
  const groups = new Map()

  for (const report of await corpusReports()) {
    for (const finding of report.findings) {
      const key = `${finding.location.file}|${finding.location.pointer}`
      if (!groups.has(key)) groups.set(key, new Set())
      groups.get(key).add(finding.ruleId)
    }
  }

  const shared = [...groups.values()].filter((ruleIds) => ruleIds.size > 1)
  assert.equal(shared.length > 0, true, 'some file and pointer really does carry more than one rule id')
})

test('no two findings share a file, a pointer and a rule id, so the message never decides an order', async () => {
  let seen = 0

  for (const report of await corpusReports()) {
    const keys = report.findings.map((finding) => `${finding.location.file}|${finding.location.pointer}|${finding.ruleId}`)
    assert.equal(new Set(keys).size, keys.length, 'two findings would have been separated by their message alone')
    seen += keys.length
  }

  assert.equal(seen > 40, true, 'the corpus really did produce a body of findings')
})
