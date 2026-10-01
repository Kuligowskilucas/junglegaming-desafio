export type CanonicalJsonValue = string | { readonly [key: string]: CanonicalJsonValue | undefined };

export function canonicalJson(value: CanonicalJsonValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  const members = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const member = value[key];
      return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
    });
  return `{${members.join(",")}}`;
}
