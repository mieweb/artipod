/**
 * Unsaved editor text survives a gated UI unmount in this tab's RAM only.
 * No filesystem, browser storage, live buffer, or key is retained here.
 */
export interface EditorDraft {
  content: string;
  savedContent: string;
}

interface DraftBuffer {
  readonly content: string;
  readonly savedContent?: string;
  readonly isDirty: boolean;
  readonly externallyChanged: boolean;
  setContent(text: string): void;
  onChange(listener: (buffer: DraftBuffer) => void): () => void;
}

export interface EditorDraftSnapshot {
  isDirty: boolean;
  externallyChanged: boolean;
}

export class MemoryEditorDrafts {
  private readonly drafts = new Map<string, EditorDraft>();
  private readonly selected = new Map<string, string>();

  private key(workspace: string, path: string): string {
    return JSON.stringify([workspace, path]);
  }

  read(workspace: string, path: string): EditorDraft | null {
    const draft = this.drafts.get(this.key(workspace, path));
    return draft ? { ...draft } : null;
  }

  selectedFile(workspace: string): string | null {
    return this.selected.get(workspace) ?? null;
  }

  close(workspace: string, path: string): void {
    if (this.selected.get(workspace) === path) this.selected.delete(workspace);
  }

  /** Bind only after authenticated FileBuffer.open has read the current disk. */
  attach(
    workspace: string,
    path: string,
    buffer: DraftBuffer,
    onChange: (snapshot: EditorDraftSnapshot) => void,
  ): () => void {
    const key = this.key(workspace, path);
    const draft = this.drafts.get(key);
    let savedContent = draft?.savedContent ?? buffer.content;
    let bufferSavedContent = buffer.savedContent;
    let changedWhileClosed = !!draft && draft.savedContent !== buffer.content;
    this.selected.set(workspace, path);
    if (draft) buffer.setContent(draft.content);
    const update = (current: DraftBuffer): void => {
      if (current.savedContent !== undefined && current.savedContent !== bufferSavedContent) {
        // A save can finish while newer keystrokes remain dirty. Retain the
        // new draft against the text that actually reached disk.
        savedContent = current.savedContent;
        bufferSavedContent = current.savedContent;
        changedWhileClosed = false;
      }
      if (current.isDirty) this.drafts.set(key, { content: current.content, savedContent });
      else {
        // Successful save/reload or undo-to-disk releases all retained text.
        this.drafts.delete(key);
        savedContent = current.content;
        changedWhileClosed = false;
      }
      onChange({ isDirty: current.isDirty, externallyChanged: changedWhileClosed || current.externallyChanged });
    };
    const off = buffer.onChange(update);
    update(buffer);
    return off;
  }
}

export const editorDrafts = new MemoryEditorDrafts();
