CREATE TABLE `in_flight_reads` (
	`partition` text NOT NULL,
	`target` text NOT NULL,
	`holder` text NOT NULL,
	`taken_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	PRIMARY KEY(`partition`, `target`)
);
--> statement-breakpoint
CREATE INDEX `in_flight_reads_deadline` ON `in_flight_reads` (`partition`,`deadline_at`);--> statement-breakpoint
CREATE TABLE `job_leases` (
	`partition` text NOT NULL,
	`job` text NOT NULL,
	`holder` text,
	`lease_until` integer,
	`progress` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`partition`, `job`)
);
