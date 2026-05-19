# Virtual Office SaaS — Engineering Guidelines

Project context and phased build plan: `plan.html`.

Stack of record: Next.js + React + shadcn/ui (DOM layer), Phaser 4 (canvas layer),
Node + TypeScript (API + realtime), PostgreSQL (source of truth), LiveKit (media).
Art for V1: Kenney CC0 packs, 16×16, loaded through an asset manifest so a paid
32×32 pack can replace it without touching game code.

---

## 1. Core Principle

You are working on a real product, not a throwaway demo.

The goal is to build a production-minded virtual office that starts with a small V1 but can continuously evolve into a commercial, multi-tenant SaaS product used by other companies.

Prioritize:

1. Correctness
2. Simplicity
3. Maintainability
4. Security
5. Performance
6. Scalability where it is reasonably needed
7. Good UX
8. Small, focused changes

Do not optimize for the amount of code written or how quickly a task appears to be completed.

---

## 2. NEVER HALLUCINATE

This is one of the most important rules.

Never assume that a library, API, function, file, component, database table, environment variable, configuration, or existing behavior exists without verifying it.

Before making a change:

- Inspect the existing code.
- Search the repository.
- Check package versions.
- Check existing patterns.
- Read relevant configuration.
- Understand how the current implementation works.
- Verify external APIs/documentation when necessary.

If you are not sure about something, do not invent an answer. Instead:

> "I found X, but Y is unclear. Before I change this, I need to confirm Z."

Ask the developer when the uncertainty could affect architecture, security, data integrity, realtime behavior, or user experience.

A wrong confident implementation is worse than asking a question.

---

## 3. ASK QUESTIONS WHEN THERE IS REAL AMBIGUITY

Do not blindly implement an ambiguous requirement.

If there are multiple reasonable approaches and the choice materially affects the system, stop and ask.

Examples: two possible database designs; unclear ownership of data; unclear authorization behavior; unclear realtime behavior; unclear UX behavior; unclear third-party API behavior; unclear expected edge-case behavior; unclear performance requirement; unclear compatibility requirement.

When asking a question:

1. Explain the ambiguity briefly.
2. Give the recommended option.
3. Explain why.
4. Ask only what is necessary.

Do not ask unnecessary questions for trivial implementation details.

---

## 4. RESEARCH BEFORE MAKING IMPORTANT TECHNICAL DECISIONS

For non-trivial technical decisions, do not rely only on memory. Research current official documentation and reliable technical sources.

Especially research: framework APIs, library behavior, breaking changes, current package versions, WebRTC/LiveKit behavior, Socket.IO behavior, authentication/security behavior, database behavior, deployment infrastructure, browser compatibility, performance characteristics.

Prefer, in order: official documentation, official GitHub repositories and issues, primary technical sources, high-quality engineering references.

Do not blindly copy solutions from random blog posts or Stack Overflow.

If research changes the recommended approach, explain why.

---

## 5. THINK BEFORE WRITING CODE

1. **Understand** — inspect the relevant code and the current architecture.
2. **Plan** — what changes, what stays, which files are actually required, dependencies, edge cases, security implications, performance implications.
3. **Choose the simplest good architecture.** Do not immediately start coding.
4. **Implement** — the smallest clean change that solves the problem.
5. **Verify** — type checks, linter, tests, build, relevant manual checks. Then report what was verified.

---

## 6. DO NOT WRITE HUGE AMOUNTS OF CODE

Do not create abstractions that are not currently needed, large utility systems for one simple operation, generic frameworks inside the project, duplicate helpers, excessive configuration, unnecessary wrappers, unused interfaces, premature optimization, or complex state management when local state is enough.

Prefer the smallest clean implementation that solves today's requirement while keeping a sensible path for tomorrow.

A 100-line solution that is clear and correct is better than a 500-line "enterprise" solution that adds unnecessary complexity.

---

## 7. DO NOT OVER-ENGINEER

This project is intended to grow, but growth does not mean everything needs to be built today.

Do not introduce: microservices without a real reason; Kubernetes without a real need; distributed systems prematurely; Redis just because it is "scalable"; complex caching without a measured problem; event buses without a real requirement; multiple databases without a reason; sophisticated abstractions for hypothetical future requirements.

If V1 has one realtime server and 10 users, in-memory realtime state may be appropriate. Design the boundary so Redis can be introduced later. Do not build the entire distributed architecture before the product needs it.

