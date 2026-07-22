export interface MetricValue {
  name: string;
  value: number;
  unit: "count" | "currency" | "second" | "byte";
}

export interface MetricsSnapshot {
  generatedAt: string;
  metrics: MetricValue[];
}

/**
 * AdminOperation only reads operational measurements. Producers remain the sole writers
 * of their account, payment, usage, and server state.
 */
export interface MetricsReader {
  read(): Promise<MetricsSnapshot>;
}
