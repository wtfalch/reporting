-- @wtfalch/reporting-service: a failed mail whose rule was turned off is now
-- marked `dropped` and leaves the retry queue, so it cannot hold a slot that
-- another rule's retry needs. Additive: one more status the table accepts.
alter table reporting_alerts drop constraint if exists reporting_alerts_status_check;
alter table reporting_alerts add constraint reporting_alerts_status_check
  check (status in ('sending', 'sent', 'failed', 'dropped'));
