'use client';

/**
 * The pod's STACK, not a file list (ported from the old app): writable
 * upper → replaceable draft layers → permanent base.
 */
import { useEffect, useState } from 'react';
import { fs } from '@/lib/filesystem';
import type { Route } from '@/lib/boot';

interface LayerRow {
  path: string;
  size: number;
  mtime?: string;
  digest: string;
  overlay?: string;
}

const fmtSize = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`;

function LayerBand({ title, tone, rows, note }: { title: string; tone: 'draft' | 'base'; rows: LayerRow[]; note?: string }) {
  const [open, setOpen] = useState(false);
  const total = rows.reduce((s, r) => s + r.size, 0);
  if (rows.length === 0) return null;
  return (
    <div className={`mb-2 rounded border px-3 py-2 ${tone === 'draft' ? 'border-blue-900 bg-blue-950/30' : 'border-gray-700 bg-[#252526]'}`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left">
        <span className="font-mono">
          {open ? '▾' : '▸'} {title}
        </span>
        <span className="shrink-0 text-xs text-gray-400">
          {rows.length} layer{rows.length === 1 ? '' : 's'} · {fmtSize(total)}
        </span>
      </button>
      {note && <p className="mt-0.5 text-xs text-gray-500">{note}</p>}
      {open && (
        <ul className="mt-2 space-y-1">
          {rows.slice(0, 200).map((l) => (
            <li key={l.digest + l.path} className="flex justify-between gap-3 text-xs">
              <span className="truncate font-mono text-gray-300">{l.path}</span>
              <span className="shrink-0 text-gray-500">
                {l.mtime ? `${new Date(Number(l.mtime) || l.mtime).toLocaleString()} · ` : ''}
                {fmtSize(l.size)} · {l.digest.slice(7, 15)}…
              </span>
            </li>
          ))}
          {rows.length > 200 && <li className="text-xs text-gray-500">… {rows.length - 200} more</li>}
        </ul>
      )}
    </div>
  );
}

export default function LayersView({ route, ready, onPublish, onBack }: { route: Route; ready: boolean; onPublish?: () => void; onBack?: () => void }) {
  const [layers, setLayers] = useState<LayerRow[] | null>(null);
  const [upperFiles, setUpperFiles] = useState<string[]>([]);
  const [upperOpen, setUpperOpen] = useState(false);
  const [head, setHead] = useState<{ digest: string; actor?: string; parents?: string } | null>(null);

  useEffect(() => {
    if (!ready) return;
    (async () => {
      const upperDir = route.isRef ? `/.artipod/upper/${encodeURIComponent(route.id)}` : `/work/${route.id}`;
      const walk = async (dir: string, prefix = ''): Promise<string[]> => {
        const out: string[] = [];
        for (const name of (await fs.promises.readdir(dir).catch(() => [])) as string[]) {
          const full = `${dir}/${name}`;
          const stat = await fs.promises.stat(full).catch(() => null);
          if (stat?.isDirectory()) out.push(...(await walk(full, `${prefix}${name}/`)));
          else out.push(`${prefix}${name}`);
        }
        return out;
      };
      setUpperFiles(await walk(upperDir));

      if (!route.isRef) {
        setLayers([]);
        return;
      }
      try {
        const refRes = await fetch(`/api/pods/refs?name=${encodeURIComponent(route.id)}`);
        if (!refRes.ok) throw new Error(String(refRes.status));
        const { manifestDigest } = (await refRes.json()) as { manifestDigest: string };
        const manifest = (await (await fetch(`/api/pods/blobs/${manifestDigest}`)).json()) as {
          layers: { digest: string; size: number; annotations?: Record<string, string> }[];
          annotations?: Record<string, string>;
        };
        setHead({
          digest: manifestDigest,
          actor: manifest.annotations?.['org.artipod.actor'],
          parents: manifest.annotations?.['org.artipod.parents'],
        });
        setLayers(
          manifest.layers.map((l) => ({
            path: l.annotations?.['org.artipod.path'] ?? '(layer)',
            size: l.size,
            mtime: l.annotations?.['org.artipod.mtime'],
            digest: l.digest,
            overlay: l.annotations?.['org.artipod.overlay'],
          })),
        );
      } catch {
        setLayers([]);
      }
    })();
  }, [route.id, route.isRef, ready]);

  const draftRows = (layers ?? []).filter((l) => l.overlay);
  const baseRows = (layers ?? []).filter((l) => !l.overlay);

  return (
    <div className="mx-auto max-w-2xl p-6 text-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold">Layers</h2>
        <div className="flex items-center gap-2">
          {onPublish && (
            <button onClick={onPublish} className="rounded bg-blue-800 px-2 py-1 text-xs hover:bg-blue-700">
              Publish
            </button>
          )}
          {onBack && (
            <button onClick={onBack} className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600">
              ← Files
            </button>
          )}
        </div>
      </div>
      <p className="mb-4 text-gray-400">
        artipod publishes one layer per file, so the interesting part is the stack, not the list: the writable upper wins over draft
        layers, drafts win over the permanent base.
        {route.mode === 'cow' ? ' (cow: the upper never pushes)' : route.mode === 'ro' ? ' (ro: the upper stays empty)' : ' (rw: the upper auto-pushes into a new head)'}
      </p>

      <div className="mb-2 rounded border border-emerald-800 bg-emerald-950/40 px-3 py-2">
        <button onClick={() => setUpperOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left">
          <span className="font-mono">{upperOpen ? '▾' : '▸'} upper (this machine, writable)</span>
          <span className="shrink-0 text-xs text-gray-400">
            {upperFiles.length} file{upperFiles.length === 1 ? '' : 's'}
          </span>
        </button>
        {upperOpen && upperFiles.length > 0 && (
          <ul className="mt-1 font-mono text-xs text-gray-400">
            {upperFiles.slice(0, 50).map((f) => (
              <li key={f}>/{f}</li>
            ))}
            {upperFiles.length > 50 && <li>… {upperFiles.length - 50} more</li>}
          </ul>
        )}
      </div>

      {route.isRef &&
        (layers === null ? (
          <p className="text-gray-500">loading basis manifest…</p>
        ) : (
          <>
            <LayerBand
              title="draft layers (replaceable)"
              tone="draft"
              rows={draftRows}
              note="pushed from an open workstream — the same actor's next push supersedes matching paths"
            />
            <LayerBand
              title="base layers (permanent)"
              tone="base"
              rows={baseRows}
              note="published/sealed content — immutable, shared verbatim by every fork and branch"
            />
            {head && (
              <p className="mt-2 font-mono text-xs text-gray-500">
                head {head.digest.slice(7, 19)}…{head.actor ? ` · pushed by ${head.actor}` : ''}
                {head.parents ? ' · has parents (history reachable)' : ''} · {(layers ?? []).length} layers ·{' '}
                {fmtSize((layers ?? []).reduce((s, l) => s + l.size, 0))} total
              </p>
            )}
          </>
        ))}
    </div>
  );
}
