/**
 * Apply Patch Parser - adapted from vscode-copilot-chat
 * 
 * Copyright 2025 OpenAI
 * Licensed under the Apache License, Version 2.0
 * 
 * Based on reference implementation from:
 * https://cookbook.openai.com/examples/gpt4-1_prompting_guide#reference-implementation-apply_patchpy
 */

// ============================================================================
// Constants
// ============================================================================

export const PATCH_PREFIX = '*** Begin Patch';
export const PATCH_SUFFIX = '*** End Patch';
export const ADD_FILE_PREFIX = '*** Add File: ';
export const DELETE_FILE_PREFIX = '*** Delete File: ';
export const UPDATE_FILE_PREFIX = '*** Update File: ';
export const MOVE_FILE_TO_PREFIX = '*** Move to: ';
export const END_OF_FILE_PREFIX = '*** End of File';
export const HUNK_ADD_LINE_PREFIX = '+';
export const HUNK_DELETE_LINE_PREFIX = '-';
export const CHUNK_DELIMITER = '@@';

// ============================================================================
// Types
// ============================================================================

export enum ActionType {
  ADD = 'add',
  DELETE = 'delete',
  UPDATE = 'update',
}

export interface FileChange {
  type: ActionType;
  oldContent?: string | null;
  newContent?: string | null;
  movePath?: string | null;
}

export interface Commit {
  changes: Record<string, FileChange>;
}

export interface Chunk {
  origIndex: number;
  delLines: string[];
  insLines: string[];
}

export interface PatchAction {
  type: ActionType;
  newFile?: string | null;
  chunks: Chunk[];
  movePath?: string | null;
}

export interface Patch {
  actions: Record<string, PatchAction>;
}

// ============================================================================
// Error Classes
// ============================================================================

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffError';
  }
}

export class InvalidPatchFormatError extends DiffError {
  constructor(message: string, public readonly kind: string) {
    super(message);
    this.name = 'InvalidPatchFormatError';
  }
}

export class InvalidContextError extends DiffError {
  constructor(message: string, public readonly file: string, public readonly kind: string) {
    super(message);
    this.name = 'InvalidContextError';
  }
}

// ============================================================================
// Text Document Interface (simplified)
// ============================================================================

export interface TextDocument {
  getText(): string;
  languageId?: string;
}

/**
 * Simple text document implementation
 */
export class SimpleTextDocument implements TextDocument {
  constructor(
    private content: string,
    public readonly languageId: string = 'plaintext'
  ) {}

  getText(): string {
    return this.content;
  }
}

// ============================================================================
// Fuzzy Matching Flags
// ============================================================================

export const enum Fuzz {
  None = 0,
  IgnoredTrailingWhitespace = 1 << 1,
  NormalizedExplicitTab = 1 << 2,
  IgnoredWhitespace = 1 << 3,
  EditDistanceMatch = 1 << 4,
  IgnoredEofSignal = 1 << 5,
  MergedOperatorSection = 1 << 6,
  NormalizedExplicitNL = 1 << 7,
}

interface FuzzMatch {
  line: number;
  fuzz: Fuzz;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute Levenshtein edit distance between two strings
 */
function computeLevenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  
  // Create a 2D array for dynamic programming
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  // Fill the dp table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }
  
  return dp[m][n];
}

/**
 * Replace explicit \\t sequences with actual tabs
 */
