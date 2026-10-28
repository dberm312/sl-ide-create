# sl-ide-create

Start a slide deck with [sl-ide](https://github.com/dberm312/sl-ide-template),
the IDE for building slides with Claude Code or Codex.
Published to npm as `create-sl-ide`, which is what `pnpm create sl-ide` runs.

You'll need:

- Node 20.19+ or 22.12+
- pnpm (`corepack enable pnpm`)
- Git
- The GitHub CLI, signed in (`gh auth login`)
- Claude Code or Codex

```sh
pnpm create sl-ide my-deck
pnpm create sl-ide my-memo --memo   # a memo on US Letter pages instead of slides
pnpm create sl-ide .                # in the current (empty) folder, named after it
# or: npm create sl-ide@latest my-deck · bun create sl-ide my-deck
```

It asks a few questions (slides or a memo; with no name in an empty
folder, whether to build right there; the repo; publishing), then:

1. Clones the **latest** sl-ide template from GitHub, keeping its history as
   the `upstream` remote, so `git pull upstream main` brings later editor
   updates into your deck. The editor isn't bundled in this package, so every
   new deck starts from the template's current `main`.
2. Creates the deck's own GitHub repo (private by default).
3. Sets it up to publish to [sl-ide cloud](https://app.sl-ide.com): signs you in
   through your browser, saves an account token on your machine, writes
   `sl-ide.config.json` and sets the repo's `SL_IDE_PUBLISH_TOKEN` secret to a
   deck token that can publish only this deck.
   Every push to `main` then updates `app.sl-ide.com/d/my-deck/`.
4. Runs `pnpm install`.

Then `cd my-deck && pnpm dev`, open Claude Code or Codex there, and run
`/new-deck`.

## Options

```
--format <slides|memo>          16:9 slides, or a US Letter memo (default slides; --memo for short)
--dir <path>                    folder for the deck (default ./<name>)
--github <private|public|none>  the deck's repo (default private)
--feedback <auto|off>          automatic anonymous usage feedback (default off)
--replace <slug>                explicitly replace an existing cloud deck
--no-publish                    skip sl-ide cloud
--no-install                    skip pnpm install
--no-open                       print the sign-in link instead of opening it
-y, --yes                       take the defaults instead of asking
```

```sh
pnpm create sl-ide login     # sign in and save an account token on this machine
pnpm create sl-ide logout    # forget saved tokens (--all: for every server)
pnpm create sl-ide@latest token   # in a deck: set its repo secret to a new deck token
```

The account token is saved in `~/.config/sl-ide/credentials.json`, readable
only by you, and never leaves this machine. Once the slug is chosen, setup
trades it for a deck token for that slug (`POST /api/cli/deck-token`) and puts
only that in the repo, so a leaked repo secret can publish only that one deck.
`token` does the same for an existing deck (after a failed setup, or for a deck
made before deck tokens); revoke the token it replaces at
app.sl-ide.com/tokens, where both kinds are listed. Each token is kept for the
server that issued it and only ever sent there. `SL_IDE_URL` picks another
server (https, or http on localhost), which needs its own `login`; decks set up
against it record it as `url` in `sl-ide.config.json`.

Each request to the server has a deadline (`SL_IDE_REQUEST_TIMEOUT_MS`,
default 30 s). Token checks are tried again after a timeout, a lost connection,
408, 429 or 5xx; a refused token is not. The sign-in token arrives in exactly
one answer, so if that answer is lost the CLI says to run `login` again rather
than polling on.

Setup checks Node, Git, pnpm and the GitHub CLI before its first question and
stops with the command that fixes whatever is missing. With `--github none` it
skips the GitHub check (and publishing, which runs in GitHub Actions). Stuck?
[sl-ide.com/contact](https://sl-ide.com/contact).

New projects use a fresh cloud slug. If `my-deck` exists, setup tries
`my-deck-2`, `my-deck-3`, and so on, without changing the folder or repo name.
This also applies with `--yes`. To intentionally publish over an existing deck,
use `pnpm create sl-ide new-repo --replace my-deck`.
The target must exist and your token must have permission to publish to it.
Setup checks availability before creating the repo; it does not reserve the slug.

New decks start restricted. After the first publish, open the deck's cloud page
(`app.sl-ide.com/decks/my-deck`) and choose Share to add viewers or allow “Anyone with the link”
to make it public; setup prints this link. Publishing cannot change sharing
settings.

`pnpm create sl-ide` runs a copy pnpm has cached, which can be older than the
latest release (one without `token` takes `token` for a deck name). On start
the CLI asks the npm registry for the latest version, at most once a day and
for at most 1.5 seconds, and warns `create-sl-ide X is out of date (latest
Y): run pnpm create sl-ide@latest …`. Offline, it just runs. Use `@latest`
for `token` and any command newer than your cached copy.

## Tests and bench

`pnpm test` runs every suite under `test/` against fake `git`, `gh`, `pnpm`
and cloud (`test/harness.mjs`). `pnpm bench` runs it three times and writes
the median and min wall time, with the machine's CPU count, OS and Node, to
`output/bench.json`, then prints the 10 slowest tests. `pnpm bench --compare`
adds the speedup against `bench/baseline.json` (the SL-60 baseline, from an
8-core Mac); `pnpm bench --compare main` runs `main` in a throwaway worktree
on this machine instead, the fair before/after for a PR. `--runs N` changes
the count and `--save` rewrites the baseline. CI runs `pnpm test` through it
once and warns, without failing, when it takes over 1.5x its baseline.

## Cross-repo CI

The `Cross-repo smoke` workflow dispatches the shared suite in private
`sl-ide-cloud` and waits for its result. On trusted main pushes, it tests the
exact CLI commit with the current template and cloud. The shared suite runs
the real CLI, clones the template with Git, builds slides and memos, prints
PDFs, publishes them to a disposable cloud and checks the served artifacts.
Only GitHub commands are replaced with a local bare repository; Clerk and
Blob use test fixtures. The helper is `test/support/cross-repo.mjs`; cloud owns
the database/browser fixtures and integration assertions. No production
credentials or decks are used.

Activation requires repository secret `CROSS_REPO_CI_TOKEN`: a fine-grained
GitHub token scoped to `dberm312/sl-ide-cloud` with Actions read/write.
The dispatch job never checks out or executes PR source. Missing secrets,
failed downstream runs and timeouts fail the check. Public PRs run
`CLI checks` without the dispatch token. Cross-repo tests run only for trusted
main commits; cloud validates the SHA against public main before allowing it
into the private fixture checkout. `CLI checks` is a required check on `main`,
and the secret is installed
([SL-38](https://linear.app/sl-ide/issue/SL-38/activate-hosted-staging-and-cross-repo-ci-enforcement)).
Check the main-push result before releasing.

## Anonymous harness feedback

Feedback is off by default, including with `-y`. Choose Auto during setup or use
`pnpm create sl-ide my-deck --feedback auto`; `--feedback off` keeps it off.
Reports describe harness behavior, audit counts and workarounds, never deck copy,
names or file contents. A random project ID lives only in gitignored
`.sl-ide/feedback.json`; a fresh clone gets a new ID.

In a deck, `pnpm feedback on` / `off` toggles automatic reports. `status` shows
settings and the endpoint; `log` shows queued and sent JSON. `/give-feedback`
previews a manual report and asks “Send?” even when automatic feedback is off.
`DO_NOT_TRACK=1` or `SL_IDE_FEEDBACK=0` blocks every delivery.
`SL_IDE_FEEDBACK_DEBUG=1` prints scrubbed payloads locally without sending.

Reports are scrubbed before being saved to `.sl-ide/outbox/`, and again before
retrying. Delivery times out after five seconds. Failed deliveries stay queued
(up to 20 reports) for a later run; successful ones move to `.sl-ide/sent/`.
Existing decks get the scripts through `/update-sl-ide` and stay opted out.
