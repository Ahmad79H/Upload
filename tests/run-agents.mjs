#!/usr/bin/env node
/**
 * TEN AGENTS, ONE PUPPET — the parallel test fleet.
 *
 * Node's test runner already parallelises files, but "10 agents simultaneously"
 * is a nicer promise when it is explicit: this script spawns TEN independent
 * worker processes, hands each one a share of the suites, and reports a single
 * verdict. Each agent is a real OS process with its own module registry, its own
 * jsdom, and its own network stub — so a crash in one cannot mask another.
 *
 *   node tests/run-agents.mjs              # unit + system, sharded across 10
 *   node tests/run-agents.mjs --watchlist  # dry run: show the plan only
 *   node tests/run-agents.mjs --agents 4   # fewer workers
 *
 * Exit code is non-zero if ANY agent reports a failure, so it drops straight
 * into CI or a pre-commit hook.
 */
import { spawn } from 'node:child_process';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const AGENT_COUNT = Number(/--agents[=\s](\d+)/.exec(args.join(' '))?.[1] || 10);
const watchlistOnly = args.includes('--watchlist');
const verbose = args.includes('--verbose');

const AGENT_NAMES = [
  'unit-core', 'unit-ai', 'unit-tools', 'unit-mind', 'unit-body',
  'system-boot', 'system-journeys', 'system-chaos', 'integration', 'sentinel',
];

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(resolve(ROOT, dir)).catch(() => [])) {
    if (entry.endsWith('.test.js')) out.push(`${dir}/${entry}`);
  }
  return out.sort();
}

function shard(files, buckets) {
  const shards = Array.from({ length: buckets }, () => []);
  files.forEach((file, i) => shards[i % buckets].push(file));
  return shards;
}

async function runAgent({ index, name, files }) {
  const started = performance.now();
  if (!files.length) {
    return { index, name, files: [], code: 0, passed: 0, failed: 0, ms: 0, output: 'nothing to do' };
  }
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-reporter=tap', ...files],
      {
        cwd: ROOT,
        env: { ...process.env, PIP_AGENT_INDEX: String(index), PIP_AGENT_NAME: name, NODE_OPTIONS: '--no-warnings' },
      },
    );
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
      if (verbose) process.stdout.write(`[${name}] ${d}`);
    });
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      const passed = (output.match(/^ok \d+/gm) || []).length;
      const failed = (output.match(/^not ok \d+/gm) || []).length;
      resolvePromise({ index, name, files, code, passed, failed, ms: Math.round(performance.now() - started), output });
    });
  });
}

function colour(text, code) {
  return process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}

async function main() {
  const unit = await collect('tests/unit');
  const system = await collect('tests/system');
  const all = [...unit, ...system];
  if (!all.length) {
    console.error('no test files found — did you run this from the project root?');
    process.exit(1);
  }
  // Heaviest suites (the full-app system tests) go first and then round-robin,
  // so no single agent ends up with all the slow work.
  const weight = (f) => (f.startsWith('tests/system') ? 3 : 1);
  const ordered = [...all].sort((a, b) => weight(b) - weight(a));
  const shards = shard(ordered, AGENT_COUNT);
  const plan = shards.map((files, i) => ({ index: i + 1, name: AGENT_NAMES[i % AGENT_NAMES.length], files }));

  console.log(`\n${colour('🥦 Plus Ultra Puppet — 10-agent test fleet', '1')}`);
  console.log(`${all.length} suites → ${AGENT_COUNT} parallel agents (${unit.length} unit, ${system.length} system)\n`);
  for (const agent of plan) {
    console.log(`  agent ${String(agent.index).padStart(2)} · ${agent.name.padEnd(16)} ${agent.files.map((f) => basename(f)).join(', ') || '—'}`);
  }
  if (watchlistOnly) return;

  console.log('\nrunning…\n');
  const results = await Promise.all(plan.map((agent) => runAgent(agent)));
  results.sort((a, b) => a.index - b.index);

  let totalPassed = 0;
  let totalFailed = 0;
  console.log('  agent  name              suites  tests  ok   fail   time');
  console.log('  ' + '─'.repeat(64));
  for (const r of results) {
    totalPassed += r.passed;
    totalFailed += r.failed;
    const flag = r.failed || r.code ? colour('✗', '31') : colour('✓', '32');
    console.log(
      `  ${flag} ${String(r.index).padStart(4)}  ${r.name.padEnd(16)} ${String(r.files.length).padStart(5)}  ${String(r.passed + r.failed).padStart(5)}  ${String(r.passed).padStart(4)}  ${String(r.failed).padStart(4)}   ${(r.ms / 1000).toFixed(1)}s`,
    );
  }

  const wallClock = Math.max(...results.map((r) => r.ms));
  console.log('  ' + '─'.repeat(64));
  console.log(
    `  ${totalFailed ? colour('FAILED', '31') : colour('PASSED', '32')}  ${totalPassed} passing, ${totalFailed} failing across ${AGENT_COUNT} agents in ${(wallClock / 1000).toFixed(1)}s wall clock\n`,
  );

  if (totalFailed) {
    console.log(colour('  failing suites:', '31'));
    for (const r of results.filter((x) => x.failed || x.code)) {
      console.log(`   • agent ${r.index} (${r.name}): ${r.files.join(', ')}`);
      const failures = r.output.split('\n').filter((l) => /^not ok /.test(l)).slice(0, 8);
      for (const line of failures) console.log(`       ${line}`);
      if (!failures.length) console.log(r.output.split('\n').slice(-8).join('\n'));
    }
  }

  // keep an artifact so the run is auditable
  try {
    await mkdir(resolve(ROOT, 'artifacts'), { recursive: true });
    await writeFile(
      resolve(ROOT, 'artifacts/agents-report.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          agents: AGENT_COUNT,
          suites: all.length,
          passed: totalPassed,
          failed: totalFailed,
          wallClockMs: wallClock,
          results: results.map(({ output, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
    console.log('  📄 artifacts/agents-report.json\n');
  } catch {
    /* artifacts are a nicety */
  }

  process.exit(totalFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('agent fleet crashed:', err);
  process.exit(1);
});
