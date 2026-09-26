#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_CLASSES_NAME,
  DEFAULT_HOLDS_NAME,
  DEFAULT_JOBS_NAME,
  DEFAULT_POLICIES_NAME,
  excerpt,
  exitCodeFor,
  formatReport,
  lintRetentionPolicies,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `data-retention-policy-linter

Check exported data-class retention policies for owners, durations, legal-hold
states, deletion-job references and conflicting environments.

This tool DELETES NOTHING. It reads four JSON documents, writes a report, and
recommends. It opens no socket, runs no job, and has no clock, so it never says
that any particular record is now old enough to remove -- only whether the
policy for a class is consistent and unblocked.

An active legal hold outranks every retention rule: a class under one is never
recommended for deletion, and a deletion job that covers it is reported as a
conflict to suspend.

Usage:
  data-retention-policy-linter --root DIR [--classes FILE] [--policies FILE]
                               [--holds FILE] [--jobs FILE] [--json]
                               [--max-file-bytes N] [--max-classes N]
                               [--max-policies N] [--max-holds N] [--max-jobs N]
                               [--max-class-refs N] [--max-environments N]
                               [--max-duration-value N] [--max-runtime-ms N]
                               [--max-findings N]

Options:
  --root DIR              Directory holding the four documents (required)
  --classes FILE          Data-class catalog, relative to --root
                          (default ${DEFAULT_CLASSES_NAME})
  --policies FILE         Retention policies, relative to --root
                          (default ${DEFAULT_POLICIES_NAME})
  --holds FILE            Legal holds, relative to --root
                          (default ${DEFAULT_HOLDS_NAME})
  --jobs FILE             Deletion jobs, relative to --root
                          (default ${DEFAULT_JOBS_NAME})
  --json                  Suppress the human summary on stderr
  --max-file-bytes N      Maximum bytes per document (default 5242880)
  --max-classes N         Maximum declared data classes (default 500)
  --max-policies N        Maximum declared retention policies (default 2000)
  --max-holds N           Maximum declared legal holds (default 500)
  --max-jobs N            Maximum declared deletion jobs (default 500)
  --max-class-refs N      Maximum class names in one hold or job (default 200)
  --max-environments N    Maximum distinct environments (default 32)
  --max-duration-value N  Maximum numeric value in a duration (default 100000)
  --max-runtime-ms N      Time budget for the evaluation (default 10000)
  --max-findings N        Maximum findings in one report (default 1000)
  -h, --help              Show this help
  -v, --version           Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  The four documents agree with one another: every class has an owner and a
  retention policy, no environment contradicts another about how long a class is
  kept, no policy falls below a declared regulatory minimum, every deletion job
  names classes that exist and are policed, and every class not under an active
  hold is covered by some job. It is a statement about four exported documents
  and nothing else: this tool never inspected a data store, so a pass says the
  written policy is consistent, never that any system obeys it.

Exit codes:
  0  the documents were linted and nothing contradicted them
  1  the documents were linted and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-class-refs', 'maxClassRefs'],
  ['--max-classes', 'maxClasses'],
  ['--max-duration-value', 'maxDurationValue'],
  ['--max-environments', 'maxEnvironments'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-holds', 'maxHolds'],
  ['--max-jobs', 'maxJobs'],
  ['--max-policies', 'maxPolicies'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
])

const VALUE_FLAGS = new Map([
  ['--classes', 'classes'],
  ['--holds', 'holds'],
  ['--jobs', 'jobs'],
  ['--policies', 'policies'],
  ['--root', 'root'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, classes: null, policies: null, holds: null, jobs: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--holds a.json --holds b.json` lints a file nobody named and
   * `--max-classes 5 --max-classes 5000` enforces a bound nobody asked for.
   * That is the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await lintRetentionPolicies({
      root: options.root,
      limits: options.limits,
      ...(options.classes === null ? {} : { classes: options.classes }),
      ...(options.policies === null ? {} : { policies: options.policies }),
      ...(options.holds === null ? {} : { holds: options.holds }),
      ...(options.jobs === null ? {} : { jobs: options.jobs }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and the
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.classes} declared data class(es) were evaluated`
      + ` and ${report.summary.undecided} could not be decided; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
