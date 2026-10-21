# Create todos

Stable IDs and estimated release gates. **FIRST** = before the first external
user; **SCALE** = before scale; **DONE** = completed. These are recommendations,
not new implementation authorization. See [the workspace map](../TODO.md) for
dependencies, rationale and shared work. Existing deferrals remain recorded below.

# Deferred tests

- [x] **create-A · DONE** — CLI smoke tests with temporary homes/repos and stubbed git/gh/cloud:
  slides and memos, skipped GitHub/install/publishing, expired credentials,
  interrupted setup and useful recovery instructions. `test/smoke.test.mjs`
  (shared fakes in `test/harness.mjs`) runs with `pnpm test`. It found and fixed
  a bug: Ctrl-C during setup exited 0 silently and left git/gh running. Failed or
  interrupted setup now stops running commands and prints recovery steps for the
  step it reached. [SL-21](https://linear.app/sl-ide/issue/SL-21). create-D adds
  its server-switching and legacy-URL cases to this suite when it lands.
- [ ] **create-B · FIRST** — Confirm newly generated projects use the current cloud publisher, start
  team-only, and explain how to enable public sharing explicitly.
- [ ] **create-C · SCALE** — Add the broader cross-repo smoke suite to CI once the cloud/template
  security fixtures exist (see their TODO.md files).

## Medium-severity findings and follow-up improvements

- [ ] **create-D · FIRST** — Scope saved credentials by normalized cloud server URL and team. The
  recorded URL is currently ignored, so changing SL_IDE_URL can send a production
  token to another server. Migrate existing credentials safely and test server
  switching, logout and legacy-token handling. (Review issue 5.)
- [x] **create-E · DONE** — Prevent accidental replacement of an existing team deck: choose a new slug
  by default and require `--replace <slug>` to publish over an existing deck.
  Regression cases run with `pnpm test`; the broader create-A smoke suite above
  should retain these existing-deck cases.

## Website split context — 2026-10-21

create-A/B target the new default `https://app.sl-ide.com`; old CLI approval
links and API requests remain supported through `sl-ide-website` at `sl-ide.com`.
create-D must explicitly handle saved old server URLs without trusting arbitrary
redirects or forwarding production credentials to unrelated servers. Changing
the default URL did not complete credential isolation or these test suites.
