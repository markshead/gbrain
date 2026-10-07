#!/usr/bin/env python3
"""gbx-newsroom-entity-guard — keep newsroom people and government bodies out of gbx facts.

Owner decision, 2026-10-06: newsroom people belong in gbn, never gbx (gbx `meta/two-brain-governance`).
The gbrain fork's facts extractor drops a fact whose entity is on a deny list stored in gbx config
`facts.newsroom_entity_guard` (src/core/facts/newsroom-entity-guard.ts). This script builds that
list from gbn and sweeps up facts that slipped past it.

  refresh [--dry-run]          rebuild the list from gbn and write it to gbx config
  sweep [--since ISO] [--dry-run]
                               expire active gbx facts whose entity the guard blocks (backup first).
                               The guard runs inside each gbrain process, and long-lived `gbrain
                               serve` children keep old code until their session restarts; the
                               sweep (cron) covers that gap. --since limits it to newer facts.
  check ENTITY [RESOLVED [SOURCE_PAGE]]  show the decision for one entity
  test                         run the shared fixture cases (same cases as the TypeScript tests)

Runbook: gbx `infra/gbx-facts-newsroom-entity-guard`.
"""
import datetime, json, os, re, sys

CONFIG_KEY = 'facts.newsroom_entity_guard'
ENV_FILE = os.path.expanduser('~/.config/gbrain/env')
SNAPSHOT = os.environ.get('GBX_GUARD_SNAPSHOT') or os.path.expanduser('~/.gbrain/newsroom-entity-guard.json')
# Overridable for the integration test (scripts/local/test-gbx-newsroom-entity-guard-pg.sh).
LOG = os.environ.get('GBX_GUARD_LOG') or os.path.expanduser('~/.claude/logs/gbx-newsroom-guard.log')
BACKUP_DIR = os.environ.get('GBX_GUARD_BACKUP_DIR') or os.path.expanduser('~/backups/gbrain')
FIXTURE = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'test', 'fixtures', 'newsroom-entity-guard-cases.json')

# The owner's default allowlist (2026-10-06): email-keyed people/*, clients/*, ad-creation/*, and anyone
# who appears in ad campaigns. Email-keyed pages end in the email's domain.
# Allowed entity pages are listed EXACTLY (v2): every gbx clients/* page and every email-keyed
# people/* page (title carries the address). A namespace prefix alone never allows. `refresh`
# runs daily, so new contacts are picked up.
# Sanity floors: refuse to publish a list much smaller than expected (a broken gbn query would
# otherwise publish a near-empty list that silently lets everything through).
FLOOR_PEOPLE, FLOOR_BODIES, MAX_SHRINK = 400, 40, 0.20
# Owner, 2026-10-07: government-body facts stay in gbx when they come from pipeline or runbook pages
# ("gbn only unless it has to do with our runbooks and pipeline work"). People never pass this way.
BODY_ALLOW_SOURCE_PREFIXES = ['news-pipeline/', 'tools/', 'infra/', 'method/', 'orchestration/', 'meta/',
                              'fortscott-biz/', 'fortscott/', 'news-server/', 'design-docs/']
# Operator-reviewed extra allow keys (e.g. the brain's owner), one per line, kept OUTSIDE the
# repo so no real name is checked in. Missing file = none.
EXTRA_ALLOW_FILE = os.environ.get('GBX_GUARD_EXTRA_ALLOW') or os.path.expanduser('~/.config/gbrain/newsroom-guard-allow.txt')


# Operator "never allow" keys, one per line, also outside the repo: a person listed here is NOT allowed
# even if an ad-campaign page names them (owner, 2026-10-07: only people actually pursued for ads are
# business contacts; a prospect marked "not pursuing" stays a newsroom person). Missing file = none.
NEVER_ALLOW_FILE = os.environ.get('GBX_GUARD_NEVER_ALLOW') or os.path.expanduser('~/.config/gbrain/newsroom-guard-never-allow.txt')


