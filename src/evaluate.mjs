/**
 * The evaluation: four compiled documents in, one row per data class out.
 *
 * Every row carries a `recommendation`, and the whole design of this module is
 * arranged around one rule:
 *
 * > **An active legal hold outranks every retention rule.** A class named by an
 * > active hold is never recommended for deletion, whatever its retention
 * > period says, whatever its regulatory minimum says, and whatever a deletion
 * > job already covering it says. A deletion job covering a held class is
 * > reported as a conflict to be suspended, not as a reason the hold is moot.
 *
 * The second rule follows from the first and is just as load-bearing: **hold
 * evidence that could not be read blocks every recommendation**. A hold entry
 * with a status this build does not implement, a hold naming something that is
 * not a name, an unreadable `holds.json` -- each of them means the set of held
 * classes is not known, and a class this run believes to be unheld might be
 * held by the hold nobody could read. So while hold evidence is incomplete, no
 * class in the run is recommended for deletion. The same reasoning, less
 * dramatically, applies to deletion-job evidence and to policies that could not
 * be attributed to a class.
 *
 * Nothing here deletes anything, schedules anything or contacts anything. The
 * output is a set of rows and a set of findings.
 */

import { formatDuration, relateDurations, satisfiesMinimum } from './duration.mjs'
import { byCodeUnit, excerpt } from './text.mjs'

/**
 * What a row's `recommendation` may be.
 *
 * Only `eligible` says deletion may proceed, and it says so about the *policy*,
 * never about a particular record: this tool has no clock, reads no data store
 * and knows nothing about how old anything is. See `README.md` for what that
 * does and does not establish.
 */
export const RECOMMENDATIONS = Object.freeze(['blocked', 'blocked-by-hold', 'eligible', 'undecided'])

/**
 * The vocabulary of `reasons`, deliberately separate from the rule catalog.
 *
 * A reason says why a class did not reach `eligible`; a rule id says what was
 * wrong with a document. They are usually related and they are not the same
 * thing -- one rule can produce several reasons and one reason can come from
 * several rules -- so keeping them apart stops a reader from mistaking the row
 * for a second copy of the findings list.
 */
export const REASONS = Object.freeze([
  'deletion-job-evidence-incomplete',
  'held-class-has-deletion-job',
  'legal-hold-active',
  'legal-hold-evidence-incomplete',
  'no-deletion-job',
  'no-retention-policy',
  'owner-missing',
  'policy-evidence-incomplete',
  'policy-unreadable',
  'regulatory-minimum-ambiguous',
  'regulatory-minimum-unreadable',
  'retention-below-minimum',
  'retention-conflict',
  'retention-conflict-ambiguous',
  'time-budget-exceeded',
])

const EVIDENCE_IDS = 8

/** A short, bounded list of ids for an evidence field. */
function listIds(ids) {
  const shown = ids.slice(0, EVIDENCE_IDS).map((id) => excerpt(id, 40))
  return ids.length > EVIDENCE_IDS ? `${shown.join(', ')} and ${ids.length - EVIDENCE_IDS} more` : shown.join(', ')
}

function countRecommendations(rows, wanted) {
  return rows.filter((row) => row.recommendation === wanted).length
}

function summarise(rows) {
  return {
    deletionRecommended: countRecommendations(rows, 'eligible'),
    blockedByHold: countRecommendations(rows, 'blocked-by-hold'),
    blocked: countRecommendations(rows, 'blocked'),
    undecided: countRecommendations(rows, 'undecided'),
  }
}

/**
 * Turn every conclusion this evaluation reached into `undecided`, except the
 * one that is already more restrictive than `undecided`.
 *
 * This exists for the case the report contract calls the cardinal sin: a budget
 * exhausted inside a loop, a `break` that falls through to the success branch,
 * and a confident claim written out on evidence the run never finished
 * gathering. The caller re-checks the budget *after* the loop and calls this
 * when it has been passed. `blocked-by-hold` is left alone on purpose -- it is
 * the strictest verdict there is, it cannot become `eligible`, and replacing it
 * would hide an active hold from the reader for no gain.
 */
