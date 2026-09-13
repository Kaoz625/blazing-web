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
//
// Raised 33 -> 34 when settings.smoke.mjs landed with the Settings screen and
// the parental controls (audit B32/B35/B1/B3/B13/B15/B28). Same rule: this
// number is the real count, always.
//
// Raised 34 -> 35 when detail-rich-sections.smoke.mjs landed with Cast,
// Production companies, Reviews and More like this on the detail sheet (audit
// B26). Same rule: this number is the real count, always.
//
// Raised 35 -> 37 when source-failover.smoke.mjs landed with automatic source
// failover on the web (audit B10) - the browser walking the ranked list the way
// the Roku and the Fire TV already do.
//
// 37, not 36. The floor was already one behind the real count when that suite
// was written: 36 files on disk against a floor of 35, so one of them could
// have gone missing for free. Same rule as every note above - this number is
// the real count, always, and catching it up is part of adding to it.
// Raised 37 -> 38 when roadmaps-calendar.smoke.mjs landed with B25/B12: the
// real Roadmaps screen (the chip used to open a static product blurb) and a
// Calendar the browser did not have at all. Same rule as every raise above:
// this number goes up when a suite lands, so a deleted suite is a failure
// rather than a quieter run.
//
// Raised 38 -> 39 when sources.smoke.mjs landed with B2: the read-only Stream
// Sources screen, which the Roku, the Fire TV and the Apple TV all have and the
// browser had not. Same rule as every raise above: this number is the real
// count, always. Counted on disk before writing it — `ls *.smoke.mjs | wc -l`
// answered 39 — rather than by adding one to what was here, which is how a
// floor drifts behind its own rule (see the 6 Sep note above, where it had
// fallen seven suites behind).
const MIN_SUITES = 39;

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
//
// Raised 3 -> 5 when settings.test.mjs and profile-parental.test.mjs landed:
// the source-filter ladders and the parental rule module (the Kids interlock,
// the raise test, the last-profile Delete guard, the grown-up gate). Those are
// the decisions a source list and a parental control are made of, and firetv
// keeps its copies in ProfileGateRules/SourceFilters for exactly this reason.
//
// Raised 5 -> 6 when livetv-guide.test.mjs landed with B33/B24/B23: the Live TV
// rating cap, the now/next line and bar, and the EPG grid's slot maths. Same
// reason again — firetv keeps ProfileGateRules and GuideTimeline outside its
// Views precisely so those three are reachable by a test.
// Raised 6 -> 8 when roadmaps.test.mjs and calendar.test.mjs landed with
// B25/B12. Same reason as the raises above: the fleet sends chapters and days
// and nothing else, so the years range, the running position, the stats line,
// the three orders, the day ordering and the twelve-hour clock are all
// decisions the client holds — and the Roku got several of them wrong once
// each before it got them right.
const MIN_UNITS = 8;

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
// A SUITE THAT HANGS MUST NOT HANG THE GATE. Measured 12 Sep 2026:
// youtube.smoke.mjs sat for 47 minutes with a live headless Comet attached and
// this runner waited on it for ever, because `close` is the only thing it
// listened for. pages.yml gives the whole gate `timeout-minutes: 30`, so in CI
// that run is killed from outside: the job goes red with no per-suite verdict,
// no tally, and no name for the suite that stopped — and because `deploy`
// needs `gate`, the live site silently stops following main.
//
// CORRECTION, 13 Sep 2026. The sentence that stood here claimed blazing-web had
// seven commits that could not reach Pages "for exactly this reason". That was
// a guess presented as a cause, and it is wrong. `gh run list --workflow pages`
// shows the 11 Sep run at 719183c SUCCEEDED and deployed. Those commits never
// reached Pages because they were never PUSHED — they sat in the local repo.
// No CI run was ever killed by a hang. The 47-minute hang above is measured and
// real; what it caused was not. The timeout below is still worth having, on its
// own merit, for the day a suite does hang in CI.
//
// 240s is far above any real suite here (the slowest measured are tens of
// seconds) and 38 x 240s is still inside the 30-minute job only if everything
// hangs, which is the case this exists to REPORT rather than to survive.
// SMOKE_TIMEOUT_MS overrides it for a deliberately slow run.
const SUITE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 240_000;

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, file)], {
      cwd: ROOT,
      // Inherit the environment so BW_DIR, DEBUG and the like still work, and
      // so a local run behaves the same as a CI one.
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ITS OWN PROCESS GROUP, so the timeout below can kill the BROWSER too.
      // Every harness here launches a headless Comet; killing only the node
      // process orphans it. Measured the same day: the 47-minute hang left its
      // Comet (and its gpu and network helpers) running after the runner was
      // killed, and a second stray from an earlier run was still up beside it.
      // Those hold a scratch profile directory and a CDP port each.
      detached: true,
    });

    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    // Negative pid = the whole group. SIGKILL rather than SIGTERM: a hung
    // playwright action does not unwind, and a browser asked politely to stop
    // can take its time. There is nothing to clean up that outliving the run
    // would help.
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      out += `\n\nTIMEOUT  killed after ${(SUITE_TIMEOUT_MS / 1000).toFixed(0)}s — this suite hangs.\n`;
      killTree();
    }, SUITE_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ file, code: 1, ms: Date.now() - started, out: `${out}\ncould not start node: ${err.message}` });
    });

    // A suite killed by a signal reports code null. That is a failure, and it
    // must not be read as 0.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        file,
        code: code === null ? 1 : code,
        signal,
        timedOut,
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
  const verdict = r.code === 0 ? 'PASS' : (r.timedOut ? 'TIMEOUT' : 'FAIL');
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
