# AI log

Record of agent mistakes caught before they shipped, and the fix that stops them recurring.
Newest first. One entry per incident.

Types: hallucination (invented API/fact) · wrong assumption (environment, requirements) ·
outdated knowledge (versions, deprecated APIs) · bug in generated code · scope creep · guardrail block

Caught by: me · test · CI · spec-reviewer · hook · code review

---

## 2026-11-25: Import commit bodies not wrapped at 72
- **Type:** bug in generated code
- **Task:** Merge three ITE183 repos into this monorepo with history, following the commit rule (subject ≤72, body wrapped at 72).
- **Agent claimed / did:** Built the merge messages for `c037e32`, `1822333` and `9f11c82` from a shell template, wrapping the text before `$repo`/`$prefix` were expanded. The expanded lines ran 81–110 chars.
- **Reality:** 4 body lines exceeded 72 chars. Confirmed by `git log -1 --format=%B` and by the new hook's checker over `git rev-list --first-parent main`.
- **Caught by:** spec-reviewer, after the push to `main`.
- **Fix:** None to history. Rewording would need a force push to `main`, and the commits were left as-is.
- **Systemic change:** Global git `commit-msg` hook (`~/.config/git/hooks/dispatch.py`, enabled via `core.hooksPath`). It rejects subjects over 72 chars, a missing blank line after the subject, and body lines over 72 chars (URL lines, trailers and indented blocks are exempt). It chains to repo-local hooks and has 17 pytest tests, including this exact message.
- **Lesson:** Check line widths on the final, expanded message. Templates hide the real length.
