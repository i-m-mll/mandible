import type { LedgerIssueKind, LedgerIssueResolution } from "./types.js";

export const REVIEWED_RESOLUTION_MIGRATION_SCHEMA = "mandible-resolution-review@1" as const;

export interface ReviewedResolutionMigrationRecord {
  readonly id: string;
  readonly project_key: string;
  readonly short_id: string;
  readonly resolution: LedgerIssueResolution;
  readonly confidence: string;
  readonly rationale: string;
  readonly evidence: readonly {
    readonly source: string;
    readonly quote_or_summary: string;
  }[];
  readonly observed_status: string;
  readonly observed_resolution: string | null;
  readonly observed_updated_at: number;
  readonly observed_kind: LedgerIssueKind | null;
}

export interface ReviewedKindMigrationRecord {
  readonly id: string;
  readonly project_key: string;
  readonly short_id: string;
  readonly kind: LedgerIssueKind;
  readonly confidence: string;
  readonly rationale: string;
  readonly evidence: readonly {
    readonly source: string;
    readonly quote_or_summary: string;
  }[];
  readonly observed_status: string;
  readonly observed_resolution: string | null;
  readonly observed_updated_at: number;
  readonly observed_kind: string;
  readonly observed_labels: readonly string[];
}

/**
 * User-authorized issue-by-issue decisions for the v183 closed-null repair.
 * The migration joins by full issue id and project key, retains this
 * provenance in issue history, and refuses any closed-null row not covered by
 * an exact record.
 */
