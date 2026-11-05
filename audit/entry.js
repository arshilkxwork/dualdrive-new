import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at `moduleUrl` is the script node was asked to run.
// Node resolves symlinks in a module's own URL but leaves process.argv[1] as
// typed, so a path through a symlink (macOS /tmp is one) would never match
// unless both sides are resolved first.
export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
