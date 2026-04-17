# GitHub Copilot instructions

Prefer the canonical agent guide in [`../AGENTS.md`](../AGENTS.md).

Repo-specific usage facts:

- The public browser API is `window.VirtualGridTable`.
- Instances are created with a container id string, not an element.
- The implementation lives in `/app.js`.
- There is no TypeScript support yet.
- The table virtualizes rows, not columns.
- Chunked mode providers must apply incoming search, sort, and column filter state themselves.
