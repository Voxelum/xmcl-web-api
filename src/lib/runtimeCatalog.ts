/**
 * Generated from the reviewed xmcl-shared-minecraft-runtime
 * runtime-catalog.lock.json. This is deployment configuration, not user input.
 */
export const runtimeCatalog = {
  schemaVersion: 1,
  sha256: "7d35cc796811673ad1d22272d0ca3e5614d4ed7b3c6b01defb6e2330fe48bcc3",
  requirements: [
    { component: "jre-legacy", major: 8 },
    { component: "java-runtime-alpha", major: 16 },
    { component: "java-runtime-beta", major: 17 },
    { component: "java-runtime-gamma", major: 17 },
    { component: "java-runtime-gamma-snapshot", major: 17 },
    { component: "java-runtime-delta", major: 21 },
    { component: "java-runtime-epsilon", major: 25 },
  ],
  runtimes: [
    { component: "jre-legacy", major: 8 },
    { component: "java-runtime-alpha", major: 16 },
    { component: "java-runtime-gamma", major: 17 },
    { component: "java-runtime-delta", major: 21 },
    { component: "java-runtime-epsilon", major: 25 },
  ],
} as const;

export interface RuntimeCatalogJava {
  component: string;
  major: number;
}

export function isRuntimeCatalogJava(value: RuntimeCatalogJava): boolean {
  return runtimeCatalog.requirements.some((requirement) =>
    requirement.component === value.component &&
    requirement.major === value.major
  ) && runtimeCatalog.runtimes.some((runtime) => runtime.major === value.major);
}
