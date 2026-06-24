-- Appointment: carry full booking data + deposit-paid info
alter table gp_appointments add column if not exists deposit_paid      boolean default false;
alter table gp_appointments add column if not exists deposit_paid_amt  numeric default 0;
alter table gp_appointments add column if not exists deposit_paid_date date;
alter table gp_appointments add column if not exists booking_data      jsonb default '{}';
