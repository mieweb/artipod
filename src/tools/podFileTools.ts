/**
 * Pod-level file tools: the same VS Code-schema tools, resolved against a
 * declarative mount table instead of a single mount.
 *
 * Core enforces NO prefix scheme (plan Decision #3): the application declares
 * each mount's path (e.g. '/context/src', '/patients/12345') and tools resolve
 * incoming absolute paths by longest-prefix match. `/context/<name>` is merely
 * the docker realizer's historical default, not a rule.
 */

import { ArtiMount } from '../artimount.js';
import {
  ToolHandler,
  ToolName,
  ToolResult,
  ReadFileParams,
  ReadFileResult,
  ICreateFileParams,
  IListDirParams,
  ListDirResult,
  ICreateDirectoryParams,
  IReplaceStringParams,
  IMultiReplaceStringParams,
  IApplyPatchParams,
  EditResult,
  MultiEditResult,
} from './types.js';
import {
  readFileDefinition,
  createFileDefinition,
  listDirDefinition,
  createDirectoryDefinition,
  replaceStringDefinition,
  multiReplaceStringDefinition,
  applyPatchDefinition,
} from './definitions.js';
import { createCoreTools } from './coreTools.js';
import { createEditTools } from './editTools.js';
import { createApplyPatchTool } from './applyPatchTool.js';
import {
  ADD_FILE_PREFIX,
  DELETE_FILE_PREFIX,
  UPDATE_FILE_PREFIX,
  MOVE_FILE_TO_PREFIX,
} from './applyPatchParser.js';

/** One row of the pod's mount table: an app-declared absolute path → a mount. */
export interface MountTableEntry {
  path: string;
  mount: ArtiMount;
}

/** Dependency-free posix normalization ('.', '..', duplicate slashes). */
function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

export class PodPathResolver {
  private entries: MountTableEntry[];

  constructor(entries: MountTableEntry[]) {
    if (!entries?.length) {
      throw new Error('Mount table cannot be empty');
    }
    const seen = new Set<string>();
    this.entries = entries
      .map((e) => {
        let p = e.path.trim();
        if (!p.startsWith('/')) {
          throw new Error(`Mount path must be absolute (start with '/'): '${e.path}'`);
        }
        p = p === '/' ? '/' : normalizePosix(p);
        if (seen.has(p)) {
          throw new Error(`Duplicate mount path: '${p}'`);
        }
        seen.add(p);
        return { path: p, mount: e.mount };
      })
      .sort((a, b) => b.path.length - a.path.length);
  }

  get table(): ReadonlyArray<MountTableEntry> {
    return this.entries;
  }

  describe(): string {
    return this.entries.map((e) => `${e.path} → mount '${e.mount.getName()}'`).join(', ');
  }

  /** Longest-prefix match of an absolute pod path to a mount + mount-relative remainder. */
  resolve(filePath: string): { entry: MountTableEntry; relativePath: string } {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      throw new Error(
        `Path '${String(filePath)}' must be absolute and start with a mount path. Mounts: ${this.describe()}`
      );
    }
    const p = normalizePosix(filePath);
    for (const entry of this.entries) {
      if (p === entry.path) return { entry, relativePath: '' };
      const prefix = entry.path === '/' ? '/' : entry.path + '/';
      if (p.startsWith(prefix)) return { entry, relativePath: p.slice(prefix.length) };
    }
    throw new Error(`Path '${filePath}' is not under any mount. Mounts: ${this.describe()}`);
  }

  /** Immediate children when `dirPath` sits above the mount points (virtual directories). */
  virtualChildren(dirPath: string): string[] | undefined {
    const p = dirPath === '/' ? '/' : normalizePosix(dirPath);
    const children = new Set<string>();
    for (const entry of this.entries) {
      const prefix = p === '/' ? '/' : p + '/';
      if (entry.path !== p && entry.path.startsWith(prefix)) {
        children.add(entry.path.slice(prefix.length).split('/')[0]);
      }
    }
    return children.size ? [...children].sort() : undefined;
  }
}

