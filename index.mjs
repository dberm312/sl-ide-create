#!/usr/bin/env node
// pnpm create sl-ide [name] [options]   (also npm create sl-ide, bunx create-sl-ide)
//
// Starts a new deck: clones the latest sl-ide template from GitHub (with its
// history, as `upstream`, so `git pull upstream main` brings later editor
// updates), creates the deck's own repo, sets it up to publish to sl-ide
// cloud, and installs dependencies. The editor itself is never bundled here,
// so a new deck always starts from the template's main.
//
//   pnpm create sl-ide .         start the deck in this (empty) folder, named after it
//   pnpm create sl-ide login     sign in to sl-ide cloud and save an account token here
//   pnpm create sl-ide logout    forget saved tokens for this cloud server
//   pnpm create sl-ide token     in a deck: give its repo a new deck token
//
// The account token stays in ~/.config/sl-ide. A deck repo's
// SL_IDE_PUBLISH_TOKEN secret is a deck token, which publishes that deck only.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import { CLOUD, DEFAULT_CLOUD, credsPath, deckToken, deviceLogin, forget, readCreds, saveToken, slugAvailable, whoami } from './lib/cloud.mjs';
import { ghReady, has, run, stopRunning } from './lib/run.mjs';
import { chooseSlug, SLUG_RE } from './lib/slug.mjs';

const TEMPLATE = process.env.SL_IDE_TEMPLATE || 'https://github.com/dberm312/sl-ide-template.git';

const HELP = `
  pnpm create sl-ide [name] [options]
  pnpm create sl-ide . [options]     in this empty folder, named after it

  Start a new deck (or memo) from the latest sl-ide template.

  Options
    --format <slides|memo>   16:9 slides, or a memo on US Letter pages (default: slides)
    --memo                   short for --format memo
    --dir <path>             folder to create the deck in (default: ./<name>)
    --github <private|public|none>   the deck's GitHub repo (default: private)
    --feedback <auto|off>    automatic anonymous usage feedback (default: off)
    --replace <slug>         explicitly publish over an existing deck instead of creating a new slug
    --no-publish             don't set up publishing to sl-ide cloud
    --no-install             skip pnpm install
    --no-open                print the sign-in link instead of opening a browser
    -y, --yes                take the defaults instead of asking
    -h, --help

  Commands
    login                    sign in to sl-ide cloud and save an account token on this machine
    logout            forget saved tokens for this server (--all: every server)
    token                    in a deck folder: set its repo's SL_IDE_PUBLISH_TOKEN to a new
                             token that can publish only that deck

  Every push to the deck's repo publishes it to ${CLOUD}/d/<slug>/.
  Existing slugs get a numeric suffix unless --replace is explicitly provided.
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string' },
    memo: { type: 'boolean' },
    dir: { type: 'string' },
    github: { type: 'string' },
    feedback: { type: 'string' },
    replace: { type: 'string' },
    publish: { type: 'boolean', default: true },
    'no-publish': { type: 'boolean' },
    install: { type: 'boolean', default: true },
    'no-install': { type: 'boolean' },
    open: { type: 'boolean', default: true },
    'no-open': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    all: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (o['no-publish']) o.publish = false;
if (o['no-install']) o.install = false;
if (o['no-open']) o.open = false;
if (o.memo) o.format = 'memo';
if (o.help) { console.log(HELP); process.exit(0); }

const interactive = process.stdin.isTTY && !o.yes;
const CONTACT = 'https://sl-ide.com/contact';
const bail = (msg, { help = true } = {}) => {
  p.cancel(msg);
  if (help) console.log(`Stuck? ${CONTACT}`);
  process.exit(1);
};
const ask = async (prompt) => {
  const v = await prompt;
  if (p.isCancel(v)) bail('Cancelled.', { help: false });
  return v;
};

// --- preflight -------------------------------------------------------------

// The deck's editor (Vite) needs Node ^20.19 or >=22.12.
const nodeOk = ([major, minor]) => (major === 20 ? minor >= 19 : major === 22 ? minor >= 12 : major > 22);

// Everything setup needs, checked before the first question so nobody answers
// prompts only to stop halfway. Each failure names the command that fixes it.
function preflight() {
  if (!nodeOk(process.versions.node.split('.').map(Number))) {
    bail(`Node ${process.versions.node} is too old; sl-ide needs 20.19+ or 22.12+. Install the current LTS: https://nodejs.org (or: nvm install --lts)`);
  }
  if (!has('git')) bail('Git is needed: https://git-scm.com/downloads (macOS: xcode-select --install)');
  if (!has('pnpm')) bail('pnpm is needed: corepack enable pnpm');
  if (o.github !== undefined && !['private', 'public', 'none'].includes(o.github)) bail('--github is private, public or none');
  if (o.github === 'none') return;
  if (!has('gh')) bail('The GitHub CLI (gh) is needed: https://cli.github.com (macOS: brew install gh), then gh auth login. Or pass --github none.');
  if (!ghReady()) bail('Sign in to GitHub first: gh auth login (or pass --github none)');
}

