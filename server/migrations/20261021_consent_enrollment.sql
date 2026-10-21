-- Additive: existing study data is preserved. Shared passwords grant no enrollment.
CREATE TABLE IF NOT EXISTS participant_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(study_id),
  participant TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_reference TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  verified_by TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invitation_expires_at TIMESTAMPTZ NOT NULL,
  device_id TEXT,
  activated_at TIMESTAMPTZ,
  collection_expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS participant_enrollments_study_idx
  ON participant_enrollments (study_id, participant);
CREATE UNIQUE INDEX IF NOT EXISTS participant_enrollments_active_participant_idx
  ON participant_enrollments (study_id, participant) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS participant_enrollments_active_device_idx
  ON participant_enrollments (study_id, device_id) WHERE revoked_at IS NULL;
