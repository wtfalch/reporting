-- Applied by the host's migration runner in a transaction.
CREATE TABLE reportings (
  id text PRIMARY KEY,
  organisation_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reportings_organisation_id_idx ON reportings (organisation_id);
