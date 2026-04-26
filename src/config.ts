import { resolve } from "node:path";

export interface Config {
  filePath: string;
  autosave: boolean;
}

const AUTOSAVE_ON = new Set(["true", "1", "yes", "on"]);
const AUTOSAVE_OFF = new Set(["false", "0", "no", "off"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.KMYMONEY_FILE;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "KMYMONEY_FILE environment variable is not set. Point it at a .kmy file.",
    );
  }

  let autosave = true;
  const autosaveRaw = env.KMY_AUTOSAVE;
  if (autosaveRaw !== undefined) {
    const v = autosaveRaw.toLowerCase().trim();
    if (AUTOSAVE_OFF.has(v)) autosave = false;
    else if (AUTOSAVE_ON.has(v)) autosave = true;
    else {
      throw new Error(
        `KMY_AUTOSAVE=${JSON.stringify(autosaveRaw)} is not a recognized boolean. ` +
          `Use one of: ${[...AUTOSAVE_ON, ...AUTOSAVE_OFF].join(", ")}.`,
      );
    }
  }

  return { filePath: resolve(raw), autosave };
}
