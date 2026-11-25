# ITE183 Monorepo — Design

Date: 2026-11-25 · Status: approved

## Intent
College activities for ITE183 are scattered across separate GitHub repos.
Consolidate them into one `MirkoLouis/ITE183` repo with one folder per
activity (plain directories, same shape as `MirkoLouis/ITD105`), so the
profile separates school work from passion projects.

## Goals
- One public repo `ITE183`, default branch `main`.
- Each existing ITE183 repo lands in its own folder with its full commit history.
- README index of all lab activities, including group work hosted elsewhere.
- Original repos stay reachable but clearly marked as moved.

## Non-goals
- Other courses (ITD110 is next, designed separately using this as the template).
- Restructuring `~/Documents/ITE183` (left untouched).
- Changing any project code.

## Anti-goals
- Losing commit history of the merged repos.
- Committing `node_modules/` or other generated files.
- Deleting the original repos (links already submitted to instructors must keep working).

## Approaches considered
| Approach | Trade-off | Decision |
|---|---|---|
| `git subtree add` | Keeps full history; result is plain folders | **Chosen**, then refined (below) |
| filter-repo `--to-subdirectory-filter` + `merge --allow-unrelated-histories` | Same subtree-style merge, but history paths live under the folder | **Used in execution** |

Execution ruling: plain `git subtree add` leaves imported commits at
root-level paths, so `git log -- <folder>` and GitHub file history showed
only the merge commit. Rewriting each source into its folder first keeps
the approved promise "history works per folder". Imported commit SHAs
differ from the originals; authors and dates are unchanged.
| Plain copy, one commit | Simplest; loses history | Rejected |
| git submodules | Folders are pointers (`folder @ sha`); originals must stay live; doesn't match ITD105 | Rejected |

## Layout
```
ITE183/
├── README.md                    index table
├── .gitignore                   node_modules/ and common artifacts
├── docs/superpowers/specs/      this design
├── lab1-http-server/            subtree ← MirkoLouis/my-bsl-http-server @ master
├── lab2-websocket/              subtree ← MirkoLouis/ITE183_Lab2_Websocket @ main
├── lab4-mmorpg/                 local ~/Documents/ITE183/MMORPG (new commit, no prior history)
└── extra-bonezegei-get-request/ subtree ← MirkoLouis/Overcomplicating-Bonezgei-Get-Request @ main
```

README index rows:
| # | Activity | Work | Location |
|---|---|---|---|
| Lab 1 | HTTP server using sockets | Solo | `lab1-http-server/` |
| Lab 2 | WebSocket server | Solo | `lab2-websocket/` |
| Lab 3 | Google OAuth & WebRTC video call | Group | https://github.com/Jevoel16/ITE183_Lab3_Google-OAuth-and-WebRTC--videocall- |
| Lab 4 | MMORPG | Group activity, done solo | `lab4-mmorpg/` |
| Extra | Overcomplicating a Bonezegei GET request | Solo | `extra-bonezegei-get-request/` |

## Decisions
- Subtrees are pulled from GitHub remotes, not local clones (local Lab 1 is 1 commit behind origin).
- Built at `~/Documents/ITE183-monorepo`.
- After ITE183 is pushed: each original repo gets a README commit pointing to
  `ITE183/<folder>`, then is archived (read-only, reversible).
- Every `git push` and every archive call gets per-action user approval.

## Left to the builder
- Exact `.gitignore` entries (based on what MMORPG/ contains).
- README prose beyond the index table.
