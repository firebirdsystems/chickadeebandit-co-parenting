-- Freeze legacy locked swaps before the app stops consulting the mutable
-- request/override tables at runtime. Prefer the applied override where one
-- exists: that was the calendar source of truth in pre-1.4 releases. Fall back
-- to the request for locks whose client never completed the override write.
-- Rows with neither source remain NULL and are deliberately ignored pending
-- manual reconciliation rather than inventing an exception.
UPDATE app_co_parenting__swap_agreements AS agreement
SET child_id = COALESCE(
      agreement.child_id,
      (SELECT child_id FROM app_co_parenting__overrides WHERE swap_request_id = agreement.id ORDER BY created_at DESC LIMIT 1),
      (SELECT child_id FROM app_co_parenting__swap_requests WHERE id = agreement.id LIMIT 1)
    ),
    start_date = COALESCE(
      agreement.start_date,
      (SELECT start_date FROM app_co_parenting__overrides WHERE swap_request_id = agreement.id ORDER BY created_at DESC LIMIT 1),
      (SELECT start_date FROM app_co_parenting__swap_requests WHERE id = agreement.id LIMIT 1)
    ),
    end_date = COALESCE(
      agreement.end_date,
      (SELECT end_date FROM app_co_parenting__overrides WHERE swap_request_id = agreement.id ORDER BY created_at DESC LIMIT 1),
      (SELECT end_date FROM app_co_parenting__swap_requests WHERE id = agreement.id LIMIT 1)
    ),
    to_parent_id = COALESCE(
      agreement.to_parent_id,
      (SELECT parent_id FROM app_co_parenting__overrides WHERE swap_request_id = agreement.id ORDER BY created_at DESC LIMIT 1),
      (SELECT to_parent_id FROM app_co_parenting__swap_requests WHERE id = agreement.id LIMIT 1)
    ),
    note = COALESCE(
      agreement.note,
      (SELECT reason FROM app_co_parenting__overrides WHERE swap_request_id = agreement.id ORDER BY created_at DESC LIMIT 1),
      (SELECT note FROM app_co_parenting__swap_requests WHERE id = agreement.id LIMIT 1)
    )
WHERE agreement.status = 'locked'
  AND (agreement.child_id IS NULL OR agreement.start_date IS NULL
    OR agreement.end_date IS NULL OR agreement.to_parent_id IS NULL);
