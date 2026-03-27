import { describe, expect, it } from "vitest";

import { createAppConfig } from "../../src/config/app-config.js";
import { loadEnvironment } from "../../src/config/env.js";

describe("loadEnvironment", () => {
  it("applies defaults for the local CLI workflow", () => {
    const environment = loadEnvironment({});

    expect(environment.NODE_ENV).toBe("development");
    expect(environment.CITATION_FIDELITY_DB_PATH).toBe(
      "data/citation-fidelity.sqlite",
    );
    expect(environment.OPENALEX_BASE_URL).toBe("https://api.openalex.org");
  });

  it("builds an absolute app config from environment values", () => {
    const environment = loadEnvironment({
      CITATION_FIDELITY_DB_PATH: "tmp/test.sqlite",
      NODE_ENV: "test",
    });

    const config = createAppConfig(environment, "/workspace");

    expect(config.nodeEnv).toBe("test");
    expect(config.databasePath).toBe("/workspace/tmp/test.sqlite");
    expect(config.providerBaseUrls.semanticScholar).toBe(
      "https://api.semanticscholar.org/graph/v1",
    );
  });
});
