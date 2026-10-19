-- Development data only. The Supabase CLI runs this after the migrations on
-- `supabase db reset` (local), and CI loads it into the development project
-- (`supabase db push --include-seed`). Never production: production's first
-- privacy policy is published by its own migration before launch.
-- The tests load it too, so they run on the same database a developer gets.

insert into policy_versions (version, published_at, path, text_sha256) values
  ('dev-2026-10-01', '2026-10-01', '/privacy/dev-2026-10-01',
   'b1b490512f7f0903455548a6c55ca777cd1b9a11b3c1687d19a8b34cde0a0ced')   -- sha256 of this text plus a trailing newline: Placeholder privacy policy for the development project only. Replace before launch.
on conflict (version) do nothing;
