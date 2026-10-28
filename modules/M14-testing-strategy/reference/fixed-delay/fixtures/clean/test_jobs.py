import time


def test_job_finishes(client):
    job = client.start()
    deadline = time.monotonic() + 30
    while (status := client.status(job)) != "done":
        assert status != "failed", f"job {job} failed"
        assert time.monotonic() < deadline, f"job {job} still {status} after 30s"
        time.sleep(0.1)  # fixed-delay: the pause between two polls of the job