export const REVIEWED_RESOLUTION_MIGRATION_DATA: readonly ReviewedResolutionMigrationRecord[] = [
  {
    "id": "4fa6c202e43706af6fb4b47e931e135c36e62ae43b0e2086b8df1ff9c2bb29db",
    "project_key": "bbooddyy",
    "short_id": "4fa6c20",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested monitoring guidance is present in the repository instructions, and repository history contains the implementation and merge commits.",
    "evidence": [
      {
        "source": "git history bbooddyy",
        "quote_or_summary": "b89ef60 adds Remote Run Monitoring guidelines and 3051086 merges them into the branch."
      },
      {
        "source": "bbooddyy/AGENTS.md",
        "quote_or_summary": "The current instructions contain titrated attention, error-first checking, and graduated relaxation guidance."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812904293,
    "observed_kind": null
  },
  {
    "id": "eda2b182bf0d3438e923d6b7063127a9e79abc3d82f407e409cd6e97eb20c862",
    "project_key": "bbooddyy",
    "short_id": "eda2b18",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested training configuration was implemented and the linked protected merge completed successfully.",
    "evidence": [
      {
        "source": "git history bbooddyy",
        "quote_or_summary": "3018208 implements PPOConfig defaults and 8240c94 merges the training hyperparameter fix into main."
      },
      {
        "source": "mandible issue report bbooddyy/eda2b18",
        "quote_or_summary": "The linked auth request for feature/fix-training-hyperparams is completed with exit_code 0."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812904083,
    "observed_kind": null
  },
  {
    "id": "0a6b4cf0f320808d83ebc38e7ff8a86522162945672f112122023e84b46dd6dd",
    "project_key": "dotfiles",
    "short_id": "0a6b4cf",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The canonical issue CLI guidance requested by the record is present in the generated global instructions.",
    "evidence": [
      {
        "source": "dotfiles/.config/claude/CLAUDE.md",
        "quote_or_summary": "The issue-tracking section says mandible issue is canonical and lists mandible issue new/list/show/comment/label commands."
      },
      {
        "source": "git history dotfiles",
        "quote_or_summary": "8772818 and later instruction-refresh commits carry the canonical mandible issue command block."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812862106,
    "observed_kind": null
  },
  {
    "id": "12aa6981f500cd9f3ff136276abab666fee36a20d68d50226c77690cbdd80397",
    "project_key": "dotfiles",
    "short_id": "12aa698",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The post-merge hook debounce was implemented in a focused commit and was included in the completed CP fixes batch.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "d80a693 is titled Add debounce to post-merge hook daemon restart."
      },
      {
        "source": "mandible issue report dotfiles/7b45fe4",
        "quote_or_summary": "The completed auth request CP fixes batch explicitly includes hook debounce and exited successfully."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "212ed6605407c6e0a6de5a97784230848e17a7eb0f2ada952aadebd1ff5a18a1",
    "project_key": "dotfiles",
    "short_id": "212ed66",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested insertion guard and reconcile cleanup were implemented in the conversation ingestion service.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "2e8256d is titled Add hard zero-block insertion guard and improve reconcile cleanup in conversations ingestion."
      },
      {
        "source": "mandible issue report dotfiles/212ed66",
        "quote_or_summary": "The issue body specifies the same insertion guard and one-time cleanup scope."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "27d344d71c033850de033a138996ae839994d5bac1098e517d2f442065ea31fa",
    "project_key": "dotfiles",
    "short_id": "27d344d",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested conventions are present across the targeted project instruction files, including PEP 8, uv, Equinox, JAX tree, and jax_cookbook guidance.",
    "evidence": [
      {
        "source": "project instruction files",
        "quote_or_summary": "Current jax-cookbook, Feedbax, RNNs robust policies, Robustness, bbooddyy, and rlrmp instructions contain the requested Python/JAX conventions."
      },
      {
        "source": "mandible issue report dotfiles/27d344d",
        "quote_or_summary": "The record identifies this as the external-repository CLAUDE.md migration partition; the requested guidance is materially present in those repositories."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "3862a0bbf847f3bbb834a61937c9be286a031cbcab46be6625ae38bc0209bec6",
    "project_key": "dotfiles",
    "short_id": "3862a0b",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Both pane scripts were changed to check the setting and the linked auth merge completed successfully.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "1718fc9 is titled Check subagent_panes_enabled in codex-pane and claude-pane scripts."
      },
      {
        "source": "mandible issue report dotfiles/3862a0b",
        "quote_or_summary": "The linked auth request for feature/fix-pane-setting-check is completed with exit_code 0."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851490,
    "observed_kind": null
  },
  {
    "id": "4315ebecdb6a7ae92d16a15b5564c833d1aead2762fc6fcff77bb9f82438965e",
    "project_key": "dotfiles",
    "short_id": "4315ebe",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested migration, typed setting helpers, and dual-write implementation are present in repository history.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "caf2348 is titled Add DB migration v15 + typed setting helpers + tier 2 dual-write."
      },
      {
        "source": "mandible issue report dotfiles/4315ebe",
        "quote_or_summary": "The issue scope names the same db.ts and settings.ts surfaces, and the repository history contains the implementation commit."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "4cb595b0e92fabdd7853e5bf7bb94a540d100af9eb70486b42b5b6705b135eb6",
    "project_key": "dotfiles",
    "short_id": "4cb595b",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested settings panel, API, and protected-branch configuration storage were implemented.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "dc41bd9 is titled Add settings panel with protected branch configuration; 8a3f3bd subsequently uses the settings in work overview behavior."
      },
      {
        "source": "mandible issue report dotfiles/4cb595b",
        "quote_or_summary": "The issue body names the settings table, API, and work-overview use that the commits implement."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850765,
    "observed_kind": null
  },
  {
    "id": "530ab183fc322f4643c657107931305fd093ab89a889d3963c942aeb4531a350",
    "project_key": "dotfiles",
    "short_id": "530ab18",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested no-cleanup clarification was added to the auth-request documentation.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "ff7323c is titled auth-request: replace polling with SSE listener, extend timeout to 4h; CLAUDE.md: no-cleanup note."
      },
      {
        "source": "mandible issue report dotfiles/530ab18",
        "quote_or_summary": "The issue body asks for exactly the auth-merge cleanup clarification included by ff7323c."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851644,
    "observed_kind": null
  },
  {
    "id": "555d869a13f2f1cbfb111b4e9dcaa56fbc69445459e055540bc25042e5e59010",
    "project_key": "dotfiles",
    "short_id": "555d869",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The current global instructions carry the requested bounded-retry and clear-continue policy for Gemini/Codex rate limits, although the record does not prove that every proposed timing and logging detail survived verbatim.",
    "evidence": [
      {
        "source": "dotfiles/.config/claude/CLAUDE.md",
        "quote_or_summary": "The current policy says Gemini/Codex failures use bounded retries for rate limits or transient errors, then report clearly and continue with independent work."
      },
      {
        "source": "git history dotfiles",
        "quote_or_summary": "f183025 Refresh global agent instructions preserves the bounded rate-limit retry policy."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812861918,
    "observed_kind": null
  },
  {
    "id": "686d93c2d52c8e3a3406fd9bdbb5d743d21f0557ae80d1f470161e54655833a7",
    "project_key": "dotfiles",
    "short_id": "686d93c",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested starred-chats tab, storage/API surface, and /starchat skill were implemented; the feature was retired later as superseded, which does not erase historical delivery.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "8d8b873 is titled Add starred chats tab and /starchat skill and changes the database, routes, UI, and skill surfaces."
      },
      {
        "source": "git history dotfiles",
        "quote_or_summary": "Later history explicitly calls the starred-chats route superseded, confirming the earlier feature existed before retirement."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850090,
    "observed_kind": null
  },
  {
    "id": "6a7fde9b91395837219f0f0de33707bb0a47256ce550cda6ccc49222396e2661",
    "project_key": "dotfiles",
    "short_id": "6a7fde9",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The backend partition’s parser, ingestion, migration, and API components are present in repository history.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "69ca6b7 adds normalized Claude/Codex/Gemini parsers and 02cf735 adds the chokidar ingestion service and transform layer."
      },
      {
        "source": "git history dotfiles",
        "quote_or_summary": "049b211 adds the conversations/conversation_blocks migration, matching the partition’s backend scope."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "74721c1077b1c203d80a208272366b983e22f9f6b72769ddc2b7d3fc3a8bded5",
    "project_key": "dotfiles",
    "short_id": "74721c1",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The issue was explicitly closed because the convention moved to the canonical Mandible issue for SDK enforcement.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/74721c1 comment 2",
        "quote_or_summary": "The comment says the batched output convention moved to mandible issue 0911e2d and closes this dotfiles tracking issue."
      },
      {
        "source": "mandible issue report dotfiles/74721c1 relationships",
        "quote_or_summary": "The record references the still-open canonical issue Agent batched output convention: hold all information for user until work is complete."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "7b45fe412bcb86678fdeedc546e8fdb5ada1327cf4f95fc5a6916b2b3d3dde1c",
    "project_key": "dotfiles",
    "short_id": "7b45fe4",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The umbrella’s completed CP fixes batch covers the requested scanner, debounce, toast, and UI-polish work.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/7b45fe4 auth request",
        "quote_or_summary": "The completed merge request is titled CP fixes batch: issue scanner, hook debounce, UI polish, subagent panes and has exit_code 0."
      },
      {
        "source": "mandible issue report dotfiles/7b45fe4",
        "quote_or_summary": "The body lists the empty issues tab, hook debounce, reload toast, and history card padding scope."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850320,
    "observed_kind": null
  },
  {
    "id": "7eef43929a5eb9a5e142956f985e41b539627c9efc627fab9a5623d924b1013c",
    "project_key": "dotfiles",
    "short_id": "7eef439",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested conversation list/detail viewer, filtering, selection, export, and virtual scrolling UI was implemented.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "981c062 adds the conversations view with list, detail, block renderer, selection, export, and virtual scroll."
      },
      {
        "source": "mandible issue report dotfiles/7eef439",
        "quote_or_summary": "The issue body’s UI scope matches the surfaces added by 981c062."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "8cacb61a637ab9f9ba6c601a78ab595bdc5d6ccb26692a6a64af4a7c5b4d2be8",
    "project_key": "dotfiles",
    "short_id": "8cacb61",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue scanner was changed to use the JSON format required by the affected git-bug version.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "9b72308 is titled Fix issue-scanner: use git-bug --format=json parsing."
      },
      {
        "source": "mandible issue report dotfiles/8cacb61",
        "quote_or_summary": "The issue body requests exactly the --format=json switch and the resulting metadata availability."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "95e9a20e8d7a00e7845d40b3a5fa84b03808127bfb34a538b21d873964b23661",
    "project_key": "dotfiles",
    "short_id": "95e9a20",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains the focused bottom-third layout implementation and its integration into the subagent-panes work.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "8daf313 is titled Enforce bottom-third layout for subagent zones in zj-control; the related integration merge is 46438e1."
      },
      {
        "source": "mandible issue report dotfiles/95e9a20",
        "quote_or_summary": "The body requests the same resize/API and plugin-focused edge-case behavior."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849801,
    "observed_kind": null
  },
  {
    "id": "a4a6650ac26259eb73f6d319a90e26934940c45b750f288d31f3fd9d5c1dd452",
    "project_key": "dotfiles",
    "short_id": "a4a6650",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The daemon-reload toast and commit details were implemented in the dashboard.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "64d9950 is titled Add daemon reload toast notification with commit info."
      },
      {
        "source": "mandible issue report dotfiles/a4a6650",
        "quote_or_summary": "The issue body requests a dismissible, clickable toast with the last CP commit."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850029,
    "observed_kind": null
  },
  {
    "id": "acd2bd83f8cb2c8804a651614702af6d28933e3ef63c21ae3fe6dc1b0848c1e5",
    "project_key": "dotfiles",
    "short_id": "acd2bd8",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The auth-request watcher was changed to SSE with the requested timeout and disconnect behavior.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "ff7323c is titled auth-request: replace polling with SSE listener, extend timeout to 4h; the same commit includes the documentation companion change."
      },
      {
        "source": "mandible issue report dotfiles/acd2bd8",
        "quote_or_summary": "The issue body specifies persistent SSE, a 4-hour timeout, and one fallback poll."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851722,
    "observed_kind": null
  },
  {
    "id": "b8e56f2874a2aa2e15ea71ed78ce6943706e9bfa064878a71cd8f8e970a6ab5a",
    "project_key": "dotfiles",
    "short_id": "b8e56f2",
    "resolution": "wontfix",
    "confidence": "medium",
    "rationale": "This is an explicitly test-only issue with no substantive product or maintenance outcome to deliver.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/b8e56f2",
        "quote_or_summary": "The body is only Testing --label flag on new and the sole label is test-label; there are no implementation links or completion evidence."
      },
      {
        "source": "mandible issue report dotfiles/b8e56f2 timeline",
        "quote_or_summary": "The record contains only the test body and closure events."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812862276,
    "observed_kind": null
  },
  {
    "id": "bbac87ea00fc1e0d9b6a1f61d27402da96a14728265fe50d2fc0492bcf2d2a0c",
    "project_key": "dotfiles",
    "short_id": "bbac87e",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The delayed restart and stuck-approved recovery fix were implemented and the linked merge completed successfully.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "a95516c is titled Fix post-merge hook self-kill: delay daemon restart and changes the hook plus auth-queue recovery."
      },
      {
        "source": "mandible issue report dotfiles/bbac87e",
        "quote_or_summary": "The linked auth request is completed with exit_code 0."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850164,
    "observed_kind": null
  },
  {
    "id": "c23f4790fff83d2f727b33d03067a76a5d5216589b45a9ad9fe9ac66670f48b4",
    "project_key": "dotfiles",
    "short_id": "c23f479",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The unified auth-request submission/watch script was implemented in repository history.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "d81733e adds bin/auth-request as a unified submit-and-watch script."
      },
      {
        "source": "mandible issue report dotfiles/c23f479",
        "quote_or_summary": "The issue body’s requested auto-detection, preconditions, submission, watching, and fallback scope matches the script addition."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "c8dd9c8927f6ea26dedc99924f272b911b51a03101fededa180e967504456982",
    "project_key": "dotfiles",
    "short_id": "c8dd9c8",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The auth-request diff summary was changed from stat output to a bounded unified diff.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "642ad31 is titled Change diff_summary auto-generation to unified diff format with 100KB truncation."
      },
      {
        "source": "mandible issue report dotfiles/c8dd9c8",
        "quote_or_summary": "The issue body requests unified diff output, 100KB truncation, and a separate stat variable."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "d06fe5bdc49d580ddb1eaace7cb003fc6bd80657cdbf1a3bac18559490dddff0",
    "project_key": "dotfiles",
    "short_id": "d06fe5b",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The testing convention was promoted into the global instruction source.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "8772818 is titled feat: add CLAUDE.md directives for communication, testing, resilience, and workflow conventions; history search shows the write-tests guidance in that change."
      },
      {
        "source": "mandible issue report dotfiles/d06fe5b",
        "quote_or_summary": "The issue asks for a global rule applying to implementation outside bigbuild, matching the global instruction change."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "d8cf0efd86282c74d2ee356fda38f9a305b4b02ae1149841f942de95ba890023",
    "project_key": "dotfiles",
    "short_id": "d8cf0ef",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested global instruction reorganization was implemented and the linked merge completed.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/d8cf0ef auth request",
        "quote_or_summary": "The completed auth request merges feature/claude-md-restructure with exit_code 0."
      },
      {
        "source": "git history dotfiles",
        "quote_or_summary": "2f39917 merges the CLAUDE.md restructure branch."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849687,
    "observed_kind": null
  },
  {
    "id": "e32ee8b5c0d6da9a5db111258647fff21d8dd00d5647121b219314101c5f1aea",
    "project_key": "dotfiles",
    "short_id": "e32ee8b",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The two named core outcomes were implemented, but the expanded historical comments add WIP-inbox scope that is not independently proven by this record, so confidence is reduced.",
    "evidence": [
      {
        "source": "git history dotfiles",
        "quote_or_summary": "14fd509 adds auto-close on merge via Bug trailers and the setting; 717f7d1 extends stuck-approved recovery and allows dismissal/update from approved status."
      },
      {
        "source": "mandible issue report dotfiles/e32ee8b relationships",
        "quote_or_summary": "The record references the closed auto-close and stuck-approved child issues, matching the core scope."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "ecf74c7f1772525e5c0df07deda1fc236b68cc132acf70daa6355736af116e20",
    "project_key": "dotfiles",
    "short_id": "ecf74c7",
    "resolution": "wontfix",
    "confidence": "medium",
    "rationale": "This is a test-only record rather than a substantive product request; its closure comment names a commit but does not identify a meaningful requested outcome.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/ecf74c7",
        "quote_or_summary": "The body is only test, the title is test label, and the sole comment says Resolved by commit b35b3bddf62d without describing a product change."
      },
      {
        "source": "mandible issue report dotfiles/ecf74c7 timeline",
        "quote_or_summary": "The history contains only the test body, one generic commit comment, and closure events."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812862190,
    "observed_kind": null
  },
  {
    "id": "f30506a96a83f7b85f71994710770bb83fb907ab35ca03a01643b54a8ac8cfec",
    "project_key": "dotfiles",
    "short_id": "f30506a",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The proposed documentation fix landed as a stronger global rule making --spec mandatory for non-trivial work, although the record does not prove an automatic large-diff warning or document-content detector.",
    "evidence": [
      {
        "source": "dotfiles/.config/claude/CLAUDE.md",
        "quote_or_summary": "The current auth protocol says every non-trivial auth request MUST include --spec and treats omission as a workflow bug."
      },
      {
        "source": "git history dotfiles",
        "quote_or_summary": "f183025 refreshes the instructions with the mandatory non-trivial --spec rule."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812860922,
    "observed_kind": null
  },
  {
    "id": "04c4889a433a6b063cb4ce3729c626871b7c5f4913a1933bbdc9ca717eb243fd",
    "project_key": "feedbax",
    "short_id": "04c4889",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The issue explicitly says it was superseded and that the durable spec record lives in c6c6da0 instead.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/04c4889 comment 1",
        "quote_or_summary": "The user chose not to submit or merge this documentation file; the durable record now lives in spec issue c6c6da0."
      },
      {
        "source": "mandible issue report feedbax/04c4889 relationships",
        "quote_or_summary": "The issue references the replacement spec and Feedbax design coordination issues."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "138bbe5e5fb27496c72d30a610d90fce5c746457905353841374fd452683b862",
    "project_key": "feedbax",
    "short_id": "138bbe5",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested MuscleTopology and moment-arm matrix refactor is present with tests and supporting builder/model changes.",
    "evidence": [
      {
        "source": "git history feedbax",
        "quote_or_summary": "0e4d37ac adds MuscleTopology and refactors MuscleConfig to a moment-arm matrix; 8f98ab33 adds default_2link_bounds and later commits complete routing tests and model wiring."
      },
      {
        "source": "feedbax current source",
        "quote_or_summary": "muscle_config.py defines MuscleTopology and tests assert (n_muscles, n_joints) moment-arm shapes, including biarticular routing."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "3810ade035571872296453ca97c59819bf058038c98940b89c4e7f5156c9198f",
    "project_key": "feedbax",
    "short_id": "3810ade",
    "resolution": "wontfix",
    "confidence": "low",
    "rationale": "The current source still uses the arrangement discussed by this imported design issue: AbstractPlant aggregates dynamics_spec into one vector field and MechanicsState owns the effector. That is not evidence that the proposed redesign was delivered. A later open issue, 138c2d3, explicitly continues the AbstractPlant/dynamics-ownership question, so the historical discussion has no delivered or explicit supersession outcome; wontfix remains the least-overclaiming forced classification.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/3810ade",
        "quote_or_summary": "The body is an imported general discussion of AbstractPlant, Mechanics, effector state ownership, and possible vector-field aggregation; its comments are empty GitHub placeholders."
      },
      {
        "source": "mandible issue report feedbax/3810ade timeline",
        "quote_or_summary": "The only state events are closure events; no commit, branch, auth, or relationship evidence identifies an achieved outcome."
      },
      {
        "source": "feedbax source feedbax/mechanics/plant.py and feedbax/mechanics/mechanics.py",
        "quote_or_summary": "AbstractPlant.vector_field still loops over dynamics_spec and Mechanics still wraps the Diffrax ODETerm while MechanicsState stores effector; the debated design remains the implemented arrangement rather than a completed redesign."
      },
      {
        "source": "mandible issue report feedbax/138c2d3",
        "quote_or_summary": "The later open issue explicitly reviews AbstractPlant dynamics aggregation and proposes moving muscle activation dynamics into AbstractMuscle, confirming that the design question continued as open work."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885585,
    "observed_kind": null
  },
  {
    "id": "4b7cc964398e9f678e41b7e9166076d065b0c5761a948b42acdc7442c39a799c",
    "project_key": "feedbax",
    "short_id": "4b7cc96",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue contains implementation, verification, merge, and completed-auth evidence for the generic graph worker path.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/4b7cc96 comments",
        "quote_or_summary": "The comments report implementation at fcf2b40, merge 87e973e into develop, and rerun worker/provider/graph tests."
      },
      {
        "source": "mandible issue report feedbax/4b7cc96 auth request",
        "quote_or_summary": "The linked integration/graphspec-runtime-retention auth request is completed with exit_code 0."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "5d588337f841f02c21ff484b33fa5cefb02b8a617a3757e8bcdd55767ed4800b",
    "project_key": "feedbax",
    "short_id": "5d58833",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested frontend trajectory viewer was implemented and merged into develop.",
    "evidence": [
      {
        "source": "git history feedbax",
        "quote_or_summary": "9a137d55 adds the trajectory viewer panel with a Three.js scene; 2e6642d0 merges the trajectory-viewer branch into develop."
      },
      {
        "source": "mandible issue report feedbax/5d58833",
        "quote_or_summary": "The issue body’s TrajectoryPanel, scene, body rig, playback, store, and API scope matches the merged feature history."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "704490400d4f76abbb71ec66d1d7f0c8621009aa80416a01f725b0fb2125a1a3",
    "project_key": "feedbax",
    "short_id": "7044904",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue history explicitly records the badge fix in develop and a browser QA confirmation.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/7044904 comment 2",
        "quote_or_summary": "The comment says the badge-placement problem was fixed in the Scenario Projection Workspace merge 0d82869 and no work remains."
      },
      {
        "source": "mandible issue report feedbax/7044904 comment 3",
        "quote_or_summary": "The record includes Resolved by commit 0d82869."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "7f02d30fb120fbfa729dc53aa2225d0b3a6a1fdf49dda3779621d74cd3f566a2",
    "project_key": "feedbax",
    "short_id": "7f02d30",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue history records the recurrent-edge semantics, browser QA, regression tests, and merge that delivered the requested UX.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/7f02d30 comment 2",
        "quote_or_summary": "The comment says recurrent-edge semantics are on develop via merge 27384a2, browser QA confirms t+1 semantics, and regression tests are green."
      },
      {
        "source": "mandible issue report feedbax/7f02d30 comment 1",
        "quote_or_summary": "The record includes Resolved by commit 27384a2."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "a1036a63c72617ef50d18675b9e0a5f2d144193dfc33133d9b930d8ff859f24a",
    "project_key": "feedbax",
    "short_id": "a1036a6",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue contains a resolved implementation note, merge evidence, and completed-auth evidence for deriving and validating input prototypes.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/a1036a6 comment 2",
        "quote_or_summary": "The channel/input-prototype slice landed through merge 4dfa0ff; templates no longer need undocumented hand-authored input_shape values."
      },
      {
        "source": "mandible issue report feedbax/a1036a6 auth request",
        "quote_or_summary": "The linked GraphSpec/runtime/worker/retention auth request is completed with exit_code 0."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "b26e6d70bd68bcfe8caae95aec12095701efa5c40001ee6e9eb3005a290e1a17",
    "project_key": "feedbax",
    "short_id": "b26e6d7",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The imported issue has a dated implementation comment naming the commit and describing the returned validation arrays and plotting behavior.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/b26e6d7 comment 1",
        "quote_or_summary": "The comment says validation losses were added in fa571daccf642ab1d15625adec38e49b120acab5 and explains their sparse-array representation and plotting."
      },
      {
        "source": "mandible issue report feedbax/b26e6d7 body",
        "quote_or_summary": "The requested outcome is returning validation loss alongside training loss in TaskTrainerHistory."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "eb22bbd56553c29f50cfb2bb2f7feba6c6905048b775caa3f679e72b45edb712",
    "project_key": "feedbax",
    "short_id": "eb22bbd",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested FastAPI trajectory endpoints and service were implemented in the trajectory-viewer backend history.",
    "evidence": [
      {
        "source": "git history feedbax",
        "quote_or_summary": "50791c8 is titled Add FastAPI trajectory data endpoints; the related trajectory-viewer branches were merged into develop."
      },
      {
        "source": "mandible issue report feedbax/eb22bbd",
        "quote_or_summary": "The issue body’s dataset, metadata, and single-trajectory endpoint scope matches the backend commit."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "b749680e80edca5b96062f8ca79a2956cd5f80595c3ccdfd5332546e96e7fbb6",
    "project_key": "humbleb",
    "short_id": "b749680",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "This placeholder is an exact duplicate of the substantive same-title issue humbleb/24002a3. The substantive record was completed with merged resolution, and the repository now contains the requested notes column, migration, persistence API, CLI wiring, and tests.",
    "evidence": [
      {
        "source": "mandible issue report humbleb/b749680 and humbleb/24002a3",
        "quote_or_summary": "Both records have the exact title; b749680 is only placeholder while 24002a3 contains the substantive request and was resolved as merged."
      },
      {
        "source": "mandible issue report humbleb/24002a3",
        "quote_or_summary": "The canonical same-title issue has a resolved work unit and completed auth request with exit_code 0, and its closure event records resolution merged."
      },
      {
        "source": "HumbleB git history and source",
        "quote_or_summary": "Commit 3da1362 adds calibration_run.notes, initializes the migration for older DBs, accepts notes in create_run, and threads notes through the research runner; current db.py, CLI code, and calibration tests exercise the field."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "1ed1d90952eacef826f47ec0b199904889cbe35ccffcefeb75f52e69cd01ec35",
    "project_key": "mandible",
    "short_id": "1ed1d90",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has an explicit resolved-by-commit comment for the safe conflict-resolution fix.",
    "evidence": [
      {
        "source": "mandible issue report mandible/1ed1d90 comment 1",
        "quote_or_summary": "The comment says commit 5c85783 ports auto_resolve_dist_conflicts so generated-file conflicts no longer delete user content."
      },
      {
        "source": "mandible issue report mandible/1ed1d90 body",
        "quote_or_summary": "The requested outcome is preventing recursive deletion of unrelated untracked user content during auth-merge."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "38cca4909eeb53b21726a47babd7fea21471aefa4d5f6b4c3ba7d523bbb5bbad",
    "project_key": "mandible",
    "short_id": "38cca49",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has an explicit resolved-by-commit comment for the --target override.",
    "evidence": [
      {
        "source": "mandible issue report mandible/38cca49 comment 1",
        "quote_or_summary": "The comment says commit 5c85783 ports --target to auth-request.sh so callers can override the protected-branch autodetection."
      },
      {
        "source": "mandible issue report mandible/38cca49 relationships",
        "quote_or_summary": "The related dotfiles issue c6bd770 is closed with resolution fixed."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "511ebaa27d7d5f69b8670b18a5dc5658f9175338220cd33568fb3e3f9d13da7d",
    "project_key": "mandible",
    "short_id": "511ebaa",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has an explicit resolved-by-commit comment for parsing DELETE request bodies.",
    "evidence": [
      {
        "source": "mandible issue report mandible/511ebaa comment 1",
        "quote_or_summary": "The comment says commit 5c85783 includes DELETE in the body-parsing method check so body.reason is available."
      },
      {
        "source": "mandible issue report mandible/511ebaa relationships",
        "quote_or_summary": "The related dotfiles issue a21979a is closed with resolution fixed."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "823d719c4db1403c50c964c4b6e98a67a8fe79f705254578ee3875c06e0001f8",
    "project_key": "mandible",
    "short_id": "823d719",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The current Mandible SSE implementation routes broadcasts through a guarded writer that catches write failures and removes disconnected clients, but this closed record has no direct issue-linked completion comment.",
    "evidence": [
      {
        "source": "mandible current src/sse.ts",
        "quote_or_summary": "SseManager.broadcast delegates every client write to writeClient, whose try/catch removes the client on write failure; the requested failure behavior is present."
      },
      {
        "source": "mandible issue report mandible/823d719",
        "quote_or_summary": "The report has no comments or auth links and references the older dotfiles issue, so the code evidence is stronger than the record linkage."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "b4a5545dbd396f00291a7dcd03bb375c637cfaa53763c339f38d3ec3d1a321d7",
    "project_key": "mandible",
    "short_id": "b4a5545",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has an explicit resolved-by-commit comment for the SSE pipefail/false exit fix.",
    "evidence": [
      {
        "source": "mandible issue report mandible/b4a5545 comment 1",
        "quote_or_summary": "The comment says commit 5c85783 ports the SSE pipefail fix so curl exit 23 cannot turn successful auth into a failed task."
      },
      {
        "source": "mandible issue report mandible/b4a5545 relationships",
        "quote_or_summary": "The related dotfiles issue 2fa626e is closed with resolution fixed."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "e85c5bc07c6f636c491d9d822e3d94e85166c3a95e791c5b2cda657b364913a0",
    "project_key": "mandible",
    "short_id": "e85c5bc",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The umbrella’s implementation was merged and the current desktop app contains the described daemon bootstrap and lifecycle controls.",
    "evidence": [
      {
        "source": "mandible issue report mandible/e85c5bc comment 1",
        "quote_or_summary": "The comment lists bootstrap, status/start-stop-restart controls, launch mode, settings, and logs access implemented in commits 25938a7 and e1100f9."
      },
      {
        "source": "git history mandible",
        "quote_or_summary": "118b70e7 merges feature/desktop-daemon-lifecycle and ea99aa22 merges the daemon lifecycle lane; current desktop-app docs describe the same controls."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "6f783fa2605fe9e72d909031fa0cdf00b51265b16116d3bdc5afc9df18ca7c60",
    "project_key": "rlrmp",
    "short_id": "6f783fa",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The record explicitly says this interim v2 plan was superseded and is not canonical; the controlling plan is maintained in other tracked issues.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/6f783fa comment 2",
        "quote_or_summary": "The issue is closed as subsumed into 0b1f109 brainstorming and says the body is not the canonical plan."
      },
      {
        "source": "mandible issue report rlrmp/6f783fa comment 1",
        "quote_or_summary": "The controlling plan is now 43e8728, grounded in 0b1f109 and the review."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "ce34c2cfad3e548378ccf871afbb629057df292728c085e5af7b4b2db62eb6f8",
    "project_key": "rlrmp",
    "short_id": "ce34c2c",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The broad GRU-laziness framing was folded into later experiments and the updated architecture plan rather than remaining a canonical standalone work item.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/ce34c2c comment 1",
        "quote_or_summary": "Later experiments across GRU, vRNN, additive, and multiplicative architectures found 0.00% SISU velocity effect, ruling out GRU-specific laziness as the explanation."
      },
      {
        "source": "mandible issue report rlrmp/ce34c2c comment 3",
        "quote_or_summary": "The disposition says the older framing is not central and directs future work to 43e8728, 8fcb6c7, cf56e1e, and f7b1b17."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "586cfae1ba49f05aa47d780989d71f6fc39e35f2c7672f50622bb53eeb408d43",
    "project_key": "bbooddyy",
    "short_id": "586cfae",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the issue's named feature branch is recorded with exit code 0, which is direct evidence that the requested runner change was merged.",
    "evidence": [
      {
        "source": "issue report bbooddyy/586cfae auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/gpu-test-runner, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812904002,
    "observed_kind": null
  },
  {
    "id": "038ac25132e324310e96c7acf6eb1083e1672a636021e58cf160ffd976a49983",
    "project_key": "dotfiles",
    "short_id": "038ac25",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has a completed auth merge for the exact settings-expansion feature branch; the linked partition issues identify the four implementation areas.",
    "evidence": [
      {
        "source": "issue report dotfiles/038ac25 auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/settings-expansion, base_branch=main, exit_code=0; linked backend, UI, and hook partitions"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851202,
    "observed_kind": null
  },
  {
    "id": "0eb106183d8f8f1bb3600db683a6e1d896441dcc7c5d826c2a1eda390644dbea",
    "project_key": "dotfiles",
    "short_id": "0eb1061",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The linked implementation issue records that Remote Debugging Discipline is present in CLAUDE.md under Conventions, which answers this issue's placement question.",
    "evidence": [
      {
        "source": "issue report dotfiles/25e2cbe comments",
        "quote_or_summary": "Remote Debugging Discipline section is present in CLAUDE.md under Conventions; the related issue dotfiles/0eb1061 is the placement review"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "195c2bf5a396be0a3c11773bad0ec204f776230a6b1355bbe9c69c036d7d6777",
    "project_key": "dotfiles",
    "short_id": "195c2bf",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains a commit whose subject and Bug trailer directly match the requested dashboard metadata-position fix.",
    "evidence": [
      {
        "source": "git history dotfiles commit c75d744b0248a13cf0b1f832c726913e600b713d",
        "quote_or_summary": "Fix metadata position: keep stats in folded position on unfold; commit body carries Bug: 195c2bf and changes the control-plane auth view and styles."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849955,
    "observed_kind": null
  },
  {
    "id": "2481d72456f6c8326b8baf7a1eb99c885e3d1c2813bad5525c838f5e7a96a796",
    "project_key": "dotfiles",
    "short_id": "2481d72",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains the requested standalone-app PWA implementation, including the manifest, service worker, icons, index wiring, and server support.",
    "evidence": [
      {
        "source": "git history dotfiles commit d8db01c5bfda5976002159523583b43c3e004462",
        "quote_or_summary": "Add PWA support: manifest, service worker, icons; commit body carries Bug: 2481d72 and creates ui/manifest.json, ui/sw.js, icons, and related app/server changes."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850845,
    "observed_kind": null
  },
  {
    "id": "2c773fc378e173cb5161f740a3e4351cdbce904da93fe704823fa2cd45cb23f7",
    "project_key": "dotfiles",
    "short_id": "2c773fc",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The parent audit's merged rewrite explicitly includes action-scoped authorization, which is the durable clarification requested here; the audit comment lists this issue among completed sub-issues.",
    "evidence": [
      {
        "source": "issue report dotfiles/b608ad9 body",
        "quote_or_summary": "the merged CLAUDE.md rewrite adds action-scoped authorization and references dotfiles/2c773fc; parent dotfiles/4f2058d says all audit sub-tasks completed and merged"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "3b88e1db86c4947826dbd9a583cd69d5b31988587326ee7efac6d0655c8549cf",
    "project_key": "dotfiles",
    "short_id": "3b88e1d",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The parent audit's merged rewrite explicitly includes model-selection guidance, and the audit closeout lists this issue among completed sub-issues.",
    "evidence": [
      {
        "source": "issue report dotfiles/b608ad9 body",
        "quote_or_summary": "the merged CLAUDE.md rewrite adds model selection guidance and references dotfiles/3b88e1d; parent dotfiles/4f2058d says all audit sub-tasks completed and merged"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "44233e24e306107c91340efe0a3221c8b38f32c0732849470ccfbacf7c9e3148",
    "project_key": "dotfiles",
    "short_id": "44233e2",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact dashboard-v2 feature branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/44233e2 auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/cp-dashboard-v2, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850128,
    "observed_kind": null
  },
  {
    "id": "4f2058d04f9ca8bb32acba1c07a0b3e0c36862e0d4fb5054e65a1e60815feb47",
    "project_key": "dotfiles",
    "short_id": "4f2058d",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's own historical comment states that all audit sub-tasks were completed and merged to main, and lists the relevant closed sub-issues.",
    "evidence": [
      {
        "source": "issue report dotfiles/4f2058d comments[0]",
        "quote_or_summary": "All audit sub-tasks completed and merged to main; closed sub-issues include dotfiles/3b88e1d, dotfiles/2c773fc, and dotfiles/0eb1061"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "54f5f973af01b8e4e5158a0f3c6cda782da4d4c04ab45f0ac078456f4495e1e7",
    "project_key": "dotfiles",
    "short_id": "54f5f97",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "A completed auth merge exists and the historical note says the pane root cause was fixed, but the same note requires a Zellij restart and temporarily disables pane spawning; this supports a merged/root-cause delivery, not complete live activation of every umbrella behavior.",
    "evidence": [
      {
        "source": "issue report dotfiles/54f5f97 auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/settings-subagent-toggle, base_branch=main, exit_code=0"
      },
      {
        "source": "issue report dotfiles/54f5f97 comments[0]",
        "quote_or_summary": "root cause fixed (wasm32-wasip1 _start export); needs Zellij restart; pane spawning temporarily disabled via CP setting toggle"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849916,
    "observed_kind": null
  },
  {
    "id": "5692b91bbe50b19fc1b7126079f59c7df3b97183fd969e409cf3f4c886293453",
    "project_key": "dotfiles",
    "short_id": "5692b91",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested policy was implemented in CLAUDE.md: it explicitly says memory is not a substitute for control-plane state and documents issue/inbox routing plus resilience behavior.",
    "evidence": [
      {
        "source": "git history dotfiles commit 790b5d1a8c67834f074e63785ec2e8b0dbe81270",
        "quote_or_summary": "Add control plane resilience directive and issue closure policy; commit body carries Bug: 5692b91."
      },
      {
        "source": "git diff in dotfiles commit 790b5d1a8c67834f074e63785ec2e8b0dbe81270",
        "quote_or_summary": "CLAUDE.md says not to use memory files as a substitute for issue tracking, session management, inbox, or auth requests, and adds the control-plane resilience and issue-closure rules."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812852368,
    "observed_kind": null
  },
  {
    "id": "68aa75447bfbf59e787cf5d51111e38ed5b6744456bcba45cf4ca9d2f95097d4",
    "project_key": "dotfiles",
    "short_id": "68aa754",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The exact sub-issue scope is implemented: empty-output approved requests older than five minutes are recovered as interrupted, and approved requests can be updated or dismissed.",
    "evidence": [
      {
        "source": "issue report dotfiles/68aa754 body",
        "quote_or_summary": "The sub-issue requires empty-output recovery after five minutes and approved-status changes through dismiss/update."
      },
      {
        "source": "git history dotfiles commit 717f7d1c541459aeb0d37d466bad3385a353bad4",
        "quote_or_summary": "Extend stuck-approved recovery for empty output + allow dismiss/update from approved status; commit body carries Bug: 68aa754."
      },
      {
        "source": "git diff dotfiles commit 717f7d1c541459aeb0d37d466bad3385a353bad4",
        "quote_or_summary": "Adds the empty-approved five-minute recovery path with exit_code 1, permits approved status in update/dismiss, and broadcasts the resulting events."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "6bd27f21aeed253f5128a99dc28c8749ada2bb083679668dd79e201a2e3585f5",
    "project_key": "dotfiles",
    "short_id": "6bd27f2",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact iTerm2 navigation fix branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/6bd27f2 auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/fix-iterm2-goto, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850961,
    "observed_kind": null
  },
  {
    "id": "77d27882f3f929abb4bef73b1d53c47c39dcc3b48fdabdc3d45532f243a5f5b7",
    "project_key": "dotfiles",
    "short_id": "77d2788",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The requested ControlMaster configuration was directly confirmed present. A later comment isolates the remaining extra touches to an empty SSH agent and a separate smart-ssh-add issue, so the original multiplexing change was delivered even though the broader symptom persisted.",
    "evidence": [
      {
        "source": "issue report dotfiles/77d2788 comments[0]",
        "quote_or_summary": "SSH ControlMaster config exists in ~/.ssh/config; recommend closing"
      },
      {
        "source": "issue report dotfiles/77d2788 comments[1]",
        "quote_or_summary": "ControlMaster is implemented; remaining 2-3 touches are attributed to the empty SSH agent and a new issue"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812852005,
    "observed_kind": null
  },
  {
    "id": "7ee9a335f1feffb5370fa7cd4153a68ae6124cec9c04664f2229ff0a8ced8f71",
    "project_key": "dotfiles",
    "short_id": "7ee9a33",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains a UI commit whose subject and Bug trailer cover the requested session/agent registry fixes, including project handling, duration formatting, and empty-conversation cleanup.",
    "evidence": [
      {
        "source": "git history dotfiles commit 472b5f3974cc5700735262aee53b75b4a9112bac",
        "quote_or_summary": "Improve control plane UI: nested issue scrolling, deep-link toasts, session duration format, auth cross-links, hide empty conversations; commit body carries Bug: 7ee9a33 and related conversation issue IDs."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812852246,
    "observed_kind": null
  },
  {
    "id": "8219875e49d6b74331d518f259229abce2f5e93248c962e8e22a27bdc29dbdaf",
    "project_key": "dotfiles",
    "short_id": "8219875",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's comment explicitly says the standalone Mandible repository was created and the issue was closed.",
    "evidence": [
      {
        "source": "issue report dotfiles/8219875 comments[0]",
        "quote_or_summary": "DONE: Standalone git repo created at ~/Main/10 Projects/05 Utils/mandible. Closing."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "8fe1ad6ae0783d9f13b0cd02d65011456ca405799cf0c76a32e2bf9bbeec11ea",
    "project_key": "dotfiles",
    "short_id": "8fe1ad6",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains a directly matching auth-card spacing fix with the issue ID in the commit body.",
    "evidence": [
      {
        "source": "git history dotfiles commit 4bc794c14dfac329a1813d554f33624f7687037a",
        "quote_or_summary": "Fix auth card padding: consistent spacing on expand/collapse; commit body carries Bug: 8fe1ad6."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850516,
    "observed_kind": null
  },
  {
    "id": "97e0e6f184a2b6e23af824dc98f3e590129adb15ad842ac209449a4d9f60a258",
    "project_key": "dotfiles",
    "short_id": "97e0e6f",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains a directly matching replacement of the history table with expandable cards.",
    "evidence": [
      {
        "source": "git history dotfiles commit c67dd770ce3e3791c5d1e2090d72f5dedc5221eb",
        "quote_or_summary": "Replace history table with expandable cards; commit body carries Bug: 97e0e6f."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849992,
    "observed_kind": null
  },
  {
    "id": "a4e36a4c685f577affb11778cc10b907144268ad443d89c58b282a1ca94522db",
    "project_key": "dotfiles",
    "short_id": "a4e36a4",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains the requested CLAUDE.md auth-completion cleanup clarification with the issue ID in the commit body.",
    "evidence": [
      {
        "source": "git history dotfiles commit 3b87931015a66d2643f35c3d30d97ee460cca8e1",
        "quote_or_summary": "CLAUDE.md: note no cleanup needed on auth request completion; commit body carries Bug: a4e36a4."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851684,
    "observed_kind": null
  },
  {
    "id": "af82dccd2dbb0c7e41fcd5908390062c9e5f0a014c871fe0165ff36ecf1656fb",
    "project_key": "dotfiles",
    "short_id": "af82dcc",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains the requested agent-viewer support for transcript JSONL rendering and optional PID handling.",
    "evidence": [
      {
        "source": "git history dotfiles commit 82432f3de9713c78e8d2284e395af677314e9565",
        "quote_or_summary": "Add transcript JSONL rendering and optional PID to agent-viewer; commit body carries Bug: af82dcc and changes bin/agent-viewer."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849763,
    "observed_kind": null
  },
  {
    "id": "ba5a3abe686085d09758b2dbfa01f509a50969702f285438438ea783e2d03706",
    "project_key": "dotfiles",
    "short_id": "ba5a3ab",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact dashboard-v3 feature branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/ba5a3ab auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/cp-dashboard-v3, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850477,
    "observed_kind": null
  },
  {
    "id": "c0b32f91454d74ee4af055b88fcd6595dfa81ae2c8a337403ba605672b6cc118",
    "project_key": "dotfiles",
    "short_id": "c0b32f9",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Two completed auth merges are recorded for the issue's implementation branches, both targeting main with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/c0b32f9 auth_requests",
        "quote_or_summary": "completed feature/claude-md-issue-traceability and feature/issue-work-ledger merges, both base_branch=main and exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "c477474c667714b41816ae157108805c38d914ae5010b1ee9cec629716c58f26",
    "project_key": "dotfiles",
    "short_id": "c477474",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains the requested CLAUDE.md documentation update to use the unified auth-request script.",
    "evidence": [
      {
        "source": "git history dotfiles commit bf2132027ff4663a6e187b66cb22e669a8354aba",
        "quote_or_summary": "Update CLAUDE.md: replace manual auth submission with auth-request script; commit body carries Bug: c477474."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "ca46239d8f43506975620f0d583afb7519783a5792d0646d54f18eb913f2f8e9",
    "project_key": "dotfiles",
    "short_id": "ca46239",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact issue-scanner fix branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/ca46239 auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/fix-issue-scanner-ls, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850921,
    "observed_kind": null
  },
  {
    "id": "d0759d1dc0829926781779110cb0b9f52bdba3c6f74f655a515d832d2544966d",
    "project_key": "dotfiles",
    "short_id": "d0759d1",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The umbrella’s three requested conversation behaviors are present in repository history: sub-agent grouping with a UI toggle, better titles/empty-conversation handling, and the associated zero-block cleanup.",
    "evidence": [
      {
        "source": "git history dotfiles commit b4822aa40f47270b202f0fa7aa9cf2741a8146cb",
        "quote_or_summary": "Add sub-agent conversation grouping with parent linkage and UI toggle; commit body carries Bug: d0759d1."
      },
      {
        "source": "git history dotfiles commit 472b5f3974cc5700735262aee53b75b4a9112bac",
        "quote_or_summary": "The control-plane UI follow-up carries Bug: d0759d1 and implements improved titles plus hiding empty conversations."
      },
      {
        "source": "git history dotfiles commit 2e8256d710e27d68d9c3c2f70e9902f1b8886b4f",
        "quote_or_summary": "Add hard zero-block insertion guard and improve reconcile cleanup in conversations ingestion; this is the linked zero-block child implementation."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812852208,
    "observed_kind": null
  },
  {
    "id": "dabcb7fdc3d65348e60d50a6815fcb9370ebb7ffb91b16002972002b214ccd15",
    "project_key": "dotfiles",
    "short_id": "dabcb7f",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested unified auth-request submit/watch script was implemented in the referenced child partition, with the companion CLAUDE.md instructions updated separately.",
    "evidence": [
      {
        "source": "git history dotfiles commit d81733e2075b97b5a341c2c3284b3e66d717d5aa",
        "quote_or_summary": "Add bin/auth-request: unified submit + watch for auth requests; the commit body carries Bug: c23f479, the script partition named by dabcb7f."
      },
      {
        "source": "git history dotfiles commits 9a7256f1b29b48777df583476f0a7cf0e70bde63 and b29945d356c8c28e6ebd16a1a4deabb12f1b1a27",
        "quote_or_summary": "Follow-up fixes to the auth-request script, both carrying Bug: c23f479."
      },
      {
        "source": "git history dotfiles commit bf2132027ff4663a6e187b66cb22e669a8354aba",
        "quote_or_summary": "The companion c477474 partition updates CLAUDE.md to replace manual auth submission with the auth-request script."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851528,
    "observed_kind": null
  },
  {
    "id": "e3e886f7433136ed03f191e8aab03ed2f3b89f91185c0d07ccf17688ee56630b",
    "project_key": "dotfiles",
    "short_id": "e3e886f",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact bash-PATH fix branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/e3e886f auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/fix-bash-path, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851405,
    "observed_kind": null
  },
  {
    "id": "ed804ba41ad0e171ae763c1cbf61f1e10bd66d5a9ee346b74e6c72a75acec17c",
    "project_key": "dotfiles",
    "short_id": "ed804ba",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact pre-auth merge-dry-run branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report dotfiles/ed804ba auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/pre-auth-merge-dryrun, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812851448,
    "observed_kind": null
  },
  {
    "id": "f8fe0d83b97937b683c4fd9dccdadf07b4075db1c6b011a738672d54c2fd7194",
    "project_key": "dotfiles",
    "short_id": "f8fe0d8",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains a directly matching fix for subagent pane stacking and automatic close behavior.",
    "evidence": [
      {
        "source": "git history dotfiles commit d4d22ace16d051859ef3e345b12ae6bf7a03ba04",
        "quote_or_summary": "Fix subagent pane stacking and auto-close; commit body carries Bug: f8fe0d8 and changes the stop hook, Zellij plugin source/wasm, and agent-viewer."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "04e727c58f15b2e54fe1002a58a93bb268023b3f4bf24092ed39b8c1bc58638b",
    "project_key": "feedbax",
    "short_id": "04e727c",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Historical comments describe the concrete ensemble fix: adding out_axes removed the proliferating dimensions and enabled distinct trial specs for ensemble replicates.",
    "evidence": [
      {
        "source": "issue report feedbax/04e727c comments[1]",
        "quote_or_summary": "fixed the proliferating dimensions by adding out_axes to the vmap; distinct trial specs are generated for each model replicate"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "20554335f9b392bbd9784b1a2a506c883dd7a87024043f49490226dee175055e",
    "project_key": "feedbax",
    "short_id": "2055433",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Repository history contains all four named training enhancements: LATTICE noise, REACH-only/frame-skip support, curriculum learning, and the extended batched PPO trainer.",
    "evidence": [
      {
        "source": "git history feedbax commit 64b497fe",
        "quote_or_summary": "Add LATTICE correlated latent-space exploration noise; commit body carries Bug: 2055433."
      },
      {
        "source": "git history feedbax commit 4e73a378",
        "quote_or_summary": "Add REACH-only mode and n_steps frame_skip helper; commit body carries Bug: 2055433."
      },
      {
        "source": "git history feedbax commit 1193ca03",
        "quote_or_summary": "Add curriculum learning: progressive target distance for REACH; commit body carries Bug: 2055433."
      },
      {
        "source": "git history feedbax commit 418840f2",
        "quote_or_summary": "Add train_ppo_batched_extended with obs norm, LATTICE, curriculum, annealing; commit body carries Bug: 2055433."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "3c92fbdbbe13ada5b9a142ed82ed129933fe9a810d19d07a9d308eb2ea4e8d62",
    "project_key": "feedbax",
    "short_id": "3c92fbd",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Both named implementation partitions are individually recorded with resolution=merged, matching the parent umbrella's complete two-part scope.",
    "evidence": [
      {
        "source": "issue report feedbax/928d494 and feedbax/1d2192d",
        "quote_or_summary": "P1 physics backend abstraction and P2 CDE controller module both have status=closed and resolution=merged"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885278,
    "observed_kind": null
  },
  {
    "id": "4fcb0fc75976b9d718b4612bf5bb1b8ca015757bc28e9dbe2748db09ea501820",
    "project_key": "feedbax",
    "short_id": "4fcb0fc",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The design concerns were addressed by a delivered architectural replacement: Feedbax moved from staged models and Iterator flow to explicit graph components with unified state and graph-based intervention composition.",
    "evidence": [
      {
        "source": "git history feedbax commit c3bce23833f044d644670d9971bd3caf41485f35",
        "quote_or_summary": "The eager-models specification explicitly defines the migration from staged models to an eager graph, unified state, and components rather than special intervenors."
      },
      {
        "source": "git history feedbax commit 1e5d8ecbb75856890aabec318961a3dd0946f0806",
        "quote_or_summary": "Implement eager graph architecture cutover; deletes feedbax/_staged.py, adds Graph/Component execution, unifies state/interventions, updates tasks/training, and adds graph tests."
      },
      {
        "source": "current feedbax develop source/docs",
        "quote_or_summary": "develop contains the cutover; docs state that the staged model approach has been replaced by an explicit eager graph architecture, and current source has no AbstractStagedModel implementation."
      },
      {
        "source": "issue report rlrmp/b131510",
        "quote_or_summary": "The merged downstream audit explicitly identifies 1e5d8ec as the eager-graph cutover and references feedbax/4fcb0fc as the old-API design concern."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885778,
    "observed_kind": null
  },
  {
    "id": "65635ea29be6b7afdc50175b28fc7a1cf674823515f9a340c36b2bfec678141d",
    "project_key": "feedbax",
    "short_id": "65635ea",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Historical comments record both stages of the requested redesign: moving CartesianState handling to PointMass and then converting AbstractLTISystem to LTISystem composition.",
    "evidence": [
      {
        "source": "issue report feedbax/65635ea comments",
        "quote_or_summary": "comments record the generalization and final conversion from AbstractLTISystem inheritance to LTISystem composition"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885701,
    "observed_kind": null
  },
  {
    "id": "75a4665b3538a0ee51dade4c96a7a593f91be434442ab21a8401cb4e7d2ea01b",
    "project_key": "feedbax",
    "short_id": "75a4665",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has implementation notes, focused verification, a develop merge, and an explicit resolved-by-commit record covering the requested compatibility UX.",
    "evidence": [
      {
        "source": "issue report feedbax/75a4665 comments",
        "quote_or_summary": "implementation and browser verification completed; develop contains the behavior through merge 27384a2; resolved by commit 27384a2"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "974b9ba189bd87125ffaea9be31012e83790b91e1a76eb5c11bb356cbaa4ecde",
    "project_key": "feedbax",
    "short_id": "974b9ba",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has implementation notes, focused tests/build verification, a develop merge, and an explicit resolved-by-commit record covering the schema vocabulary contract.",
    "evidence": [
      {
        "source": "issue report feedbax/974b9ba comments",
        "quote_or_summary": "schema vocabulary implemented and verified; develop contains the work through merge 27384a2; resolved by commit 27384a2"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "a3e46d5e1435580bbd33f661da6604a9482eaa85c633f5d24d943ef15e4d1c24",
    "project_key": "feedbax",
    "short_id": "a3e46d5",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The umbrella's historical closeout explicitly says it is closing as subsumed by feedbax/1088451, so this is a supersession/folded-plan disposition rather than delivery of every item in the old umbrella.",
    "evidence": [
      {
        "source": "issue report feedbax/a3e46d5 comments",
        "quote_or_summary": "Closing as subsumed by feedbax/1088451; the old umbrella is retained as historical context"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "bc73002b893d776a11fefc678a6de18c640a8fb6633f8ee62908a7016472c15a",
    "project_key": "feedbax",
    "short_id": "bc73002",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The historical comment states the caching problem was solved by implementing a cached validation_trials property in AbstractTask backed by a subclass get_validation_trials method.",
    "evidence": [
      {
        "source": "issue report feedbax/bc73002 comments[0]",
        "quote_or_summary": "solved for now by making subclasses implement get_validation_trials and validation_trials a cached property in AbstractTask"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885740,
    "observed_kind": null
  },
  {
    "id": "f93db6a30fb95e97168295bf12b74fd851463b4d07d3a211f295c14c7600c138",
    "project_key": "feedbax",
    "short_id": "f93db6a",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue has a completed integration auth merge plus comments describing the persisted recurrence contract, focused verification, and the exact resolving commit.",
    "evidence": [
      {
        "source": "issue report feedbax/f93db6a auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=integration/graphspec-runtime-retention, base_branch=develop, exit_code=0"
      },
      {
        "source": "issue report feedbax/f93db6a comments",
        "quote_or_summary": "core recurrence support is on develop through merge 27384a2 and resolved by commit 27384a2"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "00b046ed9c2357f38d604e02d56d2364c89051515654a8247793a00a21cf49ec",
    "project_key": "mandible",
    "short_id": "00b046e",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's comment explicitly records the standalone Mandible fix and identifies the resolving commit.",
    "evidence": [
      {
        "source": "issue report mandible/00b046e comments[0]",
        "quote_or_summary": "Resolved by commit 5c85783; auth-merge pre-auth-check now filters untracked files from dirty-tree detection"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "215897e19af5a8dc0a61a62d5c3d0b186e436bb8815858b6119661293156d3c5",
    "project_key": "mandible",
    "short_id": "215897e",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's comment explicitly records the standalone Mandible fix and identifies the resolving commit.",
    "evidence": [
      {
        "source": "issue report mandible/215897e comments[0]",
        "quote_or_summary": "Resolved by commit 5c85783; auth-request.sh uses updated --pinned flag syntax"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "40a3976d1d6c5a8560cd0f6436c7d41dc90bcff9e03138b0840e60ad32bb8dbf",
    "project_key": "mandible",
    "short_id": "40a3976",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The issue has an explicit resolving commit and a concrete summary of structured diff and issue-linking support, but the single comment does not separately verify every original execution-resilience sub-requirement.",
    "evidence": [
      {
        "source": "issue report mandible/40a3976 comments[0]",
        "quote_or_summary": "Resolved by commit 86c71a8; added /api/graph with full Bug trailer parsing and umbrella inference for structured diff data and issue linking"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "6e31c5fd8bffd48797348587809b832ca421575a75884a717256aaef657c006a",
    "project_key": "mandible",
    "short_id": "6e31c5f",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's comment explicitly records the standalone Mandible fix and identifies the resolving commit.",
    "evidence": [
      {
        "source": "issue report mandible/6e31c5f comments[0]",
        "quote_or_summary": "Resolved by commit 5c85783; auth-request.sh distinguishes API errors from connection failures using HTTP status"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "a7ef2fe5ec4ccb35341aea72a76bd98fbe70b00d1bf907ea88fa4750b32f090d",
    "project_key": "mandible",
    "short_id": "a7ef2fe",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's comment explicitly records the standalone Mandible fix and identifies the resolving commit.",
    "evidence": [
      {
        "source": "issue report mandible/a7ef2fe comments[0]",
        "quote_or_summary": "Resolved by commit 5c85783; auth-request.sh passes head_branch and base_branch correctly"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "c26d9b5edfd0d7b8eab83a78d2a486588b0baef4d7406ac8a090bb957196e5a2",
    "project_key": "mandible",
    "short_id": "c26d9b5",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The issue's comment explicitly records the standalone Mandible fix and identifies the resolving commit.",
    "evidence": [
      {
        "source": "issue report mandible/c26d9b5 comments[0]",
        "quote_or_summary": "Resolved by commit 5c85783; auth-merge detects in-progress merges and resumes with --continue"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "8dfcb5e6670f1e2b0eff2aa13a85d78301a1c73b4052bf83c4d1b4a8d3a5d50a",
    "project_key": "mll-bio",
    "short_id": "8dfcb5e",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "A completed auth merge for the exact chat-log MDX feature branch is recorded with exit code 0.",
    "evidence": [
      {
        "source": "issue report mll-bio/8dfcb5e auth_requests[0]",
        "quote_or_summary": "status=completed, head_branch=feature/chat-log-mdx, base_branch=main, exit_code=0"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "753508cbb670c2680aaf0a016101c908ae8a75c7355ad16aadcea8f52d96733f",
    "project_key": "rlrmp",
    "short_id": "753508c",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The analysis itself was completed and committed; the later disposition only moves it to historical/background status under the new plan, which does not erase the documentary outcome.",
    "evidence": [
      {
        "source": "issue report rlrmp/753508c comments",
        "quote_or_summary": "Resolved by commit 16ef7f3; disposition says it remains useful historical/background analysis under rlrmp/43e8728"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812897217,
    "observed_kind": null
  },
  {
    "id": "f695729a4f0fac5c0bed8433a42d7455cdf0b2c317b97dcd81637bb5362d7537",
    "project_key": "rlrmp",
    "short_id": "f695729",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The administrative closeout explicitly says the old programme was superseded by rlrmp/43e8728 and that closure is not evidence the nine-stage programme was completed.",
    "evidence": [
      {
        "source": "issue report rlrmp/f695729 comments",
        "quote_or_summary": "Superseded as active phase skeleton by rlrmp/43e8728; administrative note says this is a supersession closure, not completion"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "d94da60fd783e698142041cf50da922a22eb5410ff52f0ed0094f06c1c7d99f5",
    "project_key": "bbooddyy",
    "short_id": "d94da60",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested six-condition experiment script is present and implements the stated n_steps=200 correction and OOM retry.",
    "evidence": [
      {
        "source": "git:bbooddyy@85d61f7",
        "quote_or_summary": "Commit adds the six-condition comparison script and carries Bug: d94da60; the current script asserts n_steps=200 and contains OOM retry handling."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "094c9223937b51cd9073545fed1c07c32353231ea8d4b389f8a104f4f1991672",
    "project_key": "dotfiles",
    "short_id": "094c922",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The SubagentStart pane-spawning hook was implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@fe19167",
        "quote_or_summary": "Commit 'Wire SubagentStart hook to spawn Zellij panes for subagent streams' carries Bug: 094c922."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849877,
    "observed_kind": null
  },
  {
    "id": "112dddf2705051a84a0d569c693b53324d8bd40a3ea8c8d697230a0465da4fe4",
    "project_key": "dotfiles",
    "short_id": "112dddf",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested answer-ordering policy was included in the documented policy batch.",
    "evidence": [
      {
        "source": "git:dotfiles@8772818",
        "quote_or_summary": "Commit 'add CLAUDE.md directives for communication, testing, resilience, and workflow conventions' carries Bug: 112dddf."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812860966,
    "observed_kind": null
  },
  {
    "id": "1f61211adb2f93f4f21509229ba7f9b02f3f283488c7c6c89732ab6a2af904dd",
    "project_key": "dotfiles",
    "short_id": "1f61211",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The issue was explicitly closed as a duplicate of the equivalent canonical issue cca7243.",
    "evidence": [
      {
        "source": "issue-comment:dotfiles/1f61211",
        "quote_or_summary": "Comment says it is a duplicate of cca7243 and closes this record in favor of it."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812861814,
    "observed_kind": null
  },
  {
    "id": "25e2cbe222461d5c8f55a62931c24b9140e427fb554f8408b26f8cba7e786d45",
    "project_key": "dotfiles",
    "short_id": "25e2cbe",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested Remote Debugging Discipline documentation was explicitly confirmed present.",
    "evidence": [
      {
        "source": "issue-comment:dotfiles/25e2cbe",
        "quote_or_summary": "Two comments confirm the section is implemented in CLAUDE.md under Conventions; the related policy commit is 424fccf."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812852619,
    "observed_kind": null
  },
  {
    "id": "2ec38f610ab48fcf83c25630a176124065d5d15540df25e218ef14b251612112",
    "project_key": "dotfiles",
    "short_id": "2ec38f6",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The worktree MERGE_HEAD detection bug was fixed.",
    "evidence": [
      {
        "source": "git:dotfiles@2276c4c",
        "quote_or_summary": "Commit fixes PreToolUse to resolve the git dir and carries Bug: 2ec38f6."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850805,
    "observed_kind": null
  },
  {
    "id": "40e4b8219e461a442ab7e0084efc609e973b9118a9476222fb631561a35b2780",
    "project_key": "dotfiles",
    "short_id": "40e4b82",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The stale takeissuewith reference was removed.",
    "evidence": [
      {
        "source": "git:dotfiles@6102462",
        "quote_or_summary": "Commit removes the stale /takeissuewith skill reference and carries Bug: 40e4b82."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812860725,
    "observed_kind": null
  },
  {
    "id": "448bc91b179a4371ca5a6ddf02e62dc200e67020eacdb5e02e8b4d81b6c837a0",
    "project_key": "dotfiles",
    "short_id": "448bc91",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The pane wrapper behavior was corrected as requested.",
    "evidence": [
      {
        "source": "git:dotfiles@018f00e",
        "quote_or_summary": "Commit fixes codex-pane direction and removes the open-command fallback; it carries Bug: 448bc91."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849839,
    "observed_kind": null
  },
  {
    "id": "5230a358157e9ea97795e2531c8a8c33914f5c964280428340b20439c66c915d",
    "project_key": "dotfiles",
    "short_id": "5230a35",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The workflow-rule persistence requirement was added to the policy batch.",
    "evidence": [
      {
        "source": "git:dotfiles@8772818",
        "quote_or_summary": "The policy commit carries Bug: 5230a35 and documents the workflow convention."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "551ace27b3a28f0b911b45e528b791b40007be2b1083d13317e72fb49381a743",
    "project_key": "dotfiles",
    "short_id": "551ace2",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The standalone Mandible extraction and Tauri-wrapper scope was explicitly reported complete.",
    "evidence": [
      {
        "source": "issue-comment:dotfiles/551ace2",
        "quote_or_summary": "Comment says Mandible was extracted to the standalone repo; the Tauri child also reports its wrapper added."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "670e375dbb431684bff7008139ed65f490d7ebe9977a816537125cc04f0ed9b8",
    "project_key": "dotfiles",
    "short_id": "670e375",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Automatic issue closure from Bug trailers was implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@14fd509",
        "quote_or_summary": "Commit adds auto-close on merge and the setting, carrying Bug: 670e375."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "68fca3ed0e33000797c417df8fa857af4ae1ea5e05d50bc5b78ec634bccee66e",
    "project_key": "dotfiles",
    "short_id": "68fca3e",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The history-card padding and reload-toast issue-link changes were implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@2e730ed",
        "quote_or_summary": "Commit fixes history card padding and adds issue links to the reload toast; it carries Bug: 68fca3e."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850440,
    "observed_kind": null
  },
  {
    "id": "72949b0b63fde4f9ce1ae81336e19ea6cde6eadb6711eb5a21e643d26a1572e5",
    "project_key": "dotfiles",
    "short_id": "72949b0",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The expandable auth-card execution console was merged successfully.",
    "evidence": [
      {
        "source": "auth-request:1c50820d-cae0-4e67-b22c-2255100d4e34",
        "quote_or_summary": "Read-only auth query shows completed, exit_code 0, feature/auth-console-output, and six changed files for issue 72949b0."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850201,
    "observed_kind": null
  },
  {
    "id": "7970115730b4f06b5e3b4bf84aae8e27f2224a58c103fdcda7d9b1907713d289",
    "project_key": "dotfiles",
    "short_id": "7970115",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The session registry v2 scope was implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@7541f99",
        "quote_or_summary": "Commit implements projects, context menus, duration, and layout and carries Bug: 7970115."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850726,
    "observed_kind": null
  },
  {
    "id": "7eebb0c82de225cdc934912afb143beb7d5413241dd8056ed0018241b7421af8",
    "project_key": "dotfiles",
    "short_id": "7eebb0c",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The notify and reaper settings integration was implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@4f15a54",
        "quote_or_summary": "Commit wires claude-notify and claude-reaper to CP API settings and carries Bug: 7eebb0c."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "88a4472342f82487b45a2a5e3f63f1714d4e1118faa87dc69617d310b9de5618",
    "project_key": "dotfiles",
    "short_id": "88a4472",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The Tauri native window wrapper was explicitly reported added.",
    "evidence": [
      {
        "source": "issue-comment:dotfiles/88a4472",
        "quote_or_summary": "Comment says the Tauri wrapper was added to the standalone Mandible repo under src-tauri/."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "90297db09c3dc66742a7128bcb5e829f1e7ee9fc29d3a63889cfb5c309f78ca7",
    "project_key": "dotfiles",
    "short_id": "90297db",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The six-section settings dashboard was implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@2ef1b4b",
        "quote_or_summary": "Commit expands the settings dashboard to six sections and carries Bug: 90297db."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "9d0725a692f8e576bd2694141b521ce143d059cf448b4ffbea91f7ea4e806d11",
    "project_key": "dotfiles",
    "short_id": "9d0725a",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The completeness-check policy for discussion-derived specs was added in the policy batch.",
    "evidence": [
      {
        "source": "git:dotfiles@8772818",
        "quote_or_summary": "The policy commit carries Bug: 9d0725a and is the direct historical implementation evidence."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812861093,
    "observed_kind": null
  },
  {
    "id": "a7021047b657485e7b3b4f2214b3a66a6e0869a94b74e2545481ae886130890c",
    "project_key": "dotfiles",
    "short_id": "a702104",
    "resolution": "wontfix",
    "confidence": "high",
    "rationale": "This was explicitly a temporary test issue intended to be closed immediately, not a durable deliverable.",
    "evidence": [
      {
        "source": "issue-report:dotfiles/a702104",
        "quote_or_summary": "Body says 'Temporary test issue — will be closed immediately'; no substantive requested outcome exists."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812862234,
    "observed_kind": null
  },
  {
    "id": "b3006e4f938e7e10f7f98fc477c1c36a8b82a090407153ac0748479f984c2838",
    "project_key": "dotfiles",
    "short_id": "b3006e4",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The third-party timeout and rate-limit handling policy was included in the policy batch.",
    "evidence": [
      {
        "source": "git:dotfiles@8772818",
        "quote_or_summary": "The policy commit carries Bug: b3006e4 and adds the requested resilience/workflow directives."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "bb4e07bb54ec7b02e534a7945ec05384cc4604d73a09c2e87370f9f572bd3733",
    "project_key": "dotfiles",
    "short_id": "bb4e07b",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The auth-history, issue-detail JSON, and session-issue filtering fixes were implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@7fd12ca",
        "quote_or_summary": "Commit title matches the requested backend fixes and carries Bug: bb4e07b."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "c130daca9fefe259ddacab488eda9490a738d3bf3d5e9daa7a2d2d8f622b7970",
    "project_key": "dotfiles",
    "short_id": "c130dac",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The Zellij plugin loading failure was addressed by restoring the plugin binary and pane-query support.",
    "evidence": [
      {
        "source": "git:dotfiles@812373e",
        "quote_or_summary": "Commit restores zj-control.wasm and updates zj-query, directly addressing the missing plugin/_start failure described by the issue."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850882,
    "observed_kind": null
  },
  {
    "id": "c8a9014b9c37cfc167ad571bb3c60b896105779968ff6debecc6bbb7fb31b7a0",
    "project_key": "dotfiles",
    "short_id": "c8a9014",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The PreToolUse safe-mode toggle was implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@2f61cfc",
        "quote_or_summary": "Commit adds the pretool_hooks_enabled safe-mode toggle and carries Bug: c8a9014."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "cca7243be1ff506cbbdae30613b027a4a8786df2a12d4ab635ace7ec498d5a72",
    "project_key": "dotfiles",
    "short_id": "cca7243",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The canonical branch-use policy issue was implemented in the policy batch.",
    "evidence": [
      {
        "source": "git:dotfiles@8772818",
        "quote_or_summary": "The policy commit carries Bug: cca7243; the later 1f61211 record explicitly identifies this issue as the canonical duplicate target."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812861765,
    "observed_kind": null
  },
  {
    "id": "d51fbc86aba0d39329872b20e61f44eb97b22e1cd54a6170207c1cc138b672d1",
    "project_key": "dotfiles",
    "short_id": "d51fbc8",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The chat-log ingestion/viewing/export umbrella was merged successfully.",
    "evidence": [
      {
        "source": "auth-requests:31a22abf-0702-4c61-8f3f-0331d28ff5ae,168ff0b6-8888-4af5-8de1-f497ad8234e7",
        "quote_or_summary": "Read-only auth queries show both requests completed with exit_code 0 and changes bound to issue d51fbc8; the report also shows all three partitions closed."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "dca90c5025c4454df7d307dfd05be40dbd53c2f0ddce36d46a19d5d900e3a1e5",
    "project_key": "dotfiles",
    "short_id": "dca90c5",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The post-merge control-plane rebuild hook was implemented and merged successfully.",
    "evidence": [
      {
        "source": "auth-request:6e75347e-1be4-49c5-8597-7cb0c9bb71f2",
        "quote_or_summary": "Auth query shows completed, exit_code 0, feature/post-merge-cp-rebuild, one changed file, and issue dca90c5; commit 3e7dd79 carries the issue reference."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812849725,
    "observed_kind": null
  },
  {
    "id": "ea601345b6b5b3b6de2bf74d7a701790f51e5b5bab5b73c6b4b1296472051b0d",
    "project_key": "dotfiles",
    "short_id": "ea60134",
    "resolution": "wontfix",
    "confidence": "high",
    "rationale": "This is a placeholder record with no actionable content or identifiable requested outcome.",
    "evidence": [
      {
        "source": "issue-report:dotfiles/ea60134",
        "quote_or_summary": "Report body is only 'Desc' with title 'Title'; no comments, branches, auth, or work evidence exist."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812855097,
    "observed_kind": null
  },
  {
    "id": "ef884055b2405e093f656366fc79dce33888bd15f69ef14b32cc91512bf62ca0",
    "project_key": "dotfiles",
    "short_id": "ef88405",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The work overview v2 features were implemented.",
    "evidence": [
      {
        "source": "git:dotfiles@8a3f3bd",
        "quote_or_summary": "Commit implements ahead/behind, pinning, filtering, and context menus and carries Bug: ef88405."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812850688,
    "observed_kind": null
  },
  {
    "id": "ff7410c9b28202cd962d538c718391cf9f92f42cdde96ad34fd1f1eb34148db2",
    "project_key": "dotfiles",
    "short_id": "ff7410c",
    "resolution": "delivered",
    "confidence": "medium",
    "rationale": "The requested auth DELETE documentation exists in the canonical standalone Mandible CLAUDE.md, and the linked P1 documentation rewrite is merged; the old dotfiles location was explicitly noted as pending, so this is semantic delivery after the documentation split rather than exact old-file proof.",
    "evidence": [
      {
        "source": "issue-report:dotfiles/ff7410c; parent:dotfiles/b608ad9",
        "quote_or_summary": "Issue comment confirms the canonical standalone docs contain the DELETE format; linked P1 rewrite b608ad9 is resolved as merged; current Mandible CLAUDE.md documents DELETE /api/auth/request/<id>."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812858791,
    "observed_kind": null
  },
  {
    "id": "0866f1d8dd59c87117cbd03f39ea70db3d88a8a16b50ba656250ce7ef2807387",
    "project_key": "feedbax",
    "short_id": "0866f1d",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The dimension propagation engine and parameter-sync scope was implemented and committed.",
    "evidence": [
      {
        "source": "issue-comment:feedbax/0866f1d",
        "quote_or_summary": "Closeout comment says the schema/dimension/recurrence merge 27384a2 is on develop and no remaining closeout work is attached."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "2299344236e21f1d24ec96d323f304e61f7c97aa8af0ca63bfb7f10b55d868cb",
    "project_key": "feedbax",
    "short_id": "2299344",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The requested AbstractTaskTrialSpec replacement was completed.",
    "evidence": [
      {
        "source": "github-comment:feedbax/2299344",
        "quote_or_summary": "Historical GitHub comment says AbstractTaskTrialSpec was replaced by TaskTrialSpec in c25cce71d956d3ddfea547201c69bca89714ce7b."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885854,
    "observed_kind": null
  },
  {
    "id": "4b5941a1de2e6f106a43f37ce367e2f3d0f8764fab2dfe0df94ce88c4c93d7e2",
    "project_key": "feedbax",
    "short_id": "4b5941a",
    "resolution": "wontfix",
    "confidence": "high",
    "rationale": "This is a placeholder record with no actionable content or identifiable requested outcome.",
    "evidence": [
      {
        "source": "issue-report:feedbax/4b5941a",
        "quote_or_summary": "Report body is only 'Desc' with title 'Title'; no comments, branches, auth, or work evidence exist."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812888233,
    "observed_kind": null
  },
  {
    "id": "590d951b2423d7f07c518a395f2bb05faa793bde1c9ca3327cbbe2460b1c1ea0",
    "project_key": "feedbax",
    "short_id": "590d951",
    "resolution": "wontfix",
    "confidence": "low",
    "rationale": "The issue required user-created artwork, but the record has no completion evidence and the requested favicon artifact is absent from the current checkout.",
    "evidence": [
      {
        "source": "issue-report:feedbax/590d951; repo-scan:feedbax",
        "quote_or_summary": "Body explicitly requires user action in Affinity Designer; no completion comment exists and no favicon file was found. Closure alone does not prove delivery."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "690615710baeb80936c296717e82db0a6c3dfa44ac164e7d60c78afdf973386c",
    "project_key": "feedbax",
    "short_id": "6906157",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The trajectory viewer umbrella was merged successfully.",
    "evidence": [
      {
        "source": "auth-request:7617d0d2-0f09-4585-8250-fed3af60c966",
        "quote_or_summary": "Read-only auth query shows completed, exit_code 0, feature/trajectory-viewer, 17 changed files, and issue 6906157."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812884690,
    "observed_kind": null
  },
  {
    "id": "76f712030fb29bf60291eeac7b431c3e6f080323c7fc93ebe9dcac333170e770",
    "project_key": "feedbax",
    "short_id": "76f7120",
    "resolution": "wontfix",
    "confidence": "high",
    "rationale": "The reported disconnected port was explicitly determined not to be a bug and was superseded by a separate redundancy-removal issue.",
    "evidence": [
      {
        "source": "issue-comment:feedbax/76f7120",
        "quote_or_summary": "Comment says the feedback port is intentionally unused, the issue is not a bug, and the real issue is GRUOracle redundancy under 63eb0a9."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "981fc5aa4b04131c9b0eca429d1bfa5feb21325d592c9683e83cc3bf58f0baaf",
    "project_key": "feedbax",
    "short_id": "981fc5a",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The historical Optax opt_state shape issue was fixed in the repository.",
    "evidence": [
      {
        "source": "git:feedbax@308ec205",
        "quote_or_summary": "Commit title is 'Fix the opt_state changes shape issue', matching the imported GitHub issue."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779812885623,
    "observed_kind": null
  },
  {
    "id": "a8d2579609f4cc7b8707a9c801b51cd8b3ba70f1af7f80343c95c0e205371075",
    "project_key": "feedbax",
    "short_id": "a8d2579",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The generalized loss-term functionality was implemented.",
    "evidence": [
      {
        "source": "github-comment:feedbax/a8d2579",
        "quote_or_summary": "Historical GitHub comment says a working implementation is available in c25cce71 and names TargetStateLoss and TargetSpec."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "df2ba4bcdc3921dd2ad80a9e0a09d49221c11adc191a29911de04ca68974185a",
    "project_key": "feedbax",
    "short_id": "df2ba4b",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The malformed record was explicitly closed as a duplicate of d18cf9c, the intended tracker.",
    "evidence": [
      {
        "source": "issue-comment:feedbax/df2ba4b",
        "quote_or_summary": "Comment says the original body was corrupted and d18cf9c contains the intended text; this record is the malformed duplicate."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "670ec5984fdc6b6fae38572bf8b58505c3cac304e730668ecc23a69f027fc2a4",
    "project_key": "humbleb",
    "short_id": "670ec59",
    "resolution": "wontfix",
    "confidence": "high",
    "rationale": "The issue records an intentional, validated early-stop assumption rather than an unfixed defect.",
    "evidence": [
      {
        "source": "issue-report:humbleb/670ec59",
        "quote_or_summary": "Body states the monotonicity assumption is intentional for the targeted local models, saves compute, and was validated against prior runs."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "13f7c92fedac3284222e085b4e30967519b44e92f4ec63b88c6c5c8e62b8f992",
    "project_key": "mandible",
    "short_id": "13f7c92",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The issue was explicitly closed as a duplicate of 93c57c4, which owns the same bug and the fix.",
    "evidence": [
      {
        "source": "issue-comment:mandible/13f7c92",
        "quote_or_summary": "Comment says this record is a duplicate, its analysis was added to 93c57c4, and the fix is tracked there."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "33214c766d95f117ff00587d85b6d14fce72d4b71067d07a071974e9b4195d71",
    "project_key": "mandible",
    "short_id": "33214c7",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The macOS bash compatibility fix was implemented.",
    "evidence": [
      {
        "source": "issue-comment:mandible/33214c7",
        "quote_or_summary": "Comment says the fix landed in commit 5c85783 and ported the shebang fix to the standalone repo."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "4980617079f2ec5192b2b85d3e071bbaf485dce05fe1cf1dd724c8a21836d8f6",
    "project_key": "mandible",
    "short_id": "4980617",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The auth-merge restart race was fixed.",
    "evidence": [
      {
        "source": "issue-comment:mandible/4980617",
        "quote_or_summary": "Comment says commit 1fc4b45 backgrounds the daemon restart with a three-second delay and carries Bug: 4980617."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "723628e1214adfe8979e199b6529b8b321026d117ca354e5b23c08b97ed00644",
    "project_key": "mandible",
    "short_id": "723628e",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The stale test schema and AuthQueue guard were fixed and merged.",
    "evidence": [
      {
        "source": "issue-comment:mandible/723628e",
        "quote_or_summary": "Comment records the attempted alignment and says it was resolved by merge 341039320a95."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "b34fdf2e4af4f597bf70220505a5ebb873ae3a68bf27f9019382ab840ce5eee9",
    "project_key": "mandible",
    "short_id": "b34fdf2",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "Desktop startup and daemon lifecycle handling were implemented and merged.",
    "evidence": [
      {
        "source": "issue-comment:mandible/b34fdf2",
        "quote_or_summary": "Comment says it was resolved by merge 118b70e73dd0; parent e85c5bc documents the delivered bootstrap and daemon-control scope."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "e74dcfb994a3a34d8925ea25f09b31a07a907fec66ad65b1fa8bdd9a7ffb2a09",
    "project_key": "mandible",
    "short_id": "e74dcfb",
    "resolution": "delivered",
    "confidence": "high",
    "rationale": "The label-test record has explicit commit resolution.",
    "evidence": [
      {
        "source": "issue-comment:mandible/e74dcfb",
        "quote_or_summary": "Comment says it was resolved by commit c9dac2ba3271."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "35f64be19459a170905641c7a88cd937be2152ae21d342e79b63646840657a06",
    "project_key": "rlrmp",
    "short_id": "35f64be",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "This v1 experiment plan was explicitly superseded by v2 and then retained only as historical material under the game-equivalence umbrella.",
    "evidence": [
      {
        "source": "issue-comments:rlrmp/35f64be",
        "quote_or_summary": "Comments identify 6f783fa and then 43e8728 as the canonical successors and say not to use this issue as the canonical plan."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "84ee4ffa55979b32d0d743af4ac80f9dde9a2ee6bbdcc9837cabb93ad7fbc1d6",
    "project_key": "rlrmp",
    "short_id": "84ee4ff",
    "resolution": "wontfix",
    "confidence": "high",
    "rationale": "The record has an explicit disposition that APT/CVaR are not the first path and should be revisited only after the certified game path; it was then marked resolved by commit.",
    "evidence": [
      {
        "source": "issue-comment:rlrmp/84ee4ff",
        "quote_or_summary": "Disposition comment says APT/CVaR remain context but are not pursued first under 43e8728; a following comment records resolution by commit 16ef7f3."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": null
  },
  {
    "id": "3c60ddef3c2f2cdee10c6d742f460bd70a720b1858b7c9b3dd129ddff4858757",
    "project_key": "feedbax",
    "short_id": "3c60dde",
    "resolution": "duplicate",
    "confidence": "high",
    "rationale": "The issue is duplicate provenance: its body and first comment identify fd0dc34 as the covering issue, and a structured duplicate_of edge points to that issue. This reviewed override supersedes the stale typed fixed value.",
    "evidence": [
      {
        "source": "metadata-exceptions@2",
        "quote_or_summary": "The body and comment identify duplicate provenance, and structured duplicate_of points to fd0dc34."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1781539806876,
    "observed_kind": "feature"
  }
] as const;

/**
 * The kind-review manifest is intentionally a separate, explicit input. Its
 * observed fields are copied from the review snapshot so the migration can
 * reject stale or cross-project decisions before applying them.
 */
export const REVIEWED_KIND_MIGRATION_DATA: readonly ReviewedKindMigrationRecord[] = [
  {
    "id": "04e727c58f15b2e54fe1002a58a93bb268023b3f4bf24092ed39b8c1bc58638b",
    "project_key": "feedbax",
    "short_id": "04e727c",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The issue requests a new ability to add interventions to an existing ensembled model; the current failure is the implementation constraint motivating it.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The desired behavior is to add an intervention to an existing ensembled model at any time, rather than only during model construction."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "05256eb4d882f1b243f4557d6ffed8a4f7ffd93e452d59871207d6010deee22c",
    "project_key": "rlrmp",
    "short_id": "05256eb",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "This is an experimental training run for a named controller family.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The issue names a controller-training experiment rather than a software capability or maintenance task."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782447581750,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "0531a0d3d5729bc83a84618c6d5f30adde48bab0f30cce44360fda4165f2a9b3",
    "project_key": "mandible",
    "short_id": "0531a0d",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Scope Coordinate the 2026-06-30 IAB review follow-ups across Timeline, Artifacts, Spaces, and Auth. The user annotated browser comments in the live Mandible IAB preview on `integration/mandible-iab-preview-20260630-97cb5c4`. The first two batches were integrated, then a further browser review identified two remaining follow-up lanes: large artifact preview sizing/lazy loading and preview-disabled notice placement ",
    "evidence": [
      {
        "source": "issue report for mandible/0531a0d",
        "quote_or_summary": "## Scope Coordinate the 2026-06-30 IAB review follow-ups across Timeline, Artifacts, Spaces, and Auth. The user annotated browser comments in the live Mandible IAB preview on `integration/mandible-iab-preview-20260630-97cb5c4`. The first two batches were integrated, then a further browser review identified two remaining follow-up lanes: large artifact preview sizing/lazy loading and preview-disabled notice placement above Auth/Spaces headers. ## Children | issue | scope | branch | state | | --- | --- | --- | --- | "
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782948791120,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "078a7433cb4d0eeb39e95ce3db19e9876cd2c1529cca33ed02115026d58029a8",
    "project_key": "rlrmp2",
    "short_id": "078a743",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "The body defines a concrete cleanup and audit deliverable with deletion, lint, classification, and factoring gates.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The purpose is to make landed scientific source smaller, remove proven-dead machinery, resolve Ruff findings, classify violations, and route general capability pressure."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788370787804,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "07fa59b0471eb5181af56a38d720290331e3dadc81840de5f34c162366d9938c",
    "project_key": "mandible",
    "short_id": "07fa59b",
    "kind": "umbrella",
    "confidence": "medium",
    "rationale": "The objective is an artifact-backed Briefing detail capability with several direct child lanes for parity, aggregation, parser/API binding, and detail submission. The issue is the coordinating program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/07fa59b (title)",
        "quote_or_summary": "Briefings as artifacts: response directives embedded in markdown"
      },
      {
        "source": "mandible issue report mandible/07fa59b (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=open."
      },
      {
        "source": "mandible issue report mandible/07fa59b (body)",
        "quote_or_summary": "The objective is an artifact-backed Briefing detail capability with several direct child lanes for parity, aggregation, parser/API binding, and detail submission. The issue is the coordinating program."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787020136862,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "08483d59ebdf951a6de0296bdf4ad42a610673cadf3cae2097db21c89b8f6693",
    "project_key": "rlrmp",
    "short_id": "08483d5",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The report centers one capability or implementation lane; related children or labels do not change that single-lane purpose: Part of [issue:54389a4]. Related to [issue:0a46652], [issue:b413bb0], [issue:ae9f30f], [issue:3c5836c], [issue:9bb676f], and [issue:5720a49]. Goal: define and test adaptive soft-adversary procedures before preparing any new launch-facing training run. The immediate question is whether adaptive lambda can keep the adversary active and scientifically meaningful without treating old cap, radius, or trust-region numbers ",
    "evidence": [
      {
        "source": "issue report for rlrmp/08483d5",
        "quote_or_summary": "Part of [issue:54389a4]. Related to [issue:0a46652], [issue:b413bb0], [issue:ae9f30f], [issue:3c5836c], [issue:9bb676f], and [issue:5720a49]. Goal: define and test adaptive soft-adversary procedures before preparing any new launch-facing training run. The immediate question is whether adaptive lambda can keep the adversary active and scientifically meaningful without treating old cap, radius, or trust-region numbers as default bounds. Motivation: fixed lambda selection has not produced a stable launch-facing method"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782876894163,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "08fa4648692dee6235f997352bd868577077cf6e2576179f900316d2ad8ba908",
    "project_key": "rlrmp",
    "short_id": "08fa464",
    "kind": "experiment",
    "confidence": "medium",
    "rationale": "The body asks an empirical question about training-batch versus nominal-probe damage and specifies a training variant, so the canonical kind is experiment.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/08fa464 (title)",
        "quote_or_summary": "Training-batch-basis damage clamp: drive lambda from the EMA of training-batch damage"
      },
      {
        "source": "mandible issue report rlrmp/08fa464 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      },
      {
        "source": "mandible issue report rlrmp/08fa464 (body)",
        "quote_or_summary": "The body asks an empirical question about training-batch versus nominal-probe damage and specifies a training variant, so the canonical kind is experiment."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783807998199,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "097d2b768c4881e1a3a1c48a03a4a51762cb18e90823804d80c726c51ea2356a",
    "project_key": "mandible",
    "short_id": "097d2b7",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue defines and coordinates a central ledger architecture, import/export, and many typed operational entities.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The direction includes a Mandible-owned backend, typed entities, event/history projections, and isolated git-bug import/export compatibility."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "09aed43510bb75c385e2f72381954ecde9b3ce6b2ad4827578adb0790fbeb836",
    "project_key": "rlrmp",
    "short_id": "09aed43",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body coordinates multiple upstream Feedbax lanes and corresponding RLRMP cleanup lanes.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Children cover Feedbax task/GraphSpec capabilities and RLRMP restoration, wrapper replacement, and deletion work."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781387750150,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "0a466526fe039f403c8a717449f4484659843f5991af4e48d262ee0e08394a53",
    "project_key": "rlrmp",
    "short_id": "0a46652",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Coordinate repair and principled calibration of soft-constraint adversary training before any further soft-adversary launch. The current soft-PGD first batch on [issue:d55c5f0] is invalid for scientific comparison because the adversary energy penalty was batch-summed while the task loss was batch-meaned; at batch size 64 this made the penalty approximately 64x too large and suppressed the adversary. This umbrella est",
    "evidence": [
      {
        "source": "issue report for rlrmp/0a46652",
        "quote_or_summary": "Coordinate repair and principled calibration of soft-constraint adversary training before any further soft-adversary launch. The current soft-PGD first batch on [issue:d55c5f0] is invalid for scientific comparison because the adversary energy penalty was batch-summed while the task loss was batch-meaned; at batch size 64 this made the penalty approximately 64x too large and suppressed the adversary. This umbrella establishes the corrected objective, the lambda scale, the closed-loop finite adversary classes, the di"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782867386390,
    "observed_kind": "umbrella",
    "observed_labels": [
      "experiment",
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "0c44fecfd53858cb659e64cdd80e1d721936f32a3a5bc29d58ddf05c827bf1d8",
    "project_key": "dotfiles",
    "short_id": "0c44fec",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The body identifies stale duplicate auth requests as a concrete queue defect and names the affected execution paths.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Duplicate pending requests can remain after a successful merge and later fail when approved; the body proposes post-success and pre-execution guards."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "bug",
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "0cbde8230255da3d3c025c2d58c4c25f70c5c9c6bc8a07da2d45319126046e84",
    "project_key": "rlrmp",
    "short_id": "0cbde82",
    "kind": "maintenance",
    "confidence": "medium",
    "rationale": "The body is repository instruction/runbook consolidation and stale-fact correction, which is maintenance rather than a product feature or experiment.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/0cbde82 (title)",
        "quote_or_summary": "De-drift AGENTS.md/CLAUDE.md into one canonical file; fix stale runbook facts"
      },
      {
        "source": "mandible issue report rlrmp/0cbde82 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|maintenance; status=open."
      },
      {
        "source": "mandible issue report rlrmp/0cbde82 (body)",
        "quote_or_summary": "The body is repository instruction/runbook consolidation and stale-fact correction, which is maintenance rather than a product feature or experiment."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781062476783,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "0fe1cd20aa12885b15f935690c8f86164ec258a75e93b5af370bb3931f1cd85a",
    "project_key": "rlrmp2",
    "short_id": "0fe1cd2",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The primary purpose is to organize a multi-arm comparator implementation and analysis package, not merely one code change: it owns the protocol lock, several solver/controller arms, shared rollout integration, and a reviewed child split.",
    "evidence": [
      {
        "source": "issue report body and coordinator reconciliation",
        "quote_or_summary": "The body lists comparator protocol, solver, controller, and rollout deliverables; a later comment records seven reviewed children and their merged implementation/analysis lanes."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784346665691,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "13baecc527ea29e8007b79a2b91aa7a9b89ce4749444f3665c2374c4b555a976",
    "project_key": "rlrmp",
    "short_id": "13baecc",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is package-structure maintenance and factoring, not a new scientific experiment.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The deliverable is a source-package reorganization into math and pipelines layers."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781231900401,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "1697bdc7a33297eb828e02d578b6454fea8b327c1d7af3df401eb6502792b49c",
    "project_key": "rlrmp",
    "short_id": "1697bdc",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "This is a scientific frozen-adversary search with mechanism-specific thresholds, outputs, and acceptance criteria, so experiment is the substantive kind.",
    "evidence": [
      {
        "source": "issue report body and completion comment",
        "quote_or_summary": "The body defines a practical lambda-threshold search with mechanism rows and required JSON/CSV/Markdown outputs; the closeout records the frozen search implementation and results."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496898,
    "observed_kind": "unknown",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "172e64264c9bb4773349c3fb5657b933598ec1dc69e141a5bf4ba693609cff55",
    "project_key": "rlrmp",
    "short_id": "172e642",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/172e642 (title)",
        "quote_or_summary": "Port delayed no-integrator branch through current Feedbax-native pipelines"
      },
      {
        "source": "mandible issue report rlrmp/172e642 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781467946998,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "17d8a1ba03763347d13415a11190d1f6f9d4d5145aa22b78eea2b97bb47e5362",
    "project_key": "mandible",
    "short_id": "17d8a1b",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Coordination umbrella for the 2026-08 `begood` leanness pass. Distinct from [issue:2070f2f], whose sequencing contract is explicitly *compatibility-preserving*; this pass operates under the newer standard, where net-negative LOC is a goal, legacy code is not retained \"just in case\", and fallbacks must fail loudly rather than degrade silently. [issue:2070f2f] remains the index for its own finite children table; overla",
    "evidence": [
      {
        "source": "issue report for mandible/17d8a1b",
        "quote_or_summary": "Coordination umbrella for the 2026-08 `begood` leanness pass. Distinct from [issue:2070f2f], whose sequencing contract is explicitly *compatibility-preserving*; this pass operates under the newer standard, where net-negative LOC is a goal, legacy code is not retained \"just in case\", and fallbacks must fail loudly rather than degrade silently. [issue:2070f2f] remains the index for its own finite children table; overlapping scope is noted per child. ## Measured baseline (main@e35c41d6, 2026-08-24) 1,019 tracked files"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787622871446,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "187573d591fb8282412b70ba5ac116d622dd21dac9b9ff1566fd3c7610ab2c72",
    "project_key": "mandible",
    "short_id": "187573d",
    "kind": "bug",
    "confidence": "medium",
    "rationale": "The scope starts from observed blank/stale Timeline rows and defines a concrete correctness repair. The child table is an implementation plan for that bug, not the issue's primary identity.",
    "evidence": [
      {
        "source": "mandible issue report mandible/187573d (title)",
        "quote_or_summary": "Timeline row materialization and residual correctness"
      },
      {
        "source": "mandible issue report mandible/187573d (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report mandible/187573d (body)",
        "quote_or_summary": "The scope starts from observed blank/stale Timeline rows and defines a concrete correctness repair. The child table is an implementation plan for that bug, not the issue's primary identity."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781208015970,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "19553e9f7150bd223f0c0ceae581efebd628aa40fddedb2b29be5be36905c5a7",
    "project_key": "feedbax",
    "short_id": "19553e9",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: This umbrella coordinated the follow-up alignment work discovered after [issue:09aed43]. It is now complete: the Feedbax waves are merged into `develop`, the RLRMP waves are merged into `main`, and all children are closed/done. Follow-up work that remains after this umbrella is tracked by [issue:64a04e0]. That successor is narrower: it covers active RLRMP consumption of Feedbax-native graph components plus Feedbax/RL",
    "evidence": [
      {
        "source": "issue report for feedbax/19553e9",
        "quote_or_summary": "This umbrella coordinated the follow-up alignment work discovered after [issue:09aed43]. It is now complete: the Feedbax waves are merged into `develop`, the RLRMP waves are merged into `main`, and all children are closed/done. Follow-up work that remains after this umbrella is tracked by [issue:64a04e0]. That successor is narrower: it covers active RLRMP consumption of Feedbax-native graph components plus Feedbax/RLRMP training-run spec alignment. This issue should remain historical and should not receive new impl"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1781540433973,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "1ab1fefff7082427dee7cea8dbc8b4dcf5ad33eae4d77d4280df19bec4ae4124",
    "project_key": "rlrmp",
    "short_id": "1ab1fef",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The title describes a bounded scientific trial with a named curriculum treatment.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "This is a short experimental trial of an epsilon-scaled adaptive curriculum."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783020706149,
    "observed_kind": "bug",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "1b27353fd3ce6bb49ae8e8efc6c15e25ec8b24c6e8fdf80eebf36a86cf61b120",
    "project_key": "mandible",
    "short_id": "1b27353",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue is a concrete Timeline UI defect/follow-up concerning header controls and axis pinning.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The requested correction is scoped to Timeline header controls and a pinned axis."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782222677521,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "1b274fa21f0b0580738cc61f883781b8f5413f7b92cf7ac8e4a48fe45cb73a4b",
    "project_key": "rlrmp",
    "short_id": "1b274fa",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The primary purpose is to coordinate a post-merge remediation wave across many defect fixes with one integration branch and protected-delivery context, making it an umbrella.",
    "evidence": [
      {
        "source": "issue report body",
        "quote_or_summary": "The body says it coordinates the remediation wave and lists 11 child issues with shared integration/auth context."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783319471171,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "project_key": "mandible",
    "short_id": "1bae3c4",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Decision Generalize the Project Timeline ([issue:41d22a6]) row model from \"rows are issues\" to **rows as declarative filters**, and upgrade the event substrate so filter rows have honest data to render: structured relationship records, label history, derived backlinks, and operational events on the timeline. This implements the direction recorded on [issue:4a0b3df] (2026-06-11): root rows as filter predicates plus",
    "evidence": [
      {
        "source": "issue report for mandible/1bae3c4",
        "quote_or_summary": "## Decision Generalize the Project Timeline ([issue:41d22a6]) row model from \"rows are issues\" to **rows as declarative filters**, and upgrade the event substrate so filter rows have honest data to render: structured relationship records, label history, derived backlinks, and operational events on the timeline. This implements the direction recorded on [issue:4a0b3df] (2026-06-11): root rows as filter predicates plus a built-in residual row; surfacing derives from queryable ledger state, never mandated bookkeeping."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781202841424,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "1c6293a786c3da3b51ebc7a0acef879cd8d13b960b0d704687169d246d3cd75e",
    "project_key": "feedbax",
    "short_id": "1c6293a",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/1c6293a (title)",
        "quote_or_summary": "Deterministic training-run orchestration — wave 1"
      },
      {
        "source": "mandible issue report feedbax/1c6293a (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783815953387,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "1c854dcda5195528a3025d406ad6a9af9ae57f19d6b6fdd0c83a268e202abea0",
    "project_key": "mandible",
    "short_id": "1c854dc",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/1c854dc (title)",
        "quote_or_summary": "Chat transcript presentation and indexed navigation"
      },
      {
        "source": "mandible issue report mandible/1c854dc (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787162750743,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "1f3236b2c0734707d613f5d863fe3c3db6e5853bef690640021b894407c37df7",
    "project_key": "feedbax",
    "short_id": "1f3236b",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates a broad compiler and round-trip correctness program rather than one isolated change.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The stored issue is an umbrella for graph compiler consolidation and round-trip truth."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788408845597,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "1fabee8c73599a8f643e04da78c03092258c974e8488c791f44d2532fbe6be02",
    "project_key": "rlrmp",
    "short_id": "1fabee8",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/1fabee8 (title)",
        "quote_or_summary": "Reference-realized phase-modulated recurrent bridge"
      },
      {
        "source": "mandible issue report rlrmp/1fabee8 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1780259112583,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "203fb54167d26e86ffe70a63a628254bd8070a0279337b8c6dae089776b1c151",
    "project_key": "mandible",
    "short_id": "203fb54",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The body specifies a concrete artifact-detail preview and location capability set, including local and bundle previews.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Acceptance covers preview placement, light-mode rows, stable locators, local-file and bundle previews, and local drift policy."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787341041704,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "2070f2f4ecd8bfe1601ebc34136b40b37ff5df56c2ea79c8fc9f008edce82f1c",
    "project_key": "mandible",
    "short_id": "2070f2f",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Coordination umbrella for the 2026-08 leanness/structure pass (supersedes this issue's original open-ended /unfrack framing; the first compatibility-preserving batch shipped 2026-05/06). Scope is now a finite children table, per the codex-reviewed plan. Inputs: nine-area audit + synthesis [artifact-series:c409eabea3b8], gpt-5.6-sol xhigh strengthening review [artifact:282890ed58e6], area findings [artifact-series:a36",
    "evidence": [
      {
        "source": "issue report for mandible/2070f2f",
        "quote_or_summary": "Coordination umbrella for the 2026-08 leanness/structure pass (supersedes this issue's original open-ended /unfrack framing; the first compatibility-preserving batch shipped 2026-05/06). Scope is now a finite children table, per the codex-reviewed plan. Inputs: nine-area audit + synthesis [artifact-series:c409eabea3b8], gpt-5.6-sol xhigh strengthening review [artifact:282890ed58e6], area findings [artifact-series:a36f7a14382c] (backend), [artifact-series:106fadf3a012] (auth), [artifact-series:cab8307e041a] (ledger)"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787786163342,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "20a6850e9a4823c603162c1f8e712375d9a71bb975dd7f216bb7491cb1c3c7dd",
    "project_key": "feedbax",
    "short_id": "20a6850",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: The training worker ignores the graph spec. Three audits (Codex, Gemini, Claude) identified the following violations: 1. worker/app.py: hardcodes hidden_type=GRUCell, out_size=6, out_nonlinearity=sigmoid; cfg.network_type is read but never used; graph_spec is silently dropped before reaching the worker 2. api/training.py L86-91: graph_spec received but not forwarded to training_service.start_training() 3. training_se",
    "evidence": [
      {
        "source": "issue report for feedbax/20a6850",
        "quote_or_summary": "The training worker ignores the graph spec. Three audits (Codex, Gemini, Claude) identified the following violations: 1. worker/app.py: hardcodes hidden_type=GRUCell, out_size=6, out_nonlinearity=sigmoid; cfg.network_type is read but never used; graph_spec is silently dropped before reaching the worker 2. api/training.py L86-91: graph_spec received but not forwarded to training_service.start_training() 3. training_service.py / worker/client.py: no graph_spec parameter in the pipeline 4. graphStore.ts: Network is in"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "246182c4b42484c59c36fd6c32a1b8df302e1d72b0b896aae3df5cd83cca2ce4",
    "project_key": "rlrmp",
    "short_id": "246182c",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue names an ablation study, which is an experiment by definition here.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "A delayed post-movement cost-tail ablation is a scientific experiment."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782058945232,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "252e1258bef92570bc75c235ae20635bc519ec73d78d0dc0aa89c473c543f6ce",
    "project_key": "mandible",
    "short_id": "252e125",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/252e125 (title)",
        "quote_or_summary": "Shared resource-ref parser: fix artifact:sha256: linkifier + unresolved-reference UI"
      },
      {
        "source": "mandible issue report mandible/252e125 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782220602474,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "27dece35b328e3e614c39c21de8532346a130c19d64b24e5dc16ca451d7a52ef",
    "project_key": "rlrmp",
    "short_id": "27dece3",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The report centers one capability or implementation lane; related children or labels do not change that single-lane purpose: Part of umbrella [issue:54389a4]. Builds on [issue:093d949], [issue:3b850d6], [issue:1697bdc], and the frozen Adam tuning child [issue:f3c5db9]. Goal: turn the frozen soft-adversary audit results into coordinate/physical-scale sanity tables and a durable no-launch training spec lock for user approval. Scope: - Cover direct epsilon, closed-loop linear no-bias, and closed-loop affine across the c92 small, moderate, and",
    "evidence": [
      {
        "source": "issue report for rlrmp/27dece3",
        "quote_or_summary": "Part of umbrella [issue:54389a4]. Builds on [issue:093d949], [issue:3b850d6], [issue:1697bdc], and the frozen Adam tuning child [issue:f3c5db9]. Goal: turn the frozen soft-adversary audit results into coordinate/physical-scale sanity tables and a durable no-launch training spec lock for user approval. Scope: - Cover direct epsilon, closed-loop linear no-bias, and closed-loop affine across the c92 small, moderate, and stress rows. - Connect practical lambda multipliers and perturbation scales to the user's force/sca"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496898,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "28537460551ec9396c04d1cc1ab63d7de6abe00f8ce86508125c5b2314057f69",
    "project_key": "dotfiles",
    "short_id": "2853746",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Objective Consolidate repository-owned agent policy, roles, shared skills, and integration sources under the existing `agents/` umbrella while preserving provider installation paths and the deployed `agent-schedule` runtime layout. ## Delivered source organization Child [issue:47c442b] is merged through `4e0ca04`. It moved authored policy, role, shared-skill, and Hermes integration sources under `agents/`; preserv",
    "evidence": [
      {
        "source": "issue report for dotfiles/2853746",
        "quote_or_summary": "## Objective Consolidate repository-owned agent policy, roles, shared skills, and integration sources under the existing `agents/` umbrella while preserving provider installation paths and the deployed `agent-schedule` runtime layout. ## Delivered source organization Child [issue:47c442b] is merged through `4e0ca04`. It moved authored policy, role, shared-skill, and Hermes integration sources under `agents/`; preserved scheduler paths; added root `AGENTS.md` with `CLAUDE.md` as its symlink; documented source/output"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1789065382944,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "2879f14d95767fcceb39914f9fcbcd891f0cdde7f9591fb2f55231518bb86373",
    "project_key": "mandible",
    "short_id": "2879f14",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates separate SDK and Channel mode work, with explicit child issues and mode-specific decisions.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Children cover Channel terminal view, preset switching, hybrid injection, and the mode selector."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "2a2ffec415adab5269eaeb54c8ea5eb5c70cc5ec41b9d8a5080efc81b10279d4",
    "project_key": "mandible",
    "short_id": "2a2ffec",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: ## Problem The artifact detail header now shows the home repo, but it also shows custody/role metadata such as `link` and `script` in the eyebrow. The requested header should show only the repo name beside the short artifact ref. Source code artifacts preview as plain monospaced text without syntax highlighting. Add syntax highlighting for code-like text artifacts using a pragmatic browser library after checking curr",
    "evidence": [
      {
        "source": "issue report for mandible/2a2ffec",
        "quote_or_summary": "## Problem The artifact detail header now shows the home repo, but it also shows custody/role metadata such as `link` and `script` in the eyebrow. The requested header should show only the repo name beside the short artifact ref. Source code artifacts preview as plain monospaced text without syntax highlighting. Add syntax highlighting for code-like text artifacts using a pragmatic browser library after checking current options. The implementation should keep artifact previews fast and should not load a heavyweight"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782948791123,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "2cb6a583d4065e639e264cfc1ab16b89b247a6baf916f9d19af5b4c6a76aee0f",
    "project_key": "rlrmp",
    "short_id": "2cb6a58",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/2cb6a58 (title)",
        "quote_or_summary": "Force-state observability by robust training"
      },
      {
        "source": "mandible issue report rlrmp/2cb6a58 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783983013987,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "2da2033c16eb7f250d26c136026cc93605c9240bf74f523e00c5678ac79f96fb",
    "project_key": "mandible",
    "short_id": "2da2033",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/2da2033 (title)",
        "quote_or_summary": "Source-backed conversation storage, custody, search, and recovery"
      },
      {
        "source": "mandible issue report mandible/2da2033 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1786979312174,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "2e5daa33137ce4db637968558af0a5c23aa795b7d57f3a91195442155ac697b4",
    "project_key": "humbleb",
    "short_id": "2e5daa3",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report humbleb/2e5daa3 (title)",
        "quote_or_summary": "Obsidian vault integration: markdown adapter + entity page generator [umbrella]"
      },
      {
        "source": "mandible issue report humbleb/2e5daa3 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "2e7dbc7d4a09eb14bbf3e559c2396f409bcba327807457d3a0d676732127e1cf",
    "project_key": "rlrmp",
    "short_id": "2e7dbc7",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue defines experimental rows for a fixed-budget PGD condition.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The named C&S GRU PGD rows are an experimental condition set."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782570973723,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "2f16212fb2ed2756380879215542b5fc7b9a7a7b5c2b525e0657a95d0ef26682",
    "project_key": "feedbax",
    "short_id": "2f16212",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/2f16212 (title)",
        "quote_or_summary": "Stateful-layer support in graph execution + equinox wrapper de-duplication and registry invariant tests"
      },
      {
        "source": "mandible issue report feedbax/2f16212 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783360184391,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "301d1f01fc0b17584dfa6fe5757cc7cbb2c42c6606e566fa1c7b51649ce8dfce",
    "project_key": "rlrmp",
    "short_id": "301d1f0",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This work audits and documents stale cap-conditioned lineage in existing calibration results; it is corrective evidence/record maintenance, not a new experiment or product feature.",
    "evidence": [
      {
        "source": "issue report body and closeout comment",
        "quote_or_summary": "The body asks whether an outdated hard cap determined prior thresholds; the closeout says the audit note was committed and distinguishes reusable diagnostics from stale launch claims."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496899,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "30fae901fd64a0a45ff2d551bbf7dcbf4c19555647129aa2d3c1e20fbb2e2448",
    "project_key": "feedbax",
    "short_id": "30fae90",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body explicitly sequences several child lanes for manifest dispatch, launch UI, and drivers.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Children cover execution vocabularies, pending-manifest dispatch, launch UI, and the Modal driver."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783735109359,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "31e67ff84805e7e41a270f286a366b81bdc6de8e042a195b112189cd25451c67",
    "project_key": "rlrmp",
    "short_id": "31e67ff",
    "kind": "experiment",
    "confidence": "medium",
    "rationale": "The body is a cap-independent calibration redo with empirical questions, candidate beta rows, and a no-launch specification lock. It is an experiment/research lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/31e67ff (title)",
        "quote_or_summary": "Redo cap-independent soft-lambda calibration"
      },
      {
        "source": "mandible issue report rlrmp/31e67ff (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp/31e67ff (body)",
        "quote_or_summary": "The body is a cap-independent calibration redo with empirical questions, candidate beta rows, and a no-launch specification lock. It is an experiment/research lane."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496900,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "32124c14de93ecc02c6ac387d3f219bb672bc31ba67327f61786c1d069e7f0d8",
    "project_key": "mandible",
    "short_id": "32124c1",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates a framework with multiple reference types, storage, APIs, resolution, and inbox integration.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The concept defines separate browser, image, snippet, and trace reference types plus shared storage and resolution protocols."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "3244f1ad98703a1b4d9d938c7e8aad2df1ea18702ef00a07d55ce3a5eca62dc4",
    "project_key": "rlrmp",
    "short_id": "3244f1a",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue validates a scientific perturbation bank and its resulting evidence.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Validation of the final perturbation bank is part of the experiment/evaluation workflow."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782580690233,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "33b0dcb903acbcae2123598aea32764886d8112c45beb76478338c2a1afe860a",
    "project_key": "rlrmp",
    "short_id": "33b0dcb",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue defines and executes a multi-row scientific training/evaluation matrix with explicit hypotheses, run contracts, and post-run comparisons.",
    "evidence": [
      {
        "source": "issue report body and post-run comment",
        "quote_or_summary": "The body specifies old-replicate, dense, sparse, and held-out-band rows; the post-run record says all six rows completed and were evaluated against the stated generalization question."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782316251333,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "35173c570eadad2d8516b39487d6c830f77210404b0aaaf4cac2d9b42f786f39",
    "project_key": "rlrmp",
    "short_id": "35173c5",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/35173c5 (title)",
        "quote_or_summary": "SISU spectrum models: discrete vs continuous conditioning vs independent-network yardstick"
      },
      {
        "source": "mandible issue report rlrmp/35173c5 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783574920238,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "362dd17891fe14a55384ceaaea11e35b4dcb19dff2f92b3870e2ee388551f54a",
    "project_key": "mandible",
    "short_id": "362dd17",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Objective Deliver the browser-verified Mandible interaction corrections accumulated on the persistent IAB integration branch. ## Children | issue | scope | branch | state | | --- | --- | --- | --- | | [issue:6fcfe68] | Shared sidebar search geometry, active-view find shortcut ownership, keyboard list navigation, and unified Issues filtering | `feature/6fcfe68-sidebar-interactions` | done | | [issue:411e3d6] | Boun",
    "evidence": [
      {
        "source": "issue report for mandible/362dd17",
        "quote_or_summary": "## Objective Deliver the browser-verified Mandible interaction corrections accumulated on the persistent IAB integration branch. ## Children | issue | scope | branch | state | | --- | --- | --- | --- | | [issue:6fcfe68] | Shared sidebar search geometry, active-view find shortcut ownership, keyboard list navigation, and unified Issues filtering | `feature/6fcfe68-sidebar-interactions` | done | | [issue:411e3d6] | Bounded Logs tail paging, stable refresh chrome, and synchronous bottom anchoring | `feature/411e3d6-bou"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1785616599171,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "36a37d7c4dd178aea618629f66d9fb5e57f4971c229353b39f8c126430735e7b",
    "project_key": "dotfiles",
    "short_id": "36a37d7",
    "kind": "bug",
    "confidence": "medium",
    "rationale": "The body presents a batch of concrete Mandible UI bugs (dismissal, rejection confirmation, tabs, GoTo, and Logs). Multiple fixes do not make the issue an organizing umbrella; the primary substance is defect repair.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/36a37d7 (title)",
        "quote_or_summary": "Mandible UI: force-dismiss flicker, reject no-confirm, tab styling, GoTo broken, Logs empty"
      },
      {
        "source": "mandible issue report dotfiles/36a37d7 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report dotfiles/36a37d7 (body)",
        "quote_or_summary": "The body presents a batch of concrete Mandible UI bugs (dismissal, rejection confirmation, tabs, GoTo, and Logs). Multiple fixes do not make the issue an organizing umbrella; the primary substance is defect repair."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "36fb6e0cf0e309e72c43becb725484a83db1c5098f3710fc6de6959ae8193ee0",
    "project_key": "feedbax",
    "short_id": "36fb6e0",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Goal Store each immutable byte digest once within one configured Feedbax custody domain. Roles, manifests, execution inputs, checkpoint transforms, remote caches, and portable packets reference that authority. Physical copies exist only at explicit materialization, portability, or non-authoritative cache boundaries. ## Authorized implementation The owner authorized coordinated implementation on 2026-09-05. Extend ",
    "evidence": [
      {
        "source": "issue report for feedbax/36fb6e0",
        "quote_or_summary": "## Goal Store each immutable byte digest once within one configured Feedbax custody domain. Roles, manifests, execution inputs, checkpoint transforms, remote caches, and portable packets reference that authority. Physical copies exist only at explicit materialization, portability, or non-authoritative cache boundaries. ## Authorized implementation The owner authorized coordinated implementation on 2026-09-05. Extend the existing immutable artifact provider rather than add a parallel store; use one stable project cu"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788641288778,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "372edcbdaade5a81e17b5a01ae78824e9ed2765813eef7656fc8a31ff7707f98",
    "project_key": "dotfiles",
    "short_id": "372edcb",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The title and issue scope describe a coordinated multi-part Chat History overhaul.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The issue is explicitly titled an umbrella and covers a message-formatting and rendering overhaul."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "37afbf56a1d19e6c59b29c3f82c81857a78f647b0c37c06a35c17dfae363402f",
    "project_key": "mandible",
    "short_id": "37afbf5",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The goal is one coherent Tasks-view product feature with a defined authority boundary and three implementation lanes. The children implement the feature; they do not turn the issue into a generic umbrella.",
    "evidence": [
      {
        "source": "mandible issue report mandible/37afbf5 (title)",
        "quote_or_summary": "Tasks view: Mandible as the management surface for agent-schedule recurring tasks"
      },
      {
        "source": "mandible issue report mandible/37afbf5 (kind/labels)",
        "quote_or_summary": "Observed kind=deferred; labels=feature|umbrella; status=open."
      },
      {
        "source": "mandible issue report mandible/37afbf5 (body)",
        "quote_or_summary": "The goal is one coherent Tasks-view product feature with a defined authority boundary and three implementation lanes. The children implement the feature; they do not turn the issue into a generic umbrella."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1788840970665,
    "observed_kind": "deferred",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "38f7d4cb31ba4ad6fca66dfcf58bee3b1b319a11e43e10a570d5bebe3ead7dd3",
    "project_key": "rlrmp2",
    "short_id": "38f7d4c",
    "kind": "maintenance",
    "confidence": "medium",
    "rationale": "The purpose is archival evidence/receipt custody, reference-safe retirement, and corpus cleanup. That is maintenance/custody work, not an unknown task.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp2/38f7d4c (title)",
        "quote_or_summary": "Archive and receipt custody"
      },
      {
        "source": "mandible issue report rlrmp2/38f7d4c (kind/labels)",
        "quote_or_summary": "Observed kind=unknown; labels=task; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp2/38f7d4c (body)",
        "quote_or_summary": "The purpose is archival evidence/receipt custody, reference-safe retirement, and corpus cleanup. That is maintenance/custody work, not an unknown task."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788370787806,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "3bb91cc631e23b39604865326ec1435c741c54d10d34c849b2f47d95910f59a0",
    "project_key": "feedbax",
    "short_id": "3bb91cc",
    "kind": "tracker",
    "confidence": "medium",
    "rationale": "The body is an architecture/topology decision record asking whether feedbax.execution is a second product or drift, with sequencing consequences and no implementation deliverable owned by this issue.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/3bb91cc (title)",
        "quote_or_summary": "Product topology: is feedbax.execution a second product or drift?"
      },
      {
        "source": "mandible issue report feedbax/3bb91cc (kind/labels)",
        "quote_or_summary": "Observed kind=unknown; labels=question; status=closed; resolution=fixed."
      },
      {
        "source": "mandible issue report feedbax/3bb91cc (body)",
        "quote_or_summary": "The body is an architecture/topology decision record asking whether feedbax.execution is a second product or drift, with sequencing consequences and no implementation deliverable owned by this issue."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788383014120,
    "observed_kind": "unknown",
    "observed_labels": [
      "question"
    ]
  },
  {
    "id": "3cd018b7297afc6272a5d96f70f4267178e3d24bbcde1c8c0337b7cb8d189454",
    "project_key": "rlrmp",
    "short_id": "3cd018b",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue defines an experimental matrix over adaptive-epsilon target schedules.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "A target-schedule matrix is a scientific experiment design."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1783532717360,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "3cf909c8f2c4de3530b8ce8d29aaf4416c2c4fcbb64f1be0a3fa99d367001e24",
    "project_key": "rlrmp",
    "short_id": "3cf909c",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Successor phase to [issue:64a04e0] (feedbax-native alignment), per the handoff note `results/64a04e0/notes/next_phase_handoff.md`. Predecessor umbrellas (closed): [issue:09aed43], [issue:19553e9], [issue:588483d], [issue:64a04e0]. ## Thrusts 1. **Deliberately-open items** carried over from [issue:64a04e0]: [issue:e8452a4] (induced-gain LTV/LTI/power-iteration math lift into feedbax — design lane), the [issue:63cec06]",
    "evidence": [
      {
        "source": "issue report for rlrmp/3cf909c",
        "quote_or_summary": "Successor phase to [issue:64a04e0] (feedbax-native alignment), per the handoff note `results/64a04e0/notes/next_phase_handoff.md`. Predecessor umbrellas (closed): [issue:09aed43], [issue:19553e9], [issue:588483d], [issue:64a04e0]. ## Thrusts 1. **Deliberately-open items** carried over from [issue:64a04e0]: [issue:e8452a4] (induced-gain LTV/LTI/power-iteration math lift into feedbax — design lane), the [issue:63cec06] / [issue:5c6b294] lifecycle, and the parts 2-3 + transitional-surface retirement [issue:00f97d5] / "
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783090179756,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "3db32ab5859901f473a556c7f84f85f4b3b61ffc288dca3581d327906d981cba",
    "project_key": "feedbax",
    "short_id": "3db32ab",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue addresses an import failure caused by an unintended dependency on web runtime extras.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Worker identity imports must work without requiring web runtime extras, with focused acceptance tests."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1786638139598,
    "observed_kind": "unknown",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "3ef52e610a416fd024f41cfab8b77d79598fb4e187ff1e6d0b1091d8b001dd99",
    "project_key": "rlrmp",
    "short_id": "3ef52e6",
    "kind": "umbrella",
    "confidence": "medium",
    "rationale": "The body explicitly describes this issue as a sub-umbrella coordinating 16 figure-migration waves. Organization of those deliverables is the primary purpose.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/3ef52e6 (title)",
        "quote_or_summary": "Migrate legacy figure specs onto the declarative figure pipeline"
      },
      {
        "source": "mandible issue report rlrmp/3ef52e6 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp/3ef52e6 (body)",
        "quote_or_summary": "The body explicitly describes this issue as a sub-umbrella coordinating 16 figure-migration waves. Organization of those deliverables is the primary purpose."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783898482710,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "4007bf2eaf7df2fdf44a5b8cd24b139316fe3a57bf3fe2b62792fcbe50b8ca44",
    "project_key": "feedbax",
    "short_id": "4007bf2",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Successor umbrella to the closed June substrate wave — [issue:f157a9a] (declarative-analysis substrate, manifest-canonical execution), [issue:63c798f] (provider depth: eval/analysis/report manifests, artifacts, actions), [issue:de19ed2] (analysis substrate follow-ups) — and to the pipeline slice of the [issue:1088451] sequencing audit. This umbrella does NOT re-litigate the eval/analysis substrate design: `Evaluation",
    "evidence": [
      {
        "source": "issue report for feedbax/4007bf2",
        "quote_or_summary": "Successor umbrella to the closed June substrate wave — [issue:f157a9a] (declarative-analysis substrate, manifest-canonical execution), [issue:63c798f] (provider depth: eval/analysis/report manifests, artifacts, actions), [issue:de19ed2] (analysis substrate follow-ups) — and to the pipeline slice of the [issue:1088451] sequencing audit. This umbrella does NOT re-litigate the eval/analysis substrate design: `EvaluationRunManifest`, eval-stage data production, executable `AnalysisRunSpec`/bundles/CLI, and Studio spec-"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783106076364,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "406423a435e3ae1e48814d4f7b514d015247d45d2e7f0fcab1846abd615ba2b9",
    "project_key": "mandible",
    "short_id": "406423a",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body coordinates several independent view seams and shared theme/composition contracts.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The issue dispatches separate lanes for Artifact/Graph, Spaces, Projects, and Tasks and centralizes shared sidebar and theme rules."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787250695069,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "40a3976d1d6c5a8560cd0f6436c7d41dc90bcff9e03138b0840e60ad32bb8dbf",
    "project_key": "mandible",
    "short_id": "40a3976",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: ## Problem 1. diff_summary field contains git diff --stat or agent prose summaries, not unified diffs. The UI has a fully implemented per-file tab viewer (parseDiffSections, renderHunksHtml) that never gets exercised. 2. Auth queue entries do not link to the session that submitted them or to referenced issues. 3. Daemon reload during execution leaves entries stuck (3dec8c0b scenario). Migrated from dotfiles issue [is",
    "evidence": [
      {
        "source": "issue report for mandible/40a3976",
        "quote_or_summary": "## Problem 1. diff_summary field contains git diff --stat or agent prose summaries, not unified diffs. The UI has a fully implemented per-file tab viewer (parseDiffSections, renderHunksHtml) that never gets exercised. 2. Auth queue entries do not link to the session that submitted them or to referenced issues. 3. Daemon reload during execution leaves entries stuck (3dec8c0b scenario). Migrated from dotfiles issue [issue:dotfiles/fe99993]."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "40c0b7781d81f83559bbb974f30ec6a648bf9e8a4708a64a37c946a9bd244559",
    "project_key": "rlrmp2",
    "short_id": "40c0b77",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is a precisely bounded custody/deletion and reclaim operation with verification receipts.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The outcome is to retire one exact source root after integrity gates while preserving converted roots, evidence, and unrelated artifacts."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1789401992997,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "40e19110101f8e2511ed2884c52015dceb4901687f08b876453a2d8a826ebbcd",
    "project_key": "rlrmp",
    "short_id": "40e1911",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body explicitly collects several scientific tracks and anchors future review packets across them.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Scope includes robustness discovery, delayed-reaching kinematics, analytical-policy baselines, and strategy-spectrum networks."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781620588912,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "41478ae4e0e58c7c424c032fca42e69ab3920d3bc7d6661425c0bbdfc9cf5b8d",
    "project_key": "rlrmp2",
    "short_id": "41478ae",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates a corrected adaptive-lambda campaign and a three-row continuation comparison across multiple branches, children, and gates.",
    "evidence": [
      {
        "source": "issue report body",
        "quote_or_summary": "The body begins by saying it coordinates the corrected applied-damage round and three-row continuation comparison, then defines shared contracts, membership, and gated campaign work."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1788463897278,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "project_key": "mandible",
    "short_id": "41d22a6",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/41d22a6 (title)",
        "quote_or_summary": "Project Timeline workspace: shared-axis coordination narrative"
      },
      {
        "source": "mandible issue report mandible/41d22a6 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1780700355529,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "42198b076f05a7da96555b9f7a6231ba4c52cafe5f6b5172eb586fc6b5830c98",
    "project_key": "feedbax",
    "short_id": "42198b0",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/42198b0 (title)",
        "quote_or_summary": "Finish residual root package cleanup"
      },
      {
        "source": "mandible issue report feedbax/42198b0 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=maintenance|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781483017080,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "42581147db7bd772f43a7269678821011b552384c1cfb068f066ad2c89c5fe3c",
    "project_key": "mandible",
    "short_id": "4258114",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The objective explicitly coordinates two shared presentation contracts and separate implementation lanes.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The issue covers contextual hover actions and one central disclosure-motion primitive, with two child lanes."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787158547115,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "43e8728998f4ba9d7a5b8b8b58e5ff51e3cab4ebb3220ffedb1bbab372a8b04e",
    "project_key": "rlrmp",
    "short_id": "43e8728",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: **Structured plan: cs2019-to-RNN game-equivalence programme** **Abstract** This is the central plan for the cs2019-to-RNN robustness programme. It is controlled by the GPT-5.5 Pro review and the immediately preceding synthesis on [issue:0b1f109]. Older plans such as [issue:35f64be], [issue:6f783fa], and [issue:f695729] are historical inputs only where they support this framing. The first scientific task is not to rep",
    "evidence": [
      {
        "source": "issue report for rlrmp/43e8728",
        "quote_or_summary": "**Structured plan: cs2019-to-RNN game-equivalence programme** **Abstract** This is the central plan for the cs2019-to-RNN robustness programme. It is controlled by the GPT-5.5 Pro review and the immediately preceding synthesis on [issue:0b1f109]. Older plans such as [issue:35f64be], [issue:6f783fa], and [issue:f695729] are historical inputs only where they support this framing. The first scientific task is not to reproduce human behavior directly. The first task is to prove that the rlrmp/feedbax training and evalu"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "498d7f619c377ef4dde7b385670ce0fd43811023c05274896e60fabe8dd58912",
    "project_key": "mandible",
    "short_id": "498d7f6",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: ## Objective Drive the existing typed Briefing document controls and frozen submission flow from the explicit server-projected response capability, including the isolated copied-preview case. ## Dependency Consume the backend capability contract from the sibling capability issue after its signed commit is integrated. Do not reclassify server mutations in UI code. ## Frozen behavior - Verdict, single choice, multi-cho",
    "evidence": [
      {
        "source": "issue report for mandible/498d7f6",
        "quote_or_summary": "## Objective Drive the existing typed Briefing document controls and frozen submission flow from the explicit server-projected response capability, including the isolated copied-preview case. ## Dependency Consume the backend capability contract from the sibling capability issue after its signed commit is integrated. Do not reclassify server mutations in UI code. ## Frozen behavior - Verdict, single choice, multi-choice, short text, long text, and rating controls are editable only for an authenticated human when th"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787171835919,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "4a470b45ae848238ecce7142d49df0a20c95999077457de94078b455d30a755b",
    "project_key": "feedbax",
    "short_id": "4a470b4",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is a bounded migration and custody-maintenance deliverable for legacy archive trees.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The scope is an offline archive-tree migration with streaming, cloning, metadata fidelity, receipts, resumability, rollback, and dry-run behavior."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788734834138,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "4b527065caa273ebf4fec72411c7393932e5140cdda3ba19d9dada7ed0cc88ad",
    "project_key": "humbleb",
    "short_id": "4b52706",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue groups several Graph of Graphs capabilities and explicitly lists their API and UI pieces.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Missing features include similarity, tags, filtering, shelf selection, detail panel, and disambiguation."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "4d79e078de1b8daf15aeb6807a190f2b9c1488b1e055f9bb25b3270fe5808777",
    "project_key": "rlrmp",
    "short_id": "4d79e07",
    "kind": "experiment",
    "confidence": "medium",
    "rationale": "The goal is an empirical replication/training matrix with seeds, pressure, and budget sweeps; this is an experiment rather than a generic feature.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/4d79e07 (title)",
        "quote_or_summary": "Replicate lr 3e-3 PGD broad-epsilon C&S GRU training"
      },
      {
        "source": "mandible issue report rlrmp/4d79e07 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      },
      {
        "source": "mandible issue report rlrmp/4d79e07 (body)",
        "quote_or_summary": "The goal is an empirical replication/training matrix with seeds, pressure, and budget sweeps; this is an experiment rather than a generic feature."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781667141433,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "4eb51ee568ef0368a879e87643458c2215d886d647e1bc2e6b13e776e66198fd",
    "project_key": "rlrmp",
    "short_id": "4eb51ee",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue investigates agreement across evaluation lenses, which is an experimental comparison.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Cross-architecture certificate agreement is a scientific comparison experiment."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783980966600,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "4f2058d04f9ca8bb32acba1c07a0b3e0c36862e0d4fb5054e65a1e60815feb47",
    "project_key": "dotfiles",
    "short_id": "4f2058d",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: All audit sub-tasks completed and merged to main: - P1: CLAUDE.md rewrite (deduplicate, add missing rules, modularize Mandible) - P2: Skills fixes (gitdone, worktree-rules sync, remove takeissuewith) - P3: New skills (auditclaude, worktree-cleanup, sessionretro) - P4: JAX conventions migrated to 7 project repos - Follow-ups: README outline, shell tooling removal, bug-repo-rule, inbox hook, stale ref fix, Remote Debug",
    "evidence": [
      {
        "source": "issue report for dotfiles/4f2058d",
        "quote_or_summary": "All audit sub-tasks completed and merged to main: - P1: CLAUDE.md rewrite (deduplicate, add missing rules, modularize Mandible) - P2: Skills fixes (gitdone, worktree-rules sync, remove takeissuewith) - P3: New skills (auditclaude, worktree-cleanup, sessionretro) - P4: JAX conventions migrated to 7 project repos - Follow-ups: README outline, shell tooling removal, bug-repo-rule, inbox hook, stale ref fix, Remote Debugging move, spec policy, deferred label Closed sub-issues: [issue:3b88e1d], [issue:2c773fc], [issue:f"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "4fca24744ba60707b5e6438935f102a022480e2fb2a527ee30fc5946df2878d1",
    "project_key": "rlrmp",
    "short_id": "4fca247",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Motivated by a Codex+Opus dual-review (2026-06-19) of deploy fragility surfaced across multiple matrix runs. Scope: make the feedbax deploy scripts and rlrmp runbook/post-run tooling robust for parallel multi-row launches, deterministic pod acquisition with cost guards, accurate remote observability, and clean checkpoint conventions. Cross-cutting dotfiles policy filed separately. Out of scope: spec-driven launcher m",
    "evidence": [
      {
        "source": "issue report for rlrmp/4fca247",
        "quote_or_summary": "Motivated by a Codex+Opus dual-review (2026-06-19) of deploy fragility surfaced across multiple matrix runs. Scope: make the feedbax deploy scripts and rlrmp runbook/post-run tooling robust for parallel multi-row launches, deterministic pod acquisition with cost guards, accurate remote observability, and clean checkpoint conventions. Cross-cutting dotfiles policy filed separately. Out of scope: spec-driven launcher migration ([issue:d6b7018]), feedbax circular-import ([issue:ccfe63a]). ## Children | issue | scope |"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781931436500,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "504880c515a4843cb1c4047998b5da01e283f5f1714f75c2116824a2de0f32df",
    "project_key": "dotfiles",
    "short_id": "504880c",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/504880c (title)",
        "quote_or_summary": "Console view: terminal blank, stream renderer empty, duplicate label"
      },
      {
        "source": "mandible issue report dotfiles/504880c (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=error|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "5294d9faef5a92252205da42b070f268b2c8b6dc5b6906b810a61febe72cb4ce",
    "project_key": "mandible",
    "short_id": "5294d9f",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/5294d9f (title)",
        "quote_or_summary": "Dashboard view consolidation: one home per entity"
      },
      {
        "source": "mandible issue report mandible/5294d9f (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783287176337,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "5396470d1131ac2d3d4fb60a253cce3755b19f7b911e91bf4584d85b56903385",
    "project_key": "dotfiles",
    "short_id": "5396470",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The body reports concrete runtime failures: startup event-loop blocking, erroneous ingest fallback, and missing restart activation.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Startup can block the Node event loop, delta ingest can fall back into duplicate inserts, and auth-merge lacks a restart hook."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "54389a48c1e18f3a1e2147292828a00a1ca48b9dbbaaee3e8217a3488c5419d3",
    "project_key": "rlrmp",
    "short_id": "54389a4",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/54389a4 (title)",
        "quote_or_summary": "Repair soft-adversary lambda calibration and frozen audits"
      },
      {
        "source": "mandible issue report rlrmp/54389a4 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=experiment|feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782770008488,
    "observed_kind": "umbrella",
    "observed_labels": [
      "experiment",
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "551ace27b3a28f0b911b45e528b791b40007be2b1083d13317e72fb49381a743",
    "project_key": "dotfiles",
    "short_id": "551ace2",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Extract Mandible from dotfiles into its own git repo, add a Tauri native window wrapper, and update dotfiles integration (bin/mandible, wizard step).",
    "evidence": [
      {
        "source": "issue report for dotfiles/551ace2",
        "quote_or_summary": "Extract Mandible from dotfiles into its own git repo, add a Tauri native window wrapper, and update dotfiles integration (bin/mandible, wizard step)."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "5720a49be3760b3b137b80594288fb2729d4304cecb0c7a73a9a3f00d8738e00",
    "project_key": "rlrmp",
    "short_id": "5720a49",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue prevents an incorrect recommendation derived from a cap, a concrete correctness defect.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Cap-derived lambda recommendations are an incorrect behavior to prevent."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782783380030,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "577806f7402b4f1f6b25f7a9cd97ed0aa51ce7d8d8d0bf7e585754a13dd0e741",
    "project_key": "rlrmp",
    "short_id": "577806f",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: **Motivating question.** Can rlrmp run entirely through feedbax's public contracts — models constructed from GraphSpec, analyses (including the certificate/diagnostics estate) expressed in feedbax's declarative analysis system, run records as feedbax manifests exposed through the provider contract — with rlrmp reduced to a pure extension package (registered components, domain math, analysis classes, specs, narratives",
    "evidence": [
      {
        "source": "issue report for rlrmp/577806f",
        "quote_or_summary": "**Motivating question.** Can rlrmp run entirely through feedbax's public contracts — models constructed from GraphSpec, analyses (including the certificate/diagnostics estate) expressed in feedbax's declarative analysis system, run records as feedbax manifests exposed through the provider contract — with rlrmp reduced to a pure extension package (registered components, domain math, analysis classes, specs, narratives)? **Background (state as of 2026-06-11).** rlrmp spans three eras: (1) the main model path is pre-g"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1781315009641,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "588483dff23b3ddc7f454ca5c2f79b0e2d7346861782f71129252cbd0ccfc39f",
    "project_key": "feedbax",
    "short_id": "588483d",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: This umbrella coordinates the next pass after [issue:19553e9]. The previous wave added a real schema/migration scaffold and some RLRMP declarative analysis coverage, but the broader intent is not complete: recurring analysis groups, diagnostic sidecars, regeneration specs, checkpoint-selection records, retention artifacts, and some nested/component-local spec surfaces are still too ad hoc or too RLRMP-local. The guid",
    "evidence": [
      {
        "source": "issue report for feedbax/588483d",
        "quote_or_summary": "This umbrella coordinates the next pass after [issue:19553e9]. The previous wave added a real schema/migration scaffold and some RLRMP declarative analysis coverage, but the broader intent is not complete: recurring analysis groups, diagnostic sidecars, regeneration specs, checkpoint-selection records, retention artifacts, and some nested/component-local spec surfaces are still too ad hoc or too RLRMP-local. The guiding rule for this umbrella is: whenever a piece is reusable machinery rather than RLRMP scientific c"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1781540479992,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "5a0319047de062a90a7f23c2d5714e6bbe9da37019a11a7f2aca90edf5c4c481",
    "project_key": "rlrmp2",
    "short_id": "5a03190",
    "kind": "maintenance",
    "confidence": "medium",
    "rationale": "The purpose is a one-time migration of closed artifact roots into canonical external storage with retention and cutover receipts. This is maintenance/custody work.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp2/5a03190 (title)",
        "quote_or_summary": "Migrate the 25 closed artifact roots into canonical external storage"
      },
      {
        "source": "mandible issue report rlrmp2/5a03190 (kind/labels)",
        "quote_or_summary": "Observed kind=unknown; labels=task; status=closed; resolution=fixed."
      },
      {
        "source": "mandible issue report rlrmp2/5a03190 (body)",
        "quote_or_summary": "The purpose is a one-time migration of closed artifact roots into canonical external storage with retention and cutover receipts. This is maintenance/custody work."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788734834151,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "5a1dcd60ca38879927bf3cbb7fffbb6030855ca836c9d8a8a14cf4475c53af56",
    "project_key": "dotfiles",
    "short_id": "5a1dcd6",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The objective is a recurring repository-janitor capability that discovers projects, classifies safe candidates, and emits maintenance reports. It is a product feature for agent-schedule, not merely a one-off cleanup.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/5a1dcd6 (title)",
        "quote_or_summary": "agent-schedule: clean stale branches and worktrees every two days"
      },
      {
        "source": "mandible issue report dotfiles/5a1dcd6 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|maintenance; status=open."
      },
      {
        "source": "mandible issue report dotfiles/5a1dcd6 (body)",
        "quote_or_summary": "The objective is a recurring repository-janitor capability that discovers projects, classifies safe candidates, and emits maintenance reports. It is a product feature for agent-schedule, not merely a one-off cleanup."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1789681811445,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "5b2cdbf78f45dc66c5b95fa6cd0c53ba98c6367159856378fc3f439258ccaf86",
    "project_key": "mandible",
    "short_id": "5b2cdbf",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The title and labels identify a concrete correctness defect in parent-role identity and liveness handling.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The operation records unverifiable session identifiers and computes liveness inconsistently."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1788019300435,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "coordination"
    ]
  },
  {
    "id": "5d5a5a6044dee222b75318beb5c5fcf22c8f58a8bb06c649b2f76e88d7446070",
    "project_key": "mandible",
    "short_id": "5d5a5a6",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Objective Make the personal Mandible desktop app stay usable across sleep, reopen, daemon restart, and concurrent dashboard surfaces without a ceremonial Login click or exposing the durable operator token to the renderer. ## Decisions - Keep the durable operator credential in the macOS Keychain and Rust shell boundary. - Give each browser or desktop surface only bounded dashboard-session credentials. - Replace onl",
    "evidence": [
      {
        "source": "issue report for mandible/5d5a5a6",
        "quote_or_summary": "## Objective Make the personal Mandible desktop app stay usable across sleep, reopen, daemon restart, and concurrent dashboard surfaces without a ceremonial Login click or exposing the durable operator token to the renderer. ## Decisions - Keep the durable operator credential in the macOS Keychain and Rust shell boundary. - Give each browser or desktop surface only bounded dashboard-session credentials. - Replace only the presented dashboard session during renewal; do not revoke unrelated surfaces. - Automatically "
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1786648778558,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "5d6639a356674f36e8c9e337c5e35d0da13bc1f6fe4c04997d8e241f6fce8580",
    "project_key": "mandible",
    "short_id": "5d6639a",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/5d6639a (title)",
        "quote_or_summary": "Artifact previews should format text specs and surface repo identity"
      },
      {
        "source": "mandible issue report mandible/5d6639a (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782948791125,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "5dfef000082b708dee48cd761004c3eefdc215847a2a8b92e8b0babe3ab63e3b",
    "project_key": "mandible",
    "short_id": "5dfef00",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue explicitly coordinates annotation, submission, export, and document-pipeline children.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Children own annotation core, submission refs/export, and a document-pipeline correction."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1786934112208,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "61ada15b4e582113aa3458bbb42d7fd9f1905bac462697e9430c761087db08a7",
    "project_key": "mandible",
    "short_id": "61ada15",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue corrects a concrete existing editor defect: whitespace and below-document clicks do not place the caret intuitively, and empty-block navigation is unreliable.",
    "evidence": [
      {
        "source": "issue report body and implementation closeout",
        "quote_or_summary": "The report documents unreliable whitespace clicks and cross-block navigation, then records the correction that routes whitespace clicks to line-end/document-end caret targets."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782666785318,
    "observed_kind": "feature",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "62db538592d7bbddd4c8f4f305015b513894a584ea6f31635c39d343a07fd8a8",
    "project_key": "rlrmp2",
    "short_id": "62db538",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "Although labeled coordination, the body coordinates a finite multi-deliverable conversion and reclamation program with explicit acceptance gates.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The issue coordinates conversion of 25 roots, canonical objects and import roots, compatibility views, receipts, quarantine removal, and final custody reporting."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788734856412,
    "observed_kind": "unknown",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "64a04e04d118e1473180541d8049e8f78bda3275ff80550ea19ecb24d8409efd",
    "project_key": "feedbax",
    "short_id": "64a04e0",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/64a04e0 (title)",
        "quote_or_summary": "Feedbax-native training and graph consumption cleanup"
      },
      {
        "source": "mandible issue report feedbax/64a04e0 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=fixed."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1783107072674,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "654b285f2d1ec3b177f4c6e701984c2018e2d53d0590b0dc9b3043a6870255a2",
    "project_key": "mandible",
    "short_id": "654b285",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The objective is one typed post-v1 Briefing directive profile and release-readiness path. Its child work serves that feature contract rather than defining a portfolio-level coordination issue.",
    "evidence": [
      {
        "source": "mandible issue report mandible/654b285 (title)",
        "quote_or_summary": "Support typed responses in a post-v1 Briefing directive profile"
      },
      {
        "source": "mandible issue report mandible/654b285 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=open."
      },
      {
        "source": "mandible issue report mandible/654b285 (body)",
        "quote_or_summary": "The objective is one typed post-v1 Briefing directive profile and release-readiness path. Its child work serves that feature contract rather than defining a portfolio-level coordination issue."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787196990009,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "65871b9bb7886282b4bf7d23ba73afacaf36bc14a378014f938814eb1262ea4e",
    "project_key": "feedbax",
    "short_id": "65871b9",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body explicitly calls this a maintenance umbrella coordinating package-layout and obsolete-surface work.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The issue says it coordinates Feedbax package-layout cleanup and obsolete-surface removal across several package domains."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781473779444,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "67d40cf9cf13aea796385ab95ec37806f1d078d85e6ae2d9c99b5a0e554e6b31",
    "project_key": "mandible",
    "short_id": "67d40cf",
    "kind": "bug",
    "confidence": "high",
    "rationale": "This is a concrete production startup resource-exhaustion defect.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Production startup SQLite materialization can exhaust the heap and needs bounded behavior."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787208549965,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "682db84e2d18a32226d0066a69153f52421461485d9caa910040e2e770d6d5d2",
    "project_key": "rlrmp2",
    "short_id": "682db84",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is test-suite and contract hygiene: it classifies tests, removes unjustified breadth, and separates routine/extended checks rather than adding a product feature.",
    "evidence": [
      {
        "source": "issue report body and completion comment",
        "quote_or_summary": "The purpose is to keep a sparse suite protecting scientific and delivery contracts; the completion record cites the maintenance commit and routine, extended, and compile checks."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788370787807,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "69cee28b881c97f5abee7d4206dadcc4ef6a6ada40d80ab0f9ecd219f88efa9a",
    "project_key": "rlrmp",
    "short_id": "69cee28",
    "kind": "maintenance",
    "confidence": "medium",
    "rationale": "The body targets subtraction of duplicated analysis orchestration and retirement of legacy materializers across a 12-wave cleanup. The primary purpose is repository maintenance; child waves do not by themselves make it an umbrella.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/69cee28 (title)",
        "quote_or_summary": "Reduce analysis pipeline modules to science plus registrations"
      },
      {
        "source": "mandible issue report rlrmp/69cee28 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp/69cee28 (body)",
        "quote_or_summary": "The body targets subtraction of duplicated analysis orchestration and retirement of legacy materializers across a 12-wave cleanup. The primary purpose is repository maintenance; child waves do not by themselves make it an umbrella."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783898482718,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "6cfa892254edbd3687b92f06c799f12dda12d38144cebda1bcbcefab61e01904",
    "project_key": "rlrmp",
    "short_id": "6cfa892",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The task is to rerun a named scientific check under the soft-lambda condition.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Redoing closed-loop soft-lambda checks is an experiment/evaluation action."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496901,
    "observed_kind": "unknown",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "6d432dfa105c5e2879498acd8d230c36140d25adfd3b94a1c58d66462e4d825d",
    "project_key": "rlrmp",
    "short_id": "6d432df",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue is an experiment: it defines two single-run setpoint-sweep protocols, failure diagnostics, and an interpretation contract for the breakdown boundary.",
    "evidence": [
      {
        "source": "issue report body",
        "quote_or_summary": "The body defines linear and staircase sweep protocols, explicit instability diagnostics, and agreement criteria for interpreting the observed boundary."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783574918436,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "6e9e04587f423e8def6db6f9efedd99bbed6426f7c560a8fa9f45b26f4f4460e",
    "project_key": "rlrmp",
    "short_id": "6e9e045",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/6e9e045 (title)",
        "quote_or_summary": "Dead train_minimax argparse block and frozen migration-defaults drift"
      },
      {
        "source": "mandible issue report rlrmp/6e9e045 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|maintenance; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783182222798,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "718098451cf831abc5bd3019c72063bb66159d1661e136a97315212c05d508f0",
    "project_key": "rlrmp",
    "short_id": "7180984",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue requests a named parameter sweep, a scientific experiment.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "A direct-epsilon soft-lambda sweep is explicitly an experimental run matrix."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496902,
    "observed_kind": "unknown",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "71ef8d2eca3ae54bb8c2c75ba3c24a8f339d3de2eda1f3a954e4fb16a04b1fe3",
    "project_key": "rlrmp",
    "short_id": "71ef8d2",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: **Motivating question.** Can the marginal cost of a new rlrmp experiment drop to a few hundred authored lines — by separating authored intent, compiled execution configuration, and archival evidence, and by making the sanctioned paved road cheaper than any bypass — without losing archival interpretability of past runs? **Context.** The 2026-07-11 LOC/architecture diagnosis ([artifact-version:bebbd75d527dcdaf75f93fcf0",
    "evidence": [
      {
        "source": "issue report for rlrmp/71ef8d2",
        "quote_or_summary": "**Motivating question.** Can the marginal cost of a new rlrmp experiment drop to a few hundred authored lines — by separating authored intent, compiled execution configuration, and archival evidence, and by making the sanctioned paved road cheaper than any bypass — without losing archival interpretability of past runs? **Context.** The 2026-07-11 LOC/architecture diagnosis ([artifact-version:bebbd75d527dcdaf75f93fcf0dbb7b2e], v2; second-opinion review [artifact-version:22b042119b89ca0e262e9d9c06b6e591]) found: ~16k"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783914971702,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "7237df6dbd10cf1cb6c62812d10656d081a3c25700ad1fd81891f1d123d0f61a",
    "project_key": "feedbax",
    "short_id": "7237df6",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Run a new contract-preserving internal cleanup of Feedbax develop. Preserve Mandible-facing provider/manifest/execution contracts and other public package/API/config/storage surfaces. Apply /unfuck-level scrutiny to internal-only duplication, stale abstractions, dead code, test gaps, and architecture drift. Capture external-surface inventory, reproducible cloc baselines/finals, focused implementation notes, verificat",
    "evidence": [
      {
        "source": "issue report for feedbax/7237df6",
        "quote_or_summary": "Run a new contract-preserving internal cleanup of Feedbax develop. Preserve Mandible-facing provider/manifest/execution contracts and other public package/API/config/storage surfaces. Apply /unfuck-level scrutiny to internal-only duplication, stale abstractions, dead code, test gaps, and architecture drift. Capture external-surface inventory, reproducible cloc baselines/finals, focused implementation notes, verification, and any deferred risks before protected-branch delivery."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1780171973645,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "75c89455563873255129bf87ee6a46b77fb6565744f60f7a7050d993991ec575",
    "project_key": "humbleb",
    "short_id": "75c8945",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Coordinate the May 30 backend-only implementation batch requested from the open HumbleB ledger. Scope: - Implement all clear, code-only backend/product-architecture work that can be done today. - Exclude product UI architecture work. - Do not run real model/API-backed calibration or ingestion workloads; only smoke/unit tests and deterministic local ingestion fixtures are in scope. - Keep one integration branch and me",
    "evidence": [
      {
        "source": "issue report for humbleb/75c8945",
        "quote_or_summary": "Coordinate the May 30 backend-only implementation batch requested from the open HumbleB ledger. Scope: - Implement all clear, code-only backend/product-architecture work that can be done today. - Exclude product UI architecture work. - Do not run real model/API-backed calibration or ingestion workloads; only smoke/unit tests and deterministic local ingestion fixtures are in scope. - Keep one integration branch and merge worker branches bottom-up. Initial target lanes: - Graph mutation guardrails and tests. - Generi"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1780173950868,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "76b134fc807fe5639a0add18514a28cba7ba9b2cab4599498ed99a9c686d8751",
    "project_key": "mandible",
    "short_id": "76b134f",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: Live ledger Markdown still contains old-style artifact links that the previous artifact reference repair did not catch. Evidence from rlrmp `08483d5`: - The issue body and comments 1, 2, 4, 8, 9, and 10 contain Markdown links whose visible labels look like `[artifact:sha256:<short-prefix>]`. - The href query values also encode old refs, for example `artifact=artifact%3Asha256%3A<full-hash>`. - Resolving the old encod",
    "evidence": [
      {
        "source": "issue report for mandible/76b134f",
        "quote_or_summary": "Live ledger Markdown still contains old-style artifact links that the previous artifact reference repair did not catch. Evidence from rlrmp `08483d5`: - The issue body and comments 1, 2, 4, 8, 9, and 10 contain Markdown links whose visible labels look like `[artifact:sha256:<short-prefix>]`. - The href query values also encode old refs, for example `artifact=artifact%3Asha256%3A<full-hash>`. - Resolving the old encoded/full form now reports it as unsupported and advises repair to `artifact-blob:<hash>`. - The canon"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782996489280,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "782a2c685beb8d1ecaf40074f3ff1d96463dcfd0c84eb246c428d738a8df93d4",
    "project_key": "rlrmp",
    "short_id": "782a2c6",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/782a2c6 (title)",
        "quote_or_summary": "Bridge machinery for recurrence and standard certificates"
      },
      {
        "source": "mandible issue report rlrmp/782a2c6 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1780162728001,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "7a97e2c55bae200b818780a0dac5e31aec1156a1b29f1695bb072d4e7d52b1ac",
    "project_key": "mandible",
    "short_id": "7a97e2c",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/7a97e2c (title)",
        "quote_or_summary": "Parent-role assume reports anonymous live holder while status is empty"
      },
      {
        "source": "mandible issue report mandible/7a97e2c (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=coordination|error; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787009673849,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "coordination"
    ]
  },
  {
    "id": "7c126e36b290ecc5f752fc11cda1b09890107419f802299bad6fcba0245ed039",
    "project_key": "feedbax",
    "short_id": "7c126e3",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/7c126e3 (title)",
        "quote_or_summary": "Integrate local artifact reader and collection prerequisites"
      },
      {
        "source": "mandible issue report feedbax/7c126e3 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1789570490858,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "7c1f7ed111aea64bb8a5e640ad4e9e16c1640291f73f53fdd848c8477aac3ac1",
    "project_key": "rlrmp",
    "short_id": "7c1f7ed",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue names a robustness-spectrum scientific study.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The delayed SISU robustness spectrum is an experimental investigation."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781967885917,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "7cfe941ce9e0ec4e97d8a35ca26b23f57cea96296f6594e0a12830dc21565780",
    "project_key": "rlrmp",
    "short_id": "7cfe941",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: \\`analysis/pipelines/gru_perturbation_calibration.py\\` still bakes scientific calibration data as module constants — \\`DEFAULT_AMPLITUDE_FACTORS\\` (14-entry float tuple), reach calibration points, timing bins, native conventions. This is the [issue:ea6ccb4] governed-data-product class; a comment in the file confirms only the unit-sensitivity table and velocity scale were migrated. Migrate the remaining tables onto th",
    "evidence": [
      {
        "source": "issue report for rlrmp/7cfe941",
        "quote_or_summary": "\\`analysis/pipelines/gru_perturbation_calibration.py\\` still bakes scientific calibration data as module constants — \\`DEFAULT_AMPLITUDE_FACTORS\\` (14-entry float tuple), reach calibration points, timing bins, native conventions. This is the [issue:ea6ccb4] governed-data-product class; a comment in the file confirms only the unit-sensitivity table and velocity scale were migrated. Migrate the remaining tables onto the \\`AnalysisDataProduct\\` envelope with loaders, matching \\`data_products/calibration.py\\`. Second f"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783224012658,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "80970c98618a3ca26c0c819aee0f6c4300ebedde0f0300e0860c9991fe8f89eb",
    "project_key": "rlrmp2",
    "short_id": "80970c9",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp2/80970c9 (title)",
        "quote_or_summary": "Adaptive-lambda science package and locked run readiness"
      },
      {
        "source": "mandible issue report rlrmp2/80970c9 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784077651865,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "80f18c03013df4b34fd126d0f6d756f7b5c0f142d35305ff021a2b87c5ea2523",
    "project_key": "mandible",
    "short_id": "80f18c0",
    "kind": "tracker",
    "confidence": "high",
    "rationale": "The body explicitly calls this an open coordination surface and says it does not replace the implementation issues below.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Its goal is to keep existing follow-ups cross-referenced so the unified model does not regress; it owns no single implementation deliverable."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "813fcf6284b9a73d8f161e912a7fefe4dd1c53c83dd00c1100d1b054fa7ff1e1",
    "project_key": "rlrmp",
    "short_id": "813fcf6",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/813fcf6 (title)",
        "quote_or_summary": "Experiment-running workflow: run-experiment skill, closure semantics, deterministic post-run/packet"
      },
      {
        "source": "mandible issue report rlrmp/813fcf6 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781367608002,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8230121d3d9144e0e463196bee41da26d65727315dac4309bd4606af5827461a",
    "project_key": "rlrmp2",
    "short_id": "8230121",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This evidence lane produces a concrete revision-pinned baseline and classification record; it is not merely ongoing orientation.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The purpose is to inventory and classify every residual surface, pin revisions and measurements, and produce a baseline checkpoint with zero unknowns."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788352513815,
    "observed_kind": "unknown",
    "observed_labels": [
      "task"
    ]
  },
  {
    "id": "837e253695b1f0b1d2e202b96ffa35723a716572942debaf1321ed4234d92fd9",
    "project_key": "dotfiles",
    "short_id": "837e253",
    "kind": "feature",
    "confidence": "high",
    "rationale": "This is a requested expansion of the worktree merge command so valid integration merges can be represented directly.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The current command rejects valid feature-to-integration merges and the issue asks for an additional supported integration operation."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787010256284,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "83e71c130a67c150555a26a6366c1144aacbbed9c85802364d4bffa033457b66",
    "project_key": "mandible",
    "short_id": "83e71c1",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Problem The latest IAB Settings review extends the completed centering lane: the surface still reads as gray between sections because card shadows create gutters, the close control and configuration subtitle are no longer wanted, and the long form lacks lean section navigation. ## Scope Coordinate one coherent Settings implementation lane that removes the card-shadow gutters, close control, and `Mandible configura",
    "evidence": [
      {
        "source": "issue report for mandible/83e71c1",
        "quote_or_summary": "## Problem The latest IAB Settings review extends the completed centering lane: the surface still reads as gray between sections because card shadows create gutters, the close control and configuration subtitle are no longer wanted, and the long form lacks lean section navigation. ## Scope Coordinate one coherent Settings implementation lane that removes the card-shadow gutters, close control, and `Mandible configuration.` subtitle; adds a modern documentation-style left table of contents with clear active, hover, "
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787250130883,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8546c2fee4b3e189281445ec61b61d970a26767d15b0f30ade5102601f3def02",
    "project_key": "mandible",
    "short_id": "8546c2f",
    "kind": "bug",
    "confidence": "medium",
    "rationale": "The problem lists concrete chat regressions and missing controls—transcript rehydration, terminal fallback, Gemini, model selection, and row layout—to repair in one follow-up.",
    "evidence": [
      {
        "source": "mandible issue report mandible/8546c2f (title)",
        "quote_or_summary": "Chat follow-ups: transcript rehydration, terminal fallback, Gemini, model picker"
      },
      {
        "source": "mandible issue report mandible/8546c2f (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report mandible/8546c2f (body)",
        "quote_or_summary": "The problem lists concrete chat regressions and missing controls—transcript rehydration, terminal fallback, Gemini, model selection, and row layout—to repair in one follow-up."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782969263679,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "865c0ee38c1dc7baad2b8bd2c8acb57fc426eb00fc9581a021d69ce778f8ee59",
    "project_key": "feedbax",
    "short_id": "865c0ee",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The mission names four extension-surface improvements and assigns an integration branch and children.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The body limits and coordinates four bounded extension-surface improvements with combined verification."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784059921189,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "86b63bc8fff65c3557608e83280d5d521b362150aa8bb46198748c0b9907b9ba",
    "project_key": "mandible",
    "short_id": "86b63bc",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The title describes several coordinated conversation-DAG capabilities rather than one isolated fix.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Branching display, fork/resume, and path-aware hydration are separate but coordinated surfaces."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8921e8408a7d536e2c3adffe334df0ecd8a8ae546952dc582cc60a2519d602b2",
    "project_key": "mandible",
    "short_id": "8921e84",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The report centers one capability or implementation lane; related children or labels do not change that single-lane purpose: Implement promotion of the long-lived docs branch into the protected branch (**develop if present, else main**; verified here = `main`) **without destroying the docs worktree**: on explicit promotion, cut a throwaway `promote/docs/<ts>` branch from the docs-branch head and submit **that** to the auth queue, so `cleanup_merged_worktrees` (`cli/auth-merge.sh:410`, called after every successful merge) tears down only th",
    "evidence": [
      {
        "source": "issue report for mandible/8921e84",
        "quote_or_summary": "Implement promotion of the long-lived docs branch into the protected branch (**develop if present, else main**; verified here = `main`) **without destroying the docs worktree**: on explicit promotion, cut a throwaway `promote/docs/<ts>` branch from the docs-branch head and submit **that** to the auth queue, so `cleanup_merged_worktrees` (`cli/auth-merge.sh:410`, called after every successful merge) tears down only the disposable proxy worktree. **Promotion mechanism = a `cli/space.sh promote-docs` subcommand** (the"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782220602483,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "8b47b855e3d5caf23916de02fadfca41dd1bd22d5f7aac2a231915d04e122c28",
    "project_key": "mandible",
    "short_id": "8b47b85",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/8b47b85 (title)",
        "quote_or_summary": "Annotation-driven dashboard follow-ups"
      },
      {
        "source": "mandible issue report mandible/8b47b85 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1780258029962,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8c988edb3b258680651e3688b9d571392f56891628e0c87d579fc2d77764a82d",
    "project_key": "mandible",
    "short_id": "8c988ed",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body explicitly assigns several boundary-cleanup children covering backup, preflight, and switchboard behavior.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Separate children move mechanism into Mandible for backup and auth preflight and address switchboard policy boundaries."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781368911284,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8cf4d95f812dfcfd8de81fd8dc495ba367a8b7f2b66bf41b0998c0d57baf32f3",
    "project_key": "rlrmp",
    "short_id": "8cf4d95",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is an artifact-output organization and reporting maintenance change.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The deliverable separates diagnostic summaries from bulk detail artifacts."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782017303252,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "8e2e8b21fc02811f71005f99f9fda3705b529865403a6d516b90c2ae4a83b90f",
    "project_key": "mandible",
    "short_id": "8e2e8b2",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Summary Replace the placeholder \"Mandible\" identity with a real user system covering humans and agents: a user registry with credentials (public key material only) and claimed bindings, evidence-backed attribution on durable writes, ownership on sessions and work units, verified merge signatures, local client authentication, and group/project permissions. Users include humans (e.g. the operator, authenticated by Y",
    "evidence": [
      {
        "source": "issue report for mandible/8e2e8b2",
        "quote_or_summary": "## Summary Replace the placeholder \"Mandible\" identity with a real user system covering humans and agents: a user registry with credentials (public key material only) and claimed bindings, evidence-backed attribution on durable writes, ownership on sessions and work units, verified merge signatures, local client authentication, and group/project permissions. Users include humans (e.g. the operator, authenticated by YubiKey-backed signing) and agents (e.g. claude-code, authenticated ambiently by its registered signi"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784744812649,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8e546417f6599d07d560d1d968be9f55f8ecd406ffce47c92480ae93bc36f601",
    "project_key": "mandible",
    "short_id": "8e54641",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The body defines one automatic auth-request change-breakdown capability with a shared report contract and backend/UI implementation lanes. Those lanes implement the feature; the primary purpose is not a generic coordination surface.",
    "evidence": [
      {
        "source": "mandible issue report mandible/8e54641 (title)",
        "quote_or_summary": "Automatic change breakdowns for auth requests"
      },
      {
        "source": "mandible issue report mandible/8e54641 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1789054823914,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8ec5295ce8426ddd6bb3d8e0f6b8c5fc0708a024e4559a9456a94c17f3a40b67",
    "project_key": "mandible",
    "short_id": "8ec5295",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body defines a transactional outbox and coordinates staged-action storage, merge execution, and review/inbox consumers.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Children own the action contract, merge-completion execution, and auth review/inbox consumption of the staged bundle."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781222028144,
    "observed_kind": "unknown",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8f2674f55be4b6b289016fa06d8825e18cfe239db5be590edc3d1cb6f4c7741e",
    "project_key": "feedbax",
    "short_id": "8f2674f",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: ## Problem The public warmup-cosine schedule implementation reaches its terminal rate at the authored decay endpoint and currently holds that rate afterward, but the public contract and non-billable preflight do not certify the post-terminal interval through the run end. Surfaced from [issue:rlrmp2/41478ae]. That experiment needs both rewarm rows to use a common 1,000-update warmup, return to 3e-5 at continuation upd",
    "evidence": [
      {
        "source": "issue report for feedbax/8f2674f",
        "quote_or_summary": "## Problem The public warmup-cosine schedule implementation reaches its terminal rate at the authored decay endpoint and currently holds that rate afterward, but the public contract and non-billable preflight do not certify the post-terminal interval through the run end. Surfaced from [issue:rlrmp2/41478ae]. That experiment needs both rewarm rows to use a common 1,000-update warmup, return to 3e-5 at continuation update 3,500, and hold 3e-5 for the final 1,000 updates of a 4,500-update continuation. Runtime behavio"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784551495037,
    "observed_kind": "bug",
    "observed_labels": [
      "feature"
    ]
  },
  {
    "id": "8f876d5fef86e615018e5e0036dc84f829082255bde0e2b6ea68bb661746f055",
    "project_key": "mandible",
    "short_id": "8f876d5",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Coordinate the current UI container unification pass across Mandible detail panes and left sidebars. ## Scope - Reuse the existing sidebar-shell issue [issue:7a95348] for moving remaining left sidebars onto the shared `ViewSidebar` container. - Implement [issue:84bec97] for shared sidebar search/filter header primitives. - Implement [issue:13ac70c] for a shared static detail-pane shell/header used by Issues, Artifact",
    "evidence": [
      {
        "source": "issue report for mandible/8f876d5",
        "quote_or_summary": "Coordinate the current UI container unification pass across Mandible detail panes and left sidebars. ## Scope - Reuse the existing sidebar-shell issue [issue:7a95348] for moving remaining left sidebars onto the shared `ViewSidebar` container. - Implement [issue:84bec97] for shared sidebar search/filter header primitives. - Implement [issue:13ac70c] for a shared static detail-pane shell/header used by Issues, Artifacts, and Auth. ## Children | issue | scope | branch | state | | --- | --- | --- | --- | | [issue:7a953"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783023054655,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "8fd85546b787f4e98f8a1de307c0d37a246ca8fa336112e8850663ff2bef557d",
    "project_key": "rlrmp",
    "short_id": "8fd8554",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Motivating question: define and execute the final pre-analysis spread of C&S GRU models, separating no-hold discovery rows, hold/delayed rows, and later SISU-conditioned rows while preserving a stable shared run contract. ## Shared Lock - Target support: `const_band16` fixed `0.15 m` reach-length support unless a child issue explicitly narrows it. - Controller family: GRU, hidden size `180`, 5 replicates per row. - O",
    "evidence": [
      {
        "source": "issue report for rlrmp/8fd8554",
        "quote_or_summary": "Motivating question: define and execute the final pre-analysis spread of C&S GRU models, separating no-hold discovery rows, hold/delayed rows, and later SISU-conditioned rows while preserving a stable shared run contract. ## Shared Lock - Target support: `const_band16` fixed `0.15 m` reach-length support unless a child issue explicitly narrows it. - Controller family: GRU, hidden size `180`, 5 replicates per row. - Optimizer: peak LR `3e-3`, warmup-cosine schedule, 500 warmup batches, warmup init fraction `0.1`. - "
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782570806990,
    "observed_kind": "umbrella",
    "observed_labels": [
      "experiment",
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "91a090c9e4ba2a31f2a78a39ef243095acda651be571535db94ca42a96d85763",
    "project_key": "rlrmp",
    "short_id": "91a090c",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/91a090c (title)",
        "quote_or_summary": "Adaptive curriculum ramp-duration comparison"
      },
      {
        "source": "mandible issue report rlrmp/91a090c (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782938294605,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "925f4ad1326e8e4012ea9ce681181cfe05ffa389ab860c9569e095cdcf20ffde",
    "project_key": "feedbax",
    "short_id": "925f4ad",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/925f4ad (title)",
        "quote_or_summary": "Umbrella: 2026-07-15 backend architecture audit remediation"
      },
      {
        "source": "mandible issue report feedbax/925f4ad (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=maintenance|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788408845616,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "96ac771ec838a8f96b65dbf58671a418fafa54c6c3063ff8bedf3fb3a6d9a832",
    "project_key": "feedbax",
    "short_id": "96ac771",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue owns the product and implementation bundle for authoring and launching runs across targets and states.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Scope includes target-specific configuration, value specs, run matrices, run tables, and backend manifests/status updates."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1783481694318,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "96c5090ef9c607a1e77dc961ed007fee48948568b344c12906fea3f7123b36d9",
    "project_key": "mandible",
    "short_id": "96c5090",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/96c5090 (title)",
        "quote_or_summary": "Umbrella: umbrella membership by relationship edges only"
      },
      {
        "source": "mandible issue report mandible/96c5090 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=coordination|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1788021903405,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "9727d79f23490bb5fddd8b2a45286375e2ad9ae2003578249f711b3f874a2d07",
    "project_key": "rlrmp",
    "short_id": "9727d79",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue is a first scientific distillation run with named dimensions and policy.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "A 6D H-infinity h0 GRU distillation run is an experiment."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782258367627,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "9937a1a877c5c7b4d7eeb8c9531c48fcb99b376d1a5d7585460ed6dcb113c970",
    "project_key": "feedbax",
    "short_id": "9937a1a",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Goal Land the launch-safety fixes proven by the completed rlrmp2 stabilization-fraction experiment, and repair the two remaining defects it exposed, so the next experiment uses ordinary Feedbax contracts without a downstream workaround. ## Scope Integrate the already-signed snapshot-provenance, smoke cleanup, process identity, science-revision, and trace-cardinality fixes onto current develop. Repair interrupted-P",
    "evidence": [
      {
        "source": "issue report for feedbax/9937a1a",
        "quote_or_summary": "## Goal Land the launch-safety fixes proven by the completed rlrmp2 stabilization-fraction experiment, and repair the two remaining defects it exposed, so the next experiment uses ordinary Feedbax contracts without a downstream workaround. ## Scope Integrate the already-signed snapshot-provenance, smoke cleanup, process identity, science-revision, and trace-cardinality fixes onto current develop. Repair interrupted-PROVISION teardown so teardown cannot reacquire a replacement resource. Repair native artifact custod"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788643781646,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "993aa8f4ed0ef4e5be37ba54a44d210da4ef7c6d3ddb0a8300e4e42f2c305c3d",
    "project_key": "mandible",
    "short_id": "993aa8f",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue is a concrete UI polish/behavior defect set in the Spaces canvas and sidebar chrome.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The follow-up is scoped to concrete canvas and sidebar chrome defects after the bottom inspector change."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782568560530,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "9b5df67c34a50b7285c084811839d0b1b95b372410b40e11e5e30412424a8ff1",
    "project_key": "dotfiles",
    "short_id": "9b5df67",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Umbrella issue for the Console tab bigbuild. The Console tab adds embedded agent sessions directly to the Mandible dashboard. Users can run Claude Code (and later other agent backends) inside Mandible without leaving to a terminal emulator. ## Sub-issues - Backend: PTY manager + WebSocket server + ring buffer + DB migrations - Frontend: Console tab UI + sub-tab system + xterm.js + view toggle - Renderer: stream-json ",
    "evidence": [
      {
        "source": "issue report for dotfiles/9b5df67",
        "quote_or_summary": "Umbrella issue for the Console tab bigbuild. The Console tab adds embedded agent sessions directly to the Mandible dashboard. Users can run Claude Code (and later other agent backends) inside Mandible without leaving to a terminal emulator. ## Sub-issues - Backend: PTY manager + WebSocket server + ring buffer + DB migrations - Frontend: Console tab UI + sub-tab system + xterm.js + view toggle - Renderer: stream-json event parsing + rich HTML rendering ## Key design decisions - node-pty + WebSocket on existing port "
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "9bb676f050b7e18e5dfd71e33ae85a9ceef406b71d56b4d895595edee2b1048f",
    "project_key": "rlrmp",
    "short_id": "9bb676f",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The report centers one capability or implementation lane; related children or labels do not change that single-lane purpose: Part of umbrella [issue:54389a4]. Follow-up to [issue:ae9f30f], [issue:3c5836c], and [issue:4bd6a81]. Goal: finish the pre-run gate for the next corrected soft-lambda training attempt by making the finite policy adversary use the intended Adam-family optimizer, producing regenerated frozen-batch diagnostics, and estimating mechanism-specific lambda values for direct epsilon, linear no-bias, and affine mechanisms. Sco",
    "evidence": [
      {
        "source": "issue report for rlrmp/9bb676f",
        "quote_or_summary": "Part of umbrella [issue:54389a4]. Follow-up to [issue:ae9f30f], [issue:3c5836c], and [issue:4bd6a81]. Goal: finish the pre-run gate for the next corrected soft-lambda training attempt by making the finite policy adversary use the intended Adam-family optimizer, producing regenerated frozen-batch diagnostics, and estimating mechanism-specific lambda values for direct epsilon, linear no-bias, and affine mechanisms. Scope: - Verify and, where needed, implement the production finite-policy optimizer path so `linear_no_"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782836354241,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "9d8eb395d027393a387b4c6e720b36f548302338fbf373faccc86fe081d1b2dd",
    "project_key": "rlrmp",
    "short_id": "9d8eb39",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/9d8eb39 (title)",
        "quote_or_summary": "Adversary formalism and same-channel GRU robustness path"
      },
      {
        "source": "mandible issue report rlrmp/9d8eb39 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1780927395422,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "9f1252a976750a022386eff812523088fd2e7f01092c00fa6d1f97b091cdbef7",
    "project_key": "humbleb",
    "short_id": "9f1252a",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report humbleb/9f1252a (title)",
        "quote_or_summary": "Implementation-only remaining backend batch"
      },
      {
        "source": "mandible issue report humbleb/9f1252a (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1780232888166,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "9fd33f00566fcca13192b66f884504d90f2ec14c320282fd846a59f8cdd876d9",
    "project_key": "mandible",
    "short_id": "9fd33f0",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: ## Context git-bug is deprecated: the Mandible ledger is canonical, and git-bug should exist only as a manual import path. But the daemon still runs git-bug continuously and, worse, synchronously inside request handlers — `spawnSync` plus a busy-wait retry loop on the single event loop, so one legacy call can freeze the entire dashboard (worst case ~45s: 3 retries x 15s timeout). ## Current behavior - Active poller: ",
    "evidence": [
      {
        "source": "issue report for mandible/9fd33f0",
        "quote_or_summary": "## Context git-bug is deprecated: the Mandible ledger is canonical, and git-bug should exist only as a manual import path. But the daemon still runs git-bug continuously and, worse, synchronously inside request handlers — `spawnSync` plus a busy-wait retry loop on the single event loop, so one legacy call can freeze the entire dashboard (worst case ~45s: 3 retries x 15s timeout). ## Current behavior - Active poller: startup scan (`src/index.ts:236`) and a 5-minute `setInterval` rescan (`src/index.ts:252`), each run"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782952467534,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "a01da2d745ba3db21fb494647f0f3169ae668cad48a501697f927e50e66f4797",
    "project_key": "rlrmp",
    "short_id": "a01da2d",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue addresses an alignment defect in delayed perturbation-bank evaluation movement.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Movement alignment in delayed perturbation-bank evaluation is a concrete correctness problem."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781973671368,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "a378b34f81f43cd34197877bba2470deda303583c114b074e1ed6975593cf43f",
    "project_key": "rlrmp",
    "short_id": "a378b34",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "This is a concrete scientific distillation/training attempt with a locked run specification, launch gate, and post-run analysis.",
    "evidence": [
      {
        "source": "issue report body and comments",
        "quote_or_summary": "The report describes the first pure closed-loop extLQG-to-GRU attempt, locks its training formulation before launch, and later records the authorized run and analysis."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782264346700,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "a5fff90adbd8489122f337dedb6b23e722f5aec25b60d26a75a062c5813bd400",
    "project_key": "mandible",
    "short_id": "a5fff90",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/a5fff90 (title)",
        "quote_or_summary": "Spaces Document editor correction: remove block chrome and make reference insertion real"
      },
      {
        "source": "mandible issue report mandible/a5fff90 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782507120237,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "a654d52c70457ceff5bf83bdb336c9297b902636c7d114f180b6f492ad075db5",
    "project_key": "dotfiles",
    "short_id": "a654d52",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/a654d52 (title)",
        "quote_or_summary": "Adopt begood and consolidate the agent-policy review"
      },
      {
        "source": "mandible issue report dotfiles/a654d52 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=coordination|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787717012358,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "a6ec3275aeab8181ee40370d49023894a388037aeb06e05384f67214f03873c4",
    "project_key": "feedbax",
    "short_id": "a6ec327",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/a6ec327 (title)",
        "quote_or_summary": "Lean governance, topology truth, and deletion harvest"
      },
      {
        "source": "mandible issue report feedbax/a6ec327 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=maintenance|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788408845684,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "a6eff5585bd85f18d9dcf1efd77ac05bc2d1ffca1b4a5b7571ca634a77f2367d",
    "project_key": "rlrmp2",
    "short_id": "a6eff55",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The primary purpose is a Stage-5 science bundle spanning knot-table control, SISU sampling, locking, and well-posedness, with several child deliverables under one integration branch.",
    "evidence": [
      {
        "source": "issue report body",
        "quote_or_summary": "The body names the Stage-5 SISU conditioning program and lists distinct knot-table, sampling, lock, and well-posedness work with six child issues."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784648645176,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "a8fbc09a842806a5fc5265d70c206e25be6c0858c74f1f0fba1ae96afd77b354",
    "project_key": "mandible",
    "short_id": "a8fbc09",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The scope coordinates a cross-system ownership contract and multiple provider/repository consumers.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The contract spans Mandible, HumbleB, Feedbax, custody, references, source snapshots, claims, and projections."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1780163078893,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "aa69570c169479db295ff6312d3d0906f7f3e8648be29b26ca61709763c5223e",
    "project_key": "rlrmp2",
    "short_id": "aa69570",
    "kind": "umbrella",
    "confidence": "medium",
    "rationale": "The body explicitly coordinates separate velocity-profile and adaptive-diagnostic child deliverables. The organizing program, rather than either individual figure, is the primary purpose.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp2/aa69570 (title)",
        "quote_or_summary": "Post-run comparison figures: velocity profiles and lambda/damage traces"
      },
      {
        "source": "mandible issue report rlrmp2/aa69570 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp2/aa69570 (body)",
        "quote_or_summary": "The body explicitly coordinates separate velocity-profile and adaptive-diagnostic child deliverables. The organizing program, rather than either individual figure, is the primary purpose."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784346665745,
    "observed_kind": "feature",
    "observed_labels": [
      "umbrella"
    ]
  },
  {
    "id": "ac8e9866716103d193835aaa490d0c10c6e9efc72b48c40a598dbfeb0213ae45",
    "project_key": "mandible",
    "short_id": "ac8e986",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Design spec for making Mandible resilient, self-diagnosing, and optionally self-repairing when it crashes or hangs. Synthesized from independent analyses by Opus and Gemini. --- ## Architecture baseline (what already exists) - SSE client has exponential backoff reconnect (500ms-15s). Server sends `: heartbeat` every 15s. - `RebuildingSplash` overlay already exists, triggered by `mandible:rebuilding` SSE event. - `GET",
    "evidence": [
      {
        "source": "issue report for mandible/ac8e986",
        "quote_or_summary": "Design spec for making Mandible resilient, self-diagnosing, and optionally self-repairing when it crashes or hangs. Synthesized from independent analyses by Opus and Gemini. --- ## Architecture baseline (what already exists) - SSE client has exponential backoff reconnect (500ms-15s). Server sends `: heartbeat` every 15s. - `RebuildingSplash` overlay already exists, triggered by `mandible:rebuilding` SSE event. - `GET /api/health` returns uptime, version, commit hash. - `unhandledRejection` is logged but does NOT cr"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "ae9f30f3bd717d880672171d855f86deb67d0e392b831c51a25767c73b02e57a",
    "project_key": "rlrmp",
    "short_id": "ae9f30f",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/ae9f30f (title)",
        "quote_or_summary": "Corrected soft-lambda smoke training run"
      },
      {
        "source": "mandible issue report rlrmp/ae9f30f (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782784630739,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "aee7cb2d439e43fbd7e569e1486ad84dbe7e6d4ebc0773f9b20605479ff50c13",
    "project_key": "mandible",
    "short_id": "aee7cb2",
    "kind": "bug",
    "confidence": "medium",
    "rationale": "The problem is a concrete stale exact-conversation lookup and bounded catch-up failure, including a daemon-crash regression. Child fixes remain part of this correctness repair.",
    "evidence": [
      {
        "source": "mandible issue report mandible/aee7cb2 (title)",
        "quote_or_summary": "Refresh an exact conversation lookup to its current source extent"
      },
      {
        "source": "mandible issue report mandible/aee7cb2 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|umbrella; status=open."
      },
      {
        "source": "mandible issue report mandible/aee7cb2 (body)",
        "quote_or_summary": "The problem is a concrete stale exact-conversation lookup and bounded catch-up failure, including a daemon-crash regression. Child fixes remain part of this correctness repair."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787201100887,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "b0845acfb8b7e4413cb3311c0caf30a043f6dc60de4e6d904a003649f44462de",
    "project_key": "rlrmp2",
    "short_id": "b0845ac",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body explicitly says the parent coordinates two smaller science/config seams and owns no implementation.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The objective is one frozen trial/noise bank, with two child deliverables and a parent coordination boundary."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1784176953666,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "b2f2da394090b8497a632cd9a5d56ae40051ac7a0cdaa280be47d65e02278647",
    "project_key": "mandible",
    "short_id": "b2f2da3",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "Despite “experiment” in the title, the issue is an umbrella coordinating auth-message, dotfiles, policy, warning, and later review work.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The body lists five children and defines the canonical protected-delivery message contract and its stabilization review."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1786715004690,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "b3ce3aeab66a37818313b4377c6aca30b17ecd24c5a9c4d66a65ae4993401eb3",
    "project_key": "feedbax",
    "short_id": "b3ce3ae",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body coordinates separate module splits and downstream import fallout.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Children split root misc and types modules, followed by a downstream RLRMP import pass."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1785947250571,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "b413bb0fa3f02e4c766df7c1b9b8b26bb1ca6179981b0ea6f8dea831f41585c3",
    "project_key": "rlrmp",
    "short_id": "b413bb0",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The task prepares a locked scientific run configuration for a named beta condition.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "A beta 1.4 soft run lock is experimental run preparation."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "obsolete",
    "observed_updated_at": 1782867255162,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "b435ba5de415ac57af3b3d70fbc72b0f0a4fa6383a15c24911a2d6afac2a562a",
    "project_key": "mandible",
    "short_id": "b435ba5",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Objective Deliver the annotated Artifact UX follow-up through one integration preview and one protected delivery: OS-default external opening for available artifact material, plus a shared search-control overlay with Artifact sorting. ## Current facts - Artifacts, Issues, and Auth use one shared floating search-control overlay contract. - Artifact sorting supports field and direction controls and persists browser-",
    "evidence": [
      {
        "source": "issue report for mandible/b435ba5",
        "quote_or_summary": "## Objective Deliver the annotated Artifact UX follow-up through one integration preview and one protected delivery: OS-default external opening for available artifact material, plus a shared search-control overlay with Artifact sorting. ## Current facts - Artifacts, Issues, and Auth use one shared floating search-control overlay contract. - Artifact sorting supports field and direction controls and persists browser-local view intent. - Artifact external opening resolves selected-version custody server-side and del"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1785518029477,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "feature",
      "umbrella"
    ]
  },
  {
    "id": "b45f19b234c0fff8b977589c25baf7c021adc676c929359d854595c60286337d",
    "project_key": "mandible",
    "short_id": "b45f19b",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The scope defines one graph API/UI projection capability over canonical ledger relationships and overlays. It is a feature even though the scope has several technical facets.",
    "evidence": [
      {
        "source": "mandible issue report mandible/b45f19b (title)",
        "quote_or_summary": "Graph projection: ledger relationships, deterministic layouts, live overlays"
      },
      {
        "source": "mandible issue report mandible/b45f19b (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=open."
      },
      {
        "source": "mandible issue report mandible/b45f19b (body)",
        "quote_or_summary": "The scope defines one graph API/UI projection capability over canonical ledger relationships and overlays. It is a feature even though the scope has several technical facets."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "b45feec7c55f1d6328529a16b2760403e35ae78d2e7665f6e96697e7efdd6633",
    "project_key": "dotfiles",
    "short_id": "b45feec",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The body explicitly partitions two workstreams: auth-queue state fixes and tab navigation changes.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The issue is an umbrella for two partitions and lists separate child issues for queue state and tab navigation."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "b4720f27ce48772dabf32b8967c0e781dc295ca57129274d762672cdbff76b25",
    "project_key": "rlrmp",
    "short_id": "b4720f2",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This issue maintains the scientific ledger by invalidating stale cap-conditioned summaries in existing comments and descriptions; it does not own a new run or implementation.",
    "evidence": [
      {
        "source": "issue report body and completion comment",
        "quote_or_summary": "The scope is to mark cap-conditioned summaries as invalid wherever they are presented as launch-facing; the closeout reports comment/description edits and no code or run."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496903,
    "observed_kind": "unknown",
    "observed_labels": [
      "experiment",
      "maintenance"
    ]
  },
  {
    "id": "b557d4e14ed58a3c2b3ce4e9306f509167f3a93b60d96fa27e36bda3ee87310e",
    "project_key": "rlrmp",
    "short_id": "b557d4e",
    "kind": "experiment",
    "confidence": "medium",
    "rationale": "The issue delivers a scientific synthesis document interpreting a null result and sequencing follow-up analyses. It is research/experimental analysis, not a parent organizer or a user-facing feature.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/b557d4e (title)",
        "quote_or_summary": "Synthesis review: objective-form hypothesis for C&S peak-velocity null"
      },
      {
        "source": "mandible issue report rlrmp/b557d4e (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp/b557d4e (body)",
        "quote_or_summary": "The issue delivers a scientific synthesis document interpreting a null result and sequencing follow-up analyses. It is research/experimental analysis, not a parent organizer or a user-facing feature."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "b683ea5790cbbc4526633fe1a3b660630f64277ed3fa25cc0e82d627e5f5bcdf",
    "project_key": "mandible",
    "short_id": "b683ea5",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue identifies concrete rendering latency and control-layout defects in the Spaces Board.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Prompt rendering and compact add-column controls are specific behavior/presentation defects."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782498851737,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "b900e0c7dd6b83d45f05a62494ec1729c3a18f78d15fd9c402f9d5a2e06a7b39",
    "project_key": "rlrmp2",
    "short_id": "b900e0c",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue explicitly calls itself a velocity-profile sub-umbrella and centralizes several trained/analytical evaluation and plotting children under shared contracts.",
    "evidence": [
      {
        "source": "issue report body",
        "quote_or_summary": "The body says 'Velocity-profile sub-umbrella' and lists children c271dc7 and 10b400e plus shared sample, projection, statistics, schema, recipe, and figure-input contracts."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1785544323886,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "babb0727d3f547d42acf4c6d4e4de84033dd617d9972f4dd4cf844dc1c6c59d4",
    "project_key": "mandible",
    "short_id": "babb072",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Coordinate the next pass of Mandible reference cleanup after compact artifact refs landed in [issue:47ef959]. Goals: - Remove legacy issue ref syntaxes from normal app/runtime behavior: `iss_...`, bare hex issue refs, and `#<hex>` issue refs. - Rewrite existing resolvable legacy issue refs in a copied DB to explicit typed Markdown refs, without touching refs already inside typed refs, Markdown links, code blocks, or ",
    "evidence": [
      {
        "source": "issue report for mandible/babb072",
        "quote_or_summary": "Coordinate the next pass of Mandible reference cleanup after compact artifact refs landed in [issue:47ef959]. Goals: - Remove legacy issue ref syntaxes from normal app/runtime behavior: `iss_...`, bare hex issue refs, and `#<hex>` issue refs. - Rewrite existing resolvable legacy issue refs in a copied DB to explicit typed Markdown refs, without touching refs already inside typed refs, Markdown links, code blocks, or other protected spans. - Deprecate artifact hash URI forms in authored/user-facing text immediately "
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781034771869,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "bd5aefbcc9cee298a94a7089cb8ee467e5dea926b6ad361eb93d4ed5536f902a",
    "project_key": "feedbax",
    "short_id": "bd5aefb",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Problem Studio currently represents delayed-task structure and many task parameters as raw values or JSON-ish arrays in generic fields. That is not a durable UX for tasks like delayed reaches, eval overrides, perturbations, temporal loss weights, acausal component parameters, or trial/replicate variation. The product needs a generalized authoring system for values that are sometimes constants, sometimes expression",
    "evidence": [
      {
        "source": "issue report for feedbax/bd5aefb",
        "quote_or_summary": "## Problem Studio currently represents delayed-task structure and many task parameters as raw values or JSON-ish arrays in generic fields. That is not a durable UX for tasks like delayed reaches, eval overrides, perturbations, temporal loss weights, acausal component parameters, or trial/replicate variation. The product needs a generalized authoring system for values that are sometimes constants, sometimes expressions, sometimes reusable time-varying functions, and sometimes sampled/random variables. This should ap"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781130391401,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "c07eae13b91e0524ec549c2b2e2f90615033b47a13b3ad46b32336299e30a8b0",
    "project_key": "feedbax",
    "short_id": "c07eae1",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/c07eae1 (title)",
        "quote_or_summary": "Umbrella: Studio/provider schema contract, task data, and selector validation"
      },
      {
        "source": "mandible issue report feedbax/c07eae1 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "c4df28dbcba2ff79cc1f3bc6b4164d884674ff0c02dce239d9af5312c422964c",
    "project_key": "mandible",
    "short_id": "c4df28d",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The issue defines one artifact-version review-round capability: annotate an immutable version, revise, and repeat. Its child lanes implement that feature.",
    "evidence": [
      {
        "source": "mandible issue report mandible/c4df28d (title)",
        "quote_or_summary": "Plan review: annotate an immutable artifact version, agent revises, repeat"
      },
      {
        "source": "mandible issue report mandible/c4df28d (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report mandible/c4df28d (body)",
        "quote_or_summary": "The issue defines one artifact-version review-round capability: annotate an immutable version, revise, and repeat. Its child lanes implement that feature."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1786932605074,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "c5404998341b5ec2e721b5fcd16252949329babea899e804f7a1026b92be5b00",
    "project_key": "feedbax",
    "short_id": "c540499",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The body describes one coherent memory-efficiency capability: compact task parameters with on-demand target generation.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Replace stored trajectory arrays with a compact TaskParams struct and target_at_t(), reducing per-environment memory."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "bug",
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "c58f784859836a9a06eca320493c13890b06841971e4409a908cdb2babb30c84",
    "project_key": "mandible",
    "short_id": "c58f784",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The issue is a concrete replacement of the review interaction model, not merely a report of an existing defect.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The planned resolution replaces free-text branch selection with a branch sidebar/timeline and moves compare into Projects."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "c6c5997351617ff288eb2622af03c7bf94c63fb6fbc3cfb759ebe5d601dec3e9",
    "project_key": "rlrmp",
    "short_id": "c6c5997",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The follow-up evaluates learning-rate continuity under adaptive epsilon, a scientific condition.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Adaptive-epsilon LR-continuity is a named experimental follow-up."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783818352342,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "c73945d0614e89dfb24971d590872a6925f9d21ac01b2a36a58d900c2da87753",
    "project_key": "feedbax",
    "short_id": "c73945d",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Goal\\n\\nFix live correctness and security defects while deleting repeated implementations of the same invariant.\\n\\n## Scope\\n\\nOwn secure-path consolidation, silent-default refusal, acausal authored-interior construction, one parent/delta and override application authority, strict external JSON boundaries, and the high-risk analysis parameter contract. Do not change compiler package ownership, durable hash domain",
    "evidence": [
      {
        "source": "issue report for feedbax/c73945d",
        "quote_or_summary": "## Goal\\n\\nFix live correctness and security defects while deleting repeated implementations of the same invariant.\\n\\n## Scope\\n\\nOwn secure-path consolidation, silent-default refusal, acausal authored-interior construction, one parent/delta and override application authority, strict external JSON boundaries, and the high-risk analysis parameter contract. Do not change compiler package ownership, durable hash domains, or Studio persistence.\\n\\n## Sequence\\n\\nConsolidate the security-critical path chain first, then"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788408845690,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "c7c1c854cc5cbd6d680b095867f1233d958105e327cc9e4b1055a0bedee4b739",
    "project_key": "rlrmp2",
    "short_id": "c7c1c85",
    "kind": "umbrella",
    "confidence": "medium",
    "rationale": "The body says the parent coordinates two smaller scientific seams and owns no implementation; it is therefore an umbrella for those deliverables.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp2/c7c1c85 (title)",
        "quote_or_summary": "Define the NumPy comparator problem and LQR reference"
      },
      {
        "source": "mandible issue report rlrmp2/c7c1c85 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=open."
      },
      {
        "source": "mandible issue report rlrmp2/c7c1c85 (body)",
        "quote_or_summary": "The body says the parent coordinates two smaller scientific seams and owns no implementation; it is therefore an umbrella for those deliverables."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1784172155210,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "c92ebd83aa08554c8d68cd9dfec4820e910b6c5ca55ba62f6f9cfcca58cab8c4",
    "project_key": "rlrmp",
    "short_id": "c92ebd8",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue is a scientific training matrix: it defines nine calibrated perturbation rows, launch gates, full runs, and post-run analysis for a comparative question.",
    "evidence": [
      {
        "source": "issue report body and post-run comments",
        "quote_or_summary": "The body defines a no-PGD calibrated perturbation matrix and its launch prerequisites; later comments record all nine rows completing at 12000 batches and subsequent comparisons."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782586690224,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "c9aa161702a8c1ba0c75fa0bdb4987467246c66b9e5e2c764dec3716c00cf7a6",
    "project_key": "mandible",
    "short_id": "c9aa161",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: Follow-up from IAB review of the Canvas edge/selection inspector pass. Problems to correct: - Selection inspector was implemented as a right side panel, but user asked for a bottom panel similar to Timeline. It should also be the destination for item refs clicked from document/canvas where applicable. - Inspector shows a confusing top-right hash that is not the selected issue display id. Remove or clarify it. - Node ",
    "evidence": [
      {
        "source": "issue report for mandible/c9aa161",
        "quote_or_summary": "Follow-up from IAB review of the Canvas edge/selection inspector pass. Problems to correct: - Selection inspector was implemented as a right side panel, but user asked for a bottom panel similar to Timeline. It should also be the destination for item refs clicked from document/canvas where applicable. - Inspector shows a confusing top-right hash that is not the selected issue display id. Remove or clarify it. - Node ports no longer move on hover, but are now positioned chaotically inside nodes; restore stable left/"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782507146050,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "cb3685af0b690bf57b4d8110e0f7ec44c1df90b96dc62cc66e51696011a54afe",
    "project_key": "rlrmp",
    "short_id": "cb3685a",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/cb3685a (title)",
        "quote_or_summary": "Nominal baseline on harmonized clean task (no-integrator game, moderate open-loop bank)"
      },
      {
        "source": "mandible issue report rlrmp/cb3685a (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783782200295,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "cce48c19599911b8a92aab37b776e99b2daf7eded8fd54c24003b186a4ca66dd",
    "project_key": "mandible",
    "short_id": "cce48c1",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/cce48c1 (title)",
        "quote_or_summary": "Issues view: label pills and status pills visually indistinct; \"error\" label looks like error state"
      },
      {
        "source": "mandible issue report mandible/cce48c1 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "cd5a3bc64ff17545a8dc27e0211d059d5d26897b3ee10f23c478d125986f2352",
    "project_key": "feedbax",
    "short_id": "cd5a3bc",
    "kind": "umbrella",
    "confidence": "medium",
    "rationale": "The objective is a public, versioned checkpoint-custody packet round trip, and the issue explicitly coordinates child lanes while owning no implementation. Its primary role is multi-deliverable coordination.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/cd5a3bc (title)",
        "quote_or_summary": "Materialize authenticated checkpoint-custody archives"
      },
      {
        "source": "mandible issue report feedbax/cd5a3bc (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|umbrella; status=open."
      },
      {
        "source": "mandible issue report feedbax/cd5a3bc (body)",
        "quote_or_summary": "The objective is a public, versioned checkpoint-custody packet round trip, and the issue explicitly coordinates child lanes while owning no implementation. Its primary role is multi-deliverable coordination."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1784181055783,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "ce690eb12b78b1b6a5a5fb6c85310a423531ae5237357ecf060bc60e00f96332",
    "project_key": "mandible",
    "short_id": "ce690eb",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates six separate control-plane and artifact-durability problems with child implementation details.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The background lists project identity, daemon readiness, payload handling, comment editing, path durability, and artifact identity as separate problems."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782418474533,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "ce814d1c879046c03a7e147570540bb8e43827ccec322f76cebe742bf719afcf",
    "project_key": "feedbax",
    "short_id": "ce814d1",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "This is a repo-wide cleanup program with external contract boundaries and multiple residual surfaces.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The body requests scrutiny of duplication, stale abstractions, dead code, tests, and tooling while preserving several external contracts."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1780174287526,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "ce8d0a6365d143f48d11f8a8fae070e07f19bcf6ae47c64f6b4e1b4be3008778",
    "project_key": "mandible",
    "short_id": "ce8d0a6",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Objective Deliver one safe end-to-end prototype that reviews two difficult dotfiles policy sections as an immutable, repo-custody Briefing, offers two text-variant decisions, supports whole-section annotation actions, and exports selected wording to ordinary Markdown without touching any official instruction source or generated output. ## Parent-owned specification The review artifact is a separate inactive file c",
    "evidence": [
      {
        "source": "issue report for mandible/ce8d0a6",
        "quote_or_summary": "## Objective Deliver one safe end-to-end prototype that reviews two difficult dotfiles policy sections as an immutable, repo-custody Briefing, offers two text-variant decisions, supports whole-section annotation actions, and exports selected wording to ordinary Markdown without touching any official instruction source or generated output. ## Parent-owned specification The review artifact is a separate inactive file committed on a dotfiles feature branch. Mandible binds the exact commit-pinned artifact version into "
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1787409452651,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "ceb5963936d47c70315242651c792dd1840ad49d6c3ce79a942f7e0ef3257053",
    "project_key": "mandible",
    "short_id": "ceb5963",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/ceb5963 (title)",
        "quote_or_summary": "Spaces Document editor should behave like a transparent Markdown document"
      },
      {
        "source": "mandible issue report mandible/ceb5963 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782605176640,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "cfdcbbd335a6d669c504771cc79eabb78feb19900359965c9ca0548d75c7849d",
    "project_key": "mll-bio",
    "short_id": "cfdcbbd",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mll-bio/cfdcbbd (title)",
        "quote_or_summary": "Sidenote hydration error on long/complex footnotes"
      },
      {
        "source": "mandible issue report mll-bio/cfdcbbd (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=error|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "d1f90ac629c86de2aefa78ae0f59a2229f2e4daa43107c3fd925e4a615df2eb1",
    "project_key": "rlrmp",
    "short_id": "d1f90ac",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The title and scope combine several residual workstreams across defaults, tasks, cloud, and module hygiene.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Multiple residual categories are coordinated under one post-alignment review issue."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1783283898582,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "d2200956d3669becbd00c14e251369b24cf192b0bfaa8692c9821266c283d3bf",
    "project_key": "mandible",
    "short_id": "d220095",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates a broad cutover of Briefing identity, rounds, directives, responses, recurrence, and custody.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The objective defines a single artifact-backed Briefing model with immutable rounds, exact artifact versions, and frozen submissions."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787027966882,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "d31e6f379ca19e4cadce1ad54c56aa1a8181ee9658de6b8ce2109876e5d1fcff",
    "project_key": "rlrmp",
    "short_id": "d31e6f3",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The report centers one capability or implementation lane; related children or labels do not change that single-lane purpose: ## Problem Current delayed no-PGD training can suppress gross pre-go and catch leakage, but the no-catch reach still peaks below the matched extLQG movement reference and shows early force/filter or acceleration support decay. One plausible reason is that the model is being asked to learn too many changes at once: wait through a preparation period, treat the go cue as permission to move, handle variable go timing, ha",
    "evidence": [
      {
        "source": "issue report for rlrmp/d31e6f3",
        "quote_or_summary": "## Problem Current delayed no-PGD training can suppress gross pre-go and catch leakage, but the no-catch reach still peaks below the matched extLQG movement reference and shows early force/filter or acceleration support decay. One plausible reason is that the model is being asked to learn too many changes at once: wait through a preparation period, treat the go cue as permission to move, handle variable go timing, handle catch/no-go trials, preserve good reach kinematics, and later support robustness training. This"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781623065540,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "d366bfb7a3be23743e13df279b59bc6b1a07e9f647b08f6b3b8f0b139085ed61",
    "project_key": "rlrmp2",
    "short_id": "d366bfb",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates multiple generated-document and compiler-cache changes under one integration boundary.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The goal is to make compiler output disposable cache content instead of tracked repository content, with several coordinated changes."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788437910253,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "d469108e72c7e7ab743b4ff587d0c9ddb63c8b3d2121dd85af2f3251b7a47f0b",
    "project_key": "rlrmp",
    "short_id": "d469108",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/d469108 (title)",
        "quote_or_summary": "Redo frozen Adam soft-lambda matching"
      },
      {
        "source": "mandible issue report rlrmp/d469108 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496903,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "d5169a0f63adae60d384adc1d6c44062b027d5e7615e27eb3c1890f342d31223",
    "project_key": "feedbax",
    "short_id": "d5169a0",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Goal\\n\\nGive durable identities, saved Studio state, and recovered processes one explicit versioned truth across Python and TypeScript.\\n\\n## Scope\\n\\nOwn the authored-bytes-to-assertion map, compile-lock algorithm pins, canonical JSON convergence, Python/TypeScript hash parity, Studio persistence version admission, process identity, autosave transaction correctness, analysis layout persistence, timeline epoch exe",
    "evidence": [
      {
        "source": "issue report for feedbax/d5169a0",
        "quote_or_summary": "## Goal\\n\\nGive durable identities, saved Studio state, and recovered processes one explicit versioned truth across Python and TypeScript.\\n\\n## Scope\\n\\nOwn the authored-bytes-to-assertion map, compile-lock algorithm pins, canonical JSON convergence, Python/TypeScript hash parity, Studio persistence version admission, process identity, autosave transaction correctness, analysis layout persistence, timeline epoch execution, remote-worker trust, and concurrent snapshot authority.\\n\\n## Sequence\\n\\nMap identities onc"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1788408845692,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "d55c5f047f218615200b0ef672fe05a34670d4d9ad8a1a48ec57ee23371d89e7",
    "project_key": "rlrmp",
    "short_id": "d55c5f0",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The title directly identifies an adversarial scientific experiment.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Soft-constraint adversary experiment is explicitly experimental work."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782674904388,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "d7400ee7eae1f284c5682a526b8fa41352c8b3b872be32f1ed1cdf308197aee7",
    "project_key": "mandible",
    "short_id": "d7400ee",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Problem Mandible still emits and copies long canonical IDs from ordinary user-facing surfaces. The concrete reproduction is Briefing `33046fe6`: ordinary header copy actions use the full stored IDs, and **Go to artifact version** navigates to an `artifact-series:<full-id>` surface instead of preserving the exact short `artifact-version` identity. This violates the user contract: every ordinary app and CLI emission",
    "evidence": [
      {
        "source": "issue report for mandible/d7400ee",
        "quote_or_summary": "## Problem Mandible still emits and copies long canonical IDs from ordinary user-facing surfaces. The concrete reproduction is Briefing `33046fe6`: ordinary header copy actions use the full stored IDs, and **Go to artifact version** navigates to an `artifact-series:<full-id>` surface instead of preserving the exact short `artifact-version` identity. This violates the user contract: every ordinary app and CLI emission must use an ambiguity-safe short-form ID. Full IDs are internal mutation/storage authority, not the"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787344042746,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "d74acde001aa4447420437a71584518e5afef6e4eca208a5eda90f248316e5e6",
    "project_key": "dotfiles",
    "short_id": "d74acde",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Umbrella issue for 24h retro findings: incorrect git-bug syntax in CLAUDE.md, raw-commit/merge blocks, worktree.yaml stale entries, subagent convention propagation, starchat/labmode skill updates. ~100+ wasted tool calls/day. 9 partitions: P1-P9.",
    "evidence": [
      {
        "source": "issue report for dotfiles/d74acde",
        "quote_or_summary": "Umbrella issue for 24h retro findings: incorrect git-bug syntax in CLAUDE.md, raw-commit/merge blocks, worktree.yaml stale entries, subagent convention propagation, starchat/labmode skill updates. ~100+ wasted tool calls/day. 9 partitions: P1-P9."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "d7d4f7430dd7ccceea88cb200f2bae427207f0c60548eabca39719d1d2775520",
    "project_key": "mandible",
    "short_id": "d7d4f74",
    "kind": "feature",
    "confidence": "medium",
    "rationale": "The objective defines and enforces a new actor-scoped response capability for isolated preview copies, with explicit positive and negative authorization behavior. It is a feature/capability contract, not merely a defect report.",
    "evidence": [
      {
        "source": "mandible issue report mandible/d7d4f74 (title)",
        "quote_or_summary": "Permit actor-scoped Briefing responses on isolated preview copies"
      },
      {
        "source": "mandible issue report mandible/d7d4f74 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787194390984,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "d9211fe9e26645d4d68832a8b6fe5f7eb3597b876eb543dadc736afd103cbc9d",
    "project_key": "feedbax",
    "short_id": "d9211fe",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/d9211fe (title)",
        "quote_or_summary": "Complete root utility cleanup"
      },
      {
        "source": "mandible issue report feedbax/d9211fe (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=maintenance|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781486887020,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "da0a78bc79f9dc3cbe73f694df084ff5b212620b9aa2b49401e4553fc80974d6",
    "project_key": "dotfiles",
    "short_id": "da0a78b",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/da0a78b (title)",
        "quote_or_summary": "Lean agentic-loop policies: pilot and promotion"
      },
      {
        "source": "mandible issue report dotfiles/da0a78b (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1784594176371,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "db41e6a87285c5f256a106a5ba7e3a84b07e18df4552b5ddb3709b8f10fccef7",
    "project_key": "feedbax",
    "short_id": "db41e6a",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue is a multi-wave backend hardening program spanning correctness, gates, orchestration, persistence, packaging, and analysis.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The body sequences three waves and multiple child findings across the backend and worker surfaces."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783360184436,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "dc560da3f71c8c5fc89c4a46809df48c0c3e256dc141aaeffe526e7c658d1a32",
    "project_key": "mandible",
    "short_id": "dc560da",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes concrete Spaces rendering and save-feedback defects.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Immediate rendering and clear preview-disabled save feedback are specific broken behaviors."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782948791130,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "dd232cdc448fefb750440b67bbbc20c9709c772b947aac6e0ca339df5df26f48",
    "project_key": "rlrmp",
    "short_id": "dd232cd",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: Part of [issue:43e8728] after the output-feedback/noise fidelity gap surfaced.\\n\\nMotivation: the current analytical/output-feedback lanes have now exposed multiple C&S fidelity gaps after the original Phase 0 game card. Before rerunning Phase 1 or Phase 3 again, we need an exhaustive audit against C&S 2019 paper/code and then one corrected canonical game card.\\n\\nScope:\\n- independently audit rlrmp current game-card",
    "evidence": [
      {
        "source": "issue report for rlrmp/dd232cd",
        "quote_or_summary": "Part of [issue:43e8728] after the output-feedback/noise fidelity gap surfaced.\\n\\nMotivation: the current analytical/output-feedback lanes have now exposed multiple C&S fidelity gaps after the original Phase 0 game card. Before rerunning Phase 1 or Phase 3 again, we need an exhaustive audit against C&S 2019 paper/code and then one corrected canonical game card.\\n\\nScope:\\n- independently audit rlrmp current game-card/output-feedback/rollout code against C&S 2019 paper and released ModelDB MATLAB code;\\n- explicitly"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1780094074870,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "de56ffabbbd05873773a438d3864eef57dee7621adf67e14f05ea31825e109d9",
    "project_key": "mandible",
    "short_id": "de56ffa",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Spaces is an authored surface for organizing heterogeneous references — issues, comments, artifacts, and external docs — into intentional project groups, leading ultimately to writing a **document** that pulls results together. It is **complementary to Timeline, not a replacement**: Timeline is the chronological / global-time-axis view; Spaces is the user/agent-structured organizing surface. Both remain primary; any ",
    "evidence": [
      {
        "source": "issue report for mandible/de56ffa",
        "quote_or_summary": "Spaces is an authored surface for organizing heterogeneous references — issues, comments, artifacts, and external docs — into intentional project groups, leading ultimately to writing a **document** that pulls results together. It is **complementary to Timeline, not a replacement**: Timeline is the chronological / global-time-axis view; Spaces is the user/agent-structured organizing surface. Both remain primary; any Timeline cross-links are shared-component / related, never \"supersedes\". **Design summary (settled; "
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782184979088,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "dee4fafda0acd4c7da36278b7c2e20db8fd54f673c3860639134a0f706863e2e",
    "project_key": "rlrmp",
    "short_id": "dee4faf",
    "kind": "maintenance",
    "confidence": "medium",
    "rationale": "The body is generated-artifact/provenance normalization and tracked JSON footprint cleanup, with no new user-facing capability. This is maintenance.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/dee4faf (title)",
        "quote_or_summary": "Normalize tracked diagnostic JSON provenance"
      },
      {
        "source": "mandible issue report rlrmp/dee4faf (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=feature|maintenance; status=closed; resolution=merged."
      },
      {
        "source": "mandible issue report rlrmp/dee4faf (body)",
        "quote_or_summary": "The body is generated-artifact/provenance normalization and tracked JSON footprint cleanup, with no new user-facing capability. This is maintenance."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782700030884,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "df9929f3e982d91cdc73181baee4aaf0dbaed23ac4a8597faf631bb92902d885",
    "project_key": "dotfiles",
    "short_id": "df9929f",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is documentation and contract maintenance for an existing CLI and commit workflow, not a new product capability.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The scope is to update the Mandible Interface Contract and global policy documentation; it explicitly owns no Mandible code."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782184905798,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "dfe72d9a564d03aa51fc4441e62e03a0b1aeb4544b48409300262efe59c4510d",
    "project_key": "humbleb",
    "short_id": "dfe72d9",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The title identifies a concrete rendering defect in merged-entity visualization.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Merged entities are displayed with overlapping circles, which is a specific visual bug."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "e13b0e9b0c229588801c9be9223b0d29017d2833095f11f18e78fdd6483d2081",
    "project_key": "rlrmp",
    "short_id": "e13b0e9",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue is a coordinated package-maintenance program with compatibility-shim removal and multiple package surfaces.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Package layout cleanup and shim removal are grouped under a maintenance umbrella."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781477766382,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  },
  {
    "id": "e13c51dae416777ddaaa1a5cc09bac5403c468bb84daab426f0f1c05132ce9b2",
    "project_key": "rlrmp2",
    "short_id": "e13c51d",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Program umbrella for the rlrmp2 side of the 2026-07 streamlining program. Purpose: - Protect locked campaigns from upstream churn (pin the Feedbax revision in locks; the Feedbax side enforces it at rehearsal and execution). - Consume landed Feedbax extension surfaces only where the public contract actually replaces a local stand-in. - Prepare SISU without inventing scientific or operational bindings, and measure slim",
    "evidence": [
      {
        "source": "issue report for rlrmp2/e13c51d",
        "quote_or_summary": "Program umbrella for the rlrmp2 side of the 2026-07 streamlining program. Purpose: - Protect locked campaigns from upstream churn (pin the Feedbax revision in locks; the Feedbax side enforces it at rehearsal and execution). - Consume landed Feedbax extension surfaces only where the public contract actually replaces a local stand-in. - Prepare SISU without inventing scientific or operational bindings, and measure slimming only after a real second method family traverses the governed path. Feedbax counterpart umbrell"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1785544303562,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "e148f3387a70a1e504ba0939189fe9d7a40384ca495f3bfb663df09dd348f838",
    "project_key": "rlrmp",
    "short_id": "e148f33",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue is explicitly a concrete launch-facing experiment with one locked adaptive curriculum row and a stated scientific question.",
    "evidence": [
      {
        "source": "issue report body and completion comment",
        "quote_or_summary": "The body calls this a concrete experiment issue and specifies the adaptive 3500-to-1000 row; the completion comment records the run outcome and verdict."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782936150359,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "e220c4405e916bad10e48027bd291d01a62884e199b186655e19739c72bd239d",
    "project_key": "mandible",
    "short_id": "e220c44",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report mandible/e220c44 (title)",
        "quote_or_summary": "Reject and clean up references issue refs"
      },
      {
        "source": "mandible issue report mandible/e220c44 (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|maintenance; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782996489281,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "e3e54b230edc7239bf7a950e3ed890ce96ffb8a047862d2f98523155105bad68",
    "project_key": "feedbax",
    "short_id": "e3e54b2",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The primary purpose is to coordinate several Feedbax remediation deliverables under one integration/auth boundary, so the canonical kind is umbrella rather than bug.",
    "evidence": [
      {
        "source": "issue report body",
        "quote_or_summary": "The body says it coordinates Feedbax-side fixes and enumerates children 57c94e5, 8fa8929, and ff733f2 with an integration plan."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783350724829,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "umbrella"
    ]
  },
  {
    "id": "e59ed002fbc12d3bb65d34938e88e04215b6bbb613bd271240b31df70f72c343",
    "project_key": "feedbax",
    "short_id": "e59ed00",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/e59ed00 (title)",
        "quote_or_summary": "Umbrella: Studio platform health — performance, contract integrity, UX foundations"
      },
      {
        "source": "mandible issue report feedbax/e59ed00 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783444992108,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "e6e5b0f6a5b31960afe641aec7b333cad513839384a58429109120caec5f26df",
    "project_key": "feedbax",
    "short_id": "e6e5b0f",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue is a program umbrella combining governed launch work with extension-surface slimming and several diagnosed debt areas.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The motivation and scope cover governed execution, durable contracts, validation, and residual extension-surface reductions."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1784585101197,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "e71fd9c44d9608ef911f98871c6156a3fce252b9fdee16d3e5f8d62dc7e755a1",
    "project_key": "rlrmp",
    "short_id": "e71fd9c",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/e71fd9c (title)",
        "quote_or_summary": "Fixed-setpoint series: independent controllers along the robustness axis"
      },
      {
        "source": "mandible issue report rlrmp/e71fd9c (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1783574918688,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "e74dcfb994a3a34d8925ea25f09b31a07a907fec66ad65b1fa8bdd9a7ffb2a09",
    "project_key": "mandible",
    "short_id": "e74dcfb",
    "kind": "unknown",
    "confidence": "low",
    "rationale": "The remaining body is only “testing label fix,” which does not establish a substantive bug, feature, maintenance task, experiment, coordination record, or umbrella.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The body contains only the phrase “testing label fix”; the title is also non-substantive."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "e7a8bade66d548f0f62c440bf849266a78953cf2e45899f54496b594a8a6b81d",
    "project_key": "mandible",
    "short_id": "e7a8bad",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Umbrella for two-partition build. P1 (auth-queue-state): Fix stale state on refresh, fix orphan card P2 (tab-nav): Tab renames/reorder/twin-button, keyboard shortcuts Migrated from dotfiles issue [issue:dotfiles/b45feec].",
    "evidence": [
      {
        "source": "issue report for mandible/e7a8bad",
        "quote_or_summary": "Umbrella for two-partition build. P1 (auth-queue-state): Fix stale state on refresh, fix orphan card P2 (tab-nav): Tab renames/reorder/twin-button, keyboard shortcuts Migrated from dotfiles issue [issue:dotfiles/b45feec]."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "e7b6e264dd1cf7366bfa9baf30369ca6a2675a9dcf1af5e3c15a584fb4bfdc9b",
    "project_key": "feedbax",
    "short_id": "e7b6e26",
    "kind": "unknown",
    "confidence": "high",
    "rationale": "The review classified this as retained architecture/design orientation about whether WhereDict and lambda keys are suitable, with alternatives discussed but no owned implementation deliverable. The explicit user decision for this single question-kind issue is to migrate it to unknown rather than tracker.",
    "evidence": [
      {
        "source": "issue report body and comments",
        "quote_or_summary": "The imported question asks whether the WhereDict/lambda-key approach is suitable; later comments compare alternative representations and record architectural context rather than a concrete implementation scope."
      },
      {
        "source": "explicit user decision",
        "quote_or_summary": "The single question-kind issue migrates to unknown."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "question",
    "observed_labels": [
      "question"
    ]
  },
  {
    "id": "e85c5bc07c6f636c491d9d822e3d94e85166c3a95e791c5b2cda657b364913a0",
    "project_key": "mandible",
    "short_id": "e85c5bc",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/e85c5bc (title)",
        "quote_or_summary": "Mandible desktop: daemon lifecycle controls and startup resilience"
      },
      {
        "source": "mandible issue report mandible/e85c5bc (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "e901a2099d0f4162155a994f7037e16e3f7dee87b83539ae3c272ab69bf6a5a5",
    "project_key": "rlrmp",
    "short_id": "e901a20",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue compares H0 policy and adversary conditions scientifically.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "The named policy-adversary comparison is an experiment."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782233516857,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "ea6cc7fda29181f7f4ccee0e3a617aa475d378355e80e4608144a9f9f21510f6",
    "project_key": "mandible",
    "short_id": "ea6cc7f",
    "kind": "feature",
    "confidence": "high",
    "rationale": "The body specifies a concrete interaction/inspector replacement with several user-facing capabilities; it is more than one isolated defect.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "Scope includes edge selection actions, unified node inspectors, smooth dragging, toolbar overflow, immediate node placement, and autosave status placement."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782573201608,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "ec59e0eb5fc08e46bfc39902ef5336cec5128e2210a1afc58d06cba12696d511",
    "project_key": "rlrmp",
    "short_id": "ec59e0e",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The report describes a concrete defect or correctness gap in existing behavior: Follow-up to [issue:5720a49], [issue:301d1f0], and [issue:08483d5]. Part of [issue:54389a4]. Goal: ensure historical soft-adversary cap/radius values never arise spontaneously in living training, replay, or analysis code. Historical run specs and old-row reproduction may continue to carry the values they actually used, but new code paths must require an explicit caller choice and provenance if a cap/radius is invoked",
    "evidence": [
      {
        "source": "issue report for rlrmp/ec59e0e",
        "quote_or_summary": "Follow-up to [issue:5720a49], [issue:301d1f0], and [issue:08483d5]. Part of [issue:54389a4]. Goal: ensure historical soft-adversary cap/radius values never arise spontaneously in living training, replay, or analysis code. Historical run specs and old-row reproduction may continue to carry the values they actually used, but new code paths must require an explicit caller choice and provenance if a cap/radius is invoked. Problem: after the cap-derived lambda guard merged, live code still appears to expose historical r"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1782879244166,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "feature"
    ]
  },
  {
    "id": "ef9c882f4660459a6541eafeda285039bd487561eacf16e80411aa02b41a827e",
    "project_key": "rlrmp",
    "short_id": "ef9c882",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The issue describes an empirical/scientific question, comparison, calibration, or run/materialization lane.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/ef9c882 (title)",
        "quote_or_summary": "Alternative pre-go hold penalties for delayed reach"
      },
      {
        "source": "mandible issue report rlrmp/ef9c882 (kind/labels)",
        "quote_or_summary": "Observed kind=feature; labels=experiment|feature; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781899685347,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "efa20938bbf6e3916b40e8b53aa83c65418acabe4fbbeac281360aa405a68ab5",
    "project_key": "feedbax",
    "short_id": "efa2093",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report feedbax/efa2093 (title)",
        "quote_or_summary": "Pipeline pane redesign: staging, sweeps, lineage, launch"
      },
      {
        "source": "mandible issue report feedbax/efa2093 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783471431882,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "f17622a047ebace09de906e696cf4389130857cf6d6a24e88e3a2374e13b906e",
    "project_key": "dotfiles",
    "short_id": "f17622a",
    "kind": "maintenance",
    "confidence": "high",
    "rationale": "This is repository-policy and generated-instruction cleanup: it removes duplicated command-surface text and configures the canonical instruction projection/post-export hook, rather than introducing a product capability.",
    "evidence": [
      {
        "source": "issue report body and completion comment",
        "quote_or_summary": "The body identifies duplicated Mandible contract text in 10-global.md and requires one generated command surface; the closeout reports removal of duplicates and setup of standalone generated targets."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1781119801586,
    "observed_kind": "feature",
    "observed_labels": [
      "feature",
      "maintenance"
    ]
  },
  {
    "id": "f3c5db9d86ae354aabd3445cdcc465e0173e22fd07b29f376db3589e340f1121",
    "project_key": "rlrmp",
    "short_id": "f3c5db9",
    "kind": "experiment",
    "confidence": "high",
    "rationale": "The task tunes and audits reliability for a frozen optimizer condition, an experimental evaluation.",
    "evidence": [
      {
        "source": "issue.title",
        "quote_or_summary": "Frozen Adam audit reliability tuning is a named experiment/evaluation activity."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1782746496904,
    "observed_kind": "feature",
    "observed_labels": [
      "experiment",
      "feature"
    ]
  },
  {
    "id": "f3dbb3e6dcf1e050d05e89d0100bf69d59fecf580d54fe4b89bc21029bba696c",
    "project_key": "mandible",
    "short_id": "f3dbb3e",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Umbrella issue for the Mandible inbox redesign. Moving from \"show all open issues\" to a work-queue/dispatch model with agent liveness tracking, continuation lifecycle, and issue-driven navigation. ## Design Summary (from two rounds of independent Opus + Gemini analysis) ### Round 1: Core dispatch model **State machine**: open → committed → merged (+ abandoned as terminal). No \"claimed\" or \"in-progress\" states — liven",
    "evidence": [
      {
        "source": "issue report for mandible/f3dbb3e",
        "quote_or_summary": "Umbrella issue for the Mandible inbox redesign. Moving from \"show all open issues\" to a work-queue/dispatch model with agent liveness tracking, continuation lifecycle, and issue-driven navigation. ## Design Summary (from two rounds of independent Opus + Gemini analysis) ### Round 1: Core dispatch model **State machine**: open → committed → merged (+ abandoned as terminal). No \"claimed\" or \"in-progress\" states — liveness and assignment are derived, not stored. **Activation**: Two-phase model: - Phase 1 (worktree cre"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "f695729a4f0fac5c0bed8433a42d7455cdf0b2c317b97dcd81637bb5362d7537",
    "project_key": "rlrmp",
    "short_id": "f695729",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Motivating question Why does our trained flavor-B controller give Δv ≈ −25% while the corrected analytical H∞ Riccati gives Δv ≈ +1–2.4% on the C&S regime, and what does that disagreement tell us about the relationship between linear-controller theory and trained recurrent controllers under unpredictable disturbances? ## Status **Exploring**, not yet committed. This umbrella defines a candidate next phase for the ",
    "evidence": [
      {
        "source": "issue report for rlrmp/f695729",
        "quote_or_summary": "## Motivating question Why does our trained flavor-B controller give Δv ≈ −25% while the corrected analytical H∞ Riccati gives Δv ≈ +1–2.4% on the C&S regime, and what does that disagreement tell us about the relationship between linear-controller theory and trained recurrent controllers under unpredictable disturbances? ## Status **Exploring**, not yet committed. This umbrella defines a candidate next phase for the project; the user has not yet greenlit running the chain end-to-end. Stages can be paused after each"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": null,
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "f6e6617cb91b0d7039fbf46efb3ed35295d1d244601857e99f5b7bce68c321bb",
    "project_key": "mandible",
    "short_id": "f6e6617",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report mandible/f6e6617 (title)",
        "quote_or_summary": "Versioned Mandible client for wt/agent-commit ledger mechanism; worktree/commit policy stays in dotfiles"
      },
      {
        "source": "mandible issue report mandible/f6e6617 (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=feature|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781373392808,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "f85769eb8f0973da19aa3afdfd3c563959f4a3bc6750ad7a47a627ec9ca011c6",
    "project_key": "dotfiles",
    "short_id": "f85769e",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue's primary purpose is to organize several related deliverables or child lanes into one coordinated program.",
    "evidence": [
      {
        "source": "mandible issue report dotfiles/f85769e (title)",
        "quote_or_summary": "First live agent-policy refinement after 9a3bc296"
      },
      {
        "source": "mandible issue report dotfiles/f85769e (kind/labels)",
        "quote_or_summary": "Observed kind=umbrella; labels=coordination|umbrella; status=open."
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1787716801918,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "fa3978f0be3fd11d011d4edf8baf9596486a3acaf3afa6385d0121ae1da451e8",
    "project_key": "feedbax",
    "short_id": "fa3978f",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "This is explicitly a cross-repository roadmap coordinating the vertical MVP path and its contract layers.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The body defines one coherent vertical path across Feedbax, Studio, Mandible, manifests, artifacts, and inspection surfaces."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "fac28cb7e6725b473e802db094f15eb6d3fea61264fcdc166bf5734721e28c7b",
    "project_key": "rlrmp",
    "short_id": "fac28cb",
    "kind": "bug",
    "confidence": "high",
    "rationale": "The issue describes a concrete defect, regression, or correctness failure; child fixes do not change that primary substance.",
    "evidence": [
      {
        "source": "mandible issue report rlrmp/fac28cb (title)",
        "quote_or_summary": "Retired linear-controller cleanup and decoupling-diagnostic attribute drift"
      },
      {
        "source": "mandible issue report rlrmp/fac28cb (kind/labels)",
        "quote_or_summary": "Observed kind=bug; labels=error|maintenance; status=closed; resolution=merged."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1783182222801,
    "observed_kind": "bug",
    "observed_labels": [
      "bug",
      "maintenance"
    ]
  },
  {
    "id": "fb63ef9497f26721bc36c7e84f036a49ed4418a07623085d9a6ecd2e2aaafa9e",
    "project_key": "feedbax",
    "short_id": "fb63ef9",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: ## Goal Make a graph-changing training continuation an ordinary, explicit Feedbax operation. A caller supplies a source checkpoint and a target model graph; Feedbax identifies stable model and optimizer state by semantic ownership, derives a complete fail-closed transfer plan, executes it, and records enough provenance to reproduce and audit the result. The first downstream use is nominal to SISU continuation in rlrm",
    "evidence": [
      {
        "source": "issue report for feedbax/fb63ef9",
        "quote_or_summary": "## Goal Make a graph-changing training continuation an ordinary, explicit Feedbax operation. A caller supplies a source checkpoint and a target model graph; Feedbax identifies stable model and optimizer state by semantic ownership, derives a complete fail-closed transfer plan, executes it, and records enough provenance to reproduce and audit the result. The first downstream use is nominal to SISU continuation in rlrmp2, but the Feedbax contract must remain general. rlrmp2 will state only scientific intent, source c"
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "fixed",
    "observed_updated_at": 1788641287772,
    "observed_kind": "umbrella",
    "observed_labels": [
      "tracker",      "umbrella"
    ]
  },
  {
    "id": "fe566dcd29106e735d89c3fa4a42fd7ce708b65e973aaf3637cf2a63dc19968a",
    "project_key": "mandible",
    "short_id": "fe566dc",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The issue coordinates a new graph surface across several entity types, edges, navigation, and server-side relationships.",
    "evidence": [
      {
        "source": "issue.body",
        "quote_or_summary": "The planned GraphView includes issues, branches, auth requests, sessions, multiple edge types, and navigation behavior."
      }
    ],
    "observed_status": "closed",
    "observed_resolution": "merged",
    "observed_updated_at": 1779816673786,
    "observed_kind": "umbrella",
    "observed_labels": [
      "feature",
      "umbrella"
    ]
  },
  {
    "id": "fed12caefc4fcbc365295fa307fc23f6fcf062d1c2b26c27f9fef7547bd73d7f",
    "project_key": "mandible",
    "short_id": "fed12ca",
    "kind": "umbrella",
    "confidence": "high",
    "rationale": "The report's primary purpose is a multi-deliverable program or integration surface: Motivating question: what should we fix across Mandible's backend, security, contracts, database, and build/test hygiene, in priority order, and who owns each unit of work? Source: broad-spectrum review on 2026-06-10 (five parallel deep reviews + firsthand re-verification of the top findings), recorded in `docs/mandible-review-2026-06-10.md`. This umbrella coordinates the fix work; long-form rationale lives on each c",
    "evidence": [
      {
        "source": "issue report for mandible/fed12ca",
        "quote_or_summary": "Motivating question: what should we fix across Mandible's backend, security, contracts, database, and build/test hygiene, in priority order, and who owns each unit of work? Source: broad-spectrum review on 2026-06-10 (five parallel deep reviews + firsthand re-verification of the top findings), recorded in `docs/mandible-review-2026-06-10.md`. This umbrella coordinates the fix work; long-form rationale lives on each child. STATUS (2026-06-10): implemented in six merge lanes via integration branch `integration/fed12c"
      }
    ],
    "observed_status": "open",
    "observed_resolution": null,
    "observed_updated_at": 1781149660869,
    "observed_kind": "umbrella",
    "observed_labels": [
      "maintenance",
      "umbrella"
    ]
  }
] as const;