// --- sign-in ---------------------------------------------------------------

async function signIn() {
  const s = p.spinner();
  const got = await deviceLogin({
    open: o.open,
    onCode: (code, url) => {
      p.note(`${url}\n\nCode: ${code}`, o.open ? 'Approve in your browser' : 'Open this link to approve');
      s.start('Waiting for approval');
    },
  }).catch((e) => { s.stop('Sign-in failed'); bail(e.message); });
  s.stop(`Signed in`);
  saveToken(got.owner, got.token);
  return got;
}

// Reuse this server's signed-in account; no organization selection.
async function publishCredentials() {
  const saved = readCreds();
  if (saved) return saved;
  if (!interactive) return signIn();
  const publish = await ask(p.confirm({ message: 'Publish this deck to sl-ide cloud?', initialValue: true }));
  return publish ? signIn() : null;
}

// --- recovery --------------------------------------------------------------

// What to do when setup stops during `step`. Until the GitHub repo exists,
// everything is local, so starting over is safe.
function recoverySteps(step, { rel, here, repo }) {
  const cd = rel === '.' ? [] : [`cd ${rel}`];
  const again = ['pnpm create sl-ide', ...process.argv.slice(2)].join(' ');
  // Commands get their own lines so they copy cleanly.
  const fresh = [here ? 'Empty this folder, then run:' : `Delete ${rel}, then run:`, again];
  switch (step) {
    case 'repo':
      return [`Check github.com/${repo}. If it was created, delete it:`, `gh repo delete ${repo}`, ...fresh];
    case 'secret':
      return [`github.com/${repo} exists but can't publish yet. Give it a deck token, then push:`,
        ...cd, 'pnpm create sl-ide token', 'git push -u origin main'];
    case 'push':
      return [`github.com/${repo} exists. Push the deck to it:`, ...cd, 'git push -u origin main'];
    case 'install':
      return ['The deck is set up. Only the install is left:', ...cd, 'pnpm install'];
    default:
      return ['Nothing was created on GitHub.', ...fresh];
  }
}

// --- commands --------------------------------------------------------------

async function login() {
  p.intro('sl-ide cloud');
  await signIn();
  p.outro(`Saved to ${credsPath} for ${CLOUD}. New decks can publish for your account.`);
}