def _key_file(path, what):
    """Keys from an operator file (one per line, '#' comments). Missing = none; unreadable = refuse."""
    try:
        with open(path, encoding='utf-8') as f:
            return {k for k in (norm(l.split('#', 1)[0]) for l in f) if k}
    except FileNotFoundError:
        return set()
    except (OSError, UnicodeDecodeError) as e:
        sys.exit('refusing: cannot read %s file %s (%s)' % (what, path, e.__class__.__name__))


def never_allow_keys():
    return _key_file(NEVER_ALLOW_FILE, 'never-allow')


def extra_allow_keys():
    return _key_file(EXTRA_ALLOW_FILE, 'extra-allow')


# ---- matching (must mirror src/core/facts/newsroom-entity-guard.ts) ----
def trim_ascii(s):
    return s.strip(' \t\r\n')


def norm(s):
    s = (s or '').lower()
    s = re.sub("['\"\u2018\u2019\u201c\u201d]", '', s)
    s = s.replace('&', ' and ')
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')


# gbrain's resolver slugifies differently from norm() (accents folded, apostrophes become '-').
# Deny keys are generated in BOTH spellings so a stored, slugified entity still matches.
# Mirrors slugify() in src/core/entities/resolve.ts and src/core/latin-fold.ts.
_LATIN = {'đ': 'd', 'ð': 'd', 'ø': 'o', 'ł': 'l', 'ħ': 'h', 'ŧ': 't', 'ı': 'i', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'th'}


def slugify(s):
    import unicodedata
    s = unicodedata.normalize('NFKD', (s or '').lower())
    s = re.sub('[\u0300-\u036f]', '', s)
    s = ''.join(_LATIN.get(ch, ch) for ch in s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def name_keys(s):
    """Generator-side keys for a name/slug segment: the runtime norm() form and the resolver form."""
    return {k for k in (norm(s), slugify(s)) if k}


def candidate_keys(s):
    keys = []
    w = norm(s)
    if w:
        keys.append(w)
    t = trim_ascii(s).rstrip('/')
    if '/' in t:
        last = norm(t[t.rindex('/') + 1:])
        if last and last not in keys:
            keys.append(last)
    return keys


_ABSENT = object()


def _str_list(v):
    # Absent field = empty list; explicit null or any non-list = invalid (same as the TypeScript side).
    if v is _ABSENT:
        return []
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        return None
    return v


def parse_guard(raw):
    """Strict validation; anything invalid means no guard (the writer fails open, the sweep stops)."""
    if raw is None or not trim_ascii(str(raw)):
        return None
    try:
        o = json.loads(raw)
    except Exception:
        return None
    if not isinstance(o, dict) or o.get('version') != 2 or 'allow_slug_prefixes' in o:
        return None
    bp = _str_list(o.get('body_allow_source_prefixes', _ABSENT))
    bs = _str_list(o.get('body_slugs', _ABSENT))
    if bp is None or bs is None or any(not trim_ascii(x).endswith('/') or trim_ascii(x) == '/' for x in bp):
        return None
    d = o.get('deny')
    if not isinstance(d, dict):
        return None
    deny = {}
    for k, v in d.items():
        if not isinstance(v, str):
            return None
        nk = norm(k)
        if nk:
            deny[nk] = v
    if not deny:
        return None
    ak, sl = _str_list(o.get('allow_keys', _ABSENT)), _str_list(o.get('allow_slugs', _ABSENT))
    if ak is None or sl is None:
        return None
    return {'deny': deny,
            'allow_keys': {norm(k) for k in ak if norm(k)},
            'allow_slugs': {trim_ascii(s) for s in sl if trim_ascii(s)},
            'body_prefixes': [trim_ascii(x) for x in bp],
            'body_slugs': {trim_ascii(x) for x in bs if trim_ascii(x)}}


def decide(g, raw, resolved, source_page=None):
    if not g:
        return (False, None, None)
    r = trim_ascii(raw) if isinstance(raw, str) else ''
    res = trim_ascii(resolved) if isinstance(resolved, str) else ''
    stored = res or r
    if not stored:
        return (False, None, None)
    if stored in g['allow_slugs']:
        return (False, None, None)
    if any(k in g['allow_keys'] for k in candidate_keys(stored)):
        return (False, None, None)
    for s in (r, res):
        if not s:
            continue
        for k in candidate_keys(s):
            if k in g['deny']:
                src = trim_ascii(source_page) if isinstance(source_page, str) else ''
                if src and g['deny'][k] in g['body_slugs'] and any(src.startswith(p) for p in g['body_prefixes']):
                    return (False, None, None)
                return (True, k, g['deny'][k])
    return (False, None, None)


# ---- db ----
def env():
    out = {}
    for line in open(ENV_FILE):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        out[k.replace('export ', '').strip()] = v.strip().strip('"').strip("'")
    return out


def conns():
    import psycopg2
    xu, nu = os.environ.get('GBX_GUARD_XERIC_URL'), os.environ.get('GBX_GUARD_NEWSROOM_URL')
    if not (xu and nu):
        e = env()
        xu, nu = e['XERIC_DATABASE_URL'], e['NEWSROOM_DATABASE_URL']
    return psycopg2.connect(xu), psycopg2.connect(nu)


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, 'a') as f:
        f.write('%s %s\n' % (datetime.datetime.now().astimezone().isoformat(timespec='seconds'), msg))


