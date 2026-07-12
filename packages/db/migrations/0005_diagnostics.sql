-- Build diagnostics ride the deployment row, so a failed (or warning-laden)
-- build can explain itself in any dashboard without a log excavation.
ALTER TABLE app.deployments ADD COLUMN diagnostics jsonb;
