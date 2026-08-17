-- Forward-only fix for the first legacy SECURITY DEFINER view.
alter view public.v_property_completion_audit
  set (security_invoker = true);