def key_ok(k):
    # Multi-token keys only: a single token ("mark", "commission") is far too generic.
    return bool(k) and '-' in k and len(k) >= 5


def title_name(t):
    return re.sub(r'\s*\([^)]*\)', '', t or '').strip()


GOV_TYPES = ('org', 'organization', 'government-body')


def build(gx, gn):
    cn, cx = gn.cursor(), gx.cursor()
    cn.execute("""select slug, title, type from pages where deleted_at is null and (
                    type = 'person' or (type = any(%s) and slug ~ '^(ks|mi)/'))""", (list(GOV_TYPES),))
    ents = cn.fetchall()
    cn.execute("""select a.slug, a.alias_norm from page_aliases a join pages p
                    on p.slug = a.slug and p.source_id = a.source_id
                  where p.deleted_at is null and (p.type = 'person' or (p.type = any(%s) and p.slug ~ '^(ks|mi)/'))""",
               (list(GOV_TYPES),))
    aliases = {}
    for s, a in cn.fetchall():
        aliases.setdefault(s, []).append(a)
    deny, per_ent = {}, {}
    for slug, title, typ in ents:
        ks = name_keys(slug.rsplit('/', 1)[-1]) | name_keys(title_name(title))
        if typ != 'person':
            ks |= name_keys(slug)
        for a in aliases.get(slug, []):
            ks |= name_keys(a)
        ks = {k for k in ks if key_ok(k)}
        per_ent[slug] = (title, typ, ks)
        for k in ks:
            deny.setdefault(k, slug)

    never = never_allow_keys()
    allow, reasons = extra_allow_keys() - never, {}
    # (a) anyone who appears in an ad campaign: a gbn person named (or wikilinked) in gbx ad-creation/*
    cx.execute("select slug, lower(compiled_truth || ' ' || coalesce(timeline, '')) from pages "
               "where deleted_at is null and source_id = 'default' and slug like 'ad-creation/%%'")
    ad_text = cx.fetchall()
    for slug, (title, typ, ks) in per_ent.items():
        if typ != 'person':
            continue
        names = {title_name(title).lower()} | {a.replace('-', ' ') for a in aliases.get(slug, [])}
        names = {n for n in names if len(n.split()) >= 2 and len(n) >= 6}
        hits = set()
        for p, txt in ad_text:
            if '[[' + slug.lower() + ']]' in txt or '[[' + slug.lower() + '|' in txt or \
               any(re.search(r'\b' + re.escape(n) + r'\b', txt) for n in names):
                hits.add(p)
        if hits and (ks & never):
            reasons[slug] = 'never-allow (operator file) overrides ad campaign page(s): ' + ', '.join(sorted(hits))
        elif hits:
            allow |= ks
            reasons[slug] = 'appears in ad campaign page(s): ' + ', '.join(sorted(hits))
    # never-allow is per PERSON: drop every key of anyone a never key names (covers other spellings and
    # stray extra-allow entries); warn about never keys that name no newsroom person.
    # Step (b) below never adds KEYS; it only lists exact business page slugs. A never-listed person who
    # also has an email-keyed gbx contact page keeps that one page allowed: a business identity is
    # separate from the newsroom person (gbx meta/two-brain-governance, "Cross-brain entities").
    matched = set()
    for slug, (title, typ, ks) in per_ent.items():
        hit = ks & never
        if hit:
            matched |= hit
            allow -= ks
    for k in sorted(never - matched):
        print('WARN never-allow key matches no newsroom person: %s' % k)
        log('refresh: never-allow key matches no newsroom person: %s' % k)

    # (b) business pages with affirmative evidence, listed exactly: every clients/* page and every
    # email-keyed people/* page (title carries an address). A name-keyed gbx page gets NO pass on a
    # name collision: that is the very shape of the leak. Collisions are reported for review.
    cx.execute("select slug, title, type from pages where deleted_at is null and source_id = 'default' "
               "and (slug like 'people/%%' or slug like 'clients/%%')")
    allow_slugs, collisions = [], {}
    for slug, title, typ in cx.fetchall():
        business = (slug.startswith('people/') and '@' in (title or '')) or slug.startswith('clients/')
        if business:
            allow_slugs.append(slug)
        hit = sorted(k for k in {norm(slug.rsplit('/', 1)[-1]), norm(title_name(title))} if k in deny)
        if hit:
            collisions[slug] = (business, hit)
    for slug, (business, hit) in sorted(collisions.items()):
        reasons['gbx:' + slug] = ('business page, own slug allowed' if business else 'NAME-KEYED, NOT allowed (review)') + \
            ' — collides on ' + ', '.join(hit)
    return {
        'version': 2,
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'generated_by': 'gbx-newsroom-entity-guard refresh',
        'deny': dict(sorted(deny.items())),
        'allow_keys': sorted(allow),
        'allow_slugs': sorted(allow_slugs),
        'body_allow_source_prefixes': BODY_ALLOW_SOURCE_PREFIXES,
        'body_slugs': sorted(s for s, v in per_ent.items() if v[1] != 'person'),
        'allow_reasons': reasons,
        'counts': {'gbn_people': sum(1 for v in per_ent.values() if v[1] == 'person'),
                   'gbn_bodies': sum(1 for v in per_ent.values() if v[1] != 'person'),
                   'deny_keys': len(deny), 'allow_keys': len(allow), 'allow_slugs': len(allow_slugs)},
    }


