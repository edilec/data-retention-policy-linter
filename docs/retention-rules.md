# Rule catalog, limits and the supported dialect

This document is the reference for what `data-retention-policy-linter` reads, what
each rule means, what every limit is, and what the tool deliberately cannot tell
you. `README.md` is the shorter introduction.

The single fact to carry into everything below: **the tool deletes nothing**. It
reads four JSON documents and writes a report. Every `recommendation` in that
report is a statement about the policy documents, never an instruction that
something has been or should now be removed.

## Input dialect

Four documents live in one directory, the `--root`. Their default names are
`classes.json`, `policies.json`, `holds.json` and `jobs.json`; each can be renamed
with its own flag. Every document declares `"schemaVersion": "1"` and one array.
Unknown keys are refused rather than ignored, at the document level and at the
entry level, so a one-character typo cannot quietly disable a check.

### `classes.json` — the data-class catalog

```json
{
  "schemaVersion": "1",
  "classes": [
    {
      "id": "billing.invoices",
      "owner": "finance-platform",
      "description": "Issued customer invoices and their line items.",
      "regulation": "Companies Act 2013, s.128",
      "regulatoryMinimum": { "value": 8, "unit": "year" }
    }
  ]
}
```

`id` is required. `owner` is checked rather than required by the shape gate: a
class with no usable owner still gets a row and is still evaluated for everything
else, and the missing owner is reported under its own rule. `regulation` is a free
text citation. `regulatoryMinimum` is a duration.

### `policies.json` — one retention period per class per environment

```json
{
  "schemaVersion": "1",
  "policies": [
    { "class": "billing.invoices", "environment": "production", "retention": { "value": 8, "unit": "year" } }
  ]
}
```

Two policies for the same class in the same environment are refused: neither copy
is authoritative.

### `holds.json` — legal holds

```json
{
  "schemaVersion": "1",
  "holds": [
    { "id": "matter-2031-discovery", "status": "active", "classes": ["support.transcripts"] }
  ]
}
```

`status` is `active` or `released` and nothing else. See below.

### `jobs.json` — deletion jobs

```json
{
  "schemaVersion": "1",
  "jobs": [
    { "id": "nightly-expiry-sweep", "classes": ["billing.invoices"] }
  ]
}
```

A job declares which classes it covers. It declares no schedule and no target,
because this tool does not run it and would only be pretending to understand one.

### Names

A class id, environment name, hold id and job id are each 1–120 characters from
`[A-Za-z0-9._:/+-]`, starting with a letter or digit. An owner or a regulation
citation is freer — spaces and ordinary punctuation are fine — but is still
bounded at 120 characters and may not carry a control, separator or bidi
character. A name that would print differently from the value the linter compared
is refused rather than cleaned up and used.

## Durations are compared as explicit units

A duration is `{"value": <integer ≥ 0>, "unit": "day" | "week" | "month" | "year"}`
and nothing else. A duration written as a string — `"30d"`, `"P7Y"`,
`"6 months"` — is reported as unsupported and the entry carrying it is not
evaluated. Parsing a duration out of text is where a linter starts guessing:
`"1m"` is a minute to one exporter and a month to another, and the cost of
guessing wrong here is a deletion recommendation against data that was meant to
be kept.

Each duration compiles to the closed interval of days it can span:

| Unit | Days per unit |
| --- | --- |
| `day` | 1 |
| `week` | 7 |
| `month` | 28 to 31 |
| `year` | 365 to 366 |

Comparisons therefore answer one of four things: definitely less, definitely
greater, definitely equal, or **ambiguous**. Two durations written identically
(`8 year` and `8 year`) are equal by inspection; two exact ones (`7 day` and
`1 week`) are equal by arithmetic; `1 month` against `30 day` is ambiguous,
because in February the month is shorter and in March it is longer.

Ambiguity is never rounded away and never resolved in the permissive direction.
It is a finding, it makes the run `incomplete`, and the class it concerns is left
`undecided` and is not recommended for deletion. The fix is to restate both
durations in the same unit.

## An active legal hold outranks every retention rule

This is the property the tool is built around.

- A class named by an **active** hold is never recommended for deletion, whatever
  its retention period says, whatever its regulatory minimum says, and whatever
  deletion job already covers it. Its row reads `blocked-by-hold`.
