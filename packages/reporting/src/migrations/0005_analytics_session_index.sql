-- @wtfalch/reporting 0.4.0: a session-scoped index on reporting_analytics.
--
-- Debugging a tenant's user-reported bug means "everything this session
-- did," and every row already carries a per-tab session id -- the lightest
-- privacy-consistent equivalent of session replay (gap issue #9;
-- `analyticsRecent` gained a `sessionId` filter). Without an index shaped
-- for it, that filter is a sequential scan of the whole raw analytics
-- window on a busy site. Same shape as `reporting_analytics_tenant_time_idx`
-- (0002_analytics.sql): the filter column, then the reader's own order.
-- Idempotent, like every statement in this package's migrations.

create index if not exists reporting_analytics_session_time_idx
  on reporting_analytics (session_id, occurred_at desc, id desc)
  where session_id is not null;
