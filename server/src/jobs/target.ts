import { sql } from "drizzle-orm";
import { jobs } from "../db/schema";

/** The revision a job is about, read from its payload. */
export const jobRevisionId = sql<number>`json_extract(${jobs.payload}, '$.revisionId')`;
