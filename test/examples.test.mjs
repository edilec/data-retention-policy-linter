import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, projectDirectory, raisedRules } from './support.mjs'

/**
 * The shipped examples, run the way the README says to run them.
 *
 * `npm run example` is part of `npm run check`, so the clean example failing
 * would already break the build. These cases add the three that are supposed to
 * be interesting -- an example whose output nobody asserts is an example that
 * stops matching the tool it documents.
 */

const EXAMPLES = Object.freeze(['broken', 'clean', 'held', 'incomplete'])

async function example(name, extraArgs = []) {
  const root = join(projectDirectory, 'examples', name)
  const result = await cliRun(['--root', root, '--json', ...extraArgs])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

const rowFor = (report, id) => report.classes.find((row) => row.id === id)

test('every example directory holds exactly the four documents', async () => {
  for (const name of EXAMPLES) {
    const entries = (await readdir(join(projectDirectory, 'examples', name))).sort()
    assert.deepEqual(entries, ['classes.json', 'holds.json', 'jobs.json', 'policies.json'], name)
  }
})

test('the clean example passes with nothing to report', async () => {
  const { code, report } = await example('clean')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 4)
  assert.equal(report.summary.deletionRecommended, 4)
  assert.deepEqual(report.environments, ['production', 'warm-standby'])
})

test('the clean example records a released hold without letting it block anything', async () => {
  const { report } = await example('clean')
  const row = rowFor(report, 'support.transcripts')

  assert.deepEqual(row.holds, ['matter-1180-closed'])
  assert.deepEqual(row.activeHolds, [])
  assert.equal(row.recommendation, 'eligible')
  assert.deepEqual(row.reasons, [])
})

test('the broken example completes and fails, with a verdict rather than a gap', async () => {
  const { code, report } = await example('broken')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.deepEqual(raisedRules(report), [
    'class-owner-missing',
    'class-uncovered-by-job',
    'environment-coverage-partial',
    'environment-duration-conflict',
    'job-class-unknown',
    'retention-below-minimum',
  ])
  assert.equal(report.summary.errors, 6)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.undecided, 0, 'nothing here is unknown; it is simply wrong')
  assert.equal(report.summary.deletionRecommended, 0)
  assert.equal(report.summary.blocked, 4)
})

test('the broken example says, per class, which conflict blocked it', async () => {
  const { report } = await example('broken')

  assert.deepEqual(rowFor(report, 'billing.invoices').reasons, ['retention-below-minimum'])
  assert.deepEqual(rowFor(report, 'identity.contact-details').reasons, ['retention-conflict'])
  assert.deepEqual(rowFor(report, 'support.transcripts').reasons, ['owner-missing'])
  assert.deepEqual(rowFor(report, 'telemetry.page-views').reasons, ['no-deletion-job'])
})

/**
 * The acceptance case, shipped as an example anybody can run.
 *
 * `support.transcripts` is kept for 180 days, has a regulatory minimum of 90,
 * is owned, is policed in both environments, and is covered by the nightly
 * deletion job. Every retention rule in the file says it may be swept. It is
 * under an active legal hold, so it is not recommended for deletion, and the
 * job that covers it is reported as a conflict to suspend.
 */
test('the held example blocks the held class and recommends the other three', async () => {
  const { code, report } = await example('held')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.deepEqual(raisedRules(report), ['hold-active', 'hold-conflicts-with-job'])
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.blockedByHold, 1)
  assert.equal(report.summary.deletionRecommended, 3)

  const held = rowFor(report, 'support.transcripts')
  assert.equal(held.recommendation, 'blocked-by-hold')
  assert.deepEqual(held.activeHolds, ['matter-2031-discovery'])
  assert.deepEqual(held.deletionJobs, ['nightly-expiry-sweep'])
  assert.deepEqual(held.retention, [
    { environment: 'production', value: 180, unit: 'day' },
    { environment: 'warm-standby', value: 180, unit: 'day' },
  ])
  assert.deepEqual(held.regulatoryMinimum, { value: 90, unit: 'day' })
  assert.deepEqual(held.reasons, ['held-class-has-deletion-job', 'legal-hold-active'])

  for (const id of ['billing.invoices', 'identity.contact-details', 'telemetry.page-views']) {
    assert.equal(rowFor(report, id).recommendation, 'eligible', id)
  }
})

test('the incomplete example is incomplete, and neither unknown is resolved in the permissive direction', async () => {
  const { code, report } = await example('incomplete')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), [
    'environment-duration-ambiguous',
    'hold-coverage-unknown',
    'hold-status-unsupported',
  ])
  assert.equal(report.summary.undecided, 2)
  assert.equal(report.summary.deletionRecommended, 0)

  assert.deepEqual(rowFor(report, 'analytics.sessions').reasons, [
    'legal-hold-evidence-incomplete',
    'retention-conflict-ambiguous',
  ])
  assert.deepEqual(rowFor(report, 'billing.invoices').reasons, ['legal-hold-evidence-incomplete'])
  assert.equal(report.summary.holds, 0, 'the hold with an unimplemented status compiled to nothing')
})

test('every example is byte-identical on a second run', async () => {
  for (const name of EXAMPLES) {
    const first = await example(name)
    const second = await example(name)
    assert.equal(first.stdout, second.stdout, name)
  }
})
