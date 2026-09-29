export const retentionPolicyDefaults = {
  application_queue_days: 10,
  terminal_application_days: 10,
  talent_pool_days: 30,
  talent_pool_grace_days: 10,
  hiring_need_days: 10,
  timekeeping_cutoff_grace_days: 5,
  report_days: 365,
  activity_log_days: 30,
} as const;

export type RetentionPolicyName = keyof typeof retentionPolicyDefaults;
export type RetentionPolicies = Record<RetentionPolicyName, number>;
