import { z } from "zod";

/** Strict ISO date: YYYY-MM-DD. Guards lexical date-range comparisons. */
export const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