def check_brains(gx, gn):
    """Refuse unless gx is the xeric brain (database `gbrain`) and gn is newsroom."""
    a, b = gx.cursor(), gn.cursor()
    a.execute("select current_database()")
    b.execute("select current_database()")
    dx, dn = a.fetchone()[0], b.fetchone()[0]
    if dx != 'gbrain' or dn != 'newsroom':
        sys.exit('refusing: expected gbx=gbrain and gbn=newsroom databases, got %s / %s' % (dx, dn))


def cmd_refresh(dry):
    gx, gn = conns()
    check_brains(gx, gn)
    g = build(gx, gn)
    n = g['counts']
    if n['gbn_people'] < FLOOR_PEOPLE or n['gbn_bodies'] < FLOOR_BODIES:
        log('refresh: REFUSED, below floor %s' % json.dumps(n))
        sys.exit('refusing to publish: gbn people/bodies below floor (%d/%d)' % (n['gbn_people'], n['gbn_bodies']))
    cur = load_guard(gx)
    if cur and len(g['deny']) < (1 - MAX_SHRINK) * len(cur['deny']) and '--allow-shrink' not in sys.argv:
        log('refresh: REFUSED, deny list would shrink %d -> %d' % (len(cur['deny']), len(g['deny'])))
        sys.exit('refusing to publish: deny list shrinks %d -> %d (>%d%%); rerun with --allow-shrink if intended'
                 % (len(cur['deny']), len(g['deny']), int(MAX_SHRINK * 100)))
    print(json.dumps(g['counts']))
    for k, v in g['allow_reasons'].items():
        print('allow  %-45s %s' % (k, v))
    if parse_guard(json.dumps(g)) is None:
        sys.exit('refusing to publish: the generated list does not validate')
    if dry:
        return
    os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
    json.dump(g, open(SNAPSHOT, 'w'), indent=1)
    c = gx.cursor()
    c.execute("insert into config (key, value) values (%s, %s) on conflict (key) do update set value = excluded.value",
              (CONFIG_KEY, json.dumps(g)))
    gx.commit()
    c.execute("select length(value) from config where key = %s", (CONFIG_KEY,))
    log('refresh: %s, config %d bytes' % (json.dumps(g['counts']), c.fetchone()[0]))
    print('written to gbx config %s; snapshot %s' % (CONFIG_KEY, SNAPSHOT))


