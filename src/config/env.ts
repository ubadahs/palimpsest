import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  CITATION_FIDELITY_DB_PATH: z
    .string()
    .min(1)
    .default("data/citation-fidelity.sqlite"),
  OPENALEX_BASE_URL: z.string().url().default("https://api.openalex.org"),
  SEMANTIC_SCHOLAR_BASE_URL: z
    .string()
    .url()
    .default("https://api.semanticscholar.org/graph/v1"),
  BIORXIV_BASE_URL: z.string().url().default("https://api.biorxiv.org"),
  OPENALEX_EMAIL: z.string().email().optional(),
  SEMANTIC_SCHOLAR_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

let cachedEnvironment: AppEnvironment | undefined;

function parseEnvironment(source: NodeJS.ProcessEnv): AppEnvironment {
  return environmentSchema.parse(source);
}

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  if (source !== process.env) {
    return parseEnvironment(source);
  }

  loadDotenv({ path: ".env.local", quiet: true });
  loadDotenv({ quiet: true });
  cachedEnvironment = parseEnvironment(process.env);
  return cachedEnvironment;
}
