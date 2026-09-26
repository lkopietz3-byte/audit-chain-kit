-- reference-impl/postgres-advisory-lock-append.sql
--
-- Concurrency-safe append for a hash-chained audit log, backed by Postgres.
--
-- STATUS (read first)
-- ---------------------------------------------------------------------------
-- * NOT compatible with verifyChain(). This function hashes
--   sha256(prev_hash || p_canonical_json); appendEntry()/verifyChain() hash
--   canonicalJSON({ createdAt, index, payload, prevHash }). Rows written here
--   fail verifyChain() even when nothing was changed.
-- * idx, chain_id and created_at are not bound into entry_hash, and the
--   hashed bytes (p_canonical_json) are not stored, so a row cannot be
--   re-verified from this table alone.
-- * Not tested in this repository (no Postgres in its test suite), and not
--   shipped in the npm package. Treat it as an illustration of the advisory
--   lock pattern only.
--
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------------
-- `appendEntry()` in this package is an in-memory pure function: it takes an
-- array, returns a new array. That's fine for a single process holding the
-- whole chain in memory. It is NOT fine the moment two callers can append to
-- the SAME chain concurrently against a shared database — e.g. two API
-- requests both handling events for the same report/order/session at once.
--
-- THE RACE THIS PREVENTS
-- ---------------------------------------------------------------------------
-- The naive version of "append to a DB-backed hash chain" is:
--   1. SELECT entry_hash FROM chain WHERE chain_id = ? ORDER BY idx DESC LIMIT 1
--   2. compute entry_hash = sha256(prev_hash || canonicalJSON(record))
--   3. INSERT the new row
-- If two callers interleave between step 1 and step 3, both read the SAME
-- prev_hash, both compute a hash chained off it, and both INSERT — the
-- chain forks into two branches that each look internally valid. Nothing
-- about `verifyChain()` (or any hash-chain verifier) can detect a fork after
-- the fact; the only fix is to make the read-then-write atomic.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- Wrap the SELECT and the INSERT in a single PL/pgSQL function and take a
-- transaction-scoped advisory lock (`pg_advisory_xact_lock`)
-- keyed by `chain_id` before reading prev_hash. Advisory locks are:
--   - automatically released at COMMIT or ROLLBACK (including on error or a
--     dropped connection) — they cannot leak and wedge the table forever;
--   - keyed per chain_id (via hashtextextended), so concurrent appends to
--     DIFFERENT chains never contend with each other, only same-chain
--     appends serialize;
--   - cheap: no row lock, no table lock, just an in-memory lock table.
-- Concurrent callers appending to the same chain now queue up one at a time
-- across the read+write, so the second caller's SELECT can only run after
-- the first caller's INSERT (and lock release) has completed — no fork is
-- possible.
--
-- Isolation level: this reasoning assumes READ COMMITTED (the Postgres
-- default), where the SELECT below takes a fresh snapshot after the lock is
-- granted. Under REPEATABLE READ or SERIALIZABLE the snapshot can predate
-- the lock, so a queued caller may read a stale head; the unique
-- (chain_id, idx) constraint then turns that into an error, not a fork.
-- (Reasoned from Postgres semantics; not tested here.)
--
-- CANONICALIZATION SPLIT: SQL doesn't (and shouldn't) reimplement
-- `canonicalJSON` from `src/canonicalize.ts`. Instead the caller computes
-- the canonical JSON string in application code (using this package's
-- `canonicalJSON`, or a byte-identical reimplementation) and passes it in as
-- `p_canonical_json`; Postgres just concatenates prev_hash and hashes,
-- INSIDE the lock, using pgcrypto. Keep the app-side canonicalizer and this
-- function's hash formula in lockstep — see the comment on `v_entry_hash`.
--
-- USAGE
-- ---------------------------------------------------------------------------
--   const canonical = canonicalJSON({ payload, /* whatever fields you hash */ });
--   const { data } = await supabase.rpc("append_audit_entry", {
--     p_chain_id: reportId,
--     p_canonical_json: canonical,
--     p_payload: payload,
--   });
--   // data.entry_hash / data.prev_hash / data.idx now reflect the persisted row.
--
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

