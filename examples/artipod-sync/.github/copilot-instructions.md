## Code Quality Principles

<!-- https://github.com/mieweb/template-mieweb-opensource/blob/main/.github/copilot-instructions.md -->

### 🎯 DRY (Don't Repeat Yourself)
- **Never duplicate code**: If you find yourself copying code, extract it into a reusable function
- **Single source of truth**: Each piece of knowledge should have one authoritative representation
- **Refactor mercilessly**: When you see duplication, eliminate it immediately
- **Shared utilities**: Common patterns should be abstracted into utility functions

### 💋 KISS (Keep It Simple, Stupid)
- **Simple solutions**: Prefer the simplest solution that works
- **Avoid over-engineering**: Don't add complexity for hypothetical future needs
- **Clear naming**: Functions and variables should be self-documenting
- **Small functions**: Break down complex functions into smaller, focused ones
- **Readable code**: Code should be obvious to understand at first glance

### 🧹 Folder Philosophy
- **Clear purpose**: Every folder should have a main thing that anchors its contents.
- **No junk drawers**: Don’t leave loose files without context or explanation.
- **Explain relationships**: If it’s not elegantly obvious how files fit together, add a README or note.
- **Immediate clarity**: Opening a folder should make its organizing principle clear at a glance.

### 🔄 Refactoring Guidelines
- **Continuous improvement**: Refactor as you work, not as a separate task
- **Safe refactoring**: Always run tests before and after refactoring
- **Incremental changes**: Make small, safe changes rather than large rewrites
- **Preserve behavior**: Refactoring should not change external behavior
- **Code reviews**: All refactoring should be reviewed for correctness

### ⚰️ Dead Code Management
- **Immediate removal**: Delete unused code immediately when identified
- **Historical preservation**: Move significant dead code to `.attic/` directory with context
- **Documentation**: Include comments explaining why code was moved to attic
- **Regular cleanup**: Review and clean attic directory periodically
- **No accumulation**: Don't let dead code accumulate in active codebase

## Tech Stack & Architecture
- **Framework**: Next.js 14 (App Router)
- **Styling**: Tailwind CSS
- **State/Logic**: Client-side heavy (ZenFS, isomorphic-git).
- **Constraint**: NO backend server for git operations. All logic must run in the browser.
- **Git networking**: the only server involvement is the CORS proxy at `/api/git` (browser default; `NEXT_PUBLIC_GIT_CORS_PROXY` overrides). The public `cors.isomorphic-git.org` is dead — never default to it.

## Deployment Environments

### 🌐 Sample Site (`artipod-bash`)
- **Detection**: If `hostname` returns `artipod-bash`, this machine is the public sample site.
- **Run a release build, not dev**: `npm run build && npm run start -- -p 3000`
- **Port**: Always serve on port 3000 (`npm run dev -p 3500` is for local development only).
- **Public URL**: A load balancer outside the container maps `https://artipod-bash.os.mieweb.org` to port 3000.
- **Process manager**: systemd unit `artipod-sync` (source of truth: `deploy/artipod-sync.service`). Deploy with `npm ci && npm run build && sudo systemctl restart artipod-sync`; logs via `journalctl -u artipod-sync -f`.
- **Never run `npm run dev` here while the service is live**: `next dev` overwrites `.next`, so the running release build 500s on its own chunks and the page hangs at "Initializing FileSystem...". Recover with `npm run build && sudo systemctl restart artipod-sync`.
- **Implication**: Generated links, callbacks, and CORS/redirect origins should use the public HTTPS URL, not `localhost:3000`.

## HTML & CSS Guidelines
- **Tailwind CSS**: Use Tailwind CSS for styling. Prefer utility classes directly in JSX.
- **Conditional Classes**: Use `clsx` or `tailwind-merge` for conditional class names.
- **Semantic HTML**: Use semantic tags (`<main>`, `<section>`, `<article>`, etc.) instead of just `<div>` where appropriate, even when using Tailwind.
- **CSS Simplicity**: Avoid global CSS files. Use Tailwind configuration for theme customization.

## Accessibility (ARIA Labeling)

### 🎯 Interactive Elements
- **All interactive elements** (buttons, links, forms, dialogs) must include appropriate ARIA roles and labels
- **Use ARIA attributes**: Implement aria-label, aria-labelledby, and aria-describedby to provide clear, descriptive information for screen readers
- **Semantic HTML**: Use semantic HTML wherever possible to enhance accessibility

### 📢 Dynamic Content
- **Announce updates**: Ensure all dynamic content updates (modals, alerts, notifications) are announced to assistive technologies using aria-live regions
- **Maintain tab order**: Maintain logical tab order and keyboard navigation for all features
- **Visible focus**: Provide visible focus indicators for all interactive elements

## Internationalization (I18N)

### 🌍 Text and Language Support
- **Externalize text**: All user-facing text must be externalized for translation
- **Multiple languages**: Support multiple languages, including right-to-left (RTL) languages such as Arabic and Hebrew
- **Language selector**: Provide a language selector for users to choose their preferred language

### 🕐 Localization
- **Format localization**: Ensure date, time, number, and currency formats are localized based on user settings
- **UI compatibility**: Test UI layouts for text expansion and RTL compatibility
- **Unicode support**: Use Unicode throughout to support international character sets

## Documentation Preferences

### Diagrams and Visual Documentation
- **Always use Mermaid diagrams** instead of ASCII art for workflow diagrams, architecture diagrams, and flowcharts
- **Use memorable names** instead of single letters in diagrams (e.g., `Engine`, `Auth`, `Server` instead of `A`, `B`, `C`)
- Use appropriate Mermaid diagram types:
  - `graph TB` or `graph LR` for workflow architectures 
  - `flowchart TD` for process flows
  - `sequenceDiagram` for API interactions
  - `gitgraph` for branch/release strategies
- Include styling with `classDef` for better visual hierarchy
- Add descriptive comments and emojis sparingly for clarity

### Documentation Standards
- Keep documentation DRY (Don't Repeat Yourself) - reference other docs instead of duplicating
- Use clear cross-references between related documentation files
- Update the main architecture document when workflow structure changes

## Working with GitHub Actions Workflows

### Development Philosophy
- **Script-first approach**: All workflows should call scripts that can be run locally
- **Local development parity**: Developers should be able to run the exact same commands locally as CI runs
- **Simple workflows**: GitHub Actions should be thin wrappers around scripts, not contain complex logic
- **Easy debugging**: When CI fails, developers can reproduce the issue locally by running the same script

## Quick Reference

### 🪶 All Changes should be considered for Pull Request Philosophy

* **Smallest viable change**: Always make the smallest change that fully solves the problem.
* **Fewest files first**: Start with the minimal number of files required.
* **No sweeping edits**: Broad refactors or multi-module changes must be split or proposed as new components.
* **Isolated improvements**: If a change grows complex, extract it into a new function, module, or component instead of modifying multiple areas.
* **Direct requests only**: Large refactors or architectural shifts should only occur when explicitly requested.

### Code Quality Checklist
- [ ] **DRY**: No code duplication - extracted reusable functions?
- [ ] **KISS**: Simplest solution that works?
- [ ] **Minimal Changes**: Smallest viable change made for PR?
- [ ] **Naming**: Self-documenting function/variable names?
- [ ] **Size**: Functions small and focused?
- [ ] **Dead Code**: Removed or archived appropriately?
- [ ] **Accessibility**: ARIA labels and semantic HTML implemented?
- [ ] **I18N**: User-facing text externalized for translation?
- [ ] **Lint**: Run linter if appropriate
- [ ] **Test**: Run tests