# Product

<!-- impeccable:product-schema 1 -->

## Platform

macOS desktop application built with Electron, with the original EDICT dashboard
and local Python runtime embedded for offline-first orchestration.

## Users

Individuals and small teams who want a desktop multi-agent workstation for
planning, coding, document production, testing, and project delivery.

## Product Purpose

Turn the EDICT three-provinces/six-ministries workflow into a usable desktop
workstation: receive a decree, route it through the existing agents, produce
project artifacts, and keep the work scoped to an explicit workspace and
project.

## Positioning

Edict_InnerCourt is a desktop wrapper and operational improvement of EDICT. The
desktop shell, first-run setup, workspace boundary, settings, execution tools,
and record management are additions around the original multi-agent core; they
do not replace that core.

## Operating Context

The application can receive work from the desktop workbench and, where
configured, external channels such as Feishu, Telegram, Discord, Slack, or
Signal. A user must choose or create a workspace directory before work begins.
Provider, model, and channel configuration belongs in Settings, not in the
workspace creation flow.

## Capabilities and Constraints

- A workspace is a required operating boundary.
- The first project defaults to the selected workspace directory; additional
  project directories can be associated with the workspace as the product grows.
- Workspaces are isolated by default. Memory and agent context are shared only
  when explicitly configured inside the active workspace.
- Formal tasks preserve the exact EDICT chain: 皇上 → 太子 → 中书省 → 门下省
  → 尚书省 → 六部 → 回奏.
- Simple progress questions may be answered directly by 太子, while formal work
  continues through the full chain.
- Writes, commands, commits, pushes, publishing, and deletion remain approval-
  aware operations.

## Brand Commitments

The interface should feel like a focused command workstation: quiet dark
surfaces, clear state, restrained imperial ink/gold accents, and strong
operational feedback. It must make the current workspace, project, task stage,
agent responsibility, approval state, and produced artifacts legible at a glance.

## Evidence on Hand

The current implementation already contains the EDICT task board, court
discussion, 御书房, model/provider settings, skills/MCP settings, external
channel settings, task scheduler, and a bundled runtime. The next product slice
is the required workspace-first entry and the new workbench shell around these
existing capabilities.

## Product Principles

1. Preserve the EDICT workflow and terminology where it is the product’s core.
2. Make the work boundary explicit before allowing execution.
3. Put provider, model, channel, skill, and MCP choices in Settings so they can
   be reused across workspaces without making workspace creation cumbersome.
4. Prefer a small number of reliable paths that produce files, code, tests,
   plans, and deliverables over decorative or secondary features.
5. Keep background execution recoverable and make destructive or externally
   visible actions explicit.

## Accessibility & Inclusion

Use semantic controls, visible focus states, keyboard-accessible forms, readable
contrast, concise status text, and explicit empty/error/loading states. Do not
depend on emoji alone to convey state or action.
