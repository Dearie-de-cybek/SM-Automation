-- 003_compliance: records required by Meta App Review — data deletion requests and
-- deauthorization callbacks. Kept out of 002 so the platform schema stays one concern.

CREATE TABLE IF NOT EXISTS data_deletion_requests (
  code             text PRIMARY KEY,
  provider         text NOT NULL,
  -- App-scoped user id from the provider's signed request (not our client id).
  external_user_id text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completed', 'not_found', 'failed')),
  detail           jsonb NOT NULL DEFAULT '{}',
  requested_at     timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS data_deletion_requests_user_idx
  ON data_deletion_requests (provider, external_user_id, requested_at DESC);
