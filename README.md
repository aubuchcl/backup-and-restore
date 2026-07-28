# backup-relay

Pulls `mongodump` archives from DocumentDB and serves them to sibling containers
over the private network. Two jobs, one container:

1. **Take a backup** — connects to the source, records per-collection document
   counts, runs `mongodump --archive --gzip`, hashes the result, writes a manifest.
2. **Serve it** — a small HTTP API that other containers pull from. Bearer-token
   authenticated, never published publicly.

The manifest is the interesting part. It records what the source held at dump
time, so the receiving side can verify the restore landed everything rather than
just trusting that `mongorestore` exited zero.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness. **Unauthenticated**, and never touches the database, so the container stays healthy while the source is unreachable. |
| `POST /backups` | Take a backup now. Returns the manifest. `409` if one is already running. |
| `GET /backups` | All manifests, newest first. |
| `GET /backups/latest` | Manifest of the newest backup. |
| `GET /backups/:id/manifest` | One manifest. |
| `GET /backups/:id` | Streams the gzipped archive. Sets `X-Checksum-Sha256` and `ETag`. |
| `DELETE /backups/:id` | Remove an archive and its manifest. |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | — | **Required.** The source cluster. |
| `MONGODB_DB` | all databases | Restrict the dump to one database. Recommended. |
| `MONGODB_TLS_CA_FILE` | — | Amazon's bundle, at `/app/global-bundle.pem` in this image. |
| `MONGODB_READ_PREFERENCE` | driver default | Set `secondaryPreferred` to keep the dump off the primary. |
| `BACKUP_TOKEN` | — | **Required** unless `ALLOW_NO_TOKEN=true`. Shared secret. |
| `BACKUP_DIR` | `/data/backups` | Where archives live. Mount a volume here. |
| `BACKUP_KEEP` | `5` | Retention. Older backups are pruned after each new one. |
| `BACKUP_TIMEOUT_MS` | `600000` | Kills a hung `mongodump`. |
| `BIND_HOST` | `0.0.0.0` | Must stay reachable by siblings; isolation comes from not publishing the port. |
| `PORT` | `4000` | |

TLS options are appended to the connection string rather than passed as command
line flags, because the database tools have moved between `--ssl/--sslCAFile`
and `--tls/--tlsCAFile` across versions while the URI options stayed stable.

## Taking and restoring a backup

```bash
# On the relay
curl -X POST -H "Authorization: Bearer $BACKUP_TOKEN" http://backup-relay:4000/backups

# On the receiving container
RELAY_URL=http://backup-relay:4000 \
BACKUP_TOKEN=... \
TARGET_URI='mongodb://user:pass@mongo.your-env.cycle.io:27017/' \
npm run restore
```

The restore client fetches the manifest, streams the archive while hashing it,
**refuses to run `mongorestore` if the hash does not match**, restores, then
re-counts every collection against the manifest and exits non-zero on any
mismatch. Set `RESTORE_DROP=true` to wipe target collections first.

Note that `mongorestore` needs to exist on the receiving side too. If that
container is not built from this image, install `mongodb-database-tools` there,
or run the restore from this container pointed at the new cluster.

## Security notes

- **Auth is on by default.** The service refuses to start without `BACKUP_TOKEN`
  unless you explicitly pass `ALLOW_NO_TOKEN=true`. A private network is the
  primary control; the token means an accidentally published port is not an
  instant database dump leak. Token comparison is constant-time.
- **The download path is locked down.** Backup ids must match
  `\d{8}T\d{6}Z-[a-z0-9]{6}` exactly, and the resolved path is re-checked to
  confirm it sits inside `BACKUP_DIR`. Verified against encoded and unencoded
  traversal attempts, and against reading the manifest files themselves.
- **Archives are the whole database in the clear.** Whatever volume backs
  `BACKUP_DIR` deserves the same care as the database. Set `BACKUP_KEEP` low.
- A failed or timed-out dump deletes its partial archive, so a consumer can
  never fetch a truncated file.

## Where this fits in the demo

```
DocumentDB (AWS VPC)
      │  mongodump over VPC peering
      ▼
backup-relay ──── private network ────▶ new Mongo cluster on Cycle
  (holds archive + manifest)              (mongorestore, counts verified)
```

The relay's manifest counts and the demo app's `/api/verify` fingerprint are
independent checks on the same claim. Counts confirm nothing went missing;
the fingerprint confirms nothing was altered.

## Tested

Exercised with a stubbed `mongodump` and a stubbed driver, against a live
instance of the server:

- Auth: missing, wrong, and correct tokens; `/healthz` reachable without one
- Path traversal: `../` raw and percent-encoded, double-encoded, bare dotfiles,
  wrong-case ids, and attempts to fetch the `.json` manifests directly — all
  rejected with `400`
- Downloads: byte-identical stream, `X-Checksum-Sha256` matching the manifest,
  valid gzip on arrival, `404` for a well-formed but absent id
- Dump pipeline: manifest carries correct per-collection counts and total
- Failures: `mongodump` exiting non-zero surfaces its own stderr tail;
  a missing binary says so plainly; neither leaves a partial archive behind
- Retention: `BACKUP_KEEP=2` with three backups leaves exactly two
- Restore: full round trip with count verification, and a **deliberately
  corrupted archive is refused before `mongorestore` is invoked**

Not yet run against real DocumentDB, a real Cycle cluster, or a real
`mongodump` binary — and the Docker build has not been executed, since this
environment has no Docker daemon. The image installs
`mongodb-database-tools` from MongoDB's apt repo, so build it once on a machine
with network access before you rely on it.
