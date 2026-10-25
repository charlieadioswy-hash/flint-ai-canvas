#!/usr/bin/env python3
"""Read-only PostgreSQL preservation checks for development deployments.

Capture both snapshots while application writers are stopped:
  python3 scripts/development-verify-data.py snapshot --output before.json
  python3 scripts/development-verify-data.py snapshot --database isolated_copy \
    --reference before.json --output after.json
  python3 scripts/development-verify-data.py compare before.json after.json

Snapshots contain counts, digests, column metadata, and the complete migration
ledger. Business values and credentials never leave PostgreSQL. A referenced
snapshot retains a full digest and a digest projected onto each old table's old
columns, so added columns do not hide changes to existing data. New tables must
be empty. Data migrations fail conservatively and require explicit assessment.
Run the deployed migrate-schema verify separately to validate schema identities.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


FORMAT = "yingce-development-pg-preservation-v1"
ALGORITHM = "md5-of-pk-ordered-row-md5-jsonb;jsonb-text-order-without-pk"


class VerificationError(Exception):
    """An error whose message contains no business values or raw tool output."""


def dump_json(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def fingerprint(value):
    return hashlib.sha256(dump_json(value).encode()).hexdigest()


def write_json(path, value):
    # O_EXCL and restrictive permissions preserve existing baselines, including
    # when another deployment creates the same output path concurrently.
    with open(path, "x", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
        json.dump(value, handle, ensure_ascii=True, sort_keys=True, indent=2)
        handle.write("\n")


def ledger_map(snapshot):
    rows = snapshot["ledgerRows"]
    digest = hashlib.sha256("\n".join(rows).encode()).hexdigest()
    if snapshot.get("ledgerSHA256") != digest:
        raise VerificationError("Snapshot ledger digest mismatch")
    result = {}
    for raw in rows:
        row = json.loads(raw)
        version = row["version"]
        if type(version) is not int or version <= 0 or version in result:
            raise VerificationError("Invalid or duplicate ledger version")
        if not all(isinstance(row.get(key), str) and row[key]
                   for key in ("name", "checksum", "applied_at")):
            raise VerificationError("Incomplete migration ledger record")
        result[version] = (row, raw)
    if list(result) != sorted(result):
        raise VerificationError("Migration ledger is not ordered by version")
    return result


def column_map(snapshot):
    result = {}
    for column in snapshot["columns"]:
        key = (column["table"], column["name"])
        if key in result:
            raise VerificationError("Duplicate column definition")
        result[key] = column
    return result


def validate_snapshot(value):
    if value.get("format") != FORMAT or value.get("algorithm") != ALGORITHM:
        raise VerificationError("Unsupported snapshot format or digest algorithm")
    tables = value["tables"]
    if not isinstance(tables, dict):
        raise VerificationError("Invalid snapshot table metadata")
    columns = column_map(value)
    for name, table in tables.items():
        if not isinstance(name, str) or type(table["count"]) is not int or table["count"] < 0:
            raise VerificationError("Invalid table name or count")
        if not isinstance(table["hash"], str) or not re.fullmatch(r"[0-9a-f]{32}", table["hash"]):
            raise VerificationError("Invalid table digest")
        for key in ("primaryKey", "hashColumns"):
            entries = table[key]
            if not isinstance(entries, list) or not all(isinstance(entry, str) for entry in entries) or len(entries) != len(set(entries)):
                raise VerificationError("Invalid primary key or hash column list")
        if set(table["hashColumns"]) != {column for relation, column in columns if relation == name}:
            raise VerificationError("Hash columns disagree with column metadata")
        if not set(table["primaryKey"]).issubset(table["hashColumns"]):
            raise VerificationError("Primary key column missing from table")
        reference_columns, reference_hash = table.get("referenceColumns"), table.get("referenceHash")
        if reference_columns is None:
            if reference_hash is not None:
                raise VerificationError("Reference digest has no column list")
        elif not isinstance(reference_columns, list) or not all(isinstance(column, str) for column in reference_columns) or len(reference_columns) != len(set(reference_columns)) or not isinstance(reference_hash, str) or not re.fullmatch(r"[0-9a-f]{32}", reference_hash):
            raise VerificationError("Invalid reference digest or column list")
    ledger_map(value)
    return value


def read_snapshot(path):
    return validate_snapshot(json.loads(Path(path).read_text(encoding="utf-8")))


def snapshot_sql(reference=None):
    # All discovery and hashing share one read-only repeatable-read transaction.
    # SQL format quotes identifiers/literals; JSON contains column names only.
    reference_columns = {} if reference is None else {
        name: table["hashColumns"] for name, table in reference["tables"].items()
    }
    encoded = dump_json(reference_columns).replace("'", "''")
    return r"""
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL standard_conforming_strings = on;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '10s';
SELECT jsonb_build_object(
  'kind', 'metadata',
  'columns', coalesce(jsonb_agg(jsonb_build_object(
    'table', table_name, 'name', column_name, 'type', data_type,
    'udt', udt_name, 'maxLength', character_maximum_length,
    'nullable', is_nullable
  ) ORDER BY table_name, ordinal_position), '[]'::jsonb)
)::text
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN (
  SELECT c.relname FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
);
SELECT jsonb_build_object('kind','ledger','row',to_jsonb(t)::text)::text
FROM public.schema_migrations AS t ORDER BY version;
WITH relations AS (
  SELECT c.oid, n.nspname, c.relname,
    coalesce((SELECT array_agg(a.attname::text ORDER BY a.attnum)
      FROM pg_attribute AS a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
      ARRAY[]::text[]) AS columns,
    ('__REFERENCE__'::jsonb ? c.relname) AS has_reference,
    ARRAY(SELECT jsonb_array_elements_text('__REFERENCE__'::jsonb -> c.relname)) AS reference_columns,
    (SELECT string_agg(format('t.%I', a.attname), ', ' ORDER BY k.ordinality)
      FROM pg_index AS i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = c.oid AND i.indisprimary) AS pk_order,
    coalesce((SELECT jsonb_agg(a.attname ORDER BY k.ordinality)
      FROM pg_index AS i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = c.oid AND i.indisprimary), '[]'::jsonb) AS pk
  FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> 'schema_migrations'
), projected AS (
  SELECT *, format('(to_jsonb(t) - %L::text[])',
    ARRAY(SELECT unnest(columns) EXCEPT SELECT unnest(reference_columns))) AS reference_expression
  FROM relations
)
SELECT format($snapshot$
  SELECT jsonb_build_object(
    'kind','table','table',%L,'count',count(*),
    'hash',md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY %s), '')),
    'primaryKey',%L::jsonb,'hashColumns',%L::jsonb,
    'referenceHash',%s,'referenceColumns',%L::jsonb
  )::text FROM %I.%I AS t;