---

## 8. ARCHITECT FOR EXTENSION, NOT FOR HYPOTHETICAL SCALE

"Future-proof" does NOT mean implementing future features now.

**Good:** multi-tenant database structure; clear module boundaries; shared API/realtime contracts; server-side authorization; configurable map/room data; replaceable realtime state storage; clean domain boundaries.

**Bad:** building billing before users need it; building enterprise SSO before customers require it; building Kubernetes before traffic requires it; building a complex office editor before the basic office works.

Build foundations, not future features.

---

## 9. ALWAYS CHECK EXISTING CODE BEFORE CREATING SOMETHING NEW

Before creating a component, hook, utility, service, API route, database model, type, helper, or configuration — search the repository first.

> Does something already exist that solves most of this?

Reuse existing project conventions. Do not introduce a second way of doing something the project already solves well.

---

## 10. DO NOT REWRITE WORKING CODE WITHOUT A REASON

If the existing implementation works, do not rewrite it because you prefer another style.

Only refactor for: a bug, a security problem, a performance issue, a maintainability problem, an architectural inconsistency, or a required feature that cannot reasonably be added otherwise.

Keep unrelated code untouched.

---

## 11. MINIMIZE THE BLAST RADIUS

Every task should change as little of the system as reasonably possible.

Before modifying a file: is this file actually required for this task?

Avoid unrelated formatting changes, unrelated refactoring, unnecessary API changes, unnecessary database structure changes, unnecessary dependency changes.

Small diffs are easier to review, debug and revert.

---

## 12. SECURITY IS NOT OPTIONAL

Treat security as part of the implementation, not a later phase.

Always consider: authentication, authorization, organization/tenant isolation, input validation, server-side permission checks, token handling, secrets, rate limiting, WebSocket authentication, media room authorization, database access, sensitive information exposure.

Never trust the client for authorization.

- **BAD:** Client says "I am an admin."
- **GOOD:** Server verifies authenticated user → organization membership → role → permission.

Never expose secrets to the browser.

---

## 13. MULTI-TENANCY IS A HARD SECURITY BOUNDARY

A user from Organization A must never be able to access Organization B's users, offices, rooms, realtime channels, media rooms, or private data.

Do not rely on IDs being difficult to guess. Authorization must be enforced server-side.

---

## 14. REALTIME CODE NEEDS EXTRA CARE

Before changing realtime code, consider: race conditions, duplicate connections, reconnects, disconnects, stale sockets, out-of-order events, message frequency, state synchronization, server authority, client prediction/interpolation, multiple tabs, network loss, server restart.

Do not assume "the event was sent, therefore everyone received it."

Design for failure.

---

## 15. DO NOT SEND HIGH-FREQUENCY DATA THROUGH REST

REST is for application operations. Realtime communication uses the realtime layer.

- **Bad:** repeated `POST /player/move`
- **Good:** Socket.IO → `PLAYER_MOVE`

Persistent state belongs in PostgreSQL. Ephemeral realtime state belongs in the realtime system.

---

## 16. DATABASE RULES

PostgreSQL is the source of truth for persistent data: users, organizations, memberships, offices, rooms, roles, settings, persistent configuration.

Do not continuously store transient player coordinates in PostgreSQL.

Avoid unnecessary database queries inside high-frequency realtime loops.

Use migrations. Use appropriate indexes. Think about data ownership before adding tables.

---

## 17. MAP / GAME ARCHITECTURE

The virtual office must not be hardcoded into game logic.

Separate **map data, room data, collision data, spawn points, interaction zones** from **Phaser rendering, movement, physics, realtime synchronization**.

Do not build the full office editor now, but do not make the current architecture impossible to extend into one later.

---

## 18. THIRD-PARTY SERVICES

Use managed infrastructure where it provides significant value: LiveKit for media/WebRTC, managed PostgreSQL, managed Redis when needed, a mature authentication provider.

Do not rebuild infrastructure that is not your product differentiator.

Spend engineering effort on the actual product experience: virtual world + presence + proximity communication + collaboration.

---

## 19. PERFORMANCE: MEASURE BEFORE OPTIMIZING

First make it correct. Then measure. Optimize based on CPU usage, memory, network traffic, realtime latency, render performance, database query performance, connection count, reconnect rate.

Do not introduce complicated optimization because you assume it might be necessary.

---