type MountHandlers = Map<string, ToolHandler>;

function buildMountHandlers(mount: ArtiMount): MountHandlers {
  const handlers: MountHandlers = new Map();
  for (const t of [...createCoreTools(mount), ...createEditTools(mount), createApplyPatchTool(mount)]) {
    handlers.set(t.name, t);
  }
  return handlers;
}

/**
 * Create pod-level file tool handlers over a mount table.
 * Each handler resolves the path parameter(s) via longest-prefix match and
 * delegates to the owning mount's tool, echoing the caller's original paths
 * back into the result.
 */
export function createPodFileTools(resolver: PodPathResolver): ToolHandler[] {
  const perMount = new Map<ArtiMount, MountHandlers>();
  const handlerFor = (mount: ArtiMount, name: string): ToolHandler => {
    let handlers = perMount.get(mount);
    if (!handlers) {
      handlers = buildMountHandlers(mount);
      perMount.set(mount, handlers);
    }
    const h = handlers.get(name);
    /* istanbul ignore next -- registry always contains the mount-level tools */
    if (!h) throw new Error(`No mount-level handler for ${name}`);
    return h;
  };

  const readFile: ToolHandler<ReadFileParams, ReadFileResult> = {
    name: ToolName.ReadFile,
    definition: readFileDefinition,
    async execute(params) {
      try {
        const { entry, relativePath } = resolver.resolve(params.filePath);
        const result = (await handlerFor(entry.mount, ToolName.ReadFile).execute({
          ...params,
          filePath: relativePath,
        })) as ReadFileResult;
        return { ...result, filePath: params.filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          filePath: params.filePath,
          startLine: 0,
          endLine: 0,
          totalLines: 0,
          truncated: false,
        };
      }
    },
  };

  const createFile: ToolHandler<ICreateFileParams, ToolResult & { filePath?: string }> = {
    name: ToolName.CreateFile,
    definition: createFileDefinition,
    async execute(params) {
      try {
        const { entry, relativePath } = resolver.resolve(params.filePath);
        const result = await handlerFor(entry.mount, ToolName.CreateFile).execute({
          ...params,
          filePath: relativePath,
        });
        return { ...result, filePath: params.filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          filePath: params.filePath,
        };
      }
    },
  };

  const listDir: ToolHandler<IListDirParams, ListDirResult> = {
    name: ToolName.ListDirectory,
    definition: listDirDefinition,
    async execute(params) {
      // Paths above the mount points list as virtual directories
      const virtual = typeof params.path === 'string' && params.path.startsWith('/')
        ? resolver.virtualChildren(params.path)
        : undefined;
      try {
        const { entry, relativePath } = resolver.resolve(params.path);
        const result = (await handlerFor(entry.mount, ToolName.ListDirectory).execute({
          ...params,
          path: relativePath,
        })) as ListDirResult;
        if (virtual) {
          const names = new Set(result.entries.map((e) => e.name));
          for (const v of virtual) {
            if (!names.has(v)) result.entries.push({ name: v, isDirectory: true });
          }
          result.entries.sort((a, b) =>
            a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)
          );
        }
        return result;
      } catch (error) {
        if (virtual) {
          return { success: true, entries: virtual.map((name) => ({ name, isDirectory: true })) };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          entries: [],
        };
      }
    },
  };

  const createDirectory: ToolHandler<ICreateDirectoryParams, ToolResult & { dirPath?: string }> = {
    name: ToolName.CreateDirectory,
    definition: createDirectoryDefinition,
    async execute(params) {
      try {
        const { entry, relativePath } = resolver.resolve(params.dirPath);
        const result = await handlerFor(entry.mount, ToolName.CreateDirectory).execute({
          ...params,
          dirPath: relativePath,
        });
        return { ...result, dirPath: params.dirPath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          dirPath: params.dirPath,
        };
      }
    },
  };

  const replaceString: ToolHandler<IReplaceStringParams, EditResult> = {
    name: ToolName.ReplaceString,
    definition: replaceStringDefinition,
    async execute(params) {
      try {
        const { entry, relativePath } = resolver.resolve(params.filePath);
        const result = (await handlerFor(entry.mount, ToolName.ReplaceString).execute({
          ...params,
          filePath: relativePath,
        })) as EditResult;
        return { ...result, filePath: params.filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          filePath: params.filePath,
        };
      }
    },
  };

  const multiReplace: ToolHandler<IMultiReplaceStringParams, MultiEditResult> = {
    name: ToolName.MultiReplaceString,
    definition: multiReplaceStringDefinition,
    async execute(params) {
      if (!params.replacements || !Array.isArray(params.replacements)) {
        return {
          success: false,
          error: 'Invalid input: replacements array is required',
          results: [],
          successCount: 0,
          failureCount: 0,
        };
      }
      const results: EditResult[] = [];
      let successCount = 0;
      let failureCount = 0;
      for (let i = 0; i < params.replacements.length; i++) {
        const replacement = params.replacements[i];
        try {
          const { entry, relativePath } = resolver.resolve(replacement.filePath);
          const result = (await handlerFor(entry.mount, ToolName.ReplaceString).execute({
            ...replacement,
            filePath: relativePath,
          })) as EditResult;
          results.push({ ...result, filePath: replacement.filePath });
          if (result.success) successCount++;
          else failureCount++;
        } catch (error) {
          results.push({
            success: false,
            error: `Replacement at index ${i} failed: ${error instanceof Error ? error.message : String(error)}`,
            filePath: replacement.filePath,
          });
          failureCount++;
        }
      }
      return {
        success: failureCount === 0,
        content: `${successCount} of ${params.replacements.length} replacements applied`,
        results,
        successCount,
        failureCount,
      };
    },
  };

  const PATH_HEADER_PREFIXES = [UPDATE_FILE_PREFIX, ADD_FILE_PREFIX, DELETE_FILE_PREFIX, MOVE_FILE_TO_PREFIX];

  const applyPatch: ToolHandler<IApplyPatchParams, EditResult> = {
    name: ToolName.ApplyPatch,
    definition: applyPatchDefinition,
    async execute(params) {
      try {
        // Rewrite every file-header path to be mount-relative; a patch must
        // stay within a single mount (cross-mount patches are ambiguous).
        const mounts = new Set<ArtiMount>();
        let entryUsed: MountTableEntry | undefined;
        const rewritten = (params.input ?? '').split('\n').map((line) => {
          for (const prefix of PATH_HEADER_PREFIXES) {
            if (line.startsWith(prefix)) {
              const original = line.slice(prefix.length).trim();
              const { entry, relativePath } = resolver.resolve(original);
              mounts.add(entry.mount);
              entryUsed = entry;
              return prefix + relativePath;
            }
          }
          return line;
        });
        if (mounts.size > 1) {
          return {
            success: false,
            error: `apply_patch cannot span mounts in one patch; found paths under ${mounts.size} different mounts. Split the patch per mount. Mounts: ${resolver.describe()}`,
            filePath: '',
          };
        }
        if (!entryUsed) {
          return { success: false, error: 'Patch contains no file operations', filePath: '' };
        }
        const result = (await handlerFor(entryUsed.mount, ToolName.ApplyPatch).execute({
          ...params,
          input: rewritten.join('\n'),
        })) as EditResult;
        const filePath = result.filePath
          ? `${entryUsed.path === '/' ? '' : entryUsed.path}/${result.filePath.replace(/^\//, '')}`
          : result.filePath;
        return { ...result, filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          filePath: '',
        };
      }
    },
  };

  return [readFile, createFile, listDir, createDirectory, replaceString, multiReplace, applyPatch];
}