def load_guard(gx):  # used by `check`
    c = gx.cursor()
    c.execute("select value from config where key = %s", (CONFIG_KEY,))
    r = c.fetchone()
    return parse_guard(r[0] if r else None)


SWEEPABLE = "(row_num is null or source like 'cli:extract-conversation-facts%%')"


def old_serve_count(since):
    """How many `gbrain serve` processes started before `since` (they run pre-guard code)."""
    if not since:
        return None
    import subprocess
    try:
        cut = datetime.datetime.fromisoformat(since.replace('Z', '+00:00'))
        if cut.tzinfo is None:
            cut = cut.astimezone()
        age = (datetime.datetime.now(datetime.timezone.utc) - cut).total_seconds()
        out = subprocess.run(['ps', '-eo', 'etimes=,args='], capture_output=True, text=True).stdout
        return sum(1 for l in out.splitlines() if 'gbrain serve' in l and int(l.split(None, 1)[0]) > age)
    except Exception:
        return None


def cmd_sweep(since, dry):
    gx, gn = conns()
    try:
        _sweep(gx, gn, since, dry)
    finally:
        try:
            gx.rollback()
            c = gx.cursor()
            c.execute("select pg_advisory_unlock_all()")
            gx.commit()
        except Exception:
            pass
        gx.close()
        gn.close()