export function replaceExplicitTabs(s: string): string {
  return s.replace(/^(?:\s|\\t|\/|#)*/gm, r => r.split('\\t').join('\t'));
}

/**
 * Replace explicit \\n and \\t sequences
 */
export function replaceExplicitNewlines(s: string): string {
  return replaceExplicitTabs(s.split('\\n').join('\n'));
}

/**
 * Unicode punctuation normalization map
 */
const PUNCT_EQUIV: Record<string, string> = {
  // Hyphen/dash variants
  '-': '-', '\u2010': '-', '\u2011': '-', '\u2012': '-',
  '\u2013': '-', '\u2014': '-', '\u2212': '-',
  // Double quotes
  '\u0022': '"', '\u201C': '"', '\u201D': '"', '\u201E': '"',
  '\u00AB': '"', '\u00BB': '"',
  // Single quotes
  '\u0027': `'`, '\u2018': `'`, '\u2019': `'`, '\u201B': `'`,
  // Spaces
  '\u00A0': ' ', '\u202F': ' ',
};

/**
 * Canonicalize string for fuzzy matching
 */
function canonicalize(s: string): string {
  return s
    .normalize('NFC')
    .replace(/./gu, c => PUNCT_EQUIV[c] ?? c);
}

/**
 * Count occurrences of a character in a string
 */
function countChar(s: string, char: string): number {
  let count = 0;
  for (const c of s) {
    if (c === char) count++;
  }
  return count;
}

// Max edit distance allowed per line for fuzzy matching
const EDIT_DISTANCE_ALLOWANCE_PER_LINE = 0.34;

// ============================================================================
// Context Finding
// ============================================================================

function findContextCore(
  lines: string[],
  context: string[],
  start: number
): FuzzMatch | undefined {
  if (context.length === 0) {
    return { line: start, fuzz: Fuzz.None };
  }

  const workingLines = lines.map(canonicalize);
  
  // Pass 1: exact equality after canonicalization
  const ctxPass1 = canonicalize(context.join('\n'));
  for (let i = start; i < workingLines.length; i++) {
    const segment = workingLines.slice(i, i + context.length).join('\n');
    if (segment === ctxPass1) {
      return { line: i, fuzz: Fuzz.None };
    }
  }

  // Pass 2: ignore trailing whitespace
  const ctxPass2 = ctxPass1.split('\n').map(l => l.trimEnd()).join('\n');
  let fuzz = Fuzz.IgnoredTrailingWhitespace;
  const trimmedLines = workingLines.map(l => l.trimEnd());
  for (let i = start; i < lines.length; i++) {
    if (trimmedLines.slice(i, i + context.length).join('\n') === ctxPass2) {
      return { line: i, fuzz };
    }
  }

  // Pass 3: normalize explicit \\t tab chars
  const ctxPass3 = replaceExplicitTabs(ctxPass2);
  if (ctxPass3 !== ctxPass2) {
    fuzz |= Fuzz.NormalizedExplicitTab;
    for (let i = start; i < lines.length; i++) {
      if (trimmedLines.slice(i, i + context.length).join('\n') === ctxPass3) {
        return { line: i, fuzz };
      }
    }
  }

  // Pass 4: normalize explicit \\t and \\n
  if (context.length === 1) {
    const ctxPass4 = replaceExplicitNewlines(ctxPass3);
    if (ctxPass4 !== ctxPass3) {
      const newContextLines = countChar(ctxPass4, '\n') + 1;
      for (let i = start; i < lines.length; i++) {
        if (trimmedLines.slice(i, i + newContextLines).join('\n') === ctxPass4) {
          return { line: i, fuzz: fuzz | Fuzz.NormalizedExplicitNL | Fuzz.NormalizedExplicitTab };
        }
      }
    }
  }

  // Pass 5: ignore all surrounding whitespace
  const ctxPass5 = ctxPass3.split('\n').map(l => l.trim()).join('\n');
  fuzz |= Fuzz.IgnoredWhitespace;
  const fullyTrimmedLines = trimmedLines.map(l => l.trimStart());
  for (let i = start; i < lines.length; i++) {
    if (fullyTrimmedLines.slice(i, i + context.length).join('\n') === ctxPass5) {
      return { line: i, fuzz };
    }
  }

  // Pass 6: edit distance fuzzy matching
  const maxDistance = Math.floor(context.length * EDIT_DISTANCE_ALLOWANCE_PER_LINE);
  fuzz |= Fuzz.EditDistanceMatch;
  if (maxDistance > 0) {
    const ctxPass6 = ctxPass5.split('\n');
    for (let i = start; i < lines.length; i++) {
      let totalDistance = 0;
      for (let j = 0; j < ctxPass6.length && totalDistance < maxDistance; j++) {
        totalDistance += computeLevenshteinDistance(fullyTrimmedLines[i + j] || '', ctxPass6[j]);
      }
      if (totalDistance <= maxDistance) {
        return { line: i, fuzz };
      }
    }
  }

  return undefined;
}

function findContext(
  path: string,
  lines: string[],
  context: string[],
  start: number,
  eof: boolean
): FuzzMatch | undefined {
  // Skip filepath comments in provided context
  path = path.trim();
  if (lines[0]?.includes(path)) {
    lines = lines.slice(1);
  }
  if (context[0]?.includes(path)) {
    context = context.slice(1);
  }

  if (eof) {
    const match1 = findContextCore(lines, context, lines.length - context.length);
    if (match1) return match1;
    
    const match2 = findContextCore(lines, context, start);
    if (match2) {
      match2.fuzz |= Fuzz.IgnoredEofSignal;
      return match2;
    }
  }
  
  return findContextCore(lines, context, start);
}

// ============================================================================
// Parser
// ============================================================================

interface NextSectionResult {
  nextChunkContext: string[];
  chunks: Chunk[];
  endPatchIndex: number;
  eof: boolean;
  fuzzMerges: number;
}

function peekNextSection(
  lines: string[],
  initialIndex: number,
  fuzzMerge = 0
): NextSectionResult {
  const enum Mode { Add, Delete, Keep }
  
  let index = initialIndex;
  const old: string[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  const chunks: Chunk[] = [];
  let mode: Mode = Mode.Keep;
  let fuzzMergeNo = 0;

  while (index < lines.length) {
    const s = lines[index]!;
    
    // Check for section terminators
    if ([CHUNK_DELIMITER, PATCH_SUFFIX, UPDATE_FILE_PREFIX, 
         DELETE_FILE_PREFIX, ADD_FILE_PREFIX, END_OF_FILE_PREFIX]
        .some(p => s.startsWith(p.trim()))) {
      if (mode === Mode.Keep && old.length && !/\S/.test(old[old.length - 1])) {
        old.pop();
      }
      break;
    }
    
    if (s === '***' || s.startsWith('***')) {
      if (s !== '***') {
        throw new InvalidPatchFormatError(`Invalid Line: ${s}`, 'invalidLine');
      }
      break;
    }

    index++;
    const lastMode: Mode = mode;
    let line = s;

    if (line[0] === HUNK_ADD_LINE_PREFIX) {
      mode = Mode.Add;
    } else if (line[0] === HUNK_DELETE_LINE_PREFIX) {
      mode = Mode.Delete;
    } else if (line[0] === ' ') {
      mode = Mode.Keep;
    } else {
      // Handle missing leading whitespace
      const nextLine = lines[index];
      const nextOp = nextLine?.[0] === HUNK_ADD_LINE_PREFIX ? Mode.Add 
                   : nextLine?.[0] === HUNK_DELETE_LINE_PREFIX ? Mode.Delete 
                   : Mode.Keep;
      const canFuzz = mode !== Mode.Keep && nextOp === mode;

      mode = Mode.Keep;
      line = ' ' + line;

      if (canFuzz) {
        fuzzMergeNo++;
        if (fuzzMerge === fuzzMergeNo) {
          mode = nextOp;
        }
      }
    }

    line = line.slice(1);

    if (mode === Mode.Keep && lastMode !== mode) {
      if (insLines.length || delLines.length) {
        chunks.push({
          origIndex: old.length - delLines.length,
          delLines,
          insLines,
        });
      }
      delLines = [];
      insLines = [];
    }

    if (mode === Mode.Delete) {
      delLines.push(line);
      old.push(line);
    } else if (mode === Mode.Add) {
      insLines.push(line);
    } else {
      old.push(line);
    }
  }

  if (insLines.length || delLines.length) {
    chunks.push({
      origIndex: old.length - delLines.length,
      delLines,
      insLines,
    });
  }

  if (index < lines.length && lines[index] === END_OF_FILE_PREFIX) {
    index++;
    return { nextChunkContext: old, chunks, endPatchIndex: index, eof: true, fuzzMerges: fuzzMergeNo };
  }

  return { nextChunkContext: old, chunks, endPatchIndex: index, eof: false, fuzzMerges: fuzzMergeNo };
}

export class Parser {
  currentFiles: Record<string, TextDocument>;
  lines: string[];
  index = 0;
  patch: Patch = { actions: {} };
  fuzz = 0;

  constructor(currentFiles: Record<string, TextDocument>, lines: string[]) {
    this.currentFiles = currentFiles;
    this.lines = lines;
  }

  private isDone(prefixes?: string[]): boolean {
    if (this.index >= this.lines.length) return true;
    if (prefixes?.some(p => this.lines[this.index]!.startsWith(p.trim()))) return true;
    return false;
  }

  private startsWith(prefix: string | string[]): boolean {
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    return prefixes.some(p => this.lines[this.index]!.startsWith(p));
  }

  private readStr(prefix = '', returnEverything = false): string {
    if (this.index >= this.lines.length) {
      throw new DiffError(`Index: ${this.index} >= ${this.lines.length}`);
    }
    if (this.lines[this.index]!.startsWith(prefix)) {
      const text = returnEverything
        ? this.lines[this.index]
        : this.lines[this.index]!.slice(prefix.length);
      this.index++;
      return text ?? '';
    }
    return '';
  }

  parse(): void {
    while (!this.isDone([PATCH_SUFFIX])) {
      let path = this.readStr(UPDATE_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Update File Error: Duplicate Path: ${path}`);
        }
        const moveTo = this.readStr(MOVE_FILE_TO_PREFIX);
        if (!(path in this.currentFiles)) {
          throw new DiffError(`Update File Error: Missing File: ${path}`);
        }
        const textDocument = this.currentFiles[path];
        const text = textDocument.getText();
        const action = this.parseUpdateFile(path, text);
        action.movePath = moveTo || undefined;
        this.patch.actions[path] = action;
        continue;
      }

      path = this.readStr(DELETE_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Delete File Error: Duplicate Path: ${path}`);
        }
        if (!(path in this.currentFiles)) {
          throw new DiffError(`Delete File Error: Missing File: ${path}`);
        }
        this.patch.actions[path] = { type: ActionType.DELETE, chunks: [] };
        continue;
      }

      path = this.readStr(ADD_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Add File Error: Duplicate Path: ${path}`);
        }
        if (path in this.currentFiles) {
          throw new DiffError(`Add File Error: File already exists: ${path}`);
        }
        this.patch.actions[path] = this.parseAddFile();
        continue;
      }

      throw new DiffError(`Unknown Line: ${this.lines[this.index]}`);
    }

    if (!this.startsWith(PATCH_SUFFIX.trim())) {
      throw new InvalidPatchFormatError('Missing End Patch', 'missingEndPatch');
    }
    this.index++;
  }

  private parseUpdateFile(path: string, text: string): PatchAction {
    const action: PatchAction = { type: ActionType.UPDATE, chunks: [] };
    const fileLines = text.split('\n');
    let index = 0;

    while (!this.isDone([
      PATCH_SUFFIX, UPDATE_FILE_PREFIX, DELETE_FILE_PREFIX, 
      ADD_FILE_PREFIX, END_OF_FILE_PREFIX
    ])) {
      const sectionStr = this.readStr(CHUNK_DELIMITER, true);
      const defStr = sectionStr.slice(CHUNK_DELIMITER.length).trim();

      if (!(sectionStr || index === 0)) {
        throw new DiffError(
          `Invalid line. Consider splitting each change into individual apply_patch tool calls:\n${this.lines[this.index]}`
        );
      }

      // Handle @@ header navigation
      if (defStr) {
        const canon = (s: string) => canonicalize(s);
        let found = false;

        // Try to find exact match first
        for (let i = index; i < fileLines.length; i++) {
          if (canon(fileLines[i]!) === canon(defStr)) {
            index = i + 1;
            found = true;
            break;
          }
        }

        // Try trimmed match
        if (!found) {
          for (let i = index; i < fileLines.length; i++) {
            if (canon(fileLines[i]!.trim()) === canon(defStr)) {
              index = i + 1;
              this.fuzz++;
              found = true;
              break;
            }
          }
        }
      }

      let nextSection = peekNextSection(this.lines, this.index);
      let match: FuzzMatch | undefined;

      for (let i = 0; i <= nextSection.fuzzMerges && !match; i++) {
        if (i > 0) {
          nextSection = peekNextSection(this.lines, this.index, i);
        }
        
        match = findContext(path, fileLines, nextSection.nextChunkContext, index, nextSection.eof);
        
        if (!match) {
          // Try from beginning of file
          match = findContext(path, fileLines, nextSection.nextChunkContext, 0, nextSection.eof);
        }

        if (i > 0 && match) {
          match.fuzz |= Fuzz.MergedOperatorSection;
        }
      }

      if (!match) {
        const ctxText = nextSection.nextChunkContext.join('\n');
        if (nextSection.eof) {
          throw new InvalidContextError(
            `Invalid EOF context at character ${index}:\n${ctxText}`,
            text,
            'invalidContext-eof'
          );
        } else {
          throw new InvalidContextError(
            `Invalid context at character ${index}:\n${ctxText}`,
            text,
            'invalidContext'
          );
        }
      }

      this.fuzz += match.fuzz;

      for (const ch of nextSection.chunks) {
        ch.origIndex += match.line;

        if (match.fuzz & Fuzz.NormalizedExplicitNL) {
          ch.insLines = ch.insLines.map(replaceExplicitNewlines);
          ch.delLines = ch.delLines.map(replaceExplicitNewlines);
        }
        if (match.fuzz & Fuzz.NormalizedExplicitTab) {
          ch.insLines = ch.insLines.map(replaceExplicitTabs);
          ch.delLines = ch.delLines.map(replaceExplicitTabs);
        }

        action.chunks.push(ch);
      }

      index = match.line + nextSection.nextChunkContext.length;
      this.index = nextSection.endPatchIndex;
    }

    return action;
  }

  private parseAddFile(): PatchAction {
    const lines: string[] = [];

    while (!this.isDone([
      PATCH_SUFFIX, UPDATE_FILE_PREFIX, DELETE_FILE_PREFIX, ADD_FILE_PREFIX
    ])) {
      const s = this.readStr();
      if (!s.startsWith(HUNK_ADD_LINE_PREFIX)) {
        throw new InvalidPatchFormatError(`Invalid Add File Line: ${s}`, 'invalidAddFileLine');
      }
      lines.push(s.slice(1));
    }

    return {
      type: ActionType.ADD,
      newFile: lines.join('\n'),
      chunks: [],
    };
  }
}

// ============================================================================
// High-level API
// ============================================================================

/**
 * Identify files that need to be loaded for patch application
 */
export function identifyFilesNeeded(text: string): string[] {
  const lines = text.trim().split('\n');
  const result = new Set<string>();
  
  for (const line of lines) {
    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      result.add(line.slice(UPDATE_FILE_PREFIX.length));
    }
    if (line.startsWith(DELETE_FILE_PREFIX)) {
      result.add(line.slice(DELETE_FILE_PREFIX.length));
    }
  }
  
  return [...result];
}

/**
 * Identify files that will be added by the patch
 */
export function identifyFilesAdded(text: string): string[] {
  const lines = text.trim().split('\n');
  const result = new Set<string>();
  
  for (const line of lines) {
    if (line.startsWith(ADD_FILE_PREFIX)) {
      result.add(line.slice(ADD_FILE_PREFIX.length));
    }
  }
  
  return [...result];
}

/**
 * Parse patch text into a Patch structure
 */
export function textToPatch(
  text: string,
  orig: Record<string, TextDocument>
): [Patch, number] {
  const lines = text.trim().split('\n');
  
  if (lines.length < 2) {
    throw new InvalidPatchFormatError('Invalid patch text', 'invalidPatchText');
  }

  const patchPrefix = PATCH_PREFIX.trim();
  if (!(lines[0] ?? '').startsWith(patchPrefix)) {
    throw new InvalidPatchFormatError(
      `Invalid patch text. Patch must start with ${patchPrefix}.`,
      'invalidPatchTextPrefix'
    );
  }

  const patchSuffix = PATCH_SUFFIX.trim();
  if (lines[lines.length - 1] !== patchSuffix) {
    lines.push(patchSuffix);
  }

  const parser = new Parser(orig, lines);
  parser.index = 1;
  parser.parse();
  
  return [parser.patch, parser.fuzz];
}

/**
 * Get updated file content after applying changes
 */
function getUpdatedFile(text: string, action: PatchAction, path: string): string {
  if (action.type !== ActionType.UPDATE) {
    throw new Error('Expected UPDATE action');
  }

  const origLines = text.split('\n');
  const destLines: string[] = [];
  let origIndex = 0;

  for (const chunk of action.chunks) {
    if (chunk.origIndex > origLines.length) {
      throw new DiffError(
        `${path}: chunk.origIndex ${chunk.origIndex} > len(lines) ${origLines.length}`
      );
    }
    if (origIndex > chunk.origIndex) {
      throw new DiffError(
        `${path}: origIndex ${origIndex} > chunk.origIndex ${chunk.origIndex}`
      );
    }

    destLines.push(...origLines.slice(origIndex, chunk.origIndex));
    origIndex = chunk.origIndex;

    // Add inserted lines
    if (chunk.insLines.length) {
      destLines.push(...chunk.insLines);
    }

    origIndex += chunk.delLines.length;
  }

  destLines.push(...origLines.slice(origIndex));
  return destLines.join('\n');
}

/**
 * Convert a Patch to a Commit (resolved file changes)
 */
export function patchToCommit(
  patch: Patch,
  orig: Record<string, TextDocument>
): Commit {
  const commit: Commit = { changes: {} };

  for (const [pathKey, action] of Object.entries(patch.actions)) {
    if (action.type === ActionType.DELETE) {
      commit.changes[pathKey] = {
        type: ActionType.DELETE,
        oldContent: orig[pathKey].getText(),
      };
    } else if (action.type === ActionType.ADD) {
      commit.changes[pathKey] = {
        type: ActionType.ADD,
        newContent: action.newFile ?? '',
      };
    } else if (action.type === ActionType.UPDATE) {
      const text = orig[pathKey]?.getText();
      const newContent = getUpdatedFile(text, action, pathKey);
      commit.changes[pathKey] = {
        type: ActionType.UPDATE,
        oldContent: text,
        newContent,
        movePath: action.movePath ?? undefined,
      };
    }
  }

  return commit;
}

/**
 * Process a patch and return a Commit
 */
export async function processPatch(
  text: string,
  openFn: (path: string) => Promise<TextDocument>
): Promise<Commit> {
  if (!text.trim().startsWith(PATCH_PREFIX.trim())) {
    throw new InvalidPatchFormatError(
      `Patch must start with ${PATCH_PREFIX}`,
      'patchMustStartWithBeginPatch'
    );
  }

  const paths = identifyFilesNeeded(text);
  const orig: Record<string, TextDocument> = {};

  for (const p of paths) {
    try {
      orig[p] = await openFn(p);
    } catch {
      throw new DiffError(`File not found: ${p}`);
    }
  }

  const [patch] = textToPatch(text, orig);
  return patchToCommit(patch, orig);
}

/**
 * Apply a commit to the filesystem
 */
export function applyCommit(
  commit: Commit,
  writeFn: (path: string, content: string) => void,
  removeFn: (path: string) => void
): void {
  for (const [p, change] of Object.entries(commit.changes)) {
    if (change.type === ActionType.DELETE) {
      removeFn(p);
    } else if (change.type === ActionType.ADD) {
      writeFn(p, change.newContent ?? '');
    } else if (change.type === ActionType.UPDATE) {
      if (change.movePath) {
        writeFn(change.movePath, change.newContent ?? '');
        removeFn(p);
      } else {
        writeFn(p, change.newContent ?? '');
      }
    }
  }
}