## 20. UX MATTERS AS MUCH AS TECHNICAL CORRECTNESS

A technically correct feature can still be a bad feature. After implementation, ask: is this understandable? does it feel responsive? what happens if something fails? is loading handled? is reconnect handled? are permissions clear? does the user know what is happening? does the interaction feel natural?

For the virtual office especially, the product should feel smooth and immediate.

---

## 21. ALWAYS HANDLE FAILURE STATES

Do not only implement the happy path.

- **Network:** success, loading, error, timeout, reconnect, permission denied, disconnected, retry
- **Realtime:** connected, connecting, disconnected, reconnecting, reconnected, authentication failed, server unavailable
- **Media:** permission granted, permission denied, device unavailable, connecting, connected, connection degraded, disconnected

---

## 22. TEST THE IMPORTANT PARTS

Do not write tests just to increase coverage numbers. Test behavior that can break the product.

Especially: authentication, authorization, tenant isolation, database operations, realtime event validation, presence, reconnect behavior, room entry/exit, proximity calculations, media authorization.

For the realtime system, test failure scenarios, not only successful ones.

---

## 23. BEFORE INSTALLING A DEPENDENCY

1. Do we actually need it?
2. Does the project already have something that solves this?
3. Is the dependency maintained?
4. Is it compatible with our current versions?
5. Does it introduce security or bundle-size concerns?
6. Could this be implemented simply without another dependency?

Do not add packages casually.

---

## 24. VERSION / API VERIFICATION

Never assume an API works because you remember it from another version.

Before using a library API: check the installed version, check official documentation, check the current API, check breaking changes.

If the documentation conflicts with your assumption, trust the documentation.

---

## 25. GIT DISCIPLINE

Before finishing: check `git diff`, check changed files, remove debug code, remove unused imports, remove temporary files, ensure no secrets were added, make sure unrelated files were not modified.

Use clear commit messages when asked to commit. Never commit generated secrets, environment files or credentials.

---

## 26. DO NOT HIDE PROBLEMS

If something failed, say so.

Do not claim "Done." when you did not verify it. Do not claim "Tests pass." unless you actually ran them. Do not hide warnings. Do not silently work around errors.

Report: what changed, what was tested, what was not tested, known limitations, any remaining uncertainty.

---

## 27. WHEN SOMETHING IS BROKEN, FIND THE ROOT CAUSE

Observe → reproduce → inspect → identify root cause → choose smallest correct fix → implement → verify.

Never: error → random code changes → more errors → more patches.

---

## 28. DO NOT MAKE ARCHITECTURAL DECISIONS SILENTLY

If a task requires an important architectural decision, explain it before or while implementing.

Examples: changing database ownership, changing realtime protocol, introducing Redis, changing authentication, changing media architecture, adding a major dependency, changing tenant boundaries.

Prefer: "I recommend X because Y. I will implement X unless there is a constraint against it."

If the choice is genuinely ambiguous, ask first.

---

## 29. USE THE EXISTING STACK

Do not introduce a new framework or technology because it is trendy. Prefer the project's established stack unless there is a concrete technical reason to change it.

Consistency is valuable.

---

## 30. OUTPUT FORMAT AFTER A TASK

Provide a concise summary:

**Changed** — what was implemented.
**Why** — the architectural/technical reasoning.
**Verification** — tests/checks/build performed.
**Important notes** — limitations, assumptions, follow-up work.

Do not write a huge essay unless requested.

---

## 31. WHEN ASKED TO "BUILD A FEATURE"

Do not immediately generate code. First: inspect relevant code → identify existing architecture → determine the smallest correct implementation → identify ambiguities → research if required → explain the implementation plan briefly → implement → test → review the final diff.

---

## 32. WHEN THE USER'S REQUEST CONFLICTS WITH GOOD ENGINEERING

Do not blindly follow a technically harmful instruction. Explain: "That approach will work, but I recommend X because Y." Then propose the safer/simpler approach.

The goal is not to obey the first implementation idea. The goal is to produce the best solution to the underlying problem.

---

## 33. PRIORITY ORDER

Correctness → Security → User experience → Maintainability → Performance → Scalability → Developer convenience.

Do not sacrifice correctness or security merely to make implementation faster.

---

## 34. THE VIRTUAL OFFICE PRODUCT PRINCIPLE

The core product is not "a website with a Phaser map." It is "a virtual place where a team can naturally work together."

