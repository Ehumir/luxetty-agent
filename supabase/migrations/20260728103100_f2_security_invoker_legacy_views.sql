-- Legacy reporting/catalog views must enforce the caller's grants and RLS.
alter view public.v_property_marketing_workspace set (security_invoker = true);
alter view public.v_property_type_consistency_audit set (security_invoker = true);
alter view public.property_marketing_summary set (security_invoker = true);
alter view public.v_property_amenities_grouped set (security_invoker = true);
alter view public.vw_agent_profiles_with_arrays set (security_invoker = true);
alter view public.public_agent_profiles set (security_invoker = true);
alter view public.v_properties_catalog_enriched set (security_invoker = true);
alter view public.v_properties_marketing_enriched set (security_invoker = true);
alter view public.public_agents_directory set (security_invoker = true);
alter view public.v_argos_version_progress set (security_invoker = true);
alter view public.v_argos_module_progress set (security_invoker = true);
alter view public.v_property_valuations_list set (security_invoker = true);
alter view public.v_property_valuation_kpis set (security_invoker = true);
alter view public.v_property_valuation_agent_performance set (security_invoker = true);
