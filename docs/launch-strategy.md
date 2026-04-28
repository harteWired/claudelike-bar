# Claudelike Bar — Launch Strategy

Testing, deployment, and outreach plan. Designed to be executed primarily through Claude Code automation.

---

## 1. Testing Strategy

### What We Have (v0.7.6)

| Layer | Coverage | Status |
|-------|----------|--------|
| Unit tests (vitest) | 33 tests — state machine, shell quoting, theme resolution | Green |
| CI (GitHub Actions) | Build + test + package on Ubuntu, macOS, Windows | Green |
| setup.sh smoke test | Ubuntu + macOS | Green |
| Manual testing | Devcontainer (Debian/WSL2) only | Done |

### What's Missing

**Tier 1 — Automate now (Claude Code can do these)**

| Test | Why | How to automate |
|------|-----|-----------------|
| Config round-trip | Verify JSONC write → read preserves comments, order, custom fields | vitest: write config, reload, assert fields survive |
| Hook script output | Verify `dashboard-status.sh` produces valid JSON for all event types | vitest or bash: pipe mock JSON stdin, assert output file contents |
| StatusWatcher parsing | Verify malformed JSON, missing fields, empty files don't crash | vitest: write bad files to temp dir, assert no throw |
| Edge-case terminal names | Spaces, unicode, quotes, empty string, very long names | vitest: create mock terminals with adversarial names, assert tiles render |

> **Action:** Ask Claude Code to run `/test-gen` against the current diff, then manually add the hook script tests.

**Tier 2 — Automate on CI (needs VS Code runtime)**

| Test | Why | How |
|------|-----|-----|
| Extension activation smoke | Confirms the extension loads in a real VS Code without crashing | `@vscode/test-electron` + `xvfb-run` on Linux CI runner |
| Terminal creation | Auto-start creates terminals with correct names | Extension integration test via `@vscode/test-electron` |

