/**
 * Build the Vercel Sandbox base image used by the production judge.
 *
 * Run once after `vercel link` / `vercel env pull` (or with VERCEL_TOKEN,
 * VERCEL_TEAM_ID, and VERCEL_PROJECT_ID set):
 *
 *   pnpm --filter @zapdos/judge snapshot
 *
 * Copy the printed JUDGE_SANDBOX_SNAPSHOT_ID into the Vercel project env.
 * The snapshot is created with no expiration; delete it manually if you ever
 * rebuild the image.
 */

import { Sandbox } from '@vercel/sandbox';

const INSTALL_TIMEOUT_MS = 12 * 60_000;

async function run(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
  opts: { sudo?: boolean; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const result = await sandbox.runCommand({
    cmd,
    args,
    sudo: opts.sudo,
    timeoutMs: opts.timeoutMs ?? 120_000,
    env: opts.env,
  });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (exit ${result.exitCode})\n${stderr || stdout}`,
    );
  }
  if (stdout.trim()) console.log(stdout.trim());
  return stdout;
}

async function main(): Promise<void> {
  console.log('[snapshot] creating Ubuntu sandbox...');
  const sandbox = await Sandbox.create({
    image: 'vercel/sandbox/ubuntu',
    timeout: 20 * 60_000,
    resources: { vcpus: 2 },
    // apt-get needs network access; the judge sandboxes themselves use
    // deny-all, so nothing from this build is exposed at runtime.
    networkPolicy: 'allow-all',
  });

  try {
    await run(sandbox, 'apt-get', ['update'], {
      sudo: true,
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: { DEBIAN_FRONTEND: 'noninteractive' },
    });

    await run(
      sandbox,
      'apt-get',
      [
        'install',
        '-y',
        '--no-install-recommends',
        'g++',
        'python3',
        'openjdk-21-jdk-headless',
        'coreutils',
        'bash',
        'ca-certificates',
      ],
      {
        sudo: true,
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: { DEBIAN_FRONTEND: 'noninteractive' },
      },
    );

    console.log('[snapshot] toolchain versions:');
    await run(sandbox, 'g++', ['--version']);
    await run(sandbox, 'python3', ['--version']);
    await run(sandbox, 'javac', ['-version']);

    console.log('[snapshot] saving snapshot...');
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    console.log('');
    console.log(`JUDGE_SANDBOX_SNAPSHOT_ID=${snapshot.snapshotId}`);
    console.log('');
  } finally {
    // snapshot() already stops the sandbox; stop() is a safe no-op/cleanup.
    await sandbox.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[snapshot] failed:', error);
  process.exitCode = 1;
});
