# data-retention-policy-linter

Check exported data-class retention policies for owners, durations, legal-hold
states, deletion-job references and conflicting environments.

**This tool deletes nothing.** It reads four JSON documents, writes a report, and
recommends. It opens no socket, runs no job, and has no clock — so it never says
that any particular record is now old enough to remove, only whether the written
policy for a class is consistent and unblocked.

**An active legal hold outranks every retention rule.** A class under one is never
recommended for deletion, whatever its duration says, and a deletion job that
covers it is reported as a conflict to suspend.

- **Repository:** [edilec/data-retention-policy-linter](https://github.com/edilec/data-retention-policy-linter)
- **Area:** Security & Privacy
- **License:** MIT
- Node ESM, `node >= 22`, no runtime and no development dependencies.

## Install and run

```sh
npx data-retention-policy-linter --root ./retention
```

```sh
data-retention-policy-linter --root examples/clean
data-retention-policy-linter --root examples/held --json | jq '.classes[] | {id, recommendation}'
```

stdout carries the JSON report and nothing else, so it can be piped straight into
a parser. The human summary and every diagnostic go to stderr, which means a
non-empty stderr on a successful run is correct rather than a symptom.

| Exit | Meaning |
| ---: | --- |
| `0` | The documents were linted and nothing contradicted them. |
| `1` | They were linted and at least one error-severity rule fired. |
| `2` | Invalid configuration (nothing on stdout), or evidence that could not be obtained (an `incomplete` report on stdout, never a `pass`). |

## Input

Four documents in one directory. Every one declares `"schemaVersion": "1"`, and an
unknown key anywhere is refused rather than ignored so a typo cannot disable a
check.

```
retention/
  classes.json    the data classes: id, owner, optional regulatory minimum
  policies.json   one retention period per class per environment
  holds.json      legal holds, each active or released
  jobs.json       deletion jobs and the classes they cover
```

```json
// classes.json
{ "schemaVersion": "1", "classes": [
  { "id": "billing.invoices", "owner": "finance-platform",
    "regulation": "Companies Act 2013, s.128",
    "regulatoryMinimum": { "value": 8, "unit": "year" } }
]}

// policies.json
{ "schemaVersion": "1", "policies": [
  { "class": "billing.invoices", "environment": "production",
    "retention": { "value": 8, "unit": "year" } }
]}

// holds.json
{ "schemaVersion": "1", "holds": [
  { "id": "matter-2031-discovery", "status": "active", "classes": ["support.transcripts"] }
]}

// jobs.json
{ "schemaVersion": "1", "jobs": [
  { "id": "nightly-expiry-sweep", "classes": ["billing.invoices"] }
]}
```

Each document can be given a name of its own with `--classes`, `--policies`,
`--holds` and `--jobs`; each is resolved inside `--root`, with the real path of
both sides compared, so a symbolic link planted in the tree is refused while a
legitimate file under a symlinked root is not.

### Durations are compared as explicit units

A duration is `{"value": <integer>, "unit": "day" | "week" | "month" | "year"}`. A
duration written as a string — `"30d"`, `"P7Y"` — is reported as unsupported and
the entry carrying it is not evaluated, because `"1m"` is a minute to one exporter
and a month to another.

Months and years are not fixed numbers of days, so each duration compiles to the
interval of days it can span (a month is 28–31; a year is 365–366) and a
comparison answers *less*, *greater*, *equal* or **ambiguous**. `1 month` against
`30 day` is ambiguous: in February the month is shorter and in March it is longer.
An ambiguous comparison is a finding, it makes the run `incomplete`, and the class
it concerns is left undecided rather than nudged into whichever answer is
convenient.

## Output

```json
{
  "schemaVersion": "1",
  "tool": "data-retention-policy-linter",
  "status": "fail",
  "summary": {
    "checked": 4, "errors": 1, "warnings": 0,
    "classes": 4, "policies": 8, "holds": 2, "activeHolds": 1, "jobs": 1,
    "environments": 2,
    "deletionRecommended": 3, "blockedByHold": 1, "blocked": 0, "undecided": 0
  },
  "environments": ["production", "warm-standby"],
  "classes": [
    {
      "id": "support.transcripts",
      "owner": "support-operations",
      "regulation": "internal-quality-policy-4",
      "regulatoryMinimum": { "value": 90, "unit": "day" },
      "environments": ["production", "warm-standby"],
      "retention": [{ "environment": "production", "value": 180, "unit": "day" }],
      "holds": ["matter-2031-discovery"],
      "activeHolds": ["matter-2031-discovery"],
      "deletionJobs": ["nightly-expiry-sweep"],
      "recommendation": "blocked-by-hold",
      "reasons": ["held-class-has-deletion-job", "legal-hold-active"]
    }
  ],
  "findings": [ /* ... */ ]
}
```

`recommendation` is one of `eligible`, `blocked`, `blocked-by-hold` or
`undecided`, in reverse order of precedence: a hold outranks everything, an
unknown outranks a known problem, and only `eligible` permits deletion.

The conflicts surfaced are: a retention period shorter than a declared regulatory
minimum; two environments declaring provably different durations for one class; a
deletion job referencing a class no policy declares; a class no deletion job
covers; and a class with no owner. The full catalog of fifty rules, with every
severity and every limit, is in
[`docs/retention-rules.md`](./docs/retention-rules.md).

## Examples

```sh
npm run example                                         # examples/clean,      exit 0
node bin/data-retention-policy-linter.mjs --root examples/broken      # exit 1
node bin/data-retention-policy-linter.mjs --root examples/held        # exit 1
node bin/data-retention-policy-linter.mjs --root examples/incomplete  # exit 2
```

- **`clean`** — four owned, policed, covered classes and one released hold.
  Nothing to report.
- **`broken`** — a policy below its regulatory minimum, two environments that
  disagree, a class with no owner, a class no job covers, and a job naming a class
  that no longer exists. Completes and fails.
- **`held`** — the acceptance case. `support.transcripts` is kept for 180 days
  against a 90-day minimum, is owned, is policed in both environments, and is
  covered by the nightly deletion job. Every retention rule in the file says it
  may be swept. It is under an active legal hold, so it is **not** recommended for
  deletion and the job that covers it is reported as a conflict to suspend.
- **`incomplete`** — a hold whose status this build does not implement, and two
  environments whose durations overlap without coinciding. Exits 2; nothing is
  recommended.

## Limits and non-goals

This tool reads four exported documents. Everything it says is a statement about
those documents, and the list below is what it deliberately does not do and
cannot conclude.

**It does not delete, schedule, trigger or connect.** There is no write path: the
only file-system surface the source imports is `{ readFile, realpath, stat }`, and
`test/read-only.test.mjs` snapshots the input tree byte for byte around a real run
and asserts that nothing moved. No socket is opened either, proved by a
module-resolution guard that refuses every network builtin and by a live loopback
listener planted in the input that records that nothing knocked. A URL in a
description is data, not an instruction to fetch it; a job named in a document is
data, not an instruction to run it.

**It cannot say a record is old enough to delete.** There is no clock in the
output path. `eligible` means "the written policy for this class is consistent and
unblocked", never "this data has expired". Deciding what has actually aged out is
the job of the system that holds the data.

**It cannot say whether any system obeys these documents.** A deletion job
declared here may not exist, may not run, or may cover something else. A pass says
the four files agree with one another, not that reality agrees with them.

**It cannot tell you the law.** A regulatory minimum is read from the class
catalog as a declared fact. The tool checks the policy against the minimum
somebody wrote down.

**It cannot tell you whether a hold is still in force.** `status` is read from the
export, so a hold released yesterday and exported last week still reads as active.
That is the safe direction to be wrong in, and it is why an unrecognised status is
refused rather than read as released.

**It cannot see data nobody classified.** The catalog is the world as far as this
tool is concerned. A store full of records that no class declares produces no
finding at all, which is the most important limitation on this list.

**It does not guess.** An unrecognised hold status, a duration written as a
string, a unit it does not implement, a comparison with two answers, a class name
a hold mentions and the catalog does not: each is reported as unsupported or
unknown and makes the run `incomplete`. None of them is resolved in the permissive
direction, and while hold evidence is incomplete no class in the run is
recommended for deletion at all — including classes no readable hold mentions,
because the hold nobody could read is exactly the one that would have stopped a
deletion.

**A pass is bounded by its limits.** Every bound — bytes, classes, policies,
holds, jobs, class references per entry, environments, findings, runtime — is
enforced and reported by name, and reaching one makes the run `incomplete` rather
than truncating the input and reporting on the part that was read.

`maxRuntimeMs` bounds the *evaluation*, which is the phase whose cost grows with
the product of the inputs; reading and compiling the four documents is bounded by
`maxFileBytes` and by the per-document entry limits instead. That split is not a
softening: a single `Object.keys` over one enormous entry cannot be interrupted
from inside the same thread whatever the budget says, so the compile phase is
bounded by refusing an input that is too large rather than by a clock it could
not consult. A 28.6 MB `classes.json` holding one entry with two million unknown
keys spends seconds inside `Object.keys` before any budget could be asked —
which is why the size limit, not the time limit, is what makes that input safe.

## Development

```sh
npm run check          # lint, test, example, pack:check
npm test
npm run test:coverage
```

No dependencies, runtime or development. `npm run lint` is `node --check` over
every source and test file; the tests are `node:test` with `node:assert/strict`.

## License

MIT. See [LICENSE](./LICENSE).