> **Action:** Add `@vscode/test-electron` as a devDependency. Write a single integration test that activates the extension and asserts the sidebar view is registered. Add to CI with `xvfb-run` on Ubuntu only (electron tests don't need the OS matrix).

**Tier 3 — Manual testing (needs humans)**

| Scenario | Why it can't be automated | Target tester |
|----------|--------------------------|---------------|
| macOS native (no container) | Need real macOS + VS Code + Claude Code subscription | Reddit/community volunteer |
| Windows + WSL | Path translation, `code` CLI in WSL | Reddit/community volunteer |
| GitHub Codespaces | Open VSX registry integration, no local setup | Anyone with a GitHub account |
| Remote SSH | Extension host timing, hook script PID assumptions | Power user with remote dev setup |
| Multiple workspaces | Multi-root workspace support (currently untested) | Power user |

> **Action:** Create a `TESTING.md` with a checklist for manual testers. Link it from the Reddit post. Make it easy — 5 steps, 2 minutes, "paste this output if it breaks."

---

## 2. Deployment Strategy

### Current State

| Channel | Status | URL |
|---------|--------|-----|
| GitHub | Published | github.com/harteWired/claudelike-bar |
| Open VSX | Published (v0.7.6) | open-vsx.org/extension/aes87/claudelike-bar |
| VS Code Marketplace | Not published | Requires Azure DevOps account |
| GitHub Pages demo | Live | harteWired.github.io/claudelike-bar |

### Release Pipeline (AI-native)

**Current process (manual):**
```
edit code → npm test → npm run package → npx ovsx publish → git push
```

**Target process (automated via Claude Code):**

1. **Pre-release checklist** — Claude Code runs `/review`, fixes findings, runs tests
2. **Version bump** — Claude bumps `package.json`, updates VSIX reference in devcontainer
3. **Publish** — Claude builds, packages, publishes to Open VSX via secrets-manager token
4. **Tag + release** — Claude creates a GitHub release with the VSIX attached and changelog
5. **Announce** — Claude drafts social posts (see Section 3)

> **Action:** Create a `/release` skill that automates steps 1-4. The skill reads the current version, asks for a bump type (patch/minor), runs tests, publishes, tags, and creates a GitHub release. All secrets come from secrets-manager.

**VS Code Marketplace (deferred)**

Not worth the Azure DevOps overhead until there's proven demand. Open VSX covers Codespaces, Gitpod, VSCodium, and Theia. Regular VS Code users can install from the VSIX (the README documents this). Revisit if the Reddit post generates >50 installs or someone explicitly asks for marketplace availability.

### GitHub Release Automation

Each version should have a GitHub Release with:
- The `.vsix` file attached (users can install directly)
- Auto-generated changelog from commit messages since last tag
- Link to the Open VSX listing

> **Action:** Add a `release` job to the CI workflow that triggers on version tags (`v*`). It builds the VSIX, creates a GitHub Release, attaches the artifact, and publishes to Open VSX. This replaces the manual `npx ovsx publish` step.

---

## 3. Social Media & Outreach Strategy

### Principle: AI-Native Content Pipeline

Every piece of content is drafted by Claude Code, reviewed by you, and posted manually (or via API where possible). The goal is to reduce the content creation bottleneck to a single approval step.

### Channels (ordered by expected ROI)

#### A. Reddit — r/ClaudeAI

**Why:** Highest concentration of Claude Code users. Posts about workflows and tools get strong engagement.

**Content plan:**

| Post | Timing | Type |
|------|--------|------|
| Launch post | Day 1 | "I built a VS Code sidebar for Claude Code terminals" — demo link, install link, call for testers |
| Follow-up post | Day 7-10 | "What I learned building a VS Code extension with Claude Code" — meta/process post, shows the AI-native workflow |
| Bug-fix post (if applicable) | After tester feedback | "You found bugs, I fixed them" — builds credibility, shows responsiveness |

> **Action:** Claude Code drafts each post in your writing voice (voice profile at `git-publishing/STYLE_GUIDE.md` Section 8.6). You review, tweak, paste into Reddit. Store drafts in `docs/outreach/`.

**Engagement automation:**
- Claude Code can monitor the post via the Reddit API (or manual copy-paste of comments) and draft replies
- `/prompt-master` can generate optimized titles for A/B consideration

#### B. X/Twitter

**Why:** Anthropic's team and Claude Code power users are active here. Retweets from `@AnthropicAI` or Claude Code devs would be significant.

**Content plan:**

| Post | Format |
|------|--------|
| Launch tweet | Screenshot/GIF of the sidebar + 2-line pitch + demo link |
| Thread | 4-5 tweets walking through features, ending with install link |
| Dev process tweet | "This extension was built almost entirely by Claude Code, including the tests and CI pipeline" — meta angle |

> **Action:** Claude Code generates tweet drafts. For the GIF/screenshot, take a screen recording of the sidebar in action (OBS or VS Code's built-in screen recorder) — Claude can't do this part, but can tell you exactly what to capture.

**Optimal timing:** Tuesday-Thursday, 9-11am PST (US tech audience peak).

#### C. Hacker News (Show HN)

**Why:** High visibility, credentialed audience. The demo page is strong enough to stand on its own.

**Risk:** HN can be hostile to "AI-generated" projects. Lead with the problem solved, not "Claude built this."

**Content plan:**

| Field | Content |
|-------|---------|
| Title | "Show HN: Claudelike Bar — sidebar dashboard for Claude Code terminals" |
| URL | `https://harteWired.github.io/claudelike-bar/` (demo page, not GitHub) |
| Comment | 3-4 sentences: what it does, why you built it, how to install, ask for feedback |

> **Action:** Claude drafts the comment. Post on a Tuesday or Wednesday morning. Don't mention AI authorship in the HN post — let the demo speak.

#### D. GitHub — Anthropic Ecosystem

**Why:** Claude Code's repo has Issues enabled. While a "Show and Tell" issue is a stretch, there are other angles.

**Options:**
- Open a **feature request** on `anthropics/claude-code` for "extension ecosystem" or "hook documentation" and reference Claudelike Bar as a working example
- Comment on existing issues about terminal management or multi-session workflows
- Open an issue on your own repo inviting contributions

#### E. Discord / Slack Communities

**Why:** Real-time engagement, good for collecting quick feedback.

**Targets:**
- AI-focused Discord servers (search for "Claude" or "AI coding" communities)
- VS Code community Discord
- Relevant Slack workspaces (if you're in any)

> **Action:** Claude drafts a short intro message for each community. Same core pitch, adapted for the audience.

### Content Templates

All drafts stored in `docs/outreach/` and generated by Claude Code on demand:

```
docs/outreach/
├── reddit-launch.md          # r/ClaudeAI launch post
├── reddit-followup.md        # Process/meta post
├── twitter-thread.md         # Launch thread
├── hackernews-comment.md     # Show HN comment
├── testing-callout.md        # "Help me test" message for communities
└── changelog-template.md     # Template for release announcements
```

> **Action:** Ask Claude Code to generate all of these in one shot, using your voice profile.

### Metrics to Track

| Metric | Source | Goal (30 days) |
|--------|--------|-----------------|
| Open VSX installs | open-vsx.org dashboard | 100+ |
| GitHub stars | github.com/harteWired/claudelike-bar | 50+ |
| GitHub issues (bug reports) | GitHub Issues | 5+ (means people are using it) |
| Reddit post upvotes | r/ClaudeAI | 50+ |
| Unique testers who report back | GitHub Issues / Reddit comments | 10+ |

### Feedback Loop (AI-Native)

1. **Tester reports bug** → GitHub Issue
2. **Claude Code triages** → reads the issue, reproduces if possible, drafts a fix
3. **You review** → approve or adjust
4. **Claude Code ships** → `/release` skill handles test → publish → tag → announce
5. **Claude Code drafts response** → reply to the issue with the fix version

The entire cycle from bug report to published fix can happen in a single Claude Code session.

---

## 4. Execution Timeline

| Day | Action | Owner |
|-----|--------|-------|
| 0 (today) | Generate all content drafts in `docs/outreach/` | Claude Code |
| 0 | Create `TESTING.md` with manual test checklist | Claude Code |
| 1 | Post to r/ClaudeAI | You (paste draft) |
| 1 | Post launch tweet + thread | You (paste draft) |
| 2-3 | Monitor Reddit/Twitter, reply to comments | Claude Code drafts, you post |
| 3-5 | Triage first bug reports, ship fixes | Claude Code + you |
| 7 | Post Show HN (if Reddit reception was positive) | You |
| 7-10 | Reddit follow-up post ("what I learned") | Claude Code drafts, you post |
| 14 | Assess metrics, decide on VS Code Marketplace | You |
| 14 | Create `/release` skill if shipping frequent fixes | Claude Code |
| 30 | Retrospective — what worked, what didn't | You + Claude Code |

---

## 5. AI-Native Tooling Summary

| Task | Tool | Automation Level |
|------|------|-----------------|
| Write tests | `/test-gen` skill | Full — generates tests from diff |
| Code review | `/review` skill | Full — 4 reviewers + judge |
| Content drafting | Claude Code + voice profile | Full — drafts in your voice |
| Prompt optimization | `/prompt-master` skill | Full — optimizes post titles |
| Release pipeline | `/release` skill (to build) | Full — test → publish → tag |
| Bug triage | Claude Code + GitHub Issues | Semi — drafts fix, you approve |
| Community replies | Claude Code | Semi — drafts reply, you post |
| Screenshots/GIFs | Manual (OBS / screen recorder) | Manual — Claude can't see your screen |
| Posting to Reddit/X/HN | Manual | Manual — no API access from container |
