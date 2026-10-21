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
//   pnpm create sl-ide login     sign in to sl-ide cloud and save a team token
//   pnpm create sl-ide logout    forget saved tokens
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import { CLOUD, credsPath, deviceLogin, forget, legacyToken, readCreds, saveToken, slugAvailable, whoami } from './lib/cloud.mjs';
import { ghReady, has, run } from './lib/run.mjs';
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
    --team <slug>            the sl-ide cloud team that owns the deck
    --replace <slug>         explicitly publish over an existing deck instead of creating a new slug
    --share <team|public>    team-only initially; enable public sharing on the cloud deck page
    --no-publish             don't set up publishing to sl-ide cloud
    --no-install             skip pnpm install
    --no-open                print the sign-in link instead of opening a browser
    -y, --yes                take the defaults instead of asking
    -h, --help

  Commands
    login                    sign in to sl-ide cloud and save a team token
    logout [team]            forget saved tokens

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
    team: { type: 'string' },
    replace: { type: 'string' },
    share: { type: 'string' },
    publish: { type: 'boolean', default: true },
    'no-publish': { type: 'boolean' },
    install: { type: 'boolean', default: true },
    'no-install': { type: 'boolean' },
    open: { type: 'boolean', default: true },
    'no-open': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (o['no-publish']) o.publish = false;
if (o['no-install']) o.install = false;
if (o['no-open']) o.open = false;
if (o.memo) o.format = 'memo';
if (o.help) { console.log(HELP); process.exit(0); }

const interactive = process.stdin.isTTY && !o.yes;
const bail = (msg) => { p.cancel(msg); process.exit(1); };
const ask = async (prompt) => {
  const v = await prompt;
  if (p.isCancel(v)) bail('Cancelled.');
  return v;
};

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
  s.stop(`Signed in for team ${got.team}`);
  saveToken(got.team, got.token);
  return got;
}

// A token for the deck's team: a saved one, the legacy admin token, or a new
// browser sign-in. Returns { team, token } or null to skip publishing.
async function publishCredentials() {
  const saved = readCreds().teams;
  const teams = Object.keys(saved);
  const admin = legacyToken();

  if (o.team) {
    if (!SLUG_RE.test(o.team)) bail(`--team "${o.team}" isn't a team slug`);
    if (saved[o.team]) return { team: o.team, token: saved[o.team].token };
    if (admin) return { team: o.team, token: admin };
    p.log.info(`No saved token for team ${o.team}. Sign in to make one.`);
    const got = await signIn();
    if (got.team !== o.team) p.log.warn(`You approved team ${got.team}; publishing for that team instead.`);
    return got;
  }

  if (!interactive) {
    if (teams.length === 1) return { team: teams[0], token: saved[teams[0]].token };
    p.log.warn('Not publishing: pass --team <slug>, or run pnpm create sl-ide login first.');
    return null;
  }

  const choice = await ask(p.select({
    message: 'Publish this deck to sl-ide cloud?',
    options: [
      ...teams.map((t) => ({ value: `team:${t}`, label: `Yes, for team ${t}` })),
      { value: 'login', label: teams.length ? 'Yes, for another team (sign in)' : 'Yes (sign in to sl-ide cloud)', hint: 'opens your browser' },
      { value: 'skip', label: 'Not now', hint: 'add sl-ide.config.json later' },
    ],
  }));
  if (choice === 'skip') return null;
  if (choice === 'login') return signIn();
  const team = choice.slice(5);
  return { team, token: saved[team].token };
}

// --- commands --------------------------------------------------------------

async function login() {
  p.intro('sl-ide cloud');
  await signIn();
  p.outro(`Saved to ${credsPath}. New decks can publish for this team.`);
}

function logout() {
  forget(positionals[1]);
  console.log(positionals[1] ? `Forgot the token for ${positionals[1]}.` : 'Forgot all saved sl-ide tokens.');
}