export function downgradeRecommendations(result, reason) {
  for (const row of result.rows) {
    if (row.recommendation === 'blocked-by-hold') continue
    row.recommendation = 'undecided'
    if (!row.reasons.includes(reason)) {
      row.reasons.push(reason)
      row.reasons.sort(byCodeUnit)
    }
  }
  result.counts = summarise(result.rows)
  return result
}

/**
 * Compare four compiled documents.
 *
 * Returns `null` when the run could not be evaluated at all -- today that means
 * more environments than the limit allows. Otherwise returns the rows, the
 * environment list and the recommendation counts.
 */
export function evaluate(sink, names, compiled, limits, budget) {
  const { classes, policies, holds, jobs } = compiled

  const environmentSet = new Set()
  for (const policy of policies.entries) environmentSet.add(policy.environment)
  const environments = [...environmentSet].sort(byCodeUnit)

  if (environments.length > limits.maxEnvironments) {
    sink.add({
      file: names.policies,
      pointer: '/policies',
      ruleId: 'too-many-environments',
      message: `The policies name ${environments.length} environment(s), above the maxEnvironments limit of ${limits.maxEnvironments}; nothing was evaluated rather than some environments being compared and the rest ignored.`,
      suggestion: 'Raise --max-environments, or lint one group of environments at a time.',
    })
    return null
  }

  /**
   * Three completeness flags, each of which blocks every deletion
   * recommendation in the run while it is false.
   *
   * They are separate because they fail for different reasons and a reader
   * needs to know which, but they are used identically: an unknown is never
   * resolved in the permissive direction.
   */
  const holdEvidenceComplete = holds.refused === 0
  const jobEvidenceComplete = jobs.refused === 0
  const policyEvidenceComplete = policies.unattributedRefusals === 0

  if (!holdEvidenceComplete) {
    sink.add({
      file: names.holds,
      pointer: '/holds',
      ruleId: 'hold-coverage-unknown',
      message: `${holds.refused} legal hold(s) could not be read completely, so the set of classes under hold is not known. No class in this run is recommended for deletion while that is true -- including classes no hold this run could read mentions, because the hold nobody could read is exactly the one that would have stopped a deletion.`,
      suggestion: 'Fix the refused holds and re-run; until then treat every class as potentially held.',
    })
  }

  if (!jobEvidenceComplete) {
    sink.add({
      file: names.jobs,
      pointer: '/jobs',
      ruleId: 'job-coverage-unknown',
      message: `${jobs.refused} deletion job(s) could not be read completely, so which classes a job covers is not known. No class is reported as uncovered on this evidence, and none is recommended for deletion.`,
      suggestion: 'Fix the refused jobs and re-run.',
    })
  }

  if (!policyEvidenceComplete) {
    sink.add({
      file: names.policies,
      pointer: '/policies',
      ruleId: 'policy-coverage-unknown',
      message: `${policies.unattributedRefusals} retention policy entr(y/ies) were refused without naming a readable data class, so some class has a retention rule this run never read and there is no way to say which. No class is recommended for deletion on this evidence.`,
      suggestion: 'Fix the refused policies and re-run.',
    })
  }

  const holdsByClass = new Map()
  for (const hold of holds.entries) {
    if (hold.classes.length === 0) {
      sink.add({
        file: names.holds,
        pointer: `${hold.pointer}/classes`,
        ruleId: 'hold-covers-nothing',
        message: `Legal hold "${excerpt(hold.id, 80)}" names no data class, so it holds nothing here. It is recorded and it blocks nothing.`,
      })
      continue
    }
    for (const classId of hold.classes) {
      if (!classes.byId.has(classId)) {
        sink.add({
          file: names.holds,
          pointer: hold.classPointers.get(classId),
          ruleId: 'hold-class-unknown',
          message: `Legal hold "${excerpt(hold.id, 60)}" names data class "${excerpt(classId, 80)}", which the class catalog does not declare. The hold is recorded against nothing; this tool does not guess that a name it cannot find was meant to be one it can.`,
          suggestion: 'Declare the class, or correct the hold.',
        })
        continue
      }
      if (!holdsByClass.has(classId)) holdsByClass.set(classId, [])
      holdsByClass.get(classId).push(hold)
    }
  }

  const jobsByClass = new Map()
  for (const job of jobs.entries) {
    if (job.classes.length === 0) {
      sink.add({
        file: names.jobs,
        pointer: `${job.pointer}/classes`,
        ruleId: 'job-covers-nothing',
        message: `Deletion job "${excerpt(job.id, 80)}" names no data class, so it covers nothing here.`,
      })
      continue
    }
    for (const classId of job.classes) {
      if (!classes.byId.has(classId)) {
        sink.add({
          file: names.jobs,
          pointer: job.classPointers.get(classId),
          ruleId: 'job-class-unknown',
          message: `Deletion job "${excerpt(job.id, 60)}" names data class "${excerpt(classId, 80)}", which the class catalog does not declare. A job that deletes something nobody has classified is deleting on nobody's authority.`,
          suggestion: 'Declare the class, or correct the job.',
        })
        continue
      }
      if (!policies.byClass.has(classId) && !policies.refusedByClass.has(classId)) {
        sink.add({
          file: names.jobs,
          pointer: job.classPointers.get(classId),
          ruleId: 'job-class-unpolicied',
          message: `Deletion job "${excerpt(job.id, 60)}" covers data class "${excerpt(classId, 80)}", which no retention policy declares. The job would delete on a schedule nobody wrote down.`,
          suggestion: 'Declare a retention policy for this class, or remove it from the job.',
        })
      }
      if (!jobsByClass.has(classId)) jobsByClass.set(classId, [])
      jobsByClass.get(classId).push(job)
    }
  }

  for (const policy of policies.entries) {
    if (!classes.byId.has(policy.classId)) {
      sink.add({
        file: names.policies,
        pointer: `${policy.pointer}/class`,
        ruleId: 'policy-class-unknown',
        message: `This retention policy is written for data class "${excerpt(policy.classId, 80)}", which the class catalog does not declare; it was recorded against nothing and no class row mentions it.`,
        suggestion: 'Declare the class, or correct the policy.',
      })
    }
  }

  const rows = []

  for (const klass of classes.entries) {
    budget.check()

    const reasons = new Set()
    let blocked = false
    let unknown = false

    if (klass.ownerRefused) {
      reasons.add('owner-missing')
      blocked = true
    }
    if (klass.minimumRefused) {
      reasons.add('regulatory-minimum-unreadable')
      unknown = true
    }
    if (!holdEvidenceComplete) {
      reasons.add('legal-hold-evidence-incomplete')
      unknown = true
    }
    if (!jobEvidenceComplete) {
      reasons.add('deletion-job-evidence-incomplete')
      unknown = true
    }
    if (!policyEvidenceComplete) {
      reasons.add('policy-evidence-incomplete')
      unknown = true
    }

    const refusedPolicies = policies.refusedByClass.get(klass.id) ?? 0
    if (refusedPolicies > 0) {
      reasons.add('policy-unreadable')
      unknown = true
    }

    const classPolicies = (policies.byClass.get(klass.id) ?? [])
      .slice()
      .sort((left, right) => byCodeUnit(left.environment, right.environment))

    if (classPolicies.length === 0 && refusedPolicies === 0) {
      sink.add({
        file: names.classes,
        pointer: klass.pointer,
        ruleId: 'class-unpolicied',
        message: `Data class "${excerpt(klass.id, 100)}" has no retention policy in any environment, so there is no period after which anything may be deleted and no period before which anything must be kept.`,
        suggestion: 'Declare a retention policy for this class in each environment that stores it.',
      })
      reasons.add('no-retention-policy')
      blocked = true
    }

    if (classPolicies.length > 0 && environments.length > 1) {
      const present = new Set(classPolicies.map((policy) => policy.environment))
      const missing = environments.filter((environment) => !present.has(environment))
      if (missing.length > 0) {
        sink.add({
          file: names.classes,
          pointer: klass.pointer,
          ruleId: 'environment-coverage-partial',
          message: `Data class "${excerpt(klass.id, 80)}" has a retention policy in ${classPolicies.length} of the ${environments.length} environment(s) these policies name. A copy in an environment with no policy is a copy nobody has decided about.`,
          evidence: `no policy in: ${listIds(missing)}`,
          suggestion: 'Declare a policy for each environment that stores this class, or confirm it is not stored there.',
        })
      }
    }

    // Every unordered pair, because "A agrees with B" and "A agrees with C" do
    // not add up to "B agrees with C" once a duration can be an interval: one
    // month is consistent with both 28 days and 31 days, which are not
    // consistent with each other. The first conflicting pair and the first
    // undecidable pair in environment order are named; the rest would be the
    // same story told again.
    let conflict = null
    let ambiguous = null
    for (let left = 0; left < classPolicies.length; left += 1) {
      for (let right = left + 1; right < classPolicies.length; right += 1) {
        budget.check()
        const relation = relateDurations(classPolicies[left].retention, classPolicies[right].retention)
        if (relation === 'differs' && conflict === null) conflict = [classPolicies[left], classPolicies[right]]
        if (relation === 'ambiguous' && ambiguous === null) ambiguous = [classPolicies[left], classPolicies[right]]
      }
    }

    if (conflict !== null) {
      const [left, right] = conflict
      sink.add({
        file: names.classes,
        pointer: klass.pointer,
        ruleId: 'environment-duration-conflict',
        message: `Data class "${excerpt(klass.id, 80)}" is kept for provably different lengths of time in different environments: "${excerpt(left.environment, 40)}" keeps it ${formatDuration(left.retention)} and "${excerpt(right.environment, 40)}" keeps it ${formatDuration(right.retention)}.`,
        evidence: `${excerpt(left.environment, 40)}=${formatDuration(left.retention)}; ${excerpt(right.environment, 40)}=${formatDuration(right.retention)}`,
        suggestion: 'Settle on one retention period for this class, or record why the environments differ as two separate classes.',
      })
      reasons.add('retention-conflict')
      blocked = true
    }

    if (ambiguous !== null) {
      const [left, right] = ambiguous
      sink.add({
        file: names.classes,
        pointer: klass.pointer,
        ruleId: 'environment-duration-ambiguous',
        message: `Data class "${excerpt(klass.id, 80)}" is kept for ${formatDuration(left.retention)} in "${excerpt(left.environment, 40)}" and ${formatDuration(right.retention)} in "${excerpt(right.environment, 40)}"; those two periods overlap without coinciding, so whether the environments agree depends on the calendar. This build does not pick an answer.`,
        evidence: `${excerpt(left.environment, 40)}=${formatDuration(left.retention)}; ${excerpt(right.environment, 40)}=${formatDuration(right.retention)}`,
        suggestion: 'Restate both periods in the same unit so the comparison has one answer.',
      })
      reasons.add('retention-conflict-ambiguous')
      unknown = true
    }

    if (klass.regulatoryMinimum !== null) {
      for (const policy of classPolicies) {
        budget.check()
        const verdict = satisfiesMinimum(policy.retention, klass.regulatoryMinimum)
        const citation = klass.regulation === null ? '' : ` (${excerpt(klass.regulation, 80)})`
        if (verdict === 'below') {
          sink.add({
            file: names.policies,
            pointer: `${policy.pointer}/retention`,
            ruleId: 'retention-below-minimum',
            message: `"${excerpt(klass.id, 60)}" is kept for ${formatDuration(policy.retention)} in "${excerpt(policy.environment, 40)}", which is shorter than its declared regulatory minimum of ${formatDuration(klass.regulatoryMinimum)}${citation}.`,
            evidence: `retention=${formatDuration(policy.retention)}; minimum=${formatDuration(klass.regulatoryMinimum)}`,
            suggestion: 'Raise the retention period to the minimum, or correct the minimum.',
          })
          reasons.add('retention-below-minimum')
          blocked = true
        } else if (verdict === 'ambiguous') {
          sink.add({
            file: names.policies,
            pointer: `${policy.pointer}/retention`,
            ruleId: 'minimum-comparison-ambiguous',
            message: `"${excerpt(klass.id, 60)}" is kept for ${formatDuration(policy.retention)} in "${excerpt(policy.environment, 40)}" against a regulatory minimum of ${formatDuration(klass.regulatoryMinimum)}${citation}; those periods overlap without coinciding, so on some calendars the policy meets the minimum and on others it does not. This build reports that rather than choosing.`,
            evidence: `retention=${formatDuration(policy.retention)}; minimum=${formatDuration(klass.regulatoryMinimum)}`,
            suggestion: 'Restate the retention period and the minimum in the same unit.',
          })
          reasons.add('regulatory-minimum-ambiguous')
          unknown = true
        }
      }
    }

    const classHolds = holdsByClass.get(klass.id) ?? []
    const holdIds = classHolds.map((hold) => hold.id).sort(byCodeUnit)
    const activeHoldIds = classHolds.filter((hold) => hold.status === 'active').map((hold) => hold.id).sort(byCodeUnit)
    const jobIds = (jobsByClass.get(klass.id) ?? []).map((job) => job.id).sort(byCodeUnit)

    if (activeHoldIds.length > 0) {
      reasons.add('legal-hold-active')
      sink.add({
        file: names.classes,
        pointer: klass.pointer,
        ruleId: 'hold-active',
        message: `Data class "${excerpt(klass.id, 80)}" is under ${activeHoldIds.length} active legal hold(s). No deletion is recommended for it while that is true, whatever its retention period says; this run reports it as blocked-by-hold and deletes nothing.`,
        evidence: `holds: ${listIds(activeHoldIds)}`,
      })

      if (jobIds.length > 0) {
        reasons.add('held-class-has-deletion-job')
        sink.add({
          file: names.classes,
          pointer: klass.pointer,
          ruleId: 'hold-conflicts-with-job',
          message: `Data class "${excerpt(klass.id, 80)}" is under an active legal hold and is also covered by ${jobIds.length} deletion job(s); the hold outranks the retention rule, so those jobs must be suspended for this class until it is released. This tool reports the conflict and deletes nothing itself.`,
          evidence: `holds: ${listIds(activeHoldIds)}; jobs: ${listIds(jobIds)}`,
          suggestion: 'Suspend these jobs for this class, or release the hold if it no longer applies.',
        })
      }
    } else if (jobIds.length === 0 && jobEvidenceComplete) {
      // Suppressed for a held class on purpose: telling somebody that data
      // under legal hold has no deletion job is telling them to build one.
      sink.add({
        file: names.classes,
        pointer: klass.pointer,
        ruleId: 'class-uncovered-by-job',
        message: `No deletion job covers data class "${excerpt(klass.id, 100)}", so its retention period expires and nothing acts on it.`,
        suggestion: 'Add this class to a deletion job, or record why it is retained indefinitely.',
      })
      reasons.add('no-deletion-job')
      blocked = true
    }

    // Precedence, and the order matters. An active hold is the loudest
    // operational fact there is, so it is named first even when the class also
    // has conflicts; after that, an unknown outranks a known problem, because
    // "we could not tell" and "we can tell, and it is wrong" are different
    // things to hand a reader. Only the last branch permits deletion.
    let recommendation
    if (activeHoldIds.length > 0) recommendation = 'blocked-by-hold'
    else if (unknown) recommendation = 'undecided'
    else if (blocked) recommendation = 'blocked'
    else recommendation = 'eligible'

    rows.push({
      id: excerpt(klass.id, 120),
      owner: klass.owner === null ? null : excerpt(klass.owner, 120),
      regulation: klass.regulation === null ? null : excerpt(klass.regulation, 120),
      regulatoryMinimum: klass.regulatoryMinimum === null
        ? null
        : { value: klass.regulatoryMinimum.value, unit: klass.regulatoryMinimum.unit },
      environments: classPolicies.map((policy) => policy.environment).sort(byCodeUnit),
      retention: classPolicies.map((policy) => ({
        environment: policy.environment,
        value: policy.retention.value,
        unit: policy.retention.unit,
      })),
      holds: holdIds,
      activeHolds: activeHoldIds,
      deletionJobs: jobIds,
      recommendation,
      reasons: [...reasons].sort(byCodeUnit),
    })
  }

  rows.sort((left, right) => byCodeUnit(left.id, right.id))

  return { rows, environments, counts: summarise(rows) }
}
