import {
  auditabilityStatusValues,
  citationFunctionValues,
  fidelityTopLabelValues,
} from "../../domain/taxonomy.js";
import { getEnvironmentHealthSummary } from "../../health/checks.js";

export async function runDoctorCommand(): Promise<void> {
  const environmentHealth = await getEnvironmentHealthSummary();

  const summary = {
    ...environmentHealth,
    taxonomy: {
      citationFunctions: citationFunctionValues.length,
      auditabilityStatuses: auditabilityStatusValues.length,
      fidelityTopLabels: fidelityTopLabelValues.length,
    },
  };

  console.info(JSON.stringify(summary, null, 2));

  if (environmentHealth.health.grobid.status !== "ok") {
    process.exitCode = 1;
  }
}
