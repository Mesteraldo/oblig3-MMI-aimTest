# AGENTS.md

This repo is deployed to the family home server (Dokploy, later behind Cloudflare Tunnel). Instructions
for any coding agent working here.

## Platform rules

Follow the `hjemmeserver` skill: `git clone https://github.com/nerdegutt/hjemmeserver-skill ~/.claude/skills/hjemmeserver`
(private; ask Erlend for access), update with `git -C ~/.claude/skills/hjemmeserver pull`.
If your agent cannot load skills, read its `SKILL.md` directly. Not Erlend? Read its `references/member.md`.
The short version:

- Never read or print secrets. Config comes from environment variables; names go in `.env.example`.
- Ask the human before deploying, restarting or changing anything on the server.
- A push to `main` deploys to production (once the tunnel exists). Keep `main` working.
- Don't open ports, publish databases, mount the Docker socket or use `latest` tags.
- Never write environment variables in Dokploy; the human does that.

## This app

- **Owner:** jesper
- **Dokploy:** application `aimtest` in project `jesper`, environment `production`
- **URL:** https://aimtest.esper.no (admin: https://aimtest.esper.no/admin)
- **Family-only (Cloudflare Access):** no – public. `/admin` is protected by `ADMIN_PASSWORD` (HTTP Basic auth)
- **Database:** none. JSON files in volume `jesper-aimtest-data` mounted at `/data`
  (`venter/` = waiting for approval, `godkjent/` = approved, `avvist/` = rejected). Never change that mount.
- **Run locally:** `ADMIN_PASSWORD=test npm start` · tests: `npm test`
- **Migrations:** none
- **Scheduled jobs:** none

## Contract

Dockerfile in root · listens on `$PORT` (default 3000) · `GET /healthz` → 200 with a Dockerfile
`HEALTHCHECK` · logs to stdout · non-root user · no important files on the container filesystem ·
`.env` and `.env.*` in `.dockerignore`.
