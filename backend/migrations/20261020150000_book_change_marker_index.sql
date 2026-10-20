-- The change marker (20261020140000) read every audit_log row of the book from
-- the table on each poll: the (book_id, at) index has no id, so max(id) can't
-- come from it. With (book_id, id) the count is an index-only scan and the
-- highest id a single probe. On a book with 200k audit rows (500k in all): 66 ms
-- and 44k pages a poll before, 22 ms and 1k pages after.
--
-- The marker is also hashed now. Audit ids are numbered across the whole server,
-- so the raw highest id would let a member work out how much everyone else
-- changes between two of their own changes. Clients only compare it.
create index if not exists audit_log_book_id_idx on audit_log (book_id, id);

create or replace function book_change_marker(p_book uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case when can_read_book(p_book) then
    (select md5(count(*) || '.' || coalesce(max(id), 0)) from audit_log where book_id = p_book) end
$$;
