// Pure decisions about the referee's GitHub Actions workflow (tested under Node).

/**
 * What to do about the referee workflow's state. GitHub disables workflows in
 * a public repo after 60 days without commits, and the referee repo should
 * almost never get commits. A workflow the operator disabled by hand stays
 * disabled: that is an intervention, not an accident.
 */
export function workflowFix(state: string | undefined): 'enable' | 'leave' | 'warn' {
  if (state === 'disabled_inactivity') return 'enable';
  if (state === 'active') return 'leave';
  return 'warn';
}
