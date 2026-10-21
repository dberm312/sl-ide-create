# sl-ide-create

Start a slide deck with [sl-ide](https://github.com/dberm312/sl-ide-template),
the IDE for building slides with Claude Code or Codex.
Published to npm as `create-sl-ide`, which is what `pnpm create sl-ide` runs.

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
   through your browser, saves a token for your team, writes
   `sl-ide.config.json` and sets the repo's `SL_IDE_PUBLISH_TOKEN` secret.
   Every push to `main` then updates `app.sl-ide.com/d/my-deck/`.
4. Runs `pnpm install`.

Then `cd my-deck && pnpm dev`, open Claude Code or Codex there, and run
`/new-deck`.

## Options

```
--format <slides|memo>          16:9 slides, or a US Letter memo (default slides; --memo for short)
--dir <path>                    folder for the deck (default ./<name>)
--github <private|public|none>  the deck's repo (default private)
--team <slug>                   the sl-ide cloud team that owns the deck
--share <team|public>           legacy option; new decks always start team-only
--no-publish                    skip sl-ide cloud
--no-install                    skip pnpm install
--no-open                       print the sign-in link instead of opening it
-y, --yes                       take the defaults instead of asking
```

```sh
pnpm create sl-ide login     # sign in and save a token for a team
pnpm create sl-ide logout    # forget saved tokens
```

Tokens are saved in `~/.config/sl-ide/credentials.json`, readable only by
you, and can be revoked at app.sl-ide.com/tokens.

Needs Node 20.12+, git and pnpm, plus the GitHub CLI (`gh`) for the repo
and publishing.


New decks start team-only. After the first publish, open the deck's cloud page
and save “Anyone with the link” under Sharing to make it public. Publishing
cannot change sharing settings; `--share public` prints this instruction and
creates a team-only deck.
