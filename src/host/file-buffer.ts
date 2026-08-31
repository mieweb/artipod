/**
 * FileBuffer — the headless editor document extracted from artipod-sync's
 * Editor.tsx (plan §3): open → content, save(), isDirty, external-change
 * detection over `fs:changed` (reload-if-clean / flag-if-dirty). Editor-
 * agnostic: Monaco, kerebron RichEditor or CodeMirror all sit on top.
 */
import type { ZenFsLike } from '../sandbox/types.js';
import type { PodEvents } from '../events.js';

export interface FileBufferOptions {
  zfs: ZenFsLike;
  path: string;
  events?: PodEvents;
  /** Secondary tabs: refuse to save. */
  readOnly?: boolean;
}

export type FileBufferListener = (buffer: FileBuffer) => void;

export function languageForPath(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

export class FileBuffer {
  private _content = '';
  private _savedContent = '';
  private _isDirty = false;
  private _externallyChanged = false;
  private listeners = new Set<FileBufferListener>();
  private disposers: Array<() => void> = [];

  private constructor(private readonly opts: FileBufferOptions) {}

  static async open(opts: FileBufferOptions): Promise<FileBuffer> {
    const buffer = new FileBuffer(opts);
    await buffer.reload();
    if (opts.events) {
      buffer.disposers.push(
        opts.events.on('fs:changed', (e) => {
          // Editor's own save already synced the buffer.
          if (e.origin === 'editor' && e.paths?.includes(opts.path)) return;
          const affectsThisFile = !e.paths || e.paths.includes(opts.path);
          if (!affectsThisFile) return;
          void buffer.handleExternalChange();
        }),
      );
    }
    return buffer;
  }

  get path(): string {
    return this.opts.path;
  }

  get content(): string {
    return this._content;
  }

  get isDirty(): boolean {
    return this._isDirty;
  }

  /** Set when the file changed underneath a dirty buffer (warn, don't clobber). */
  get externallyChanged(): boolean {
    return this._externallyChanged;
  }

  get language(): string {
    return languageForPath(this.opts.path);
  }

  onChange(listener: FileBufferListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l(this);
  }

  /** Editor keystroke path: update content, mark dirty. */
  setContent(text: string): void {
    this._content = text;
    this._isDirty = text !== this._savedContent;
    this.notify();
  }

  async reload(): Promise<void> {
    const { zfs, path } = this.opts;
    try {
      this._content = (await zfs.promises.readFile(path, 'utf8')) as string;
    } catch {
      this._content = ''; // new file
    }
    this._savedContent = this._content;
    this._isDirty = false;
    this._externallyChanged = false;
    this.notify();
  }

  async save(): Promise<void> {
    if (this.opts.readOnly) {
      throw new Error('read-only session: saving is disabled in this tab');
    }
    const { zfs, path, events } = this.opts;
    await zfs.promises.writeFile(path, this._content);
    this._savedContent = this._content;
    this._isDirty = false;
    this._externallyChanged = false;
    events?.emit('fs:changed', { paths: [path], origin: 'editor' });
    this.notify();
  }

  /** fs:changed for our path: reload if clean, flag if dirty. */
  private async handleExternalChange(): Promise<void> {
    const { zfs, path } = this.opts;
    let onDisk: string;
    try {
      onDisk = (await zfs.promises.readFile(path, 'utf8')) as string;
    } catch {
      onDisk = '';
    }
    if (onDisk === this._savedContent) return; // nothing actually changed
    if (this._isDirty) {
      this._externallyChanged = true;
      this.notify();
    } else {
      this._content = onDisk;
      this._savedContent = onDisk;
      this._externallyChanged = false;
      this.notify();
    }
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.listeners.clear();
  }
}
