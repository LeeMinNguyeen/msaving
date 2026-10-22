-- The app is named Waterflow: the default server name, and a server still named by the former default.
alter table instance_settings alter column name set default 'Waterflow';
update instance_settings set name = 'Waterflow' where name = 'MSaving';