$snapshot$,
  relname, coalesce(pk_order, 'to_jsonb(t)::text COLLATE "C"'),
  pk::text, to_jsonb(columns)::text,
  CASE WHEN has_reference THEN format(
    'md5(coalesce(string_agg(md5(%s::text), '''' ORDER BY %s), ''''))',
    reference_expression, coalesce(pk_order, reference_expression || '::text COLLATE "C"')
  ) ELSE 'NULL' END,
  CASE WHEN has_reference THEN to_jsonb(reference_columns)::text ELSE NULL END,
  nspname, relname
)
FROM projected ORDER BY relname
\gexec
COMMIT;
""".replace("__REFERENCE__", encoded)


def collect_snapshot(args):
    if args.output.exists():
        raise VerificationError("Output already exists; baseline was not overwritten")
    reference = read_snapshot(args.reference) if args.reference else None
    command = [
        "docker", "exec", "-i", args.container, "sh", "-c",
        'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}" -At',
        "development-verify-data", args.database or "",
    ]
    try:
        result = subprocess.run(command, input=snapshot_sql(reference), text=True,
                                capture_output=True, timeout=1800, check=False)
    except subprocess.TimeoutExpired as error:
        raise VerificationError("PostgreSQL snapshot exceeded 1800 seconds") from error
    if result.returncode:
        raise VerificationError("PostgreSQL snapshot failed (exit %d); raw stderr withheld" % result.returncode)
    tables, ledger, metadata = {}, [], None
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if item.get("kind") == "metadata":
            if metadata is not None:
                raise VerificationError("Duplicate PostgreSQL metadata")
            metadata = item["columns"]
        elif item.get("kind") == "ledger":
            ledger.append(item["row"])
        elif item.get("kind") == "table":
            name = item.pop("table")
            item.pop("kind")
            if name in tables:
                raise VerificationError("Duplicate table in snapshot")
            tables[name] = item
        else:
            raise VerificationError("Unexpected PostgreSQL result type")
    if metadata is None:
        raise VerificationError("Incomplete PostgreSQL snapshot")
    value = {
        "format": FORMAT, "algorithm": ALGORITHM,
        "capturedAtUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "tables": tables, "columns": metadata,
        "referenceSnapshotSHA256": fingerprint(reference) if reference is not None else None,
        # Keep the complete PostgreSQL JSONB text for each ledger row, not just
        # names/checksums. AppliedAt and any future ledger columns must survive.
        "ledgerRows": ledger,
        "ledgerSHA256": hashlib.sha256("\n".join(ledger).encode()).hexdigest(),
    }
    validate_snapshot(value)
    write_json(args.output, value)
    return {"check": "snapshot", "passed": True, "output": str(args.output),
            "businessTableCount": len(tables), "businessRowCount": sum(t["count"] for t in tables.values()),
            "schemaVersion": max(ledger_map(value), default=0),
            "ledgerSHA256": value["ledgerSHA256"],
            "referenceSnapshotSHA256": value["referenceSnapshotSHA256"]}


def compare_values(before, after):
    validate_snapshot(before)
    validate_snapshot(after)
    problems = []
    old_ledger, new_ledger = ledger_map(before), ledger_map(after)
    old_version, new_version = max(old_ledger, default=0), max(new_ledger, default=0)
    for label, ledger in (("before", old_ledger), ("after", new_ledger)):
        if set(ledger) != set(range(1, max(ledger, default=0) + 1)):
            problems.append(label + " ledger versions must be continuous from 1")
    changed_ledger = [version for version in sorted(old_ledger)
                      if version not in new_ledger or old_ledger[version][1] != new_ledger[version][1]]
    if changed_ledger:
        problems.append("Existing ledger records changed or disappeared: %s" % changed_ledger)
    added_versions = sorted(new_ledger.keys() - old_ledger.keys())
    if added_versions != list(range(old_version + 1, new_version + 1)) or new_version < old_version:
        problems.append("New ledger versions must extend the old ledger consecutively")
    reference_matches = after.get("referenceSnapshotSHA256") == fingerprint(before)
    if after.get("referenceSnapshotSHA256") is not None and not reference_matches:
        problems.append("After snapshot references a different baseline")

    old_tables, new_tables = before["tables"], after["tables"]
    removed_tables = sorted(old_tables.keys() - new_tables.keys())
    added_tables = sorted(new_tables.keys() - old_tables.keys())
    if removed_tables:
        problems.append("Old business tables disappeared: %s" % removed_tables)
    changed_tables = []
    for name in sorted(old_tables.keys() & new_tables.keys()):
        old, new = old_tables[name], new_tables[name]
        if reference_matches:
            if new.get("referenceColumns") != old["hashColumns"]:
                problems.append("Reference hash must cover every old column in table: " + name)
                continue
            comparable_hash = new.get("referenceHash")
        elif set(old["hashColumns"]) == set(new["hashColumns"]):
            comparable_hash = new["hash"]
        else:
            problems.append("Changed table columns require snapshot --reference BEFORE: " + name)
            continue
        if old["count"] != new["count"] or old["hash"] != comparable_hash or old["primaryKey"] != new["primaryKey"]:
            changed_tables.append(name)
    if changed_tables:
        problems.append("Old table count, data digest, or primary key changed: %s" % changed_tables)
    for name in added_tables:
        if new_tables[name]["count"] != 0:
            problems.append("New business table must be empty: " + name)

    old_columns, new_columns = column_map(before), column_map(after)
    removed_columns = sorted(old_columns.keys() - new_columns.keys())
    if removed_columns:
        problems.append("Old columns disappeared: %s" % removed_columns)
    changed_columns = [
        {"table": key[0], "column": key[1], "before": old_columns[key], "after": new_columns[key]}
        for key in sorted(old_columns.keys() & new_columns.keys()) if old_columns[key] != new_columns[key]
    ]
    return {
        "check": "development_database_preservation", "passed": not problems,
        "schemaBefore": old_version, "schemaAfter": new_version,
        "oldBusinessTableCount": len(old_tables),
        "oldBusinessRowCount": sum(t["count"] for t in old_tables.values()),
        "oldLedgerRecordsUnchanged": not changed_ledger,
        "newLedgerVersions": added_versions, "changedOldTables": changed_tables,
        "ddlChanges": {
            "newTables": added_tables, "removedTables": removed_tables,
            "newColumns": [{"table": key[0], "column": key[1]} for key in sorted(new_columns.keys() - old_columns.keys())],
            "removedColumns": [{"table": key[0], "column": key[1]} for key in removed_columns],
            "changedColumns": changed_columns,
        },
        "schemaIdentityCheck": "Run the deployed migrate-schema verify separately",
        "problems": problems,
    }


def compare_snapshots(args):
    result = compare_values(read_snapshot(args.before), read_snapshot(args.after))
    if args.output:
        write_json(args.output, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subcommands = parser.add_subparsers(dest="command", required=True)
    snapshot = subcommands.add_parser("snapshot", help="capture read-only counts/digests and schema metadata")
    snapshot.add_argument("--database", help="isolated database name; defaults to the container's POSTGRES_DB")
    snapshot.add_argument("--container", default="flint-ai-canvas-postgres-1")
    snapshot.add_argument("--reference", type=Path, help="before snapshot whose old columns get a separate comparison digest")
    snapshot.add_argument("--output", required=True, type=Path, help="new snapshot JSON; existing files are never overwritten")
    compare = subcommands.add_parser("compare", help="verify preserved old data and append-only migration ledger")
    compare.add_argument("before", type=Path)
    compare.add_argument("after", type=Path)
    compare.add_argument("--output", type=Path, help="optional new report JSON; existing files are never overwritten")
    args = parser.parse_args()
    try:
        result = collect_snapshot(args) if args.command == "snapshot" else compare_snapshots(args)
    except VerificationError as error:
        print(dump_json({"passed": False, "error": str(error)}), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(dump_json({"passed": False, "error": "Verification input or command failed (%s); raw details withheld" % type(error).__name__}), file=sys.stderr)
        return 1
    print(dump_json(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
