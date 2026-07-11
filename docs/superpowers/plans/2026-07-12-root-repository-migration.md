# Channel Gateway Root Repository Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the complete `channel-gateway` source and Git history to the parent repository root while retaining `upstream-openclaw` as a pinned submodule.

**Architecture:** Import `channel-gateway/main` into the parent object database and make it the primary tree. Connect the old parent history with an `ours` merge so both histories remain reachable, then add only the upstream gitlink and `.gitmodules` entry to the new root tree.

**Tech Stack:** Git branches, bundles, unrelated-history merge, gitlink/submodule metadata, existing Node.js project verification commands.

---

### Task 1: Capture a reversible migration baseline

**Files:**
- Create: `.git/migration-backups/parent-before-root-migration.bundle`
- Create: `.git/migration-backups/channel-gateway-before-root-migration.bundle`

- [ ] **Step 1: Verify both repositories are safe to migrate**

Run:

```bash
git status --short --branch
git -C channel-gateway status --short --branch
git -C upstream-openclaw status --short --branch
```

Expected: the parent contains only the previously staged `.gitmodules`; `channel-gateway` contains only this committed plan lineage; `upstream-openclaw` is clean.

- [ ] **Step 2: Create recovery bundles**

Run:

```bash
mkdir -p .git/migration-backups
git bundle create .git/migration-backups/parent-before-root-migration.bundle --all
git -C channel-gateway bundle create ../.git/migration-backups/channel-gateway-before-root-migration.bundle --all
git bundle verify .git/migration-backups/parent-before-root-migration.bundle
git bundle verify .git/migration-backups/channel-gateway-before-root-migration.bundle
```

Expected: both bundles report that they are okay and contain complete histories.

- [ ] **Step 3: Record immutable archive refs**

Run:

```bash
git branch archive/pre-root-migration HEAD
git fetch ./channel-gateway main:refs/heads/import/channel-gateway-main
```

Expected: `archive/pre-root-migration` points at the old parent HEAD and `import/channel-gateway-main` points at the current child HEAD.

### Task 2: Build the integrated root history

**Files:**
- Modify: repository branch topology
- Create: `.gitmodules`
- Add gitlink: `upstream-openclaw`

- [ ] **Step 1: Create an isolated integration worktree**

Run:

```bash
rm -rf .omx/root-migration-worktree
git worktree add -b migration/channel-gateway-root .omx/root-migration-worktree import/channel-gateway-main
```

Expected: the worktree root contains the Channel Gateway project files directly.

- [ ] **Step 2: Connect the old parent history without changing the source tree**

Run inside `.omx/root-migration-worktree`:

```bash
git merge --allow-unrelated-histories -s ours --no-edit archive/pre-root-migration
```

Expected: a merge commit with both the imported child history and old parent history as parents; the working tree remains identical to imported Channel Gateway source.

- [ ] **Step 3: Add the upstream submodule metadata and pinned gitlink**

Run inside `.omx/root-migration-worktree`:

```bash
git config -f .gitmodules submodule.upstream-openclaw.path upstream-openclaw
git config -f .gitmodules submodule.upstream-openclaw.url https://github.com/openclaw/openclaw.git
git update-index --add --cacheinfo 160000,eefe2e8837a74c7443a9915b1d593de7e806bafa,upstream-openclaw
git add .gitmodules
git commit
```

Commit intent and trailers:

```text
Make the published repository expose the real gateway source

The former parent tree stored Channel Gateway as a gitlink, which hid the
actual implementation from GitHub. Use the existing source history as the
primary lineage and retain OpenClaw only as an upstream reference.

Constraint: Preserve both pre-migration histories and the pinned upstream revision
Rejected: Copy the nested files | loses authorship and file history
Rejected: Keep Channel Gateway as a submodule | does not publish the real source tree
Confidence: high
Scope-risk: broad
Reversibility: clean
Directive: Do not remove archive/pre-root-migration until the remote branch is verified
Tested: Git ancestry, tree shape, submodule metadata, and project verification commands
Not-tested: Remote GitHub checkout until push is explicitly requested
```

### Task 3: Activate the integrated history in the current workspace

**Files:**
- Replace gitlink: `channel-gateway`
- Populate: repository root with Channel Gateway source
- Retain gitlink: `upstream-openclaw`

- [ ] **Step 1: Move the nested repository aside as an ignored safety copy**

Run:

```bash
mkdir -p .omx/migration-backups
mv channel-gateway .omx/migration-backups/channel-gateway-repository
git reset HEAD -- .gitmodules
rm -f .gitmodules
```

Expected: the nested repository remains recoverable under `.omx/`, and the old parent worktree has no staged migration file.

- [ ] **Step 2: Fast-forward the parent main ref to the integration result**

Run:

```bash
git merge --ff-only migration/channel-gateway-root
```

Expected: `main` points at the integrated history and the project source is present at the repository root.

- [ ] **Step 3: Re-register the existing upstream worktree**

Run:

```bash
git submodule init -- upstream-openclaw
git submodule sync -- upstream-openclaw
```

Expected: `git submodule status -- upstream-openclaw` reports commit `eefe2e8` without a leading `-`.

### Task 4: Verify history, structure, and project behavior

**Files:**
- Modify only if required: `.gitignore`

- [ ] **Step 1: Verify repository structure and ancestry**

Run:

```bash
test "$(git ls-files --stage channel-gateway | wc -l | tr -d ' ')" = 0
test "$(git ls-files --stage upstream-openclaw | awk '{print $1}')" = 160000
git merge-base --is-ancestor 04e594be780475c88ec64eb847f90c4e081b12db HEAD
git merge-base --is-ancestor archive/pre-root-migration HEAD
git config -f .gitmodules --get submodule.upstream-openclaw.url
git diff --check
```

Expected: all commands succeed and the configured URL is `https://github.com/openclaw/openclaw.git`.

- [ ] **Step 2: Run the project verification gates**

Run the commands declared by `package.json`, prioritizing the established gate:

```bash
npm run check
```

Expected: lint/typecheck/tests used by the project finish successfully. If `check` does not cover all declared gates, run the missing lint, typecheck, and test scripts separately.

- [ ] **Step 3: Confirm final cleanliness and record exact remote state**

Run:

```bash
git status --short --branch
git log --oneline --decorate --graph -12
git remote -v
```

Expected: the tracked tree is clean; `main` contains both histories; no push is performed during this plan.