// Give the deck in this folder (its sl-ide.config.json) a new deck token as
// its repo's secret: after a failed setup, or to replace an old token. The
// old one keeps working until it is revoked at /tokens.
async function token() {
  p.intro('sl-ide cloud · deck token');
  let config;
  try { config = JSON.parse(fs.readFileSync('sl-ide.config.json', 'utf8')); } catch {
    bail('Run this in a deck folder: no readable sl-ide.config.json here.');
  }
  const slug = config?.slug;
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) bail('sl-ide.config.json has no valid "slug".');
  let server;
  try { server = config.url === undefined ? DEFAULT_CLOUD : new URL(config.url).origin; } catch { bail('sl-ide.config.json has an invalid "url".'); }
  if (server !== CLOUD) bail(`This deck publishes to ${server}. Run: SL_IDE_URL=${server} pnpm create sl-ide token`);
  if (!ghReady()) bail('GitHub CLI is not signed in. Run: gh auth login');
  const pub = readCreds() ?? await signIn();
  const ok = await whoami(pub.token).catch((e) => bail(`Couldn't check the saved token: ${e.message}`));
  if (!ok || ok.owner !== pub.owner || ok.deck) bail(`The saved token for ${pub.owner} was rejected (revoked?). Run: pnpm create sl-ide login`);
  const minted = await deckToken(pub.token, slug).catch((e) => bail(`Couldn't make a deck token: ${e.message}`));
  await run('gh', ['secret', 'set', 'SL_IDE_PUBLISH_TOKEN'], { input: minted })
    .catch((e) => bail(`${e.message}\nThe new token was not stored; revoke the unused "Deck · ${slug}" token at ${CLOUD}/tokens.`));
  p.outro(`Set SL_IDE_PUBLISH_TOKEN to a token that publishes only ${slug}. Revoke any older token for it at ${CLOUD}/tokens.`);
}

function logout() {
  forget({ all: o.all });
  console.log(o.all ? 'Forgot saved sl-ide tokens for every server.' : `Forgot saved sl-ide tokens for ${CLOUD}.`);
}