Prioritize: smooth movement, reliable presence, low-latency realtime state, natural proximity communication, reliable meetings, fast reconnects, clear communication status, simple UX.

Every feature should improve the team's experience.

---

## 35. SUPPLY-CHAIN SAFETY — VERIFY BEFORE RUNNING ANYTHING EXTERNAL

Never run third-party code — an npm package, a GitHub repository, a model, a script, an asset bundle — without inspecting it first. Assume nothing external is safe until checked.

**Before `npm install` of any new package:**

- Confirm the exact package name against the official docs. Typosquatting is the most common attack.
- Check it exists on npm with real download volume, a linked repository, and a recent publish date.
- Inspect `scripts` in its `package.json` for `preinstall` / `install` / `postinstall`. Lifecycle scripts are the primary execution vector — a package that runs a script on install needs a specific reason.
- Prefer `npm ci` against a committed lockfile. Never install unpinned.
- Run `npm audit` after adding anything.

**Before running any GitHub repository:**

- Read the README, `package.json`, and every install or setup script end to end before executing.
- Check stars, last commit date, open issues, and whether the repo is a fork of something more established.
- Look for obfuscated code, long base64 or hex blobs, minified files in a source tree, and unexpected network calls in build or install steps.
- Look for anything reading `~/.ssh`, `~/.aws`, `.env` files, keychain, browser profiles, or shell history.

**Never:**

- Pipe a remote script into a shell (`curl … | bash`). Download it, read it, then run it.
- Run anything with `sudo` that has not been read in full.
- Execute a binary or model artifact from an unverified source.
- Disable the sandbox to make an unfamiliar command work.

**Assets and models:** verify file types match their extensions. Image packs should contain only images — a script or executable inside an art bundle is a red flag. Prefer well-known distributors with a public track record.

**If anything looks wrong, stop and report it. Do not run it to find out.**

---

## 36. PHASE GATE — MOVE TO THE NEXT PHASE WITHOUT ASKING

Work through the phases in `plan.html` continuously. Do not ask permission to
start the next one.

**After finishing a phase, run `pnpm verify`.** It is the gate, and it is
mechanical so it cannot be done inconsistently or from memory:

| check                             | why it gates                                    |
| --------------------------------- | ----------------------------------------------- |
| typecheck, all packages           | a type error is a bug that has not happened yet |
| lint                              | catches the class of mistake review misses      |
| format                            | keeps diffs about content                       |
| unit + integration tests          | the behaviour that can break the product        |
| browser end-to-end tests          | a canvas that renders nothing still "loads"     |
| production build                  | dev-only success is not success                 |
| migrations from an empty database | proves a new environment can be created         |
| server boot + health              | proves the thing actually runs                  |

**Green → start the next phase immediately.** Do not wait, do not summarise and
pause, do not ask.

**Red → fix the current phase.** Do not begin the next one with a failing gate.
A failure is never "unrelated" — investigate before deciding it is noise.

**Do not stop to report after each phase.** A green gate is not a checkpoint to
hand back at — it is permission to keep going. Run the gate, then start the
next phase in the same turn. Keep going until you hit something in "When to
stop and ask" below, or until there are no phases left.

**Report once, when you actually stop.** Cover every phase completed since the
last report, in the format of §30, including anything that broke and what it
taught. Do not narrate progress between phases, and do not summarise a phase
just because it finished.

### When to stop and ask

Stop only when you genuinely cannot proceed:

- **A credential or account is needed** — LiveKit keys, an S3 bucket, a Stripe
  account, a domain. Build everything up to that boundary first, then stop.
- **A decision is the owner's to make** — pricing, product scope, a trade-off
  with no technically correct answer.
- **An action is destructive or outward-facing** — deleting data, publishing,
  sending anything to a third party.
- **The gate cannot be made green** and the cause is a genuine ambiguity in
  what was asked, not a bug to fix.

Anything else — a failing test, a wrong version pin, a bad architectural
choice, a broken migration — is work, not a question. Do it.

---

## 37. FINAL RULE

Before writing code, ask:

> "What is the simplest, cleanest, safest and most maintainable way to solve this problem with the architecture we already have?"

Then:

> "Am I assuming anything that I have not verified?"

Then:

> "Could this introduce a security, data, realtime or scalability problem?"

Then implement the smallest good solution.

**Do not optimize for writing more code. Optimize for building the right system.**
