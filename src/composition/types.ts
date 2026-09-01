/**
 * The one type every composition module shares.
 *
 * server.ts builds the logger and hands it down, so a builder never decides
 * where a boot line goes — it only decides what is worth saying. Kept in its
 * own module so the builders do not have to import each other for it.
 */

export type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;