- A deletion job that covers a class under an active hold is reported as
  `hold-conflicts-with-job`, an error: the job is to be suspended for that class,
  not taken as evidence that the hold does not matter.
- A held class is **not** reported as `class-uncovered-by-job`. Telling somebody
  that data under legal hold has no deletion job is telling them to build one.
- A hold status outside `active` and `released` is refused. `"lifted"`,
  `"pending release"` and `"expired"` are all real words in real matter-management
  exports, and every one of them would have to be mapped onto the two states by
  somebody who knows what the exporter meant. Reading an unrecognised status as
  released is the single most dangerous default this tool could have.
- **Hold evidence that could not be read blocks every recommendation in the run.**
  A refused hold entry, a hold class name that is not a name, an unreadable
  `holds.json`: any of them means the set of held classes is not known, and the
  hold nobody could read is exactly the one that would have stopped a deletion. So
  while that is true, no class in the run is recommended — including classes no
  readable hold mentions.

The same reasoning, with less at stake, applies to deletion-job evidence
(`job-coverage-unknown`) and to a policy entry refused without naming a readable
class (`policy-coverage-unknown`).

## Recommendations

Each class row carries one of four recommendations:

| Recommendation | Meaning |
| --- | --- |
| `blocked-by-hold` | An active legal hold names this class. Nothing else can outvote it. |
| `undecided` | Evidence was missing, unreadable or ambiguous. No answer either way. |
| `blocked` | A conflict this run could decide, and it has to be resolved first. |
| `eligible` | Nothing found here stands in the way of this class being deleted under its own policy. |

Precedence runs in that order. `eligible` is the only one that permits deletion,
and it is a statement about the four documents: it says the written policy is
consistent and unblocked, never that any particular record is old enough to go.

`reasons` on each row draws from a fixed vocabulary, kept separate from the rule
catalog because one rule can produce several reasons and one reason can come from
several rules: `deletion-job-evidence-incomplete`, `held-class-has-deletion-job`,
`legal-hold-active`, `legal-hold-evidence-incomplete`, `no-deletion-job`,
`no-retention-policy`, `owner-missing`, `policy-evidence-incomplete`,
`policy-unreadable`, `regulatory-minimum-ambiguous`,
`regulatory-minimum-unreadable`, `retention-below-minimum`, `retention-conflict`,
`retention-conflict-ambiguous`, `time-budget-exceeded`.

## Rule catalog

Severity comes from one frozen table in `src/index.mjs`, and an unknown rule id
throws rather than being emitted. The severities below are the same table, and
`test/severity-table.test.mjs` asserts the two against each other in both
directions. That is not the test that defends them: `test/severity-exit.test.mjs`
drives a real input through the real binary for every rule here and pins the
process exit code and the error count with literals, because three declarations
can be edited together and an exit code cannot be edited at all.

Only four rules are below `error`, and each is a legitimate state rather than a
contradiction.

