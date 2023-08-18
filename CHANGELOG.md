# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Rule ids are
part of the public surface: renaming one is a breaking change and is recorded
here.

## [Unreleased]

### Added

- First implementation of `data-retention-policy-linter`: reads a data-class
  catalog, a set of retention policies, a set of legal holds and a set of
  deletion jobs, and reports what contradicts what. It deletes nothing,
  schedules nothing and recommends only.
- An active legal hold as the rule everything else is arranged around. A class
  under one is never recommended for deletion, whatever its retention period
  says; a deletion job covering it is reported as a conflict to suspend; and a
  held class is not reported as uncovered, because that would be advice to build
  a job for data under hold.
- Hold evidence treated as load-bearing. A refused hold entry, a hold status
  this build does not implement, or an unreadable `holds.json` means the set of
  held classes is not known, and while that is true no class in the run is
  recommended for deletion -- including classes no readable hold mentions.
- Durations compared as explicit units and never parsed out of a string. Each
  duration compiles to the interval of days it can span (a month is 28-31, a
  year 365-366), so a comparison answers less, greater, equal or *ambiguous*,
  and an ambiguous answer is a finding that makes the run `incomplete` rather
  than being rounded into whichever verdict is convenient.
- The conflicts the tool exists to surface: a retention period below a declared
  regulatory minimum, two environments declaring provably different durations
  for one class, a deletion job referencing a class no policy declares, a class
  no deletion job covers, and a class with no owner.
- A 50-rule catalog with one frozen `ruleId -> severity` table, documented in
  `docs/retention-rules.md` and pinned behaviourally by process exit code and
  literal error counts rather than by comparing three declarations.
- Enforced limits on bytes, classes, policies, holds, jobs, class references per
  entry, environments, duration values, findings and runtime, each reported by
  name when reached and each making the run `incomplete` rather than truncating
  silently. The time budget is re-checked *after* the evaluation loop returns,
  and every recommendation that loop reached is downgraded to `undecided` when
  it has been passed.
- A CLI with `--help`, `--json`, explicit input paths and the three documented
  exit codes; the JSON report on stdout alone.
- Examples for a clean, a failing, a legally held and an incomplete policy set.

### Security

- Read-only, and proved so: the shipped source imports `{ readFile, realpath,
  stat }` and nothing else from the file system, and a test snapshots the input
  tree byte for byte around a real run.
- No network access of any kind. Proved by a module-resolution guard that
  refuses every network builtin and by a live loopback listener whose address is
  planted in the input and never contacted.
- Path confinement resolves the real path of both the root and each input, so a
  symlink planted inside the root is refused while a legitimate file under a
  symlinked root is not.
- Strict UTF-8 decoding on every input, with no inference drawn from decoded
  text.
- Control (C0), DEL, C1, line/paragraph separator and bidi characters are
  stripped from every untrusted string that reaches output, identifiers and
  owners included; a value the tool refuses is described rather than reproduced.
  Two paths broke that rule and were fixed: an unsupported duration `unit` was
  quoted back verbatim under a docblock promising the opposite, and a stray
  object key was named at the document, entry and duration levels -- the entry
  message printing the key immediately after the sentence "no record, payload or
  credential field can reach this tool by accident". A unit is now described like
  every other refused value and a key is counted rather than named, so what an
  unknown key is called cannot change one byte of the report. The canary sweep,
  which had planted its placeholders only in a description, an owner, a class id
  and a whole-string retention, now plants them in a unit and in a key too.
- A parse failure does not quote the file it failed on. V8 writes
  `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, and
  `input-not-json` interpolated that message, so a retention file short enough
  to be nothing but a credential was reproduced in full on stdout -- the one
  claim above that stripping and truncation could not keep, since `excerpt` cuts
  from the end and the quoted span is at the front. The finding now carries the
  position, line, column and offending token and never the text at them, and
  `test/parse-failure-redaction.test.mjs` drives the AWS documentation
  placeholder through the real binary and asserts it absent from stdout, from
  stderr and from every prefix down to eight characters.

  The first fix was not enough on its own. It looked for `at position N` before
  it looked for the quoting shape, so a file whose own text reads
  `at position 1` -- V8 answers it with
  `Unexpected token 'a', "at position 1" is not valid JSON` -- had the offset
  found *inside* the quoted copy, and the slice shipped the copy. The quoting
  shape is now recognised first, matched across a line break, and any detail
  still carrying a double quote is discarded for the generic sentence.

No release has been published.
