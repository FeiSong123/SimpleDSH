const stage = process.argv[2];

if (process.argv.length !== 3 || stage === undefined || stage.length === 0) {
  process.stderr.write("usage: blocked-stage.mjs <Stage NN>\n");
  process.exitCode = 2;
} else {
  process.stderr.write(`BLOCKED: ${stage}\n`);
  process.exitCode = 2;
}
