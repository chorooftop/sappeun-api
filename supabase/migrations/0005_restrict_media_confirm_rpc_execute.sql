revoke all on function public.confirm_user_photo_upload(
  uuid,
  uuid,
  text,
  timestamp with time zone
) from public;
revoke all on function public.confirm_user_photo_upload(
  uuid,
  uuid,
  text,
  timestamp with time zone
) from anon;
revoke all on function public.confirm_user_photo_upload(
  uuid,
  uuid,
  text,
  timestamp with time zone
) from authenticated;
grant execute on function public.confirm_user_photo_upload(
  uuid,
  uuid,
  text,
  timestamp with time zone
) to service_role;

revoke all on function public.confirm_user_clip_upload(
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone
) from public;
revoke all on function public.confirm_user_clip_upload(
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone
) from anon;
revoke all on function public.confirm_user_clip_upload(
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone
) from authenticated;
grant execute on function public.confirm_user_clip_upload(
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone
) to service_role;