create table if not exists audit_chain (
  id          bigserial primary key,
  chain_id    text        not null,
  idx         integer     not null,
  payload     jsonb       not null,
  prev_hash   text        not null,
  entry_hash  text        not null,
  created_at  timestamptz not null default now(),

  -- Belt-and-suspenders: even if the advisory-lock discipline were ever
  -- bypassed by a rogue caller, the DB itself refuses two rows claiming the
  -- same position in the same chain.
  constraint audit_chain_unique_position unique (chain_id, idx)
);

create index if not exists audit_chain_by_chain_id_idx
  on audit_chain (chain_id, idx desc);

create or replace function append_audit_entry(
  p_chain_id        text,
  p_canonical_json  text,   -- canonical (key-sorted) JSON of the record to hash, computed by the caller
  p_payload         jsonb   -- the payload actually stored/queried; need not equal p_canonical_json verbatim
)
returns table (
  id          bigint,
  chain_id    text,
  idx         integer,
  prev_hash   text,
  entry_hash  text,
  created_at  timestamptz
)
language plpgsql
as $$
declare
  v_prev_hash  text;
  v_next_idx   integer;
  v_entry_hash text;
begin
  if p_chain_id is null or p_chain_id = '' then
    raise exception 'append_audit_entry: p_chain_id is required';
  end if;

  -- Transaction-scoped advisory lock, keyed per chain_id. Held until this
  -- function's call completes (COMMIT or ROLLBACK of the implicit or
  -- surrounding transaction) — never leaks past that, even on error.
  -- hashtextextended(text, seed) collapses chain_id to a bigint lock key;
  -- collisions between different chain_ids are possible in principle (it's
  -- a hash) but only cause unrelated chains to needlessly serialize, never
  -- an incorrect chain — correctness comes from the SELECT+INSERT being
  -- inside the same lock scope, not from the key being collision-free.
  perform pg_advisory_xact_lock(hashtextextended(p_chain_id, 0));

  select a.entry_hash, a.idx
    into v_prev_hash, v_next_idx
  from audit_chain a
  where a.chain_id = p_chain_id
  order by a.idx desc
  limit 1;

  if v_prev_hash is null then
    -- First entry in this chain. 64 hex zeros — mirrors GENESIS_HASH in
    -- src/types.ts. Keep these in sync if you ever change one.
    v_prev_hash := repeat('0', 64);
    v_next_idx := 0;
  else
    v_next_idx := v_next_idx + 1;
  end if;

  -- entry_hash = SHA-256(prev_hash || canonical_json). This concatenation
  -- convention (prev_hash prefixed onto the canonical record string) is one
  -- valid choice; this package's TypeScript `appendEntry` instead folds
  -- prevHash in as a FIELD of the hashed record (see src/chain.ts). Pick ONE
  -- convention for a given deployment and keep the app-side canonicalizer
  -- and this SQL in lockstep — a mismatch here means `verifyChain()` will
  -- report every entry as broken even though nothing was tampered with.
  v_entry_hash := encode(digest(v_prev_hash || p_canonical_json, 'sha256'), 'hex');

  insert into audit_chain (chain_id, idx, payload, prev_hash, entry_hash)
  values (p_chain_id, v_next_idx, p_payload, v_prev_hash, v_entry_hash);

  return query
    select a.id, a.chain_id, a.idx, a.prev_hash, a.entry_hash, a.created_at
    from audit_chain a
    where a.chain_id = p_chain_id and a.idx = v_next_idx;
end;
$$;

-- Lock down direct table writes if you're on Supabase / use RLS: only the
-- function (running as its definer, or under a service role) should be able
-- to insert. Adjust the role name to whatever your service-role/DB role is.
--
-- alter table audit_chain enable row level security;
-- revoke insert, update, delete on audit_chain from public, authenticated;
-- grant execute on function append_audit_entry(text, text, jsonb) to service_role;
