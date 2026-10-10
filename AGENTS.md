# AGENTS.md

How we work in every NOAN repo, for engineers and their coding agents. This repo's own commands and stack rules live in `CLAUDE.md`; read both. The repo file wins on conflict, and both win over any skill or tool default. Sections run from most to least critical.

## Hard rules

- **Never run without an explicit go in the current turn:** migrations or any ORM CLI touching a database, SQL on a shared database, changes to auth, permissions, secrets, keys, IAM, network, DNS or billing. Read-only checks are fine. Show the command and stop. Never `sudo`.
- **A statement is not a command.** "That's unused" or an answer to your question is not a go to delete, refactor or implement. Edit only on an explicit imperative.
- **`schema.sql` changes are additive and idempotent.** Never rename or drop a column or change a type: self-hosters already ran this file. Data changes run separately.
- **Never push to `main`.** Push your branch right after every commit, PR open or not. Never merge or close PRs, create releases or change repo settings.
- **Stage explicit paths**, never `git add -A` or `.`. Read `git status --short` before committing. Script output goes to a gitignored directory.

## Security

- **Public repo:** anyone reads every file, commit and PR. No keys, customer or workspace data in code, examples or PR text.
- **Authorization:** never trust an id, a role or a recipient that comes from a client or from input. The server decides.
- **Authentication:** every endpoint that reads or writes private data checks who is calling.
- **Input:** validate everything from outside (requests, webhooks, emails, model output) before acting on it. Never spread it into a write.
- **Injection:** no raw SQL or shell built from input. Values reach a shell or CI step as env vars or args.
- **Leaks:** errors expose no stack traces or internal data. No secrets in logs.
- **Secrets:** keys come from env or a secret store, never from a file in the repo.

## Before calling it done

- **Trace a branch you just activated.** If your change sends a value nothing sent before, read the receiving branch down to the query and check the most common data case.
- **Check write sides before calling a field unused**, in jobs and workers too.
- **Lint and format the changed files.** No full-project rebuild, no full test suite unless asked.

## Architecture

- **No column defaults with business meaning.** Nullable column, fallback resolved in code in one place.
- **Place modules by domain.** A generic mechanism (auth, rate limiting, a protocol) gets its own folder even with one caller. Decide it at plan time.
- **Keep the UI consistent.** If a request breaks an app-wide rule, name the rule and where else it applies before editing.
- **No speculative fixes:** add a guard or fallback when a real case needs it.

## Testing