def _sweep(gx, gn, since, dry):
    check_brains(gx, gn)
    c = gx.cursor()
    # One sweep at a time, across hosts: a session-level Postgres advisory lock.
    c.execute("select pg_try_advisory_lock(hashtext('gbx-newsroom-guard-sweep'))")
    if not c.fetchone()[0]:
        gx.rollback()
        sys.exit('another sweep is running')
    c.execute("select value from config where key = %s", (CONFIG_KEY,))
    r = c.fetchone()
    if r is None:
        print('no guard configured; nothing to do')
        return
    g = parse_guard(r[0])
    policy = __import__('hashlib').md5(r[0].encode()).hexdigest()[:12]
    if g is None:
        log('sweep: REFUSED, guard config is invalid')
        sys.exit('guard config is invalid; refusing to sweep')
    # Rows NOT owned by a page's markdown fence: row_num IS NULL (legacy DB-only rows) or a
    # conversation-extraction row (its row_num is only a bulk key; conversations carry no fence).
    # True fence rows are left to Phase B. FOR UPDATE holds the rows until commit; the UPDATE
    # re-checks the same predicate and entity_slug.
    q = ("select id, entity_slug, context from facts where expired_at is null and entity_slug <> '' and "
         + SWEEPABLE + (" and created_at >= %s" if since else "") + " for update skip locked")
    c.execute(q, [since] if since else [])
    ids = [(fid, ent) for fid, ent, ctx in c.fetchall() if decide(g, ent, ent, ctx)[0]]
    print('%d active unfenced facts blocked by the guard%s' % (len(ids), ' (dry run)' if dry else ''))  # "unfenced" = sweepable
    if not ids:
        gx.rollback()
        log('sweep: 0 to expire (since=%s, policy=%s, old serve processes=%s)' % (since, policy, old_serve_count(since)))
        return
    c.execute("""select row_to_json(t) from (select id, source_id, entity_slug, fact, kind, visibility, notability,
                   context, valid_from, valid_until, expired_at, superseded_by, source, source_session, confidence,
                   created_at, row_num, source_markdown_slug from facts where id = any(%s) order by id) t""",
              ([i for i, _ in ids],))
    rows = [x[0] for x in c.fetchall()]
    for row in rows[:40]:
        print('  %s %-30s -> gbn %-30s <%s> %s' % (row['id'], row['entity_slug'], decide(g, row['entity_slug'], row['entity_slug'], row['context'])[2],
                                                    row['context'], (row['fact'] or '')[:90]))
    if dry:
        gx.rollback()
        return
    stamp = datetime.datetime.now().strftime('%Y-%m-%dT%H%M%S')
    path = os.path.join(BACKUP_DIR, 'gbx-newsroom-guard-sweep-%s-%d.jsonl' % (stamp, os.getpid()))
    with open(path, 'x') as f:
        for row in rows:
            f.write(json.dumps(row, default=str) + '\n')
        f.flush()
        os.fsync(f.fileno())
    # Make the new directory entry durable too, before any row is expired.
    dfd = os.open(BACKUP_DIR, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    n = 0
    for fid, ent in ids:
        c.execute("update facts set expired_at = now() where id = %s and expired_at is null and entity_slug = %s and "
                  + SWEEPABLE, (fid, ent))
        n += c.rowcount
    gx.commit()
    log('sweep: expired %d facts (since=%s, policy=%s, old serve processes=%s); backup %s'
        % (n, since, policy, old_serve_count(since), path))
    print('expired %d; backup %s' % (n, path))


def cmd_check(ent, resolved, source=None):
    gx, _ = conns()
    print(decide(load_guard(gx), ent, resolved, source))


def cmd_test():
    cases = json.load(open(FIXTURE))
    g = parse_guard(json.dumps(cases['guard']))
    bad = 0
    for inp, want in cases['normalize']:
        if norm(inp) != want:
            bad += 1
            print('FAIL norm %r -> %r, want %r' % (inp, norm(inp), want))
    for c in cases['decide']:
        got = decide(g, c['raw'], c['resolved'], c.get('source'))[0]
        if got != c['blocked']:
            bad += 1
            print('FAIL decide %s: got %s' % (c['why'], got))
    for raw in cases['invalid_configs']:
        if parse_guard(raw) is not None:
            bad += 1
            print('FAIL parse_guard(%r) should be None' % raw)
    for inp, want in cases.get('generator_keys', []):
        got = sorted(name_keys(inp)) if 'name_keys' in globals() else []
        if sorted(want) != got:
            bad += 1
            print('FAIL name_keys %r -> %r, want %r' % (inp, got, sorted(want)))
    for nc in cases.get('no_carveout_configs', []):
        g2 = parse_guard(json.dumps(nc['config']))
        if g2 is None or not decide(g2, nc['raw'], None, nc['source'])[0]:
            bad += 1
            print('FAIL no-carveout: %s' % nc['why'])
    total = len(cases['normalize']) + len(cases['decide']) + len(cases['invalid_configs']) + len(cases.get('generator_keys', [])) + len(cases.get('no_carveout_configs', []))
    print('%d/%d passed' % (total - bad, total))
    sys.exit(1 if bad else 0)


def main(a):
    if not a or a[0] in ('-h', '--help'):
        print(__doc__)
        return
    dry = '--dry-run' in a
    since = a[a.index('--since') + 1] if '--since' in a else None
    if a[0] == 'refresh':
        cmd_refresh(dry)
    elif a[0] == 'sweep':
        cmd_sweep(since, dry)
    elif a[0] == 'check':
        cmd_check(a[1], a[2] if len(a) > 2 else None, a[3] if len(a) > 3 else None)
    elif a[0] == 'test':
        cmd_test()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main(sys.argv[1:])
