/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees in this package can only be pinned by the second -- an
 * exit code cannot be satisfied by editing a table.
 *
 * Everything here builds *inputs*. Nothing here decides what a test expects: no
 * severity, no rule id, no reason code, no count and no ordering lives in this
 * file, so a test cannot accidentally assert a value against the same
 * declaration that produced it.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { lintRetentionPolicies } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/data-retention-policy-linter.mjs')

/** A structured duration, the only form this tool reads. */
export const duration = (value, unit) => ({ value, unit })

/** One data class. Optional fields are omitted entirely when they are not given. */
export function dataClass(id, owner, extra = {}) {
  const entry = { id }
  if (owner !== undefined) entry.owner = owner
  return { ...entry, ...extra }
}

/** One retention policy, for one class in one environment. */
export function policy(classId, environment, retention, description) {
  const entry = { class: classId, environment, retention }
  if (description !== undefined) entry.description = description
  return entry
}

/** One legal hold. */
export function hold(id, status, classes, description) {
  const entry = { id, status, classes }
  if (description !== undefined) entry.description = description
  return entry
}

/** One deletion job. */
export function job(id, classes, description) {
  const entry = { id, classes }
  if (description !== undefined) entry.description = description
  return entry
}

export const classDocument = (classes) => ({ schemaVersion: '1', classes })
export const policyDocument = (policies) => ({ schemaVersion: '1', policies })
export const holdDocument = (holds) => ({ schemaVersion: '1', holds })
export const jobDocument = (jobs) => ({ schemaVersion: '1', jobs })

/** The four documents, as objects, under their default names. */
export const fixture = (classes, policies, holds, jobs) => ({
  'classes.json': classDocument(classes),
  'policies.json': policyDocument(policies),
  'holds.json': holdDocument(holds),
  'jobs.json': jobDocument(jobs),
})

/**
 * A policy set that raises nothing at all: one owned class, one environment,
 * one deletion job that covers it, and no hold. Tests break exactly one thing
 * in it so that the finding they assert is the only finding there is.
 */
export const clean = () => fixture(
  [dataClass('billing.invoices', 'finance-platform')],
  [policy('billing.invoices', 'production', duration(3, 'year'))],
  [],
  [job('nightly-sweep', ['billing.invoices'])],
)

/**
 * Create a temporary root, write the named files into it, run `body(root)`, and
 * remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'data-retention-policy-linter-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => lintRetentionPolicies({ root, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams; never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/** The row for one data class. */
export const classRow = (report, id) => report.classes.find((row) => row.id === id)

/**
 * A clock that hands out a scripted sequence of millisecond readings and counts
 * how many times it was asked.
 *
 * The time budget is the one bound in this package whose firing depends on when
 * it is checked rather than on what the input contains, so tests drive it by
 * script instead of by waiting. `calls` is readable afterwards, which is what
 * lets a test aim a single over-budget reading at exactly the check that
 * happens after the evaluation loop has returned.
 */
export function scriptedClock(readingFor) {
  const state = { calls: 0 }
  const clock = () => {
    state.calls += 1
    return readingFor(state.calls)
  }
  clock.state = state
  return clock
}

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLM': String.fromCharCode(0x200f),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})