### Input and document

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable` | error | A document could not be reached or read. |
| `input-not-utf8` | error | A document is not valid UTF-8. The decoder decides; the decoded text never gets a vote. |
| `input-not-json` | error | A document is not valid JSON. The finding carries the position, line and column of the failure and never the text at it: V8 quotes the input back in its own parse message, so a file short enough to be nothing but a credential would otherwise be reproduced in full by its own error. |
| `input-too-large` | error | A document is past `maxFileBytes` and was not read. |
| `path-escapes-root` | error | A document resolves outside `--root` and was refused unread. |
| `document-invalid` | error | A document is not an object, declares an unknown key, or its list is not an array. |
| `schema-version-unsupported` | error | A document declares a `schemaVersion` this build does not implement. |

### Entries

| Rule | Severity | Meaning |
| --- | --- | --- |
| `class-invalid` | error | A class entry is not an object, declares an unknown key, or has an unusable description or citation. |
| `class-duplicate` | error | A class id is declared twice; neither copy is authoritative. |
| `class-owner-missing` | error | A class declares no usable owner. A retention decision with nobody accountable is one nobody can approve. |
| `policy-invalid` | error | A policy entry is not an object, declares an unknown key, or has an unusable description. |
| `policy-duplicate` | error | Two retention policies for one class in one environment. |
| `hold-invalid` | error | A hold entry is not an object, declares an unknown key, or has no `classes` list. |
| `hold-duplicate` | error | A hold id is declared twice. |
| `job-invalid` | error | A job entry is not an object, declares an unknown key, or has no `classes` list. |
| `job-duplicate` | error | A job id is declared twice. |
| `identifier-invalid` | error | An id, class name or environment name is not a usable name. |
| `class-reference-duplicate` | error | A class is listed more than once by one hold or job. |

### Durations

| Rule | Severity | Meaning |
| --- | --- | --- |
| `duration-not-structured` | error | A duration is a string or a bare number. This build compares explicit units and never parses a duration out of text. |
| `duration-invalid` | error | A duration is not an object with exactly `value` and `unit`, or its value is not an integer of zero or more. |
| `duration-unit-unsupported` | error | A duration uses a unit this build does not implement. It is refused rather than converted into a guess. |
| `duration-out-of-range` | error | A duration value is past `maxDurationValue`. It is refused rather than clamped. |

### Retention conflicts

| Rule | Severity | Meaning |
| --- | --- | --- |
| `retention-below-minimum` | error | A retention period is shorter than its class's declared regulatory minimum, for every calendar both intervals allow. |
| `minimum-comparison-ambiguous` | error | A retention period and a regulatory minimum overlap without coinciding, so on some calendars the policy meets the minimum and on others it does not. |
| `environment-duration-conflict` | error | Two environments keep one class for provably different lengths of time. |
| `environment-duration-ambiguous` | error | Two environments' periods overlap without coinciding, so whether they agree depends on the calendar. |
| `environment-coverage-partial` | warning | A class has a policy in some of the environments these policies name and not others. |
| `class-unpolicied` | error | A declared class has no retention policy in any environment. |
| `policy-class-unknown` | error | A retention policy is written for a class the catalog does not declare. |
| `policy-coverage-unknown` | error | A policy entry was refused without naming a readable class, so some class has a rule this run never read and there is no way to say which. |

### Legal holds

| Rule | Severity | Meaning |
| --- | --- | --- |
| `hold-active` | info | A class is under one or more active legal holds. Recorded, and it blocks every deletion recommendation for that class. |
| `hold-conflicts-with-job` | error | A class under an active hold is covered by a deletion job. Suspend the job for that class. |
| `hold-status-unsupported` | error | A hold declares a status this build does not implement. It is never read as released. |
| `hold-class-unknown` | error | A hold names a class the catalog does not declare. The tool does not guess that it was meant to name one it knows. |
| `hold-covers-nothing` | warning | A hold names no class, so it holds nothing here. |
| `hold-coverage-unknown` | error | A hold could not be read completely, so the set of held classes is not known and no class is recommended for deletion. |

### Deletion jobs

| Rule | Severity | Meaning |
| --- | --- | --- |
| `class-uncovered-by-job` | error | No deletion job covers a class, so its retention period expires and nothing acts on it. Suppressed for a class under an active hold. |
| `job-class-unknown` | error | A deletion job names a class the catalog does not declare. |
| `job-class-unpolicied` | error | A deletion job covers a declared class that no retention policy declares. The job would delete on a schedule nobody wrote down. |
| `job-covers-nothing` | warning | A deletion job names no class. |
| `job-coverage-unknown` | error | A job could not be read completely, so which classes are covered is not known. No class is reported as uncovered on that evidence. |

### Bounds and vacuity

| Rule | Severity | Meaning |
| --- | --- | --- |
| `too-many-classes` | error | `classes.json` declares more classes than `maxClasses`. Nothing was compiled from it. |
| `too-many-policies` | error | `policies.json` declares more policies than `maxPolicies`. |
| `too-many-holds` | error | `holds.json` declares more holds than `maxHolds`. |
| `too-many-jobs` | error | `jobs.json` declares more jobs than `maxJobs`. |
| `too-many-class-references` | error | One hold or job names more classes than `maxClassRefs`. The entry was refused rather than read in part. |
| `too-many-environments` | error | The policies name more environments than `maxEnvironments`. Nothing was evaluated. |
| `too-many-findings` | error | The run produced more findings than `maxFindings`; the report is partial. |
| `time-budget-exceeded` | error | The evaluation passed `maxRuntimeMs`. Every recommendation it had reached is downgraded to `undecided`. |
| `no-classes-evaluated` | error | Four documents compiled and no class was evaluated, so the run has no evidence to be green on. |

## Limits

Every limit is enforced, and exceeding one produces a finding that names it. No
limit truncates silently, and a run that reached one is `incomplete` rather than a
verdict. A caller may lower a limit but never raise it past its hard cap.

| Limit | Flag | Default | Hard cap |
| --- | --- | ---: | ---: |
| `maxClassRefs` | `--max-class-refs` | 200 | 2000 |
| `maxClasses` | `--max-classes` | 500 | 5000 |
| `maxDurationValue` | `--max-duration-value` | 100000 | 1000000 |
| `maxEnvironments` | `--max-environments` | 32 | 256 |
| `maxFileBytes` | `--max-file-bytes` | 5242880 | 67108864 |
| `maxFindings` | `--max-findings` | 1000 | 20000 |
| `maxHolds` | `--max-holds` | 500 | 5000 |
| `maxJobs` | `--max-jobs` | 500 | 5000 |
| `maxPolicies` | `--max-policies` | 2000 | 20000 |
| `maxRuntimeMs` | `--max-runtime-ms` | 10000 | 600000 |

An unknown limit key is a configuration error, not something to ignore.

There is no recursion limit, because there is no recursive structure in the
input: the deepest shape this tool reads is an array of objects holding an array
of strings, and each of those is bounded by name above. There is likewise no
pattern this tool compiles out of its input — no field in any of the four
documents becomes a regular expression — so there is no place where an input can
choose what gets matched, and no unbounded backtracking to defend against.

The time budget is checked inside the evaluation loop **and again after it has
returned**. A budget that can be exhausted inside a loop cannot be trusted to have
fired before the loop's conclusions were written down, so if the second check
finds the budget passed, every recommendation the loop reached is downgraded to
`undecided` — except `blocked-by-hold`, which is already stricter than
`undecided` and cannot become `eligible`.

## Status, exit codes and ordering

| Status | Exit | Meaning |
| --- | ---: | --- |
| `pass` | 0 | The four documents were read in full and nothing contradicted them. |
| `fail` | 1 | They were read in full and at least one error-severity rule fired. |
| `incomplete` | 2 | Evidence was missing, unreadable, truncated or ambiguous. Never a pass. |

A configuration error also exits 2 but writes **nothing** to stdout: a run that
never had a subject has nothing to report about one. A run that had a subject and
could not obtain evidence about it writes an `incomplete` report to stdout, which
is what tells a consumer *which* input was not read.

Findings are ordered by `location.file`, then `location.pointer`, then `ruleId`,
then `message`. Every order in the package is by UTF-16 code unit. Locale-aware
comparison reads ICU data that differs between Node builds, and it weighs
punctuation differently from its code point — `maxClassRefs` and `maxClasses`
really do swap under English collation — so a collated report would name a
different environment in a conflict on a different machine. `test/ordering.test.mjs`
pins eleven of the sixteen ordering sites by what the tool emits; the remaining
five are proved equivalent by enumeration in `test/ordering-equivalence.test.mjs`.

Running the tool twice over identical inputs produces byte-identical stdout. There
is no wall clock, no locale, no randomness and no filesystem enumeration in the
output path.

## What this tool cannot tell you

- **Whether any record is actually old enough to delete.** There is no clock in
  the output path and no data store is read. `eligible` describes a policy, not a
  row in a database.
- **Whether any system obeys these documents.** The four files are exports. A
  deletion job declared here may not exist, may not run, or may cover something
  else entirely.
- **Whether a regulatory minimum is the right one.** It is read from the class
  catalog as a declared fact. The tool checks the policy against the minimum
  somebody wrote down; it does not know the law.
- **Whether a legal hold is still in force.** `status` is read from the export. A
  hold released yesterday and exported last week still reads as active, which is
  the safe direction to be wrong in.
- **Whether an unknown class name is a typo.** A hold or job naming a class the
  catalog does not declare is an error, and the tool does not guess that it was
  meant to name a declared one.
- **Whether a class nobody declared exists.** The catalog is the world. Data that
  is stored and never classified is invisible to this tool, which is the most
  important thing on this list.
