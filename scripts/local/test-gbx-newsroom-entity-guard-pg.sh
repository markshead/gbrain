#!/usr/bin/env bash
# Integration test for scripts/local/gbx-newsroom-entity-guard.py against REAL Postgres
# (local patch 2026-10-06, gbxheld). Throwaway pgvector container; two databases named
# `gbrain` and `newsroom` so the script's brain-identity check passes; real gbrain schema via
# `gbrain init` under a scratch GBRAIN_HOME (never touches ~/.gbrain). Never touches production.
#
# Covers: refresh publishes a valid v2 list (and refuses below the floor / on wrong DB names);
# sweep expires only guarded, unfenced, active rows, keeps allowed and fenced ones, writes a
# lossless JSONL backup, and refuses when another sweep holds the advisory lock or the config
# is invalid.
set -euo pipefail
cd "$(dirname "$0")/../.."
SCRIPT="$PWD/scripts/local/gbx-newsroom-entity-guard.py"
PY=${GBX_GUARD_PY:-$HOME/.venvs/sky/bin/python}
PORT=${GBX_GUARD_TEST_PORT:-5441}
NAME=gbxguard-test-pg-$$
T=$(mktemp -d)
pass=0; fail=0
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:$PORT:5432 pgvector/pgvector:pg16 >/dev/null
for i in $(seq 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P() { docker exec -i "$NAME" psql -U postgres -XAt -v ON_ERROR_STOP=1 "$@"; }
P -c "create database gbrain" >/dev/null
P -c "create database newsroom" >/dev/null
P -c "create database wrongname" >/dev/null
X="postgresql://postgres:postgres@127.0.0.1:$PORT/gbrain"
N="postgresql://postgres:postgres@127.0.0.1:$PORT/newsroom"
for u in "$X" "$N"; do
  GBRAIN_HOME="$T/home-$(basename "$u")" bun src/cli.ts init --url "$u" --non-interactive >"$T/init-$(basename "$u").log" 2>&1 \
    || { echo "init failed for $u"; tail -20 "$T/init-$(basename "$u").log"; exit 1; }
done

# gbn: 400 filler people + the named ones, 40 bodies (floors are 400 / 40)
{
  echo "begin;"
  for i in $(seq 1 400); do echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','people/filler-person-$i','person','Filler Person $i','x');"; done
  for i in $(seq 1 40); do echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','ks/test-county/body-number-$i','org','Test County Body Number $i','x');"; done
  echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','people/alice-example','person','Alice \"Q\" Example','x');"
  echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','people/bob-example','person','Bob Example','x');"
  echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','ks/acme-county/commission','org','Acme County Commission','x');"
  echo "insert into page_aliases (source_id, alias_norm, slug) values ('default','alice q example','people/alice-example');"
  echo "commit;"
} | P -d newsroom >/dev/null

# gbx: an ad page naming Bob, a client page, facts
{
  echo "begin;"
  echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','ad-creation/campaigns-ledger','project','Campaigns','## Bob Example — CLOSED / PAID');"
  echo "insert into pages (source_id, slug, type, title, compiled_truth) values ('default','clients/carol-example','company','Carol Example Co','x');"
  echo "insert into facts (source_id, entity_slug, fact, source) values
    ('default','people/alice-example','A1 alice chaired','test'),
    ('default','alice-example','A2 alice spoke','test'),
    ('default','ks/acme-county/commission','C1 commission voted','test'),
    ('default','bob-example','B1 bob renewed the ad','test'),
    ('default','clients/carol-example','K1 client renewed','test'),
    ('default','people/dave-example','D1 dave fixed it','test');"
  echo "insert into facts (source_id, entity_slug, fact, source, row_num, source_markdown_slug) values
    ('default','people/alice-example','F1 fenced alice row','test', 1, 'people/alice-example');"
  echo "insert into facts (source_id, entity_slug, fact, source, row_num, source_markdown_slug) values
    ('default','people/alice-example','A9 conversation alice row','cli:extract-conversation-facts', 5, 'sessions/example');"
  echo "insert into facts (source_id, entity_slug, fact, source, context) values
    ('default','ks/acme-county/commission','C2 pipeline run named the commission','test','news-pipeline/run-2026-09-01');"
  echo "insert into facts (source_id, entity_slug, fact, source, expired_at) values
    ('default','people/alice-example','E1 already expired','test', now() - interval '1 day');"
  echo "commit;"
} | P -d gbrain >/dev/null

: > "$T/extra-allow.txt"   # isolated: never read the operator's real allow/never-allow files
export GBX_GUARD_XERIC_URL="$X" GBX_GUARD_NEWSROOM_URL="$N" GBX_GUARD_LOG="$T/guard.log" \
       GBX_GUARD_BACKUP_DIR="$T/backups" GBX_GUARD_SNAPSHOT="$T/snapshot.json" GBX_GUARD_EXTRA_ALLOW="$T/extra-allow.txt" GBX_GUARD_NEVER_ALLOW="$T/no-never-allow.txt"
mkdir -p "$T/backups"
echo "== gbx-newsroom-entity-guard integration (real Postgres) =="

"$PY" -I "$SCRIPT" refresh >"$T/refresh.out" 2>&1 && ok "refresh succeeds" || { bad "refresh succeeds"; cat "$T/refresh.out"; }
eq "config is a valid v2 list" "$(P -d gbrain -c "select (value::jsonb->>'version') from config where key='facts.newsroom_entity_guard'")" "2"
eq "alice is denied" "$(P -d gbrain -c "select (value::jsonb->'deny') ? 'alice-example' from config where key='facts.newsroom_entity_guard'")" "t"
eq "single-token last segment is never a key" "$(P -d gbrain -c "select (value::jsonb->'deny') ? 'commission' from config where key='facts.newsroom_entity_guard'")" "f"
eq "body full slug denied" "$(P -d gbrain -c "select (value::jsonb->'deny') ? 'ks-acme-county-commission' from config where key='facts.newsroom_entity_guard'")" "t"
eq "ad-campaign person allowed" "$(P -d gbrain -c "select (value::jsonb->'allow_keys') ? 'bob-example' from config where key='facts.newsroom_entity_guard'")" "t"
eq "client page listed exactly" "$(P -d gbrain -c "select (value::jsonb->'allow_slugs') ? 'clients/carol-example' from config where key='facts.newsroom_entity_guard'")" "t"

# wrong database name -> refused
if GBX_GUARD_XERIC_URL="postgresql://postgres:postgres@127.0.0.1:$PORT/wrongname" "$PY" -I "$SCRIPT" refresh --dry-run >"$T/wrong.out" 2>&1; then
  bad "refresh refuses a non-gbx database"; else grep -q "refusing: expected gbx=gbrain" "$T/wrong.out" && ok "refresh refuses a non-gbx database" || bad "refresh refuses a non-gbx database (wrong message)"; fi

# floor: drop gbn people below 400 -> refused, config unchanged
P -d newsroom -c "update pages set deleted_at = now() where slug like 'people/filler-person-1%'" >/dev/null
before=$(P -d gbrain -c "select md5(value) from config where key='facts.newsroom_entity_guard'")
if "$PY" -I "$SCRIPT" refresh >"$T/floor.out" 2>&1; then bad "refresh refuses below the floor"; else ok "refresh refuses below the floor"; fi
eq "config unchanged after refused refresh" "$(P -d gbrain -c "select md5(value) from config where key='facts.newsroom_entity_guard'")" "$before"
P -d newsroom -c "update pages set deleted_at = null" >/dev/null

# sweep dry run changes nothing
"$PY" -I "$SCRIPT" sweep --dry-run >"$T/dry.out" 2>&1
eq "dry run reports 4 blocked" "$(grep -o '^[0-9]* active unfenced facts' "$T/dry.out" | grep -o '^[0-9]*')" "4"
eq "dry run expires nothing" "$(P -d gbrain -c "select count(*) from facts where expired_at is not null")" "1"

# advisory lock held by another session -> sweep refuses
docker exec "$NAME" psql -U postgres -d gbrain -XAtc "select pg_advisory_lock(hashtext('gbx-newsroom-guard-sweep')); select pg_sleep(8);" >/dev/null 2>&1 &
sleep 2
if "$PY" -I "$SCRIPT" sweep >"$T/locked.out" 2>&1; then bad "sweep refuses while another holds the lock"; else grep -q "another sweep is running" "$T/locked.out" && ok "sweep refuses while another holds the lock" || bad "sweep refuses while locked (wrong message: $(tail -1 "$T/locked.out"))"; fi
wait

# operator never-allow file removes a derived ad-campaign allow (owner, 2026-10-07: only people actually
# pursued for ads are business contacts)
# Per PERSON, not per key: a different spelling in the never file, plus a stray extra-allow entry for the
# same person, must still leave no key of that person allowed. Plain refresh (no --allow-shrink).
printf 'Bob Example  # prospect not pursued\nnobody-example  # matches no one\n' > "$T/never-allow.txt"
printf 'bob-example\n' > "$T/extra-allow-bob.txt"
GBX_GUARD_NEVER_ALLOW="$T/never-allow.txt" GBX_GUARD_EXTRA_ALLOW="$T/extra-allow-bob.txt" "$PY" -I "$SCRIPT" refresh >"$T/refresh2.out" 2>&1 || { bad "plain refresh with never-allow"; cat "$T/refresh2.out"; }
eq "never-allow removes every key of bob from allow_keys" "$(P -d gbrain -c "select exists (select 1 from jsonb_array_elements_text(value::jsonb->'allow_keys') k where k like 'bob%') from config where key='facts.newsroom_entity_guard'")" "f"
eq "bob stays on the deny list" "$(P -d gbrain -c "select (value::jsonb->'deny') ? 'bob-example' from config where key='facts.newsroom_entity_guard'")" "t"
eq "refresh reports the override for bob" "$(grep -c 'never-allow (operator file) overrides' "$T/refresh2.out")" "1"
eq "refresh warns about a never key that matches no one" "$(grep -c 'never-allow key matches no newsroom person: nobody-example' "$T/refresh2.out")" "1"
mkdir -p "$T/unreadable-never"
if GBX_GUARD_NEVER_ALLOW="$T/unreadable-never" "$PY" -I "$SCRIPT" refresh --dry-run >"$T/never-bad.out" 2>&1; then bad "refresh refuses an unreadable never-allow file"; else grep -q "refusing: cannot read never-allow file" "$T/never-bad.out" && ok "refresh refuses an unreadable never-allow file" || bad "unreadable never-allow (wrong message: $(tail -1 "$T/never-bad.out"))"; fi

# real sweep
"$PY" -I "$SCRIPT" sweep >"$T/sweep.out" 2>&1 || { bad "sweep runs"; cat "$T/sweep.out"; }
eq "expired exactly A1, A2, A9 (conversation row), B1 (never-allow), C1" "$(P -d gbrain -c "select string_agg(left(fact,2), ',' order by fact) from facts where expired_at > now() - interval '1 minute'")" "A1,A2,A9,B1,C1"
eq "allowed, fenced, pipeline-body and other rows untouched" "$(P -d gbrain -c "select string_agg(left(fact,2), ',' order by fact) from facts where expired_at is null")" "C2,D1,F1,K1"
bk=$(ls "$T/backups"/gbx-newsroom-guard-sweep-*.jsonl 2>/dev/null | head -1)
eq "backup has 5 lossless rows" "$(wc -l < "$bk" | tr -d ' ')" "5"
eq "backup row carries full fact text and pre-expiry state" "$("$PY" -I -c "import json,sys; r=[json.loads(l) for l in open(sys.argv[1])]; print(all(x['expired_at'] is None and x['fact'] for x in r))" "$bk")" "True"

# invalid config -> sweep refuses, nothing changes
P -d gbrain -c "update config set value = '{\"version\": 2, \"deny\": \"broken\"}' where key='facts.newsroom_entity_guard'" >/dev/null
P -d gbrain -c "insert into facts (source_id, entity_slug, fact, source) values ('default','people/alice-example','A3 new leak','test')" >/dev/null
if "$PY" -I "$SCRIPT" sweep >"$T/invalid.out" 2>&1; then bad "sweep refuses an invalid config"; else ok "sweep refuses an invalid config"; fi
eq "invalid config expired nothing" "$(P -d gbrain -c "select count(*) from facts where fact like 'A3%' and expired_at is null")" "1"

echo "== $pass passed, $fail failed =="
[ "$fail" = 0 ]
