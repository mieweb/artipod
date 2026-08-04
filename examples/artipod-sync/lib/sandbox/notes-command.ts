/**
 * `notes` — artipod-sync shell notes. The just-bash builtin `help` (command
 * list) cannot be shadowed by a custom command, so session semantics live
 * here and the terminal banner points at it.
 */
import { defineCommand } from 'just-bash/browser';

export const SHELL_NOTES = `artipod-sync shell notes
=========================
This is just-bash (a bash interpreter in TypeScript) over a persistent
in-browser filesystem (ZenFS). Files survive reloads.

Session semantics — each line runs in a fresh shell; the host carries state:
  * cwd, variables, exports and aliases persist across lines
  * shell FUNCTIONS do NOT persist across lines (define and use them on
    one line, or in a script file you run with 'bash file.sh')
  * shopt/set -o changes do not persist across lines

Interactive limits (no TTY): read -p/-s prompts, pagers (less) and editors
(vim) do not work — use 'edit <file>' to open Monaco. gzip/zcat need
node:zlib and are unavailable in the browser; plain 'tar' works.

Extras:
  edit <file>      open the Monaco editor
  git <sub>        clone/status/diff/files (isomorphic-git; https:// only)
  df [-hTv] [--scan]
                   storage usage. Size/Avail exist only on the 'origin' row:
                   the browser gives ONE quota to the whole origin, shared by
                   IndexedDB and OPFS, so per-device capacity is '-'. Used is
                   a browser estimate (Chromium only); --scan walks the tree
                   for exact bytes.
  mount, findmnt, lsblk [-f], fdisk -l, diskutil list
                   the same storage facts in other shapes. The origin quota
                   is the 'disk'; IndexedDB and OPFS are its partitions.
                   Each takes --help.
  help             list all available commands
  history          shell history (mirrors the terminal's arrow-key history)
  Tab              complete commands, aliases and paths
  Ctrl+C           cancel the running command
`;

export const makeNotesCommand = () =>
  defineCommand('notes', async () => ({ stdout: SHELL_NOTES, stderr: '', exitCode: 0 }));
