# P9-A Exchange Reading Phase 2

This candidate is local-only. It must not be applied to Production without a separate release review.

## Membership policy

- Rooms have two to four active members. One active member may keep the room and invite again; zero active members ends it.
- Declining or leaving does not reactivate membership. A current active member must send a fresh invitation and the user must accept it.
- A `blocked` historical membership cannot be invited back into that room. Current pairwise blocks are rechecked under sorted user locks before invitations, acceptance, and content writes.
- Leaving revokes the user's note shares. Past group messages remain available to the remaining active members.
- A different title/author can be linked only when the invitee explicitly confirms that their edition is the same work. The personal book remains the source of truth.

## Messages and reports

- Group messages are separate from 1:1 DM storage. Direct table access is denied; active membership and all active-member block pairs are checked by RPC.
- `client_id` makes retries idempotent. A sender may add at most 20 messages per room per rolling minute.
- Read cursors are per room and account. Listing does not mark read; the visible room marks the newest rendered message.
- A group report snapshots one message and its timestamp. Evidence and receipts are inaccessible to browser roles. The existing hourly P5-B purge deletes the snapshot at the same maximum-90-day boundary while retaining `social_reports` metadata.

## Account deletion boundary

Account deletion preserves group-message bodies for the remaining participants, sets `sender_id` to `NULL`, records `sender_deleted_at`, and renders the author as `탈퇴한 사용자`. Membership, private notes and share links still cascade. Reports and protected evidence survive deletion of either party and follow the shared hold-aware retention policy documented in `p9a-account-deletion.md`.

## Phase 3 boundary

`exchange_reading_note_shares` contains only links to owner-private notes. Phase 3 must add spoiler-aware RPCs without granting access to `book_notes`, must implement edition/page rules, and must decide how a revoked share can be re-shared without losing audit meaning.
