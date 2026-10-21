# Contributing to NEXUS

Thank you for contributing. NEXUS runs agents and tools against real data: a change can be
functionally correct and still be dangerous. Every contribution must therefore preserve
deny-by-default, human confirmations and the non-disclosure of secrets.

## Language

The project is written in **English** — code, comments, documentation, user-facing strings and
test names. Issues and pull requests are accepted in English or French; maintainer replies will be
in English so the thread stays useful to everyone.

Part of the codebase predates this rule and is still in French. It is being translated, and the
remaining volume is measurable rather than vague:

```sh
pnpm translation:status                 # how much is left, by area
pnpm translation:status --files docs     # the remaining files in one area, largest first
```

If you touch such a file, translating the lines you touch is welcome; translating the whole file in
the same pull request is not, because it buries your actual change in a diff nobody can review.

The queue is ordered by who reads what. Entry doors first — they are done. Then user-facing strings
— also done. Then the architecture documents, then code comments package by package, and test names
last: no outside reader sees them, and renaming one can break a test filter in CI.

## Environment

1. Install the versions declared in `.nvmrc` and `package.json#packageManager`.
2. Copy `.env.example` to `.env` and put only development credentials in it.
3. Run `pnpm install`, then `pnpm db:generate`.
4. Before opening a pull request, run `pnpm verify` and `pnpm format:check`.
5. For a persistence change, also run `pnpm test:pg` against a PostgreSQL with pgvector.

The Python Mission Engine is verified with:

```bash
cd services/mission-engine
uv sync --frozen --extra dev
uv run pytest -q
```

## Rules

- Add a test that fails before the fix and passes after it.
- Never add a secret, token, cookie, browser export or absolute user path.
- Never weaken a permission or a confirmation to make a scenario pass.
- Document migrations, environment variables and lasting architectural choices.
- Keep packages framework-independent: the API stays the composition point.
- A new dependency needs a bounded version, a compatible licence and an explicit reason. Services
  under strong network licences stay optional and separate.

Sensitive changes — authentication, cryptography, command execution, MCP, sandboxing, updates —
require a security review. Report a vulnerability privately as described in
[`SECURITY.md`](SECURITY.md), never in a public issue.

## A test must be able to fail

This is the rule we have broken most often, so it is written down. A green check proves nothing
unless the check can go red. Three real examples from this repository:

- a helper that waited for a condition returned `false` on exhaustion instead of throwing, so
  callers carried on with a state they only believed was true — and an `async` predicate returns a
  promise, which is always truthy, so one such wait succeeded instantly and always;
- a guard test asserting that no signing secret appears in the Gradle files could not fail, because
  those files were not declared in that task's cache inputs. The build cache replied "green" for a
  file that had just changed;
- a rule forbidding `CRITICAL` actions without confirmation was removed from the product and the
  corpus stayed green — correctly, because a second barrier also blocked. Only removing both made
  `rm -rf` go through. Defence in depth is real here, and it is now measured rather than assumed.

So: when you add a guard, break it on purpose once and watch it go red. When you declare cache
inputs, verify the invalidation rather than assume it.

## AI-generated contributions

Most of NEXUS is written by AI agents working from written instructions, reviewed and merged by a
human who is accountable for the result. The commit trailers say so, and we would rather state it
plainly than let you discover it.

What this means for you as a contributor:

- **AI-assisted contributions are welcome.** We care that the code is correct, tested and
  explained, not about which tool typed it.
- **You must have read what you submit.** The pull request template asks you to confirm this. A
  contribution the author cannot explain cannot be reviewed, whoever or whatever wrote it.
- **Disclose it.** Not as a confession — it changes what reviewers look at. Machine-written code
  tends to fail differently from hand-written code: plausible-looking APIs that do not exist, tests
  that assert the implementation rather than the behaviour, comments describing intentions the code
  does not have.

### Developer Certificate of Origin

Every commit must carry a `Signed-off-by:` line, added by `git commit -s`:

```
Signed-off-by: Jane Doe <jane@example.com>
```

By signing off you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under the project's licence. For
machine-generated content, **you** are the one certifying it — the signature is what turns a tool's
output into a contribution somebody stands behind.

A CI check verifies the sign-off on pull requests. History predating this rule is not retroactively
signed, and we will not rewrite it: changing every hash of an already-merged branch would cost a
great deal and prove nothing.

### Contributor Licence Agreement

External contributions also require a signed [Contributor Licence Agreement](CLA.md). It is short
and it is standard: you keep the copyright on your work, and you grant the project a licence broad
enough to relicense it later.

We ask for it for one reason, stated honestly: NEXUS is AGPL-3.0, and without a CLA the licence can
never change again without the agreement of every past contributor, one by one. Collecting it costs
you a signature today; not collecting it would close that door permanently. If you would rather not
sign, say so in the pull request — a well-described bug report is worth more than a patch we cannot
accept.
