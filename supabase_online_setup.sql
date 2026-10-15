-- MEDKAS ONLINE V1.0 - MIGRATION / GRANTS
-- Jalankan setelah SQL database awal yang sudah dibuat sebelumnya.

-- Karena MedKas memakai ID client-side untuk menjaga relasi antar data,
-- kolom ID operasional dibuat TEXT. Tabel user_profiles tetap UUID karena
-- terhubung ke auth.users.

-- Lepas FK terlebih dahulu agar tipe kolom dapat diubah dengan aman.
alter table public.user_profiles drop constraint if exists user_profiles_member_id_fkey;
alter table public.transactions drop constraint if exists transactions_member_id_fkey;
alter table public.transactions drop constraint if exists transactions_iuran_id_fkey;
alter table public.iuran drop constraint if exists iuran_transaction_id_fkey;

alter table public.members alter column id type text using id::text;
alter table public.transactions alter column id type text using id::text;
alter table public.iuran alter column id type text using id::text;
alter table public.transactions alter column iuran_id type text using iuran_id::text;
alter table public.transactions alter column member_id type text using member_id::text;
alter table public.iuran alter column member_id type text using member_id::text;
alter table public.iuran alter column transaction_id type text using transaction_id::text;
alter table public.user_profiles alter column member_id type text using member_id::text;

-- Pasang kembali FK setelah tipe ID diseragamkan.
alter table public.user_profiles
  add constraint user_profiles_member_id_fkey
  foreign key (member_id) references public.members(id) on delete set null;

alter table public.transactions
  add constraint transactions_member_id_fkey
  foreign key (member_id) references public.members(id) on delete set null;

alter table public.transactions
  add constraint transactions_iuran_id_fkey
  foreign key (iuran_id) references public.iuran(id) on delete set null;

alter table public.iuran
  add constraint iuran_transaction_id_fkey
  foreign key (transaction_id) references public.transactions(id) on delete set null;

-- Data API grants. RLS tetap menjadi lapisan otorisasi utama.
grant usage on schema public to anon, authenticated;
grant select on public.app_settings to authenticated;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.iuran to authenticated;
grant select, insert, update, delete on public.user_profiles to authenticated;

-- User baru boleh membuat profilnya sendiri sebagai USER.
-- Admin kemudian dapat menaikkan role/status lewat policy admin yang sudah ada.
drop policy if exists "user_profiles_insert_self" on public.user_profiles;
create policy "user_profiles_insert_self"
on public.user_profiles
for insert
to authenticated
with check (
  id = auth.uid()
  and role = 'user'::public.medkas_role
);

-- User boleh membaca profilnya sendiri; admin boleh membaca semua.
drop policy if exists "user_profiles_select_own" on public.user_profiles;
create policy "user_profiles_select_own"
on public.user_profiles
for select
to authenticated
using (
  id = auth.uid()
  or public.is_admin()
);

-- Untuk sinkronisasi profil sendiri.
drop policy if exists "user_profiles_update_own" on public.user_profiles;
create policy "user_profiles_update_own"
on public.user_profiles
for update
to authenticated
using (id = auth.uid() or public.is_admin())
with check (id = auth.uid() or public.is_admin());

-- Pastikan fungsi role dapat dieksekusi oleh user login.
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_bendahara() to authenticated;

-- Default iuran MedKas.
insert into public.app_settings (id, iuran_amount, app_name, app_version)
values (1, 10000, 'MedKas', 'V1.0')
on conflict (id) do nothing;