From [Kent C. Dodds' testing principles](https://github.com/kentcdodds/kody/blob/main/docs/contributing/testing-principles.md).

**Tests run offline.** Pick the test by where the bug would be.

- **Logic with real branching and no I/O** (a parser, a rule, a gate): call it with inputs, assert outputs.
- **Code that talks to NOAN, a database or another service:** run it through the entry point production uses, against a local fake of that service (a stub server, an in-memory store). Never against a live workspace.
- **Mocking several of our own modules means the test only checks the mocks.** Test through the entry point instead.
- **Never skip silently.** No early return on a missing env var: a test that can't run fails.

**Principles**

- **Ask what bug the test catches.** None beyond the type checker means no test. No red-green on types, schemas or wiring.
- **Test the enforcement point** with the real branching, not the thin helper it calls.
- **Assert what a caller observes** (rendered output, payloads, public contracts), not markup, copy or config strings.
- **A refactor that keeps behavior shouldn't touch tests.** If it does, they test implementation.
- **No change detectors** on generated or external data. No fully mocked tests of a few lines of logic: write the manual check instead.
- **Fewer, longer tests:** one setup, then every action and assertion of the workflow, intermediate states included.
- **Flat files:** a test script runs its checks top to bottom, no setup or teardown hooks. Helpers return ready-to-use objects.
- **Name tests after behavior:** "dropping facts to None saves the key without its stack restriction".
- **High bar for regression tests.** Tests run offline with local fixtures.
- **Extend before adding:** find the test that already covers the branch and add to it.
- **Test surgery** when the suite grows: drop duplicates and copy pins, merge same-setup tests, turn input matrices into tables.
- **For manual-only behavior**, hand over numbered steps, one per code path, each with its expected result.

## Working with people

- **While a decision is open, give analysis, not edits:** trade-offs, `file:line`, what comparable products actually do.
- **Question scope** on tickets with no customer evidence or that pull the product into an adjacent category, before planning.
- **Don't rewrite LLM prompts** or other tuned text without asking what the goal is.
- **"Later", "not now", "park it" mean drop it.** No follow-up ticket or TODO unless asked.
- **Re-read a file right before editing it**, and the plan, ticket and `git log` before answering "what's left".

## Git

- `gh pr create --draft --head <branch> --base main`: a draft by default, always explicit.
- **Commit message: one imperative subject line.** No body, no trailers.
- Fixes to an earlier commit on an open branch are amended into it, not stacked.
- Branch `<initials>/<slug>` once work is agreed. Never delete or force-move someone else's branch.
- Don't watch CI; one status check is fine.

## Writing on GitHub

`gh` skips the web templates, so agents follow these by hand.

- **No em dashes**, anywhere (GitHub, code, UI copy, docs, chat). Factual, no commentary on difficulty, no selling. Cut lines that don't change what the reader does.
- **Linking:** leave the ticket alone while the PR is open. After merge, tick the item with the PR number only ("Done in #1821"), link it in Development, move the card to Done.
- **PRs:** exactly the sections of `.github/PULL_REQUEST_TEMPLATE.md`, 3 to 6 lines, nothing the ticket says.
- **Issue titles:** one sentence, under 80 characters, nothing after a dash or colon. Start with the type emoji: 🐞 bug, ✨ feature, 🔧 tech debt. Then tasks start with a verb, bugs state the observed behavior. Also set the matching label.
- **Issue bodies:** template sections, delete empty ones, never "N/A". One line per checklist item. Bugs paste the exact error.
- **Wrong-branch PR:** open the right one and say which to close; don't edit the wrong one.
- **Comments:** answer the question, link instead of re-explaining, no unasked status updates.

## Code

- Never export, rename or reshape code only so a test can reach it.
- A small flow is a plain function in a folder named by its domain. A class only for real state or a shared interface.
- Reuse a function by computing its full input before adding a mode for one caller.
- Shape hand-written config for the code that reads it. Needing `fromEntries` round trips or a cast means the shape is wrong.
- `map`/`filter`/`reduce` over loops that mutate a result. Plain objects over `Map` for string keys.

## Comments

Every comment gets reviewed. Default to none.

- **Only what the code can't show:** a constraint from another file, a non-local invariant, a line where a reader would ask "why?". Cut it if removing it wouldn't confuse anyone, doc blocks that summarize a short function included.
- **Keep existing comments** when refactoring, adapted to the new code. Drop one only when its code is gone.
- **One short, informal sentence**, the way you'd say it to a teammate. Not spec voice, not a label, never a question. Right: "A key's stacks only narrow, never widen. We re-check the creator's role every request, so demoting someone shrinks their keys right away."
- **The constraint, never the reasoning:** no rationale, no "like GitHub does", no pointer to a ticket or another function.
- **Current behavior only.** No "no longer", "instead of", "previously".
- **Plain verbs:** store, update, check, skip, create. Not park, stamp, mint, surface, leverage.
- **Format:** match the comment syntax the file already uses.

## Naming

- Concrete words already in the codebase ("key", "org", "limit"), not "principal", "ceiling", "budget". No jargon a non-native reader trips on ("old pricing", not "grandfathered").
- Use the product's terms as `SKILL.md` in `getnoan/skills` defines them (stack, block, fact). Never give one of them a second name.
- Name files and functions by what they do, not generic nouns (`services.ts`, `Manager`). Customer-facing copy is American English.

## Elsewhere

- Ground review findings in a `file:line`, a cited framework or a competitor's actual behavior. "Blocker" only if a live user path hits it.
- Lead with the answer. Two or three options max, each with a trade-off and a recommendation.
- Evidence and export files: `YYYYMMDD_snake_case.ext`.
