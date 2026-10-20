-- What clients poll to notice that someone changed a book (msaving#25): an
-- opaque marker that changes whenever anything in the book does. Every change
-- to a book's rows already writes an audit_log row, so the marker is that
-- book's count of them and their highest id. The count also catches a change
-- that commits after a later one (ids are handed out before commit, so the
-- highest id alone would miss it). Members only; the answer says no more than
-- "something changed".
create or replace function book_change_marker(p_book uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case when can_read_book(p_book) then
    (select count(*) || '.' || coalesce(max(id), 0) from audit_log where book_id = p_book) end
$$;
revoke execute on function book_change_marker(uuid) from public;
grant execute on function book_change_marker(uuid) to app_user;
