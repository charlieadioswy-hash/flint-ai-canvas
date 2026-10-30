import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("verify_data", Path(__file__).with_name("development-verify-data.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def snapshots():
    columns = ["user_id", "request_id", "task_id", "request_hash", "created_at"]
    before = {
        "format": verify.FORMAT, "algorithm": verify.ALGORITHM,
        "tables": {"model3d_submissions": {"count": 2, "hash": "a" * 32, "primaryKey": ["task_id"], "hashColumns": columns}},
        "columns": [{"table": "model3d_submissions", "name": name} for name in columns],
        "ledgerRows": [json.dumps({"version": n, "name": "prior", "checksum": "prior", "applied_at": "2026-10-30"}) for n in range(1, 78)],
        "backfills": {"model3d_requests": {"count": 2, "hash": "b" * 32}},
    }
    before["ledgerSHA256"] = hashlib.sha256("\n".join(before["ledgerRows"]).encode()).hexdigest()
    after = copy.deepcopy(before)
    after["ledgerRows"].append(json.dumps({"version": 78, "name": "model3d_requests", "checksum": "sha256:model3d-requests-v78-20261030", "applied_at": "2026-10-31"}))
    after["ledgerSHA256"] = hashlib.sha256("\n".join(after["ledgerRows"]).encode()).hexdigest()
    after["tables"]["model3d_requests"] = {"count": 2, "hash": "b" * 32, "primaryKey": ["user_id", "request_id"], "hashColumns": columns}
    after["columns"] += [{"table": "model3d_requests", "name": name} for name in columns]
    return before, after


class BackfillVerificationTest(unittest.TestCase):
    def test_exact_backfill_passes(self):
        before, after = snapshots()
        result = verify.compare_values(before, after)
        self.assertTrue(result["passed"], result["problems"])
        self.assertEqual(result["verifiedBackfills"], ["model3d_requests"])

    def test_missing_extra_changed_or_empty_backfill_fails(self):
        for changes in ({"count": 1}, {"count": 3}, {"count": 0}, {"hash": "c" * 32}, {"primaryKey": ["task_id"]}):
            with self.subTest(changes=changes):
                before, after = snapshots()
                after["tables"]["model3d_requests"].update(changes)
                self.assertFalse(verify.compare_values(before, after)["passed"])

    def test_missing_source_digest_and_wrong_migration_fail(self):
        before, after = snapshots()
        before.pop("backfills")
        self.assertFalse(verify.compare_values(before, after)["passed"])
        before, after = snapshots()
        row = json.loads(after["ledgerRows"][-1])
        row["checksum"] = "different"
        after["ledgerRows"][-1] = json.dumps(row)
        after["ledgerSHA256"] = hashlib.sha256("\n".join(after["ledgerRows"]).encode()).hexdigest()
        self.assertFalse(verify.compare_values(before, after)["passed"])

    def test_old_data_and_unknown_populated_tables_still_fail(self):
        before, after = snapshots()
        after["tables"]["model3d_submissions"]["hash"] = "d" * 32
        self.assertFalse(verify.compare_values(before, after)["passed"])
        before, after = snapshots()
        after["tables"]["unexpected"] = {"count": 1, "hash": "e" * 32, "primaryKey": ["id"], "hashColumns": ["id"]}
        after["columns"].append({"table": "unexpected", "name": "id"})
        self.assertFalse(verify.compare_values(before, after)["passed"])


if __name__ == "__main__":
    unittest.main()
