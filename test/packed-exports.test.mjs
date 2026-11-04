/**
 * Packed-exports smoke.
 *
 * `tsup` succeeding proves the build worked against the working tree. It does
 * not prove that what `npm install` receives can be imported: a `files` entry
 * that forgets a chunk, or an `exports` target that points at a file tsup never
 * emitted, only shows up in the packed tarball. This test packs the package the
 * way a publish would, unpacks it into a temp dir, then walks every subpath in
 * `exports` and asserts its `default` file imports and its `types` file exists —
 * using the packed `package.json`, not the working one.
 *
 * It stays offline: only `npm pack` + local `tar`, never `npm publish`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run npm pack into `dest`, return the tarball filename. */
function packInto(dest) {
  const result = spawnSync('npm', ['pack', '--pack-destination', dest], {
    cwd: ROOT,
    encoding: 'utf8',
    // prepack runs `npm run build`; give it room on cold CI.
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `npm pack failed:\n${result.stdout}\n${result.stderr}`);
  const tgz = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .pop();
  assert.ok(tgz, `npm pack printed no .tgz:\n${result.stdout}`);
  return path.join(dest, tgz);
}

/** A declared subpath can be a glob (`./locale/*.json`); exact set membership
 * would misreport a correctly packed package. Mirrors the toolkit's shipsPath. */
function shipsPath(shipped, target) {
  if (target.includes('*') === false) return shipped.has(target);
  const [head, tail] = target.split('*');
  const suffix = tail ?? '';
  for (const file of shipped) {
    if (file.startsWith(head) && file.endsWith(suffix)) return true;
  }
  return false;
}

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    for (const key of ['default', 'import', 'require']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return undefined;
}

test('packed tarball: every exports subpath imports and ships its .d.ts', async () => {
  const tmp = tmpDir('kit-pack-');
  try {
    const tgz = packInto(tmp);
    const unpack = path.join(tmp, 'unpack');
    fs.mkdirSync(unpack, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', tgz, '-C', unpack], { encoding: 'utf8' });
    assert.equal(untar.status, 0, `tar failed:\n${untar.stderr}`);

    // `npm pack` nests everything under a single `package/` folder.
    const pkgDir = path.join(unpack, 'package');
    assert.ok(fs.existsSync(pkgDir), 'tarball has no package/ root');

    // The packed entries import their declared runtime deps (`semver`). Those
    // are installed by `npm install`, not shipped in the tarball — so make them
    // resolvable from the unpacked copy by linking the repo's own node_modules.
    // This stays offline and reproduces what a real install provides.
    const repoModules = path.join(ROOT, 'node_modules');
    if (fs.existsSync(repoModules)) {
      fs.symlinkSync(repoModules, path.join(pkgDir, 'node_modules'), 'dir');
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const shipped = new Set(
      // Every file actually in the tarball, relative to package/.
      (function walk(dir, base = '') {
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
          else out.push(rel);
        }
        return out;
      })(pkgDir),
    );

    const subpaths = Object.entries(pkg.exports).filter(([key]) => key !== './package.json');
    assert.ok(subpaths.length > 0, 'package.json exports has no importable subpaths');

    const problems = [];
    for (const [subpath, value] of subpaths) {
      const target = exportTarget(value);
      if (target === undefined) {
        problems.push(`${subpath}: exports entry has no default/import target`);
        continue;
      }
      const rel = target.replace(/^\.\//, '');

      if (shipsPath(shipped, rel) === false) {
        problems.push(`${subpath}: tarball is missing ${rel} (its default target)`);
        continue;
      }

      // The JS target must actually import from the packed copy.
      try {
        await import(pathToFileURL(path.join(pkgDir, rel)).href);
      } catch (error) {
        problems.push(`${subpath}: ${rel} does not import: ${error.message}`);
      }

      // Every entry must ship a types file next to its default.
      const types = value !== null && typeof value === 'object' ? value.types : undefined;
      if (typeof types === 'string') {
        const typesRel = types.replace(/^\.\//, '');
        if (shipsPath(shipped, typesRel) === false) {
          problems.push(`${subpath}: tarball is missing ${typesRel} (its types target)`);
        }
      } else {
        problems.push(`${subpath}: exports entry declares no types target`);
      }
    }

    assert.deepEqual(problems, [], `packed exports problems:\n- ${problems.join('\n- ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
