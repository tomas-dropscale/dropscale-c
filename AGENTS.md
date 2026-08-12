<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Dropscale production workflow

- This is the canonical production repository: `/home/degendad/dev/projects/dropscale-c`, remote `https://github.com/tomas-dropscale/dropscale-c.git`.
- `/home/degendad/dev/projects/dropscale` is a different repository. Do not implement the production audit/admin UI there merely because both projects reference the Worker name `dropscale-da`.
- Before editing, verify the remote, switch to `main`, inspect the worktree, and run `git pull --ff-only origin main`.
- Preserve unrelated modifications and untracked files. Never reset, discard, overwrite, or silently stash user work.
- When the user explicitly requests implementation/publication, work directly on `main`, commit, and push `origin main`. Do not create a feature branch unless explicitly requested.
- Run tests, typecheck, lint, and build in proportion to the change. This project requires Node 22 or newer.
- A push to `main` deploys through the existing Cloudflare Workers Builds integration. It is not a GitHub Actions workflow.
- Do not run `wrangler login`, open OAuth, or invent a manual deployment for the normal workflow. Wait for and verify the `Workers Builds: dropscale-da` check tied to the pushed SHA.
- Existing protected access is stored at `/home/degendad/.cloudflare/dropscale-c.env` and `/home/degendad/.supabase/access-token`. Never print or commit their values; normal Git-triggered deployment does not require them.
- Do not report the change as live until the Cloudflare check succeeds and the production version is verified. Compare screenshot time with deployment completion time before diagnosing a stale UI.
- For the complete reusable runbook, use the global `dropscale-deploy` skill.