async function create() {
  p.intro('sl-ide · new deck');

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

  for (const tool of ['git', 'pnpm']) {
    if (!has(tool)) bail(tool === 'pnpm' ? 'pnpm is needed: corepack enable pnpm' : 'git is needed');
  }

  // GitHub repo
  let github = o.github;
  const gh = ghReady();
  if (!github) {
    github = !gh ? 'none'
      : interactive ? await ask(p.select({
        message: 'GitHub repo for the deck',
        options: [
          { value: 'private', label: 'Private', hint: 'recommended' },
          { value: 'public', label: 'Public' },
          { value: 'none', label: 'None for now' },
        ],
      })) : 'private';
    if (!gh) p.log.warn('GitHub CLI not signed in (gh auth login), so no repo will be made. Publishing needs one.');
  }
  if (!['private', 'public', 'none'].includes(github)) bail('--github is private, public or none');
  if (github !== 'none' && !gh) bail('gh is not installed or not signed in: gh auth login');
  let owner = null;
  if (github !== 'none') {
    owner = await run('gh', ['api', 'user', '-q', '.login']);
    const exists = await run('gh', ['repo', 'view', `${owner}/${name}`]).then(() => true, () => false);
    if (exists) bail(`github.com/${owner}/${name} already exists`);
  }

  // Publishing
  let pub = null;
  let share = o.share ?? 'team';
  if (o.publish && github !== 'none') {
    pub = await publishCredentials();
    if (pub) {
      const ok = await whoami(pub.token);
      if (!ok) bail(`The saved token for ${pub.team} was rejected (revoked?). Run: pnpm create sl-ide login`);
      const originalSlug = slug;
      try {
        slug = await chooseSlug(slug, { replace: o.replace, check: (candidate) => slugAvailable(pub.token, candidate) });
      } catch (e) { bail(e.message); }
      if (o.replace !== undefined) p.log.warn(`Explicitly replacing deck ${slug} for team ${pub.team}.`);
      else if (slug !== originalSlug) p.log.info(`Using new deck slug ${slug}; ${originalSlug} is already in use.`);
      // Publishing never changes privacy. Public sharing is an authenticated
      // action on the cloud deck page, after the first successful publish.
      if (share === 'public') p.log.warn('New decks start team-only. After publishing, choose Anyone with the link on the cloud deck page.');
      if (!['team', 'public'].includes(share)) bail('--share is team or public');
      share = 'team';
    }
  } else if (o.publish && github === 'none') {
    p.log.info('Publishing runs in GitHub Actions, so it is off without a repo.');
  }

  if (o.replace !== undefined && !pub) bail('--replace requires cloud publishing and a GitHub repo.');

  // Do it
  const s = p.spinner();
  try {
    s.start('Cloning the latest sl-ide template');
    await run('git', ['clone', '-q', TEMPLATE, dest]);
    await run('git', ['remote', 'rename', 'origin', 'upstream'], { cwd: dest });
    await run('git', ['config', 'pull.rebase', 'false'], { cwd: dest });
    const head = await run('git', ['log', '-1', '--format=%h %s'], { cwd: dest });
    s.stop(`Cloned sl-ide (${head.split(' ')[0]})`);

    if (format !== 'slides') {
      if (!fs.existsSync(path.join(dest, 'scripts', 'use-format.mjs'))) {
        throw new Error(`this sl-ide template has no ${format} format yet`);
      }
      await run('node', ['scripts/use-format.mjs', format], { cwd: dest });
      await run('git', ['add', '-A'], { cwd: dest });
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `Start from the ${format} starter`], { cwd: dest });
      p.log.success(`Set up as a ${format}`);
    }

    if (pub) {
      const config = { slug, team: pub.team, visibility: share };
      fs.writeFileSync(path.join(dest, 'sl-ide.config.json'), `${JSON.stringify(config, null, 2)}\n`);
      await run('git', ['add', 'sl-ide.config.json'], { cwd: dest });
      await run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `Publish to sl-ide cloud as ${slug} (${share}, team ${pub.team})`], { cwd: dest });
    }

    if (github !== 'none') {
      s.start(`Creating github.com/${owner}/${name}`);
      await run('gh', ['repo', 'create', name, `--${github}`, '--source', '.', '--remote', 'origin'], { cwd: dest });
      // Before the first push, so its CI run publishes.
      if (pub) await run('gh', ['secret', 'set', 'SL_IDE_PUBLISH_TOKEN', '--repo', `${owner}/${name}`], { cwd: dest, input: pub.token });
      await run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dest });
      s.stop(`Created github.com/${owner}/${name} (${github})`);
    }

    if (o.install) {
      s.start('Installing dependencies');
      await run('pnpm', ['install', '--silent'], { cwd: dest });
      s.stop('Installed dependencies');
    }
  } catch (e) {
    s.stop('Stopped');
    bail(e.message);
  }

  const rel = path.relative(process.cwd(), dest) || '.';
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
    p.log.success(`Every push to main publishes ${CLOUD}/d/${slug}/ (${share === 'public' ? 'anyone with the link' : `team ${pub.team}`}).`);
  } else {
    p.log.info('Not publishing. To publish later, add sl-ide.config.json (see the deck\'s README).');
  }
  p.outro(format === 'memo' ? 'Memo ready.' : 'Deck ready.');
}

const cmd = positionals[0];
if (cmd === 'login') await login();
else if (cmd === 'logout') logout();
else await create();
