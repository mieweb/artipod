# Changelog

## 0.1.0 — initial standalone preview

- Open an interpreted Artipod terminal over a trusted local workspace.
- Create named snapshots that include editor saves and terminal filesystem changes.
- Select a snapshot and open an isolated fork in a new workspace.
- Open local files through the Artipod filesystem mirror.
- Package a self-contained runtime with separately replaceable LGPL libraries.
- Keep native Chat checkpoint integration optional and disabled by default;
  it requires a separate editor core patch.

This replaces the unpublished `artipod-checkpoints` development manifest with
`artipod`. Experimental chat mappings from the former extension ID are not
migrated. Artipod snapshot history remains in each workspace's `.artipod` store.
