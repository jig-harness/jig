import time


def test_job_finishes(client):
    job = client.start()
    while client.status(job) != "done":
        time.sleep(0.1)  # fixed-delay: the pause between two polls of the job
