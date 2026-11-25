CREATE TABLE `job_schedules` (
	`partition` text NOT NULL,
	`job` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`every_ms` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`partition`, `job`)
);
