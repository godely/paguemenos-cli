"""Index a normalized retailer-supplied store inventory snapshot using Python's standard library."""
import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys

RETAILERS = ("paguemenos", "drogariasaopaulo")
FIELDS = ("retailer", "id", "store_code", "quantity", "timestamp")


def instant(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None or date.utcoffset() is None:
        raise ValueError("timestamp needs an explicit UTC offset")
    return date.astimezone(timezone.utc).isoformat(timespec="microseconds")


def read_csv(path, as_of, retailer):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle, strict=True)
        if not rows.fieldnames or not set(FIELDS).issubset(rows.fieldnames) or len(set(rows.fieldnames)) != len(rows.fieldnames):
            raise ValueError("expected unique CSV headers including retailer,id,store_code,quantity,timestamp")
        for row in rows:
            try:
                if None in row or any(row[key] is None for key in FIELDS):
                    raise ValueError()
                chain, sku, branch, units, observed = (row[key].strip() for key in FIELDS)
                if chain != retailer or not sku.isascii() or not sku.isdigit() or not branch:
                    raise ValueError()
                if units and (not units.isascii() or not units.isdigit() or int(units) > 2**53-1):
                    raise ValueError()
                observed = instant(observed)
                if observed > as_of:
                    raise ValueError()
                yield sku, branch, int(units) if units else None, observed
            except (OverflowError, ValueError) as error:
                raise ValueError(f"invalid inventory record at CSV line {rows.line_num}") from error


def ingest(args):
    snapshot_at = instant(args.snapshot_at)
    if snapshot_at > datetime.now(timezone.utc).isoformat(timespec="microseconds"):
        raise ValueError("snapshot is future-dated")
    with sqlite3.connect(args.database, timeout=30) as db:
        db.execute("CREATE TEMP TABLE incoming (sku TEXT, branch TEXT, units INTEGER, observed TEXT, PRIMARY KEY(sku,branch)) WITHOUT ROWID")
        db.executemany("INSERT INTO incoming VALUES(?,?,?,?)", read_csv(args.csv, snapshot_at, args.retailer))
        count = db.execute("SELECT count(*) FROM incoming").fetchone()[0]
        if not count:
            raise ValueError("empty inventory snapshot")
        db.commit()
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS snapshots(retailer TEXT PRIMARY KEY, snapshot_at TEXT NOT NULL)")
        db.execute("""CREATE TABLE IF NOT EXISTS inventory(retailer TEXT, sku TEXT, branch TEXT,
                   units INTEGER, observed TEXT, PRIMARY KEY(retailer,sku,branch)) WITHOUT ROWID""")
        prior = db.execute("SELECT snapshot_at FROM snapshots WHERE retailer=?", (args.retailer,)).fetchone()
        if prior and prior[0] > snapshot_at:
            raise ValueError("a newer snapshot is already installed")
        if prior and prior[0] == snapshot_at:
            saved = "SELECT sku,branch,units,observed FROM inventory WHERE retailer=?"
            incoming = "SELECT * FROM incoming"
            for left, right in ((saved, incoming), (incoming, saved)):
                if db.execute(left + " EXCEPT " + right + " LIMIT 1", (args.retailer,)).fetchone():
                    raise ValueError("conflicting snapshot with the same timestamp")
        else:
            db.execute("DELETE FROM inventory WHERE retailer=?", (args.retailer,))
            db.execute("INSERT INTO inventory SELECT ?,sku,branch,units,observed FROM incoming", (args.retailer,))
            db.execute("INSERT OR REPLACE INTO snapshots VALUES(?,?)", (args.retailer, snapshot_at))
    return {"retailer": args.retailer, "snapshotAt": snapshot_at, "records": count}


def lookup(args):
    uri = Path(args.database).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        db.execute("BEGIN")
        snapshot = db.execute("SELECT snapshot_at FROM snapshots WHERE retailer=?", (args.retailer,)).fetchone()
        if not snapshot:
            raise ValueError("no inventory snapshot for this retailer")
        rows = db.execute("SELECT branch,units,observed FROM inventory WHERE retailer=? AND sku=?", (args.retailer, args.sku))
        return {"snapshotAt": snapshot[0], "observations": [
            {"storeId": branch, "quantity": units, "observedAt": observed} for branch, units, observed in rows
        ]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import")
    reader = commands.add_parser("lookup")
    for command in (importer, reader):
        command.add_argument("--database", required=True)
        command.add_argument("--retailer", choices=RETAILERS, required=True)
    importer.add_argument("--snapshot-at", required=True)
    importer.add_argument("csv")
    reader.add_argument("sku")
    args = parser.parse_args()
    try:
        print(json.dumps(ingest(args) if args.command == "import" else lookup(args)))
    except (OSError, ValueError, sqlite3.Error, csv.Error) as error:
        sys.exit(str(error))

