# Browser Git Shell PoC

This is a Proof-of-Concept for a browser-based Git environment using ZenFS, isomorphic-git, and xterm.js.

## Features

- **IndexedDB-backed FileSystem**: Files persist across reloads.
- **Git Operations**: `clone`, `status`, `diff`, `files`.
- **Terminal Interface**: Basic shell commands (`ls`, `cd`, `cat`, `pwd`, `help`).
- **File Editing**: Simple modal editor.

## How to Run

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the development server:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

- **Clone a repo**:
  ```bash
  git clone https://github.com/isomorphic-git/isomorphic-git
  ```
  (Note: Large repos might take time. Use small repos for testing.)

- **List files**:
  ```bash
  ls
  cd isomorphic-git
  ls
  ```

- **Check status**:
  ```bash
  git status
  ```

- **Edit a file**:
  ```bash
  edit README.md
  ```
  Make changes and save.

- **Check diff**:
  ```bash
  git diff README.md
  ```

## Architecture

- **FileSystem**: `@zenfs/core` with `@zenfs/dom` (IndexedDB).
- **Git**: `isomorphic-git` using the ZenFS instance.
- **Terminal**: `xterm.js` rendered in a React component.
- **Shell**: Custom command parser in `lib/shell.ts`.
- **Framework**: Next.js (App Router).

## Notes

- The filesystem is mounted at `/`.
- The default working directory is `/repo`.
- CORS proxy is used for GitHub cloning (`https://cors.isomorphic-git.org`).
