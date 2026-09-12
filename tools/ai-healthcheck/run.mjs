import { ProbeFailure, runHealthcheck } from './probe.mjs';
try {
  console.log(JSON.stringify(await runHealthcheck(process.env)));
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.message,
    ...(error instanceof ProbeFailure ? error.details : {}) }));
  process.exitCode = 1;
}
