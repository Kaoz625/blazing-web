// Run every *.smoke.mjs in the repo root and fail if any one of them fails.
//
// WHY THIS IS A RUNNER AND NOT AN 18-COMMAND SHELL CHAIN. `a && b && c` stops
// at the first failure, so one broken suite hides the state of every suite
// after it — you fix it, push, and learn about the next one on the next run.
// `a; b; c` keeps going but throws every exit code away and the lane is green
// no matter what. This runs all of them, reports each one, and exits 1 if any
// failed.
//
// It also DISCOVERS the suites with readdir rather than holding a list, for
// the same reason every workflow in .github/ uses `git ls-files`: a 19th
// harness added tomorrow is run without anyone remembering to edit this file.
// And the silent no-op is guarded — finding fewer than the 18 suites that
// exist today is a failure, not an empty pass.
//
//   npm test                      every suite
//   node scripts/run-smokes.mjs home locker      just the ones whose name matches

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A floor, not a count. If the glob ever matches nothing — a rename, a move,
// a runner checking out the wrong directory — this must go RED rather than
// print "0 passed" and exit 0.
//
// IT IS SET TO THE REAL COUNT, 18, and not to a round number below it. A floor
// of 10 against 18 suites would let EIGHT of them disappear — renamed, moved,
// or deleted to quiet a red lane — and still report a green "10/10 passed".
// That is the same silent no-op this guard exists to stop, just further down
// the slope. At 18, only a suite that actually went missing goes red.
//
// Adding a 19th suite needs no edit here: the check is `<`, so the floor keeps
// working as the count grows. REMOVING one is meant to be a deliberate act —
// delete the suite and lower this number in the same commit, so the diff says
// out loud that the repo now proves less than it did.
//
// 6 Sep 2026: the floor had drifted from its own rule. It still said 18 while
// 25 suites existed, so SEVEN could have gone missing and this still reported a
// green "18/18 passed" — the exact silent no-op the paragraph above exists to
// stop, just further down the slope it warns about. Raised to the real count.
//
// Raised again the same evening, from 25 to 28, when youtube.smoke.mjs,
// youtube-play.smoke.mjs and livetv.smoke.mjs landed. THE RULE IS: this number
// is the real count, always. A floor left behind is not a conservative floor,
// it is three suites that may quietly stop existing.
//
// Raised 29 -> 30 on 7 Sep 2026 when site-source.smoke.mjs landed. Same rule:
// this number is the real count, always.
//
// Raised 30 -> 31 the same day when detail-autoplay.smoke.mjs landed.
//
// Raised 31 -> 32 when book-reader.smoke.mjs landed with the book reader and
// the continuous top-to-bottom reading mode. Same rule: this number is the real
// count, always.
//
// Raised 32 -> 33 when director-filmography.smoke.mjs landed with the web half
// of director filmography. Same rule: this number is the real count, always.
const MIN_SUITES = 33;

// The unit tests were not run AT ALL. This runner is what `npm test` calls and
// what the pages workflow gates on, and it only ever globbed *.smoke.mjs — so
// media-library.test.mjs, stream-evidence.test.mjs and stream-preferences.test.mjs
// (41 assertions between them) were invisible to every push. They passed when a
// human ran them by hand, which is precisely why nobody noticed they were not
// part of the gate.
//
// They are spawned the same way as a smoke, with no --test flag and no special
// case: a file importing node:test executes on a plain `node file.mjs` and
// exits 1 when an assertion fails. Both halves of that were measured before
// wiring it up, because a unit file that ran nothing and exited 0 would add
// fake green to the gate and be worse than leaving it out.
const MIN_UNITS = 3;

const filters = process.argv.slice(2);
const entries = (await readdir(ROOT)).sort();
const smokes = entries.filter((f) => f.endsWith('.smoke.mjs'));
const units = entries.filter((f) => f.endsWith('.test.mjs'));

if (smokes.length < MIN_SUITES) {
  console.error(`FAIL  found only ${smokes.length} *.smoke.mjs in ${ROOT}; expected at least ${MIN_SUITES}.`);
  console.error('      A check that matches nothing must go red, not pass for free.');
  process.exit(1);
}

if (units.length < MIN_UNITS) {
  console.error(`FAIL  found only ${units.length} *.test.mjs in ${ROOT}; expected at least ${MIN_UNITS}.`);
  console.error('      A check that matches nothing must go red, not pass for free.');
  process.exit(1);
}

const all = [...smokes, ...units];

const suites = filters.length
  ? all.filter((f) => filters.some((s) => f.includes(s)))
  : all;

if (!suites.length) {
  console.error(`FAIL  no *.smoke.mjs or *.test.mjs matched ${filters.join(' ')}`);
  process.exit(1);
}

// Each suite prints a lot, and 18 of them interleaved would be unreadable, so
// output is captured and replayed under its own heading. A PASSING suite's
// output is still printed: these harnesses report counts (rows, cards, chips)
// that are worth reading even when they are green.
function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, file)], {
      cwd: ROOT,
      // Inherit the environment so BW_DIR, DEBUG and the like still work, and
      // so a local run behaves the same as a CI one.
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    child.on('error', (err) => {
      resolve({ file, code: 1, ms: Date.now() - started, out: `${out}\ncould not start node: ${err.message}` });
    });

    // A suite killed by a signal reports code null. That is a failure, and it
    // must not be read as 0.
    child.on('close', (code, signal) => {
      resolve({
        file,
        code: code === null ? 1 : code,
        signal,
        ms: Date.now() - started,
        out,
      });
    });
  });
}

const smokeCount = suites.filter((f) => f.endsWith('.smoke.mjs')).length;
const unitCount = suites.length - smokeCount;
console.log(`${smokeCount} smoke suite${smokeCount === 1 ? '' : 's'} + ${unitCount} unit file${unitCount === 1 ? '' : 's'}, node ${process.version}\n`);

const results = [];
for (const file of suites) {
  const r = await run(file);
  results.push(r);
  const secs = (r.ms / 1000).toFixed(1);
  const verdict = r.code === 0 ? 'PASS' : 'FAIL';
  console.log(`----- ${verdict}  ${file}  (${secs}s${r.signal ? `, killed by ${r.signal}` : ''})`);
  process.stdout.write(r.out.endsWith('\n') || r.out === '' ? r.out : `${r.out}\n`);
  console.log('');
}

const failed = results.filter((r) => r.code !== 0);
const total = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);

console.log('='.repeat(64));
for (const r of results) {
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.file}`);
}
console.log('='.repeat(64));
console.log(`${results.length - failed.length}/${results.length} passed in ${total}s`);

if (failed.length) {
  console.log(`\nFAILED: ${failed.map((r) => r.file).join(', ')}`);
  process.exit(1);
}
