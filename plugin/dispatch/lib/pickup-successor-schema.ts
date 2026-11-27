/**
 * Index ordinary pickups and materialize batch membership when a launch is written.
 * Records that do not read as launch records stay in launches so backfilling the index can proceed.
 */
export const UNREADABLE_PICKUP = `action = 'pickup' AND CASE WHEN json_valid(record) THEN
      json_type(record) IS NOT 'object'
      OR json_extract(record, '$.id') IS NOT id
      OR json_type(record, '$.version') IS NOT 'integer'
      OR json_type(record, '$.token') IS NOT 'text'
      OR json_type(record, '$.account') IS NOT 'text'
      OR json_type(record, '$.repo') IS NOT 'text'
      OR json_type(record, '$.repoPath') IS NOT 'text'
      OR json_type(record, '$.createdAt') IS NOT 'text'
    ELSE 1 END`;

export const PICKUP_SUCCESSOR_SCHEMA = `
  CREATE INDEX launches_pickup_successors ON launches (repo, action, item, created_at);
  CREATE INDEX launches_unreadable_pickups ON launches (repo, created_at)
    WHERE ${UNREADABLE_PICKUP};
  CREATE TABLE pickup_batch_members (
    repo TEXT NOT NULL,
    item TEXT NOT NULL,
    created_at TEXT NOT NULL,
    launch TEXT NOT NULL,
    PRIMARY KEY (repo, item, created_at, launch)
  ) WITHOUT ROWID;
  CREATE INDEX pickup_batch_members_launch ON pickup_batch_members (launch);

  INSERT OR IGNORE INTO pickup_batch_members
    SELECT launches.repo, json_extract(member.value, '$.key'), launches.created_at, launches.id
    FROM launches, json_each(
      CASE WHEN json_valid(launches.record) THEN launches.record ELSE '{}' END,
      '$.batchItems'
    ) AS member
    WHERE launches.action = 'pickup'
      AND CASE WHEN member.type = 'object' THEN json_type(member.value, '$.key') = 'text' END;

  CREATE TRIGGER pickup_batch_members_insert AFTER INSERT ON launches
    WHEN NEW.action = 'pickup'
    BEGIN
      INSERT OR IGNORE INTO pickup_batch_members
        SELECT NEW.repo, json_extract(member.value, '$.key'), NEW.created_at, NEW.id
        FROM json_each(
          CASE WHEN json_valid(NEW.record) THEN NEW.record ELSE '{}' END,
          '$.batchItems'
        ) AS member
        WHERE CASE WHEN member.type = 'object' THEN json_type(member.value, '$.key') = 'text' END;
    END;

  CREATE TRIGGER pickup_batch_members_delete AFTER DELETE ON launches
    BEGIN
      DELETE FROM pickup_batch_members WHERE launch = OLD.id;
    END;
`;
