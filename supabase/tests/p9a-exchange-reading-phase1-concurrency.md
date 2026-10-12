# P9-A Phase 1 independent-session checks

Run only against an isolated PostgreSQL database populated by
`p9a-exchange-reading-phase1.postgres.sql`. Never run this fixture against a
linked or Production project.

The RPC lock order is: sorted user advisory locks, then the room advisory lock.
Use two independent `psql` sessions to overlap these cases:

1. `accept_exchange_reading_invitation` vs another accept for the final seat:
   only one transaction may commit and active membership must remain `<= 4`.
2. `invite_exchange_reading_friends` vs accept: reserved `active + invited`
   membership must remain `<= 4`.
3. block vs accept: after both transactions settle, the blocked pair must not
   both be active in the same room; the blocker is marked `blocked` if already
   active.
4. block vs voluntary leave: both calls complete without deadlock and the
   member ends in a non-active state with all of their shares revoked.

PGlite verifies SQL behavior and ACL but does not prove independent-session
advisory-lock behavior. These four cases require PostgreSQL 17 connections.
