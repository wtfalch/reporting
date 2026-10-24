// Tells release.yml which package to publish, as `dir`, `name` and `version`
// step outputs.
//
// `main` carries both estate shapes until bootstrap deletes one, so nothing
// here may name a package. The answer comes from the workspace globs and
// whatever manifests exist on disk, which is also why it can run before
// `pnpm install` and fail in seconds rather than after a full dependency fetch.
//
// The rule itself lives in scripts/lib/workspace.mjs, so CI, the repo's gate
// and the bootstrap CLI cannot drift apart about which artifact goes on npm.
import { appendFileSync } from 'node:fs';
import { findPublishablePackage } from '../../scripts/lib/workspace.mjs';

let found;
try {
  found = findPublishablePackage(process.cwd());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { relDir, manifest } = found;
console.log(`publishable package: ${manifest.name} at ${relDir}`);

const output = process.env.GITHUB_OUTPUT;
if (output) {
  appendFileSync(output, `dir=${relDir}\n`);
  appendFileSync(output, `name=${manifest.name}\n`);
  appendFileSync(output, `version=${manifest.version}\n`);
}
