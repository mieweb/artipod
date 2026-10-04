# `lib/proc` — host state as files

`/proc` is a snapshot mount. Before every command the sandbox throws the mount
away and rebuilds it from the registered **providers**; after the command, files
under `rw` providers that changed are handed back to their provider.

| File | Role |
| --- | --- |
| [registry.ts](registry.ts) | what a provider is, and who is registered/enabled |
| [snapshot.ts](snapshot.ts) | mounts `/proc`, writes provider trees, records hashes |
| [reconcile.ts](reconcile.ts) | write-back for `rw` providers |
| [storage-provider.ts](storage-provider.ts) | the one built-in provider: raw IndexedDB / OPFS |

A provider is shaped like a kernel module on purpose, so `lsmod`, `modinfo` and
`modprobe` (in [../sandbox/module-command.ts](../sandbox/module-command.ts)) are
the natural UI:

```ts
registerProcProvider({
  name: 'route',
  description: 'the current hash route',
  mode: 'ro',
  root: '',                                  // writes /proc/route.json
  read: async () => ({ 'route.json': JSON.stringify(route) }),
});
```

Enable the framework with `createSandbox({ proc: true })`; nothing else needs
wiring. artipod-sync ships only `storage` — every other projection belongs to
the app embedding the sandbox.
