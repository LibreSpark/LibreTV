import os
import tempfile
import unittest
from unittest.mock import patch

import registry_queue as queue


class RegistryQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "collector.sqlite3")
        self.patch = patch.object(queue, "DB_PATH", __import__("pathlib").Path(self.db))
        self.patch.start()
        queue.initialize()
        with queue.connect() as c:
            c.execute("CREATE TABLE IF NOT EXISTS sites (host TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, directory TEXT NOT NULL, discovered_at INTEGER NOT NULL)")

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_discovered_site_allowlist_is_read_only_and_bounded(self):
        with queue.connect() as c:
            c.execute(
                "INSERT INTO sites(host,title,url,directory,discovered_at) VALUES(?,?,?,?,?)",
                ("catalog.example.org", "Catalog", "https://catalog.example.org/", "FMHY", 123),
            )
        with patch.object(queue, "require_auth"):
            result = queue.api_sites(authorization="Bearer test", limit=10)
        self.assertEqual(len(result["sites"]), 1)
        self.assertEqual(result["sites"][0]["host"], "catalog.example.org")
        self.assertEqual(result["sites"][0]["url"], "https://catalog.example.org/")


    def test_discovery_jobs_are_durable_and_idempotent(self):
        first = queue.submit_job("discover", {"search_keyword": "sample"}, "discover:sample")
        second = queue.submit_job("discover", {"search_keyword": "sample"}, "discover:sample")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["job_type"], "discover")

    def test_seedhub_collection_job_types_are_rejected_by_api(self):
        from fastapi import HTTPException
        for job_type in ("seedhub_sync", "seedhub_detail_sync"):
            with self.subTest(job_type=job_type), patch.object(queue, "require_auth"), self.assertRaises(HTTPException):
                queue.api_submit_job(
                    {"job_type": job_type, "payload": {"category": "movies"}, "idempotency_key": "retired:" + job_type},
                    authorization="Bearer test",
                )

    def test_idempotent_job_submit_and_atomic_claim(self):
        first = queue.submit_job("crawl", {"url": "https://example.org"}, "crawl:example")
        second = queue.submit_job("crawl", {"url": "https://example.org"}, "crawl:example")
        self.assertEqual(first["id"], second["id"])
        claimed = queue.claim_job("worker-a", lease_seconds=30)
        self.assertEqual(claimed["attempt"], 1)
        self.assertIsNone(queue.claim_job("worker-b"))

    def test_lease_expiry_requeues_job(self):
        job = queue.submit_job("crawl", {"url": "https://example.org"}, "lease:test")
        queue.claim_job("worker-a", lease_seconds=10)
        with queue.connect() as c:
            c.execute("UPDATE collector_jobs SET lease_until=0 WHERE id=?", (job["id"],))
        reclaimed = queue.claim_job("worker-b")
        self.assertEqual(reclaimed["id"], job["id"])
        self.assertEqual(reclaimed["attempt"], 2)
        with queue.connect() as c:
            recovered = c.execute("SELECT COUNT(*) AS n FROM collector_job_events WHERE job_id=? AND event='lease_expired_recovered'", (job["id"],)).fetchone()["n"]
        self.assertEqual(recovered, 1)

    def test_retry_backoff_then_dead_letter(self):
        job = queue.submit_job("crawl", {"url": "https://example.org"}, "retry:test", max_attempts=2)
        queue.claim_job("worker-a")
        self.assertTrue(queue.fail_job(job["id"], "worker-a", "NetworkError"))
        with queue.connect() as c:
            row = c.execute("SELECT status,available_at FROM collector_jobs WHERE id=?", (job["id"],)).fetchone()
            self.assertEqual(row["status"], "queued")
            self.assertGreater(row["available_at"], int(__import__("time").time()))
            c.execute("UPDATE collector_jobs SET available_at=0 WHERE id=?", (job["id"],))
        queue.claim_job("worker-b")
        self.assertTrue(queue.fail_job(job["id"], "worker-b", "NetworkError"))
        with queue.connect() as c:
            row = c.execute("SELECT status FROM collector_jobs WHERE id=?", (job["id"],)).fetchone()
        self.assertEqual(row["status"], "failed")

    def test_cancel_queued_job(self):
        job = queue.submit_job("crawl", {"url": "https://example.org"}, "cancel:test")
        self.assertTrue(queue.cancel_job(job["id"]))
        self.assertIsNone(queue.claim_job("worker-a"))

    def test_running_job_cancel_is_cooperative_and_recoverable(self):
        job = queue.submit_job("crawl", {"url": "https://example.org"}, "cancel-running:test")
        queue.claim_job("worker-a")
        self.assertTrue(queue.cancel_job(job["id"]))
        self.assertTrue(queue.job_cancelled(job["id"]))
        self.assertTrue(queue.mark_cancelled(job["id"], "worker-a"))
        with queue.connect() as c:
            row = c.execute("SELECT status FROM collector_jobs WHERE id=?", (job["id"],)).fetchone()
        self.assertEqual(row["status"], "cancelled")

    def test_registry_search_miss_enqueues_fmhy_discovery(self):
        with patch.object(queue, "require_auth"):
            result = queue.api_registry_search(q="Missing film", authorization="Bearer test")
        self.assertEqual(result["resources"], [])
        self.assertEqual(len(result["queued"]), 1)
        self.assertEqual(result["queued"][0]["stage"], "fmhy_discovery")
        with queue.connect() as c:
            job = c.execute("SELECT job_type,status FROM collector_jobs").fetchone()
        self.assertEqual(job["job_type"], "discover")
        self.assertEqual(job["status"], "queued")

    def test_registry_upsert_is_idempotent_and_title_is_not_identity(self):
        one = queue.upsert_resource({
            "resource_key": "provider-a:movie-1", "source_key": "provider-a",
            "resource_type": "DIRECT_MEDIA", "url": "https://media.example.org/a.mp4",
            "title": "同名电影", "movie_external_key": "tmdb:100",
        })
        again = queue.upsert_resource({
            "resource_key": "provider-a:movie-1", "source_key": "provider-a",
            "resource_type": "DIRECT_MEDIA", "url": "https://media.example.org/a.mp4",
            "title": "同名电影", "movie_external_key": "tmdb:100",
        })
        other = queue.upsert_resource({
            "resource_key": "provider-a:movie-2", "source_key": "provider-a",
            "resource_type": "DIRECT_MEDIA", "url": "https://media.example.org/b.mp4",
            "title": "同名电影", "movie_external_key": "tmdb:200",
        })
        self.assertEqual(one["id"], again["id"])
        self.assertNotEqual(one["movie_id"], other["movie_id"])

    def test_playback_requires_public_preflight(self):
        resource = queue.upsert_resource({
            "resource_key": "resource:private", "source_key": "provider",
            "resource_type": "DIRECT_MEDIA", "url": "https://media.example.org/a.mp4",
            "title": "Private", "access_state": "AUTH_REQUIRED",
        })
        with self.assertRaises(ValueError):
            queue.record_verification(resource["id"], "player", "passed", {"progressed_seconds": 3})

    def test_verification_history_and_confirmed_registry_search(self):
        resource = queue.upsert_resource({
            "resource_key": "resource:public", "source_key": "provider",
            "resource_type": "DIRECT_MEDIA", "url": "https://media.example.org/a.mp4",
            "title": "Public Film", "access_state": "PUBLIC",
        })
        queue.record_verification(resource["id"], "preflight", "passed", {"access_state": "PUBLIC"})
        queue.record_verification(resource["id"], "player", "passed", {"progressed_seconds": 3})
        with queue.connect() as c:
            row = c.execute("SELECT validation_state,playback_state FROM registry_resources WHERE id=?", (resource["id"],)).fetchone()
            history = c.execute("SELECT COUNT(*) n FROM registry_history WHERE resource_id=?", (resource["id"],)).fetchone()["n"]
            verifications = c.execute("SELECT COUNT(*) n FROM registry_verifications WHERE resource_id=?", (resource["id"],)).fetchone()["n"]
        self.assertEqual(row["validation_state"], "validated")
        self.assertEqual(row["playback_state"], "PLAYER_CONFIRMED")
        self.assertGreaterEqual(history, 3)
        self.assertEqual(verifications, 2)


    def test_registry_search_exposes_public_validated_media_before_first_playback(self):
        resource = queue.upsert_resource({
            "resource_key": "candidate:public-media", "source_key": "public-provider",
            "resource_type": "DIRECT_MEDIA", "url": "https://media.example.org/film.m3u8",
            "title": "Public Film", "access_state": "PUBLIC", "media_format": "hls",
            "candidate_id": "a" * 32,
        })
        queue.record_verification(resource["id"], "preflight", "passed", {"access_state": "PUBLIC"})
        with patch.object(queue, "require_auth"):
            result = queue.api_registry_search(q="Public Film", authorization="Bearer test")
        self.assertEqual(len(result["resources"]), 1)
        self.assertEqual(result["resources"][0]["playback_state"], "unverified")
        self.assertEqual(result["resources"][0]["candidate_id"], "a" * 32)
        self.assertEqual(result["queued"], [])
        self.assertEqual(result["search_mode"], "playback_eligible_registry")

    def test_registry_search_does_not_expose_unvalidated_or_non_media_candidates(self):
        resource = queue.upsert_resource({
            "resource_key": "candidate:cms-api", "source_key": "public-provider",
            "resource_type": "CMS_VOD", "url": "https://api.example.org/provide/vod",
            "title": "Public Film", "access_state": "PUBLIC",
        })
        queue.record_verification(resource["id"], "preflight", "passed", {"access_state": "PUBLIC"})
        with patch.object(queue, "require_auth"):
            result = queue.api_registry_search(q="Public Film", authorization="Bearer test")
        self.assertEqual(result["resources"], [])
        self.assertEqual(len(result["queued"]), 1)
        self.assertEqual(result["queued"][0]["stage"], "fmhy_discovery")



    def test_registry_search_matches_preserved_search_keyword_metadata(self):
        candidate_id = "b" * 32
        resource = queue.register_discovered_candidate({
            "id": candidate_id,
            "kind": "direct-media",
            "host": "loc.gov",
            "url": "https://loc.gov/resource/sample.mp4",
            "title": "Library of Congress",
            "status": "pending",
            "search_keyword": "The Sample Film",
            "access_state": "ACCESS_UNKNOWN",
        })
        queue.sync_candidate_validation(candidate_id, {
            "reachable": True,
            "media_format": "progressive",
            "content_type": "video/mp4",
            "access": {"access_state": "PUBLIC"},
        }, "validated")
        with patch.object(queue, "require_auth"):
            result = queue.api_registry_search(q="Sample Film", authorization="Bearer test")
        self.assertEqual([item["candidate_id"] for item in result["resources"]], [candidate_id])
        self.assertEqual(result["queued"], [])



    def test_initialize_cancels_legacy_seedhub_collection_jobs(self):
        now = int(__import__("time").time())
        legacy = ("seedhub_sync", "seedhub_detail_sync")
        with queue.connect() as c:
            for index, job_type in enumerate(legacy):
                c.execute(
                    """INSERT INTO collector_jobs
                       (id,idempotency_key,job_type,payload,status,available_at,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (f"legacy-{index}", f"legacy:{job_type}", job_type, "{}", "queued", now, now, now),
                )
        queue.initialize()
        with queue.connect() as c:
            rows = c.execute(
                "SELECT id,status,lease_owner,lease_until,cancelled_at FROM collector_jobs WHERE id LIKE 'legacy-%' ORDER BY id"
            ).fetchall()
            events = c.execute(
                "SELECT COUNT(*) AS n FROM collector_job_events WHERE event='seedhub_collection_retired'"
            ).fetchone()["n"]
        self.assertEqual([row["status"] for row in rows], ["cancelled", "cancelled"])
        self.assertTrue(all(row["lease_owner"] is None and row["lease_until"] is None for row in rows))
        self.assertTrue(all(row["cancelled_at"] is not None for row in rows))
        self.assertEqual(events, 2)

    def test_seedhub_collection_job_types_are_rejected(self):
        for job_type in ("seedhub_sync", "seedhub_detail_sync"):
            with self.subTest(job_type=job_type), self.assertRaises(ValueError):
                queue.submit_job(job_type, {"category": "movies"}, "retired:" + job_type)



if __name__ == "__main__":
    unittest.main()
