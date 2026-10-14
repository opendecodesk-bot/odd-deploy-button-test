# Running it

## The morning roll-up

Only emails to customers go out immediately. Everything addressed to **you** is collected into one
email a day.

**How it runs.** The Worker has a cron trigger that wakes it **every hour** (`wrangler.toml`,
`crons = ["0 * * * *"]`). Cron runs on UTC, so each hour the Worker checks whether it is now the
roll-up's hour in **your** time zone — `DIGEST_HOUR` (default 6) in the zone set under Global
settings → Region (else the `TIMEZONE` variable, else UTC). Only that one tick does anything; the
other 23 do one small database read and stop. This keeps the roll-up at the same local hour through
daylight-saving changes.

**What that tick does**, in order:

1. Deletes customers' design uploads (see [shops-and-domains.md](shops-and-domains.md#customers-own-designs))
   that are older than 48 hours and on no order — up to 1,000 a day.
2. Fills in Stripe fees that weren't available when a card payment was first recorded.
3. With the Shipping feature on: checks tracking on labels waiting for pickup and orders in transit
   (a limited number of lookups per run, oldest first; the rest wait for tomorrow). An order whose
   label has been scanned is marked shipped and its customer is emailed; one that was delivered is
   marked delivered. It also checks shipments of blanks you're waiting on.
4. Collects what is new since the last roll-up: orders (not test or voided ones), payments, refunds
   and disputes, customers' answers to design proofs, deliveries and pickups, failed admin sign-ins,
   and problems (an email that couldn't be sent, a Stripe webhook that failed, a roll-up that
   failed).
5. Sends one email. If there is **nothing new**, the scheduled run sends a short "nothing new"
   email instead, so a quiet morning can't be mistaken for "it didn't run".

Progress is only saved after the email is sent, so a failed send is retried the next day. If the
run itself fails, that is recorded and reported in the next one.

**In the admin:** Tools → **Communications** shows what the next roll-up will contain, when the
last one ran and what it found, and has a **Check now** button for the tracking checks.

**By hand:** `POST https://admin.<your domain>/api/daily-digest` with the JSON body
`{"key": "<CRON_SECRET>"}` runs it immediately. A manual run sends nothing when there is nothing new.
The installer generates `CRON_SECRET` and never shows it, so to use this call first set it to a
value you know: `npx wrangler secret put CRON_SECRET`. With Cloudflare Access in front of the
admin hostname, send the call to one of your shop hostnames instead, since Access stops it at
the admin's (not tried with Access on).

**Needs email.** With no email provider set up, the roll-up has nowhere to go — see
[email.md](email.md).

## Backups

Your orders, customers and books live in one D1 database. Back it up somewhere you control.

### The backup script

`scripts/d1-backup.sh` exports the whole database as SQL, compresses it, and uploads it to a
**private** R2 bucket as `<database>/<UTC timestamp>.sql.gz`. It refuses to upload an export that
has no tables or no data in it.

One-time setup:

```bash
npx wrangler r2 bucket create opendecodesk-db-backups
```

Keep that bucket **private**: the files contain your customers' names, emails and addresses.

Run it by hand:

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id> npm run db:backup:now
```

It uses your `wrangler login`. A different bucket name can be given with `BACKUP_BUCKET=…`, and a
different database name as the script's first argument.

### Nightly, from GitHub Actions

`.github/workflows/d1-backup.yml` runs the same script every night — **but only in a repository
where you have switched it on.** In a fresh fork or copy it does nothing, so it can't fail every
night (or run against the wrong account) just because the repository was copied.

To switch it on, in your own (private) repository's settings:

1. **Secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare API token that can read D1 and write to R2, and nothing
     else.
   - `CLOUDFLARE_ACCOUNT_ID` — your account id.
2. **Variable** (same page → Variables): `D1_BACKUP_ENABLED` = `true`.

It can also be started by hand from the Actions tab (it still needs the variable and the secrets).
Check the first run's log, and check that a file really appeared in the bucket.

GitHub pauses scheduled workflows in a repository that has had no activity for a while; if you
rely on this, look at the bucket now and then.

### Restoring

Restore into a **new** database first, look at it, and only then switch over.

```bash
# 1. Get a backup and unpack it
npx wrangler r2 object get opendecodesk-db-backups/opendecodesk-db/<file>.sql.gz --remote --file backup.sql.gz
gunzip backup.sql.gz

