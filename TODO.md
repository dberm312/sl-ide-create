# Deferred tests

- [ ] CLI smoke tests with temporary homes/repos and stubbed git/gh/cloud:
  slides and memos, skipped GitHub/install/publishing, expired credentials,
  interrupted setup and useful recovery instructions.
- [ ] Confirm newly generated projects use the current cloud publisher, start
  team-only, and explain how to enable public sharing explicitly.
- [ ] Add the broader cross-repo smoke suite to CI once the cloud/template
  security fixtures exist (see their TODO.md files).

## Medium-severity findings and follow-up improvements

- [ ] Scope saved credentials by normalized cloud server URL and team. The
  recorded URL is currently ignored, so changing SL_IDE_URL can send a production
  token to another server. Migrate existing credentials safely and test server
  switching, logout and legacy-token handling. (Review issue 5.)
- [ ] Prevent accidental replacement of an existing team deck: choose a new slug
  by default and require an explicit replacement option instead of only warning
  before a new repo publishes over it.
