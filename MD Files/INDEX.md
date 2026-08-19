# Streamify Documentation Index

Last reviewed: 2026-08-16

This directory contains internal project documentation. Critical public-facing
documents stay at the repository root so GitHub, contributors, and deployment
tools can find them in their conventional locations.

## Critical Root Documents

| Document | Purpose |
|---|---|
| [`README.md`](../README.md) | Project overview, installation, features, and basic troubleshooting |
| [`DEPLOYMENT.md`](../DEPLOYMENT.md) | Desktop, LAN, HTTPS, tunnel, and phone deployment guide |
| [`CHANGELOG.md`](../CHANGELOG.md) | Historical release notes and legacy roadmap |

## Internal Documentation

### Engineering

| Document | Purpose |
|---|---|
| [`Engineering/PROJECT_AUDIT.md`](Engineering/PROJECT_AUDIT.md) | Current source of truth for findings, completed fixes, risks, and future work |
| [`Engineering/POLISHING_UPDATE.md`](Engineering/POLISHING_UPDATE.md) | Complete 2026-08-15 polishing implementation record and manual verification checklist |
| [`Engineering/SMART_AUTO_ENRICH_UPDATE.md`](Engineering/SMART_AUTO_ENRICH_UPDATE.md) | Smart Auto Enrich matching, AcoustID, canonical metadata, job workflow, tests, and verification |
| [`Engineering/DISCORD_RPC.md`](Engineering/DISCORD_RPC.md) | Discord Rich Presence: IPC transport, artwork resolution, `cover_source_url`, privacy and failure modes |
| [`Engineering/PLAYER_TRANSITION_PERFORMANCE.md`](Engineering/PLAYER_TRANSITION_PERFORMANCE.md) | Retained desktop player, FLIP shell motion, lyrics scheduling, startup optimizations, memory tradeoff, and Liquid Glass performance contract |
| [`Engineering/FINDINGS.md`](Engineering/FINDINGS.md) | Desktop and mobile conversion findings captured during the Electron work |
| [`Engineering/RELEASING.md`](Engineering/RELEASING.md) | How to cut a GitHub release that installed copies auto-update from: required assets, the draft flow, and failure modes |

### History

| Document | Purpose |
|---|---|
| [`History/MIGRATION_REPORT.md`](History/MIGRATION_REPORT.md) | Historical social-app to personal-player migration report |

## Directory Layout

```text
MD Files/
|-- INDEX.md
|-- Engineering/
|   |-- DISCORD_RPC.md
|   |-- FINDINGS.md
|   |-- PLAYER_TRANSITION_PERFORMANCE.md
|   |-- POLISHING_UPDATE.md
|   |-- RELEASING.md
|   |-- SMART_AUTO_ENRICH_UPDATE.md
|   `-- PROJECT_AUDIT.md
`-- History/
    `-- MIGRATION_REPORT.md
```

## Document Authority

Use `PROJECT_AUDIT.md` for current engineering status. `FINDINGS.md`,
`MIGRATION_REPORT.md`, and older changelog entries are historical snapshots and
may mention paths, scripts, features, or assumptions that have since changed.

When behavior changes:

1. Update the root README if users are affected.
2. Update DEPLOYMENT.md if setup or networking changes.
3. Add a changelog entry for a release.
4. Update PROJECT_AUDIT.md with the engineering reason and verification status.
