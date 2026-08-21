/** Signup password policy, shown live as the user types.
 *
 *  These are *positive* affordances, not errors: an unmet rule stays neutral in
 *  the UI and only ever turns into a satisfied tick. The usual "validate on
 *  blur, not on keystroke" guidance exists to stop a form shouting INVALID at a
 *  half-typed value — it does not apply to a requirements list, whose whole
 *  purpose is to show progress while typing. Nothing driven by this ever
 *  renders red.
 *
 *  The floor is 8 characters against GoTrue's default of 6, deliberately
 *  stricter so the server can never reject a password for a reason the form did
 *  not already display. Kept in its own module (rather than beside the login
 *  component) so the page file exports only components, which is what React
 *  Fast Refresh needs to hot-reload it.
 */

export interface PasswordRule {
  id: string;
  label: string;
  test: (value: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { id: "len", label: "At least 8 characters", test: (v) => v.length >= 8 },
  { id: "upper", label: "An uppercase letter (A-Z)", test: (v) => /[A-Z]/.test(v) },
  { id: "lower", label: "A lowercase letter (a-z)", test: (v) => /[a-z]/.test(v) },
  { id: "digit", label: "A number (0-9)", test: (v) => /[0-9]/.test(v) },
  { id: "special", label: "A special character (@ ! # $ …)", test: (v) => /[^A-Za-z0-9]/.test(v) },
];

/** True when every rule passes. Used to gate signup submission. */
export function passwordMeetsRules(value: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(value));
}

/** Each rule paired with whether `value` currently satisfies it, in display
 *  order — so the UI never re-derives the policy or its ordering itself. */
export function evaluatePassword(value: string): Array<PasswordRule & { met: boolean }> {
  return PASSWORD_RULES.map((rule) => ({ ...rule, met: rule.test(value) }));
}
