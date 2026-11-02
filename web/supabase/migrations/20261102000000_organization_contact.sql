-- Datos de contacto de la organización (clínica/convenio/médico) para encabezar sus cotizaciones.
-- Todas opcionales: sin ellos, la cotización usa la marca de PlusMedik. No toca lab_tests ni lab_test_aliases.
alter table public.organizations
  add column if not exists address text check (address is null or length(address) <= 240),
  add column if not exists phone text check (phone is null or length(phone) <= 60),
  add column if not exists note text check (note is null or length(note) <= 400);
