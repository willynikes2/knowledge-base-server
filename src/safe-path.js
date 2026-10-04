// src/safe-path.js — resolve a path under a root, refusing escapes via ".." or symlinks.
import { existsSync, realpathSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

function isUnder(root, target) {
  return target === root || target.startsWith(root + sep);
}

// Follow symlinks in the existing part of an absolute path; keep the
// not-yet-created remainder as-is.
function realResolve(absPath) {
  let existing = absPath;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absPath;
    existing = parent;
  }
  return join(realpathSync(existing), relative(existing, absPath));
}

/**
 * Resolve `inputPath` under `root` and throw `message` if it lands outside,
 * either lexically or after following symlinks.
 */
export function resolveUnder(root, inputPath, message) {
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, inputPath);
  if (!isUnder(rootResolved, target) || !isUnder(realResolve(rootResolved), realResolve(target))) {
    throw new Error(message);
  }
  return target;
}
