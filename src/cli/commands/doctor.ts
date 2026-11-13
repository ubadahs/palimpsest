import {
  getEnvironmentHealthSummary,
  type HealthCheck,
} from "../../health/checks.js";

function statusIcon(check: HealthCheck): string {
  if (check.status === "ok") return "OK";
  if (check.status === "not_configured") return "SKIP";
  return "FAIL";
}

export async function runDoctorCommand(): Promise<void> {
  const environmentHealth = await getEnvironmentHealthSummary();
  const h = environmentHealth.health;

  console.info("\nPalimpsest Runtime Health Check\n");
  console.info(`  Node env:       ${environmentHealth.nodeEnv}`);
  console.info(
    `  Database:       ${statusIcon(h.database)}  ${h.database.detail ?? environmentHealth.databasePath}`,
  );
  console.info(
    `  GROBID:         ${statusIcon(h.grobid)}  ${h.grobid.detail ?? environmentHealth.providerBaseUrls.grobid}`,
  );
  console.info(
    `  Anthropic:      ${statusIcon(h.anthropic)}  ${h.anthropic.detail ?? "configured"}`,
  );

  if (environmentHealth.institutionalProxyUrl) {
    console.info(
      `  Proxy:          ${environmentHealth.institutionalProxyUrl}`,
    );
  }

  console.info("");

  console.info(JSON.stringify(environmentHealth, null, 2));

  if (h.grobid.status !== "ok") {
    process.exitCode = 1;
  }
}
