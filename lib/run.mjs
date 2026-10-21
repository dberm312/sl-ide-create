import { spawn, spawnSync } from 'node:child_process';

const running = new Set();

// Stop commands still running, so an interrupted setup leaves no clone or push behind.
export function stopRunning() {
  for (const p of running) p.kill('SIGTERM');
}

// Run a command; resolve its stdout, reject with its stderr.
export function run(cmd, args, { cwd, input, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    running.add(p);
    p.on('close', () => running.delete(p));
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
    p.stderr.on('data', (d) => { err += d; });
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')}: ${err.trim() || `exit ${code}`}`))));
  });
}

export function has(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

export function ghReady() {
  return has('gh') && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
}
