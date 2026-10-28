import time


def test_job_finishes(client):
    job = client.start()
    deadline = time.monotonic() + 30
    while True:
        remaining = deadline - time.monotonic()
        assert remaining > 0, f"job {job} not done after 30s"
        status = client.status(job, timeout=remaining)
        assert time.monotonic() < deadline, f"job {job} answered {status} after 30s"
        if status == "done":
            return
        assert status != "failed", f"job {job} failed"
        time.sleep(0.1)  # fixed-delay: the pause between two polls of the job
