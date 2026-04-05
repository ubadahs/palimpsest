import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

const nodeEnvSchema = z
  .enum(["development", "test", "production"])
  .default("development");
const databasePathSchema = z
  .string()
  .min(1)
  .default("data/citation-fidelity.sqlite");
const openAlexBaseUrlSchema = z
  .string()
  .url()
  .default("https://api.openalex.org");
const semanticScholarBaseUrlSchema = z
  .string()
  .url()
  .default("https://api.semanticscholar.org/graph/v1");
const biorxivBaseUrlSchema = z
  .string()
  .url()
  .default("https://api.biorxiv.org");
const grobidBaseUrlSchema = z.string().url();
const localRerankerBaseUrlSchema = z.string().url().optional();
const openAlexEmailSchema = z.string().email().optional();
const semanticScholarApiKeySchema = z.string().min(1).optional();
const anthropicApiKeySchema = z.string().min(1).optional();

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  CITATION_FIDELITY_DB_PATH: databasePathSchema,
  OPENALEX_BASE_URL: openAlexBaseUrlSchema,
  SEMANTIC_SCHOLAR_BASE_URL: semanticScholarBaseUrlSchema,
  BIORXIV_BASE_URL: biorxivBaseUrlSchema,
  GROBID_BASE_URL: grobidBaseUrlSchema,
  LOCAL_RERANKER_BASE_URL: localRerankerBaseUrlSchema,
  OPENALEX_EMAIL: openAlexEmailSchema,
  SEMANTIC_SCHOLAR_API_KEY: semanticScholarApiKeySchema,
  ANTHROPIC_API_KEY: anthropicApiKeySchema,
});

const lenientEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  CITATION_FIDELITY_DB_PATH: databasePathSchema,
  OPENALEX_BASE_URL: openAlexBaseUrlSchema,
  SEMANTIC_SCHOLAR_BASE_URL: semanticScholarBaseUrlSchema,
  BIORXIV_BASE_URL: biorxivBaseUrlSchema,
  GROBID_BASE_URL: grobidBaseUrlSchema.optional(),
  LOCAL_RERANKER_BASE_URL: localRerankerBaseUrlSchema,
  OPENALEX_EMAIL: openAlexEmailSchema,
  SEMANTIC_SCHOLAR_API_KEY: semanticScholarApiKeySchema,
  ANTHROPIC_API_KEY: anthropicApiKeySchema,
});

export type AppEnvironment = z.infer<typeof environmentSchema>;
export type LenientAppEnvironment = z.infer<typeof lenientEnvironmentSchema>;

let cachedEnvironment: AppEnvironment | undefined;
let cachedEnvironmentCwd: string | undefined;
let cachedLenientEnvironment: LenientAppEnvironment | undefined;
let cachedLenientEnvironmentCwd: string | undefined;

function parseEnvironment(source: NodeJS.ProcessEnv): AppEnvironment {
  return environmentSchema.parse(source);
}

function parseLenientEnvironment(source: NodeJS.ProcessEnv): LenientAppEnvironment {
  return lenientEnvironmentSchema.parse(source);
}

function loadDotenvFiles(cwd: string): void {
  loadDotenv({ path: resolve(cwd, ".env.local"), quiet: true });
  loadDotenv({ path: resolve(cwd, ".env"), quiet: true });
}

export function loadEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options?: {
    cwd?: string;
  },
): AppEnvironment {
  if (source !== process.env) {
    return parseEnvironment(source);
  }

  const cwd = resolve(options?.cwd ?? process.cwd());
  if (cachedEnvironment && cachedEnvironmentCwd === cwd) {
    return cachedEnvironment;
  }

  loadDotenvFiles(cwd);
  cachedEnvironment = parseEnvironment(process.env);
  cachedEnvironmentCwd = cwd;
  return cachedEnvironment;
}

export function loadEnvironmentLenient(
  source: NodeJS.ProcessEnv = process.env,
  options?: {
    cwd?: string;
  },
): LenientAppEnvironment {
  if (source !== process.env) {
    return parseLenientEnvironment(source);
  }

  const cwd = resolve(options?.cwd ?? process.cwd());
  if (cachedLenientEnvironment && cachedLenientEnvironmentCwd === cwd) {
    return cachedLenientEnvironment;
  }

  loadDotenvFiles(cwd);
  cachedLenientEnvironment = parseLenientEnvironment(process.env);
  cachedLenientEnvironmentCwd = cwd;
  return cachedLenientEnvironment;
}