async function create() {
  p.intro('sl-ide · new deck');
  if (o.feedback !== undefined && !['auto','off'].includes(o.feedback)) bail('--feedback is auto or off');
  preflight();

  // `.` builds the deck in the current folder and names it after the folder.
  // Asked too, when no name is given and this folder is empty.
  const cwdEmpty = fs.readdirSync(process.cwd()).every((f) => f === '.DS_Store');
  let here = positionals[0] === '.';
  if (!positionals[0] && !o.dir && interactive && cwdEmpty) {
    here = await ask(p.select({
      message: 'Where should it go?',
      options: [
        { value: true, label: 'This folder', hint: path.basename(process.cwd()) },
        { value: false, label: 'A new folder inside this one' },
      ],
    }));
  }
  let name = here ? path.basename(process.cwd()) : positionals[0];
  if (!name) {
    if (!interactive) bail('Give the deck a name: pnpm create sl-ide my-deck');
    name = await ask(p.text({
      message: 'Deck name',
      placeholder: 'acme-pitch',
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v ?? '') ? undefined : 'Letters, digits, . _ and - only'),
    }));
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) bail(`"${name}" isn't a valid name (letters, digits, . _ -)`);
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!SLUG_RE.test(slug)) bail(`can't make a link name from "${name}"`);

  // Slides or a memo. A memo is the same template with the memo starter
  // swapped in by its own script (scripts/use-format.mjs).
  let format = o.format;
  if (!format) {
    format = interactive ? await ask(p.select({
      message: 'What are you making?',
      options: [
        { value: 'slides', label: 'Slides', hint: '16:9 pages' },
        { value: 'memo', label: 'A memo', hint: 'US Letter pages, text flows from page to page' },
      ],
    })) : 'slides';
  }
  if (!['slides', 'memo'].includes(format)) bail('--format is slides or memo');

  const dest = path.resolve(o.dir ?? (here ? '.' : name));
  if (fs.existsSync(dest)) {
    // Finder leaves .DS_Store in folders it opens; it would stop git clone.
    const left = fs.readdirSync(dest).filter((f) => f !== '.DS_Store');
    if (left.length) bail(`${dest} already exists and isn't empty`);
    fs.rmSync(path.join(dest, '.DS_Store'), { force: true });
  }

  // GitHub repo (preflight checked gh unless --github none)
  let github = o.github;
  if (!github) {
    github = interactive ? await ask(p.select({
      message: 'GitHub repo for the deck',
      options: [
        { value: 'private', label: 'Private', hint: 'recommended' },
        { value: 'public', label: 'Public' },
        { value: 'none', label: 'None for now' },
      ],
    })) : 'private';
  }
  let owner = null;
  if (github !== 'none') {
    owner = await run('gh', ['api', 'user', '-q', '.login']);
    const exists = await run('gh', ['repo', 'view', `${owner}/${name}`]).then(() => true, () => false);
    if (exists) bail(`github.com/${owner}/${name} already exists`);
  }

  let feedback = o.feedback;
  if (!feedback) {
    feedback = interactive ? await ask(p.select({
      message: 'Send anonymous usage feedback automatically? It sends how sl-ide was used, never your content.',
      initialValue: 'off',
      options: [{ value: 'off', label: 'Off', hint: 'default' }, { value: 'auto', label: 'Auto' }],
    })) : 'off';
  }

  // Publishing
  let pub = null;
  if (o.publish && github !== 'none') {
    pub = await publishCredentials();
    if (pub) {
      const ok = await whoami(pub.token).catch((e) => bail(`Couldn't check the saved token: ${e.message}. Nothing has been created yet; try again.`));
      if (!ok) bail(`The saved token for ${pub.owner} was rejected (revoked?). Run: pnpm create sl-ide login`);
      if (ok.owner !== pub.owner || ok.deck) bail('The saved account does not match the token. Run: pnpm create sl-ide login');
      const originalSlug = slug;
      try {
        slug = await chooseSlug(slug, { replace: o.replace, check: (candidate) => slugAvailable(pub.token, candidate) });
      } catch (e) { bail(e.message); }
      if (o.replace !== undefined) p.log.warn(`Explicitly replacing deck ${slug} for your account.`);
      else if (slug !== originalSlug) p.log.info(`Using new deck slug ${slug}; ${originalSlug} is already in use.`);
      // The repo gets a token for this deck only; the account token stays here.
      const minted = await deckToken(pub.token, slug).catch((e) => bail(`Couldn't make a publish token for ${slug}: ${e.message}. Nothing has been created yet; try again.`));
      pub = { ...pub, deckToken: minted };
    }
  } else if (o.publish && github === 'none') {
    p.log.info('Publishing runs in GitHub Actions, so it is off without a repo.');
  }

  if (o.replace !== undefined && !pub) bail('--replace requires cloud publishing and a GitHub repo.');

  // Do it
  const rel = path.relative(process.cwd(), dest) || '.';
  const where = { rel, here, repo: `${owner}/${name}` };
  const s = p.spinner();
  let step = null;
  // Ctrl-C during a spinner exits 0 from inside clack, so the exit hook (not
  // only SIGINT) reports an unfinished step.
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  process.on('exit', () => {
    if (!step) return;
    stopRunning();
    s.cancel('Interrupted');
    fs.writeSync(2, `\nSetup was interrupted. To recover:\n${recoverySteps(step, where).map((l) => `  ${l}`).join('\n')}\n`);
    if (!process.exitCode) process.exitCode = 130;
  });
  try {
    step = 'clone';
    s.start('Cloning the latest sl-ide template');
    await run('git', ['clone', '-q', TEMPLATE, dest]);
    await run('git', ['remote', 'rename', 'origin', 'upstream'], { cwd: dest });
    await run('git', ['config', 'pull.rebase', 'false'], { cwd: dest });
    const head = await run('git', ['log', '-1', '--format=%h %s'], { cwd: dest });
    s.stop(`Cloned sl-ide (${head.split(' ')[0]})`);

    // Local consent only, never committed or derived from a deck identifier.
    fs.mkdirSync(path.join(dest, '.sl-ide'), { recursive: true, mode: 0o700 });
    // Also protect the ID when cloning an older template without the ignore rule.
    const ignore = path.join(dest, '.gitignore');
    const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
    if (!ignored.split('\n').includes('.sl-ide/')) fs.appendFileSync(ignore, '\n.sl-ide/\n');
    fs.writeFileSync(path.join(dest, '.sl-ide/feedback.json'), JSON.stringify({
      version: 1, auto: feedback === 'auto', projectId: `fb_${randomUUID()}`,
    }, null, 2) + '\n', { mode: 0o600 });

    if (format !== 'slides') {
      step = 'format';
      if (!fs.existsSync(path.join(dest, 'scripts', 'use-format.mjs'))) {
        throw new Error(`this sl-ide template has no ${format} format yet`);
      }
      await run('node', ['scripts/use-format.mjs', format], { cwd: dest });
      await run('git', ['add', '-A'], { cwd: dest });
      await run('git', ['commit', '-q', '-m', `Start from the ${format} starter`], { cwd: dest });
      p.log.success(`Set up as a ${format}`);
    }

    if (pub) {
      step = 'config';
      // CI publishes to the server the token came from.
      const config = { slug, ...(CLOUD === DEFAULT_CLOUD ? {} : { url: CLOUD }) };
      fs.writeFileSync(path.join(dest, 'sl-ide.config.json'), `${JSON.stringify(config, null, 2)}\n`);
      await run('git', ['add', 'sl-ide.config.json'], { cwd: dest });
      await run('git', ['commit', '-q', '-m', `Publish to sl-ide cloud as ${slug}`], { cwd: dest });
    }

    if (github !== 'none') {
      step = 'repo';
      s.start(`Creating github.com/${owner}/${name}`);
      await run('gh', ['repo', 'create', name, `--${github}`, '--source', '.', '--remote', 'origin'], { cwd: dest });
      // Otherwise gh in the deck may pick `upstream` (the template) for run list, secret set, etc.
      const defaulted = await run('gh', ['repo', 'set-default', `${owner}/${name}`], { cwd: dest }).then(() => true, () => false);
      if (!defaulted) p.log.warn(`Couldn't make ${owner}/${name} gh's default repo in the deck. In ${rel}, run: gh repo set-default ${owner}/${name}`);
      // Before the first push, so its CI run publishes.
      step = 'secret';
      if (pub) await run('gh', ['secret', 'set', 'SL_IDE_PUBLISH_TOKEN', '--repo', `${owner}/${name}`], { cwd: dest, input: pub.deckToken });
      step = 'push';
      await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dest });
      s.stop(`Created github.com/${owner}/${name} (${github})`);
    }

    if (o.install) {
      step = 'install';
      s.start('Installing dependencies');
      await run('pnpm', ['install', '--silent'], { cwd: dest });
      s.stop('Installed dependencies');
    }
  } catch (e) {
    const failed = step;
    step = null;
    s.stop('Stopped');
    p.log.error(e.message);
    p.note(recoverySteps(failed, where).join('\n'), 'To recover');
    bail('Setup did not finish.');
  }
  step = null;

  const lines = [
    ...(rel === '.' ? [] : [`cd ${rel}`]),
    ...(o.install ? [] : ['pnpm install']),
    'pnpm dev',
    '',
    'Then open Claude Code or Codex in that folder and run /new-deck',
    `(Codex: $new-deck) to learn your style and outline the ${format === 'memo' ? 'memo' : 'story'}.`,
  ];
  p.note(lines.join('\n'), 'Next');
  if (pub) {
    p.log.success(`Every push to main publishes ${CLOUD}/d/${slug}/ (restricted).`);
    p.log.info(`To share it, open ${CLOUD}/decks/${slug} after the first publish. Choose Share to add viewers or allow anyone with the link.`);
  } else {
    p.log.info('Not publishing. To publish later, add sl-ide.config.json (see the deck\'s README).');
  }
  p.outro(format === 'memo' ? 'Memo ready.' : 'Deck ready.');
}

const cmd = positionals[0];
if (cmd === 'login') await login();
else if (cmd === 'logout') logout();
else if (cmd === 'token') await token();
else await create();
