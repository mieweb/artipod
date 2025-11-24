# **Ticket: Browser Git Shell Proof-of-Concept (PoC)**

## **Summary**

Create a browser-based, fully client-side Git environment that uses **ZenFS (IndexedDB backend)** as a virtual filesystem, **isomorphic-git** for Git operations, and **xterm.js** for an interactive shell-style UI.
The goal is to demonstrate feasibility: cloning a repo, inspecting files, editing files, running `git status`, and showing diffs — all inside the browser with persistent storage.

---

## **Goals / Deliverables**

### **Minimum PoC Requirements**

1. **IndexedDB-backed FileSystem**

   * Use **ZenFS** (`@zenfs/core` + `@zenfs/dom`) with the **IndexedDB backend**.
   * Mount virtual filesystem at `/` with `/repo` as the working folder.
   * Persistence across browser reloads is required.

2. **Git Operations (isomorphic-git)**

   * Integrate `isomorphic-git` with the ZenFS-backed filesystem.
   * Support the following commands:

     * `git clone <url>`
     * `git status`
     * `git diff <file>`
     * `git files` (list tracked files)
   * Support cloning public GitHub repos (may require CORS proxy if needed).

3. **Browser Terminal Interface**

   * Use **xterm.js** + minimal command parser.
   * Provide a prompt, history, and basic commands:

     * `ls`
     * `cat <file>`
     * `cd <dir>`
     * `pwd`
     * `help`
   * Commands should call into JS functions, not an actual shell.

4. **File Viewing / Editing (Minimum)**

   * Allow viewing any file via `cat`.
   * Provide a minimal text-editing command, e.g.:

     * `edit <file>` → opens a textarea modal or side panel → save changes.

5. **Diff Capability**

   * Use `isomorphic-git` diff API.
   * For non-Git diffs (e.g., untracked files), fallback to a JS diff lib (optional).
   * Text diff output can be plain unified diff in terminal.

---

## **Stretch Goals (Optional for PoC)**

* Basic file tree sidebar (read-only).
* Editor using Monaco or CodeMirror.
* Mini “workspace” abstraction to support switching repos.
* UI to show IndexedDB usage / storage.

---

## **Technical Notes**

* Use NextJS
* The system must **not** require a backend server**.
  Everything must run inside the browser (client-only).

---

## **Acceptance Criteria**

* User can open the browser, run `git clone <repo>` and see files persist after refresh.
* `git status` shows at least clean/modified/untracked.
* `git diff <file>` shows unified diff in the terminal.
* User can `cat` files and optionally edit them.
* No server involvement; all logic stays client-side.
* Developer produces short README explaining how to run/test PoC.

---

## **References / Code to Start From**

* ZenFS IndexedDB example
* isomorphic-git + ZenFS example
* Minimal browser-git-shell sample (provided earlier)