# 2. Load it into a new database
npx wrangler d1 create opendecodesk-db-restore
npx wrangler d1 execute opendecodesk-db-restore --remote --file backup.sql
```

To switch the site to the restored database, put its id in `database_id` (and its name in
`database_name`) in `wrangler.toml` and run `npm run deploy`. Keep the old database until you
are sure.

For a mistake made recently, D1 also has a point-in-time restore of its own
(`npx wrangler d1 time-travel restore <database> --timestamp=<time>`), which rewinds the database in
place. How far back it reaches depends on your Cloudflare plan — see Cloudflare's D1 documentation.
It is not a substitute for backups you hold yourself.

**Files are not in the database.** Pictures, receipts and design files are in the R2 buckets. This
script does not copy them; protect those buckets separately if losing them would hurt.

## Migrations

The database's structure changes only through the files in `migrations/`, applied in order. Each
is applied once; `wrangler` keeps the list of applied ones in the database (table `d1_migrations`).

```bash
npm run db:pending    # which migrations has this database not had yet?
npm run db:migrate    # apply them
```

- A **new** database is not built by running the migrations (the earliest ones change tables that
  must already exist). It is built from `schema.sql`, with every migration recorded as already
  applied — `npm run setup` does this. See [setup.md](setup.md).
- `schema.sql` always equals "every migration applied"; a test fails if they drift apart.
- Apply migrations **before** deploying code that needs them.
- According to `wrangler`'s own help, a migration that fails is rolled back and the ones before it
  stay applied. Back up first anyway.

### A database without a migration record

If a database has its tables but `d1_migrations` is empty or missing, `wrangler` would try to apply
every migration from the first and fail. `npm run setup` fixes this by itself for an **empty**
database (no orders). For a database **with orders** it stops, because it can't know which
migrations that database has really had.

If you are certain the database's structure matches a particular version of this repository, check
out that version, and record its migrations as applied:

```bash
node -e 'import("./scripts/setup.mjs").then(S => console.log(S.migrationRecordSql(require("fs").readdirSync("migrations"))))' > record.sql
npx wrangler d1 execute DB --remote --file record.sql
```

Then return to the current version and run `npm run db:migrate`. Take a backup first.

## Upgrading to a newer version

1. **Back up** (above).
2. Get the new code: `git pull` (or merge the new release into your copy), then `npm ci`.
   Your `wrangler.toml` has your own database id, hostnames and settings in it. Keep those changes
   — commit them on a branch of your own, or set them aside and put them back — and don't publish
   that file. A fork of a public repository on GitHub is public too, so keep your own copy in a
   private repository or a branch that only exists on your computer.
3. Read the release notes for anything to do by hand.
4. `npm run deploy` — it applies new migrations, lists every shop's hostname in `wrangler.toml`,
   and then deploys, in that order, stopping at the first failure. Don't use a bare
   `npx wrangler deploy` on an installed site: it detaches any shop hostname that isn't listed in
   `wrangler.toml` ([shops-and-domains.md](shops-and-domains.md#by-hand)), and code deployed
   before its migration has run refuses sign-in until the migration is applied.
5. Open the admin, look at Tools → Global settings → Setup status, and check a shop's page loads.

**Coming from a version with one shared admin password:** nothing is lost. Everyone is signed
out once. Sign in with the password you had and any email (or none); with two-step sign-in on,
it asks for your code as before. You are then asked once for your name and email, and from then
on you sign in with that email. You are the first admin; add the others under Security → Users.

`npm run setup` is also safe to run again at any time: it changes nothing you don't re-enter.

There are no numbered releases yet, and upgrading an install made from this repository has not
been done by anyone. Treat the first upgrade with care.

## Users and roles

People sign in with their own email and password. An admin manages them under
**Security → Users**.

| Role | Shown as | Can use |
|---|---|---|
| `staff` | Back office | Orders, payments and refunds, shipping labels, production, inventory, catalog content, equipment lists, expenses, reports, design files |
| `manager` | Manager | All of that, plus creating and editing shops, custom domains, Publish, package sizes, the books (accounts and money, reconciling, expense categories, closing periods, the accountant's export). Can read Global settings |
| `admin` | Admin | Everything, plus Users, the "Require two-step sign-in" switch, the audit log and every change to Global settings |

- **Adding someone:** name, email, role. You are shown a temporary password once; give it to
  them. They must choose their own the first time they sign in.
- **Someone leaves:** disable them. They are signed out at once and can't sign in. Users are
  never deleted, so the audit log keeps their name; enable them again if they come back.
- **Forgotten password, or a lost phone:** Reset password or Reset two-step in the list. Both
  sign that person out.
- **Changing a role** signs that person out; they sign in again as what they now are.
- **There is always an active admin.** The last one can't be demoted or disabled, and nobody
  changes their own role.
- **Require two-step sign-in** (the checkbox under the list): nobody is signed out. At their
  next sign-in, anyone without an authenticator app must set one up before anything else opens,
  and is given ten recovery codes. Turn your own on first.
- **Everything above is in the audit log** (Reports → Audit Log → Security & users).

### Locked out

If the only admin has lost their password, or their phone and their recovery codes, run this on
the computer the site was installed from:

```bash
npm run setup -- --new-passphrase
```

It prints a new passphrase. Sign in with it (any email, or none): you are the first admin again,
your two-step sign-in is cleared, and you choose a new password. **Every other user's password
stops working too** — the list under Security → Users marks them "password needs a reset", and
you reset each one. That is the price of passwords that a stolen database backup can't be used
to guess.

### Resetting a demo or test site

There is no reset script in this repository. If you write one that wipes and reseeds the
business data of a demo site, leave these alone so the people testing it keep their sign-in:
the `users` table, `admin_sessions`, `audit_log`, and in `global_settings` the keys `require2fa`
and `adminSecretMark` (plus `adminPassword`, `totpSecret` and `totpLastCounter` on an install
that hasn't been signed in to since it gained users). `global_settings` also holds the shop's
own settings, so reset it key by key, not as a whole table.

## Keeping an eye on it

- **Tools → Communications** — problems since the last roll-up (emails that failed, webhooks that
  failed), and when the roll-up last ran.
- **Reports → Audit Log** — who changed what: prices, settings, voids, refunds, sign-in changes.
- **Tools → Global settings → Setup status** — anything not configured.
- **The Worker's logs in the Cloudflare dashboard** — errors the code logged (`wrangler.toml` turns
  on `[observability]`).
