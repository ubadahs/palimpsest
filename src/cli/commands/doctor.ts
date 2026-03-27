import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import {
  auditabilityStatusValues,
  citationFunctionValues,
  fidelityTopLabelValues,
} from "../../domain/taxonomy.js";

export function runDoctorCommand(): void {
  const environment = loadEnvironment();
  const config = createAppConfig(environment);

  const summary = {
    nodeEnv: config.nodeEnv,
    databasePath: config.databasePath,
    providerBaseUrls: config.providerBaseUrls,
    taxonomy: {
      citationFunctions: citationFunctionValues.length,
      auditabilityStatuses: auditabilityStatusValues.length,
      fidelityTopLabels: fidelityTopLabelValues.length,
    },
  };

  console.info(JSON.stringify(summary, null, 2));
}
