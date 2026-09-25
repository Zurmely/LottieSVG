#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
  stderr: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
  readStdin: () => readFileSync(0, 'utf8'),
  writeStdout: (s) => process.stdout.write(s),
});
