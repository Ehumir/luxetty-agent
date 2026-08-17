-- Remove inherited write-like grants from views and restore only intentional reads.
revoke all on
  public.v_property_completion_audit,
  public.v_property_marketing_workspace,
  public.v_property_type_consistency_audit,
  public.property_marketing_summary,
  public.v_property_amenities_grouped,
  public.vw_agent_profiles_with_arrays,
  public.public_agent_profiles,
  public.v_properties_catalog_enriched,
  public.v_properties_marketing_enriched,
  public.public_agents_directory,
  public.v_argos_version_progress,
  public.v_argos_module_progress,
  public.v_property_valuations_list,
  public.v_property_valuation_kpis,
  public.v_property_valuation_agent_performance
from anon, authenticated;

grant select on
  public.v_property_completion_audit,
  public.v_property_marketing_workspace,
  public.v_property_type_consistency_audit,
  public.property_marketing_summary,
  public.v_property_amenities_grouped,
  public.vw_agent_profiles_with_arrays,
  public.public_agent_profiles,
  public.v_properties_catalog_enriched,
  public.v_properties_marketing_enriched,
  public.public_agents_directory,
  public.v_argos_version_progress,
  public.v_argos_module_progress,
  public.v_property_valuations_list,
  public.v_property_valuation_kpis,
  public.v_property_valuation_agent_performance
to authenticated;

grant select on
  public.public_agent_profiles,
  public.public_agents_directory,
  public.v_properties_catalog_enriched
to anon;
