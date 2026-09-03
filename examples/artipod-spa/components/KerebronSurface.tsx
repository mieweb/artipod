'use client';

/**
 * The editing surface (spa-ui-plan P8): kerebron via @mieweb/ui's optional
 * `/kerebron` entry — RichEditor for markdown, CodeEditor for everything
 * else. Loaded client-only (wasm) in a DISPOSABLE keyed subtree:
 * CoreEditor.destroy() replaces its mount node with a clone, so we remount
 * by key instead of ever reparenting, and external reloads bump the key.
 */
import { RichEditor, CodeEditor } from '@mieweb/ui/kerebron';
import '@mieweb/ui/kerebron.css';

/** Monaco-style language ids (FileBuffer.language) → kerebron grammar names. */
const LANG_MAP: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  python: 'python',
  rust: 'rust',
  html: 'html',
  css: 'css',
  yaml: 'yaml',
  shell: 'bash',
  plaintext: 'text',
};

export default function KerebronSurface({
  language,
  value,
  onChange,
  readOnly,
}: {
  language: string;
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  const surface =
    language === 'markdown' ? (
      <RichEditor value={value} onChange={onChange} />
    ) : (
      <CodeEditor value={value} onChange={onChange} lang={LANG_MAP[language] ?? 'text'} />
    );
  return (
    // kerebron has no readOnly prop (yet) — inert the subtree for ro mode
    <div className={`h-full w-full overflow-auto ${readOnly ? 'pointer-events-none opacity-70' : ''}`} aria-readonly={readOnly}>
      {surface}
    </div>
  );
}
