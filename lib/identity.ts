export const APPLICATION_NAME = "Daily Joe Careers";

export function greetingName(name?: string) {
  const value = name?.trim();
  if (
    !value ||
    value.includes("@") ||
    /^(daily(?:\s+joe)?(?:\s+careers|\s+hr)?|careers|hr team)$/i.test(value)
  )
    return APPLICATION_NAME;
  return value.split(/\s+/)[0];
}
